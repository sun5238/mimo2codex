import { beforeEach, describe, expect, it } from "vitest";

import { selectProvider } from "../src/server.js";
import type { Config } from "../src/config.js";
import { initRegistry } from "../src/providers/registry.js";
import { createGenericProvider } from "../src/providers/generic.js";
import { deriveLaneAliases } from "../src/providers/laneAliases.js";
import { recordLane429, resetBreaker } from "../src/upstream/throttle.js";

// Cross-lane failover at the routing layer: consecutive 429s on the primary
// (lane, model) must flip BARE-name traffic to the mutual-backup lane. An
// explicit `base@lane` slug addresses exactly one lane — the breaker never
// substitutes a different lane for an explicit choice (transparent 429).

function fakeProvider(id: string, models: string[]): ReturnType<typeof createGenericProvider> {
  return createGenericProvider({
    id,
    baseUrl: `http://${id}.example/v1`,
    envKey: `${id.toUpperCase()}_API_KEY`,
    defaultModel: models[0],
    wireApi: "responses",
    models: models.map((m) => ({ id: m })),
  });
}

function fakeConfig(ids: string[]): Config {
  const providers: Record<string, unknown> = {};
  for (const id of ids) {
    providers[id] = { baseUrl: `http://${id}.example/v1`, apiKey: "k", flags: {} };
  }
  return { providers, defaultProviderId: ids[0] } as unknown as Config;
}

describe("selectProvider × lane breaker", () => {
  beforeEach(() => {
    const generics = [
      fakeProvider("alpha", ["shared-model", "solo-model"]),
      fakeProvider("beta", ["shared-model"]),
    ];
    deriveLaneAliases(generics);
    initRegistry(generics);
    resetBreaker();
  });

  it("routes bare and @lane slugs to their lanes by default", () => {
    const cfg = fakeConfig(["alpha", "beta"]);
    expect(selectProvider("shared-model", cfg, null).provider.id).toBe("alpha");
    expect(selectProvider("shared-model@beta", cfg, null).provider.id).toBe("beta");
  });

  it("fails a bare name over to the backup lane once the primary (lane, model) is OPEN", () => {
    const cfg = fakeConfig(["alpha", "beta"]);
    recordLane429("alpha", "shared-model");
    recordLane429("alpha", "shared-model");
    const routed = selectProvider("shared-model", cfg, null);
    expect(routed.provider.id).toBe("beta");
    expect(routed.upstreamModel).toBe("shared-model");
  });

  it("a model without backup keeps routing its primary (transparent 429)", () => {
    const cfg = fakeConfig(["alpha", "beta"]);
    recordLane429("alpha", "solo-model");
    recordLane429("alpha", "solo-model");
    expect(selectProvider("solo-model", cfg, null).provider.id).toBe("alpha");
  });

  it("all lanes OPEN → bare name falls back to primary", () => {
    const cfg = fakeConfig(["alpha", "beta"]);
    for (const lane of ["alpha", "beta"]) {
      recordLane429(lane, "shared-model");
      recordLane429(lane, "shared-model");
    }
    expect(selectProvider("shared-model", cfg, null).provider.id).toBe("alpha");
  });

  it("an explicit @lane slug is never substituted when its lane is OPEN", () => {
    const cfg = fakeConfig(["alpha", "beta"]);
    recordLane429("beta", "shared-model");
    recordLane429("beta", "shared-model");
    expect(selectProvider("shared-model@beta", cfg, null).provider.id).toBe("beta");
  });
});
