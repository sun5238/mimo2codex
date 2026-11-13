import { beforeEach, describe, expect, it } from "vitest";

import {
  BASE_COOLDOWN_MS,
  CONSECUTIVE_429_THRESHOLD,
  MAX_COOLDOWN_MS,
  firstOpenLane,
  injectedRetryAfterSec,
  isLaneOpen,
  recordLane429,
  recordLaneSuccess,
  resetBreaker,
} from "../src/upstream/throttle.js";
import { UpstreamError } from "../src/upstream/openaiCompatClient.js";

function err429(opts: { retryAfterSec?: number; bodySnippet?: string } = {}): UpstreamError {
  return new UpstreamError({
    status: 429,
    code: "rate_limit_exceeded",
    message: "upstream returned 429: throttling",
    ...opts,
  });
}

beforeEach(() => {
  resetBreaker();
});

describe("injectedRetryAfterSec", () => {
  it("relays the upstream value verbatim (priority)", () => {
    expect(injectedRetryAfterSec(err429({ retryAfterSec: 60 }))).toBe(60);
  });
  it("classifies Throttling.Concurrency as a sub-second blip → 2s", () => {
    expect(
      injectedRetryAfterSec(
        err429({ bodySnippet: '{"error":{"code":"Throttling.Concurrency"}}' })
      )
    ).toBe(2);
  });
  it("falls back to the 20s courtesy floor for other 429s", () => {
    expect(injectedRetryAfterSec(err429())).toBe(20);
  });
  it("does not inject for non-429 failures without an upstream value", () => {
    const e = new UpstreamError({ status: 402, code: "bad_request", message: "x" });
    expect(injectedRetryAfterSec(e)).toBeNull();
  });
});

describe("lane breaker", () => {
  const LANE = "alpha";
  const MODEL = "shared-model";

  it("stays closed below the consecutive-429 threshold", () => {
    recordLane429(LANE, MODEL);
    expect(isLaneOpen(LANE, MODEL)).toBe(false);
  });

  it("opens at the threshold, blocks during the base cooldown, half-opens after", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < CONSECUTIVE_429_THRESHOLD; i++) recordLane429(LANE, MODEL, t0);
    expect(isLaneOpen(LANE, MODEL, t0 + 1)).toBe(true);          // OPEN
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS - 1)).toBe(true);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS)).toBe(false); // HALF-OPEN probe passes
  });

  it("a failed probe doubles the cooldown, capped at 240s", () => {
    const t0 = 1_000_000;
    recordLane429(LANE, MODEL, t0);
    recordLane429(LANE, MODEL, t0);
    // probe at t0+90s fails:
    recordLane429(LANE, MODEL, t0 + BASE_COOLDOWN_MS);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS + 1)).toBe(true);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 - 1)).toBe(true);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3)).toBe(false);
    // repeated failed probes climb to — and hold at — the 240s cap:
    recordLane429(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3); // probe 2 fails → 180×2, capped to 240s
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 + 1)).toBe(true);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 + MAX_COOLDOWN_MS - 1)).toBe(true);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 + MAX_COOLDOWN_MS)).toBe(false);
    recordLane429(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 + MAX_COOLDOWN_MS); // probe 3 fails → cap holds
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 + MAX_COOLDOWN_MS * 2 - 1)).toBe(true);
    expect(isLaneOpen(LANE, MODEL, t0 + BASE_COOLDOWN_MS * 3 + MAX_COOLDOWN_MS * 2)).toBe(false);
  });

  it("a success closes the lane and resets the counter", () => {
    const t0 = 1_000_000;
    recordLane429(LANE, MODEL, t0);
    recordLane429(LANE, MODEL, t0);
    expect(isLaneOpen(LANE, MODEL, t0 + 1)).toBe(true);
    recordLaneSuccess(LANE, MODEL);
    expect(isLaneOpen(LANE, MODEL, t0 + 1)).toBe(false);
  });

  it("keys are (lane, model): sibling models on the same lane are unaffected", () => {
    const t0 = 1_000_000;
    recordLane429(LANE, MODEL, t0);
    recordLane429(LANE, MODEL, t0);
    expect(isLaneOpen(LANE, "solo-model", t0 + 1)).toBe(false);
    expect(isLaneOpen("backup", MODEL, t0 + 1)).toBe(false);
  });
});

describe("firstOpenLane", () => {
  it("picks the first candidate not blocked, else null (caller falls back to primary)", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const t0 = 1_000_000;
    recordLane429("a", "m", t0);
    recordLane429("a", "m", t0);
    const pick = firstOpenLane(
      [
        { lane: a, providerId: "a", modelId: "m" },
        { lane: b, providerId: "b", modelId: "m" },
      ],
      t0 + 1
    );
    expect((pick as { id: string }).id).toBe("b");
    recordLane429("b", "m", t0);
    recordLane429("b", "m", t0);
    expect(
      firstOpenLane(
        [
          { lane: a, providerId: "a", modelId: "m" },
          { lane: b, providerId: "b", modelId: "m" },
        ],
        t0 + 1
      )
    ).toBeNull();
  });
});
