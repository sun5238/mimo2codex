import type { UpstreamError } from "./openaiCompatClient.js";

// ---------------------------------------------------------------------------
// P3 — 429 治理（重试归 codex，网关只染色 + 换道）。
//
// 两件事住在这个模块：
//   1. Retry-After 染色：codex 拿到带该头的 429 会切换为"全额等到死线"模式
//      （`sleep_until`，不走 0.2s 起步的盲阶梯），所以网关不上游给的节律
//      原样移交；无头时按错误码补注。全部硬编码常数（2026-11-13 定案）：
//      Throttling.Concurrency → 2s（实锤：P0 观测 0.717s 后重试即成功）、
//      其余 → 20s、统一钳制 240s（< codex stream_idle_timeout 300s）。
//   2. (泳道, 模型) 熔断器：同一 base 模型在多泳道间互为备份；任一
//      (provider, model) 连续 2 次 429 → OPEN（冷却 90s 起步、探测失败
//      翻倍、封顶 240s），冷却到期 HALF-OPEN 试水，路由层跳过 OPEN-in-
//      cooldown 的候选（全堵则照走 primary 收真实 429，零合成错误）。
//      只计 429（mid-stream 断流不计数）；成功即清零/闭环。状态在进程
//      内存——网关重启清零，两发 429 即可重新学出，可接受。

// ── Retry-After 染色 ─────────────────────────────────────────────────────

// 唯一时间常数族：codex stream_idle_timeout 300s − 余量。
export const RETRY_AFTER_CEILING_SEC = 240;
// Throttling.Concurrency（实测码）：并发瞬时饱和，秒级即恢复。
const RETRY_AFTER_CONCURRENCY_SEC = 2;
// 其余 429 的缺省礼貌下限（用户定案 20s，不做成配置）。
const RETRY_AFTER_FALLBACK_SEC = 20;

export function injectedRetryAfterSec(err: UpstreamError): number | null {
  // 上游最懂自己：verbatim 值优先（parseRetryAfterSec 已在源头钳到 240）。
  if (err.retryAfterSec !== undefined && err.retryAfterSec > 0) {
    return Math.min(err.retryAfterSec, RETRY_AFTER_CEILING_SEC);
  }
  if (err.status !== 429) return null;
  if (err.bodySnippet?.includes("Throttling.Concurrency")) {
    return RETRY_AFTER_CONCURRENCY_SEC;
  }
  return RETRY_AFTER_FALLBACK_SEC;
}

// ── 熔断器 ────────────────────────────────────────────────────────────────

export const CONSECUTIVE_429_THRESHOLD = 2;
export const BASE_COOLDOWN_MS = 90_000;
export const MAX_COOLDOWN_MS = 240_000;

interface LaneState {
  consecutive429: number;
  openedAt: number | null;
  cooldownMs: number;
}

const laneStates = new Map<string, LaneState>();

function stateOf(providerId: string, modelId: string): LaneState {
  const key = `${providerId}:${modelId}`;
  let s = laneStates.get(key);
  if (!s) {
    s = { consecutive429: 0, openedAt: null, cooldownMs: BASE_COOLDOWN_MS };
    laneStates.set(key, s);
  }
  return s;
}

// 该 (泳道, 模型) 当前是否应被路由层跳过。OPEN-in-cooldown 期间为 true；
// 冷却到期（HALF-OPEN）即放行——放行后的第一发请求就是试水探测。
export function isLaneOpen(providerId: string, modelId: string, now = Date.now()): boolean {
  const s = stateOf(providerId, modelId);
  if (s.openedAt === null) return false;
  return now < s.openedAt + s.cooldownMs;
}

// 一发 429。触发阈值 → OPEN（冷却按基数起步）；试水失败 → 重新 OPEN 且冷却翻倍。
export function recordLane429(
  providerId: string,
  modelId: string,
  now = Date.now()
): void {
  const s = stateOf(providerId, modelId);
  s.consecutive429++;
  if (s.openedAt !== null || s.consecutive429 >= CONSECUTIVE_429_THRESHOLD) {
    // 重复 OPEN（试水失败）→ 翻倍；首次 OPEN → 基数。
    if (s.openedAt !== null) {
      s.cooldownMs = Math.min(s.cooldownMs * 2, MAX_COOLDOWN_MS);
    } else {
      s.cooldownMs = Math.min(
        s.cooldownMs * 2 ** Math.max(0, s.consecutive429 - CONSECUTIVE_429_THRESHOLD),
        MAX_COOLDOWN_MS
      );
    }
    s.openedAt = now;
  }
}

// 一次成功（2xx 响应到达）：清零计数、闭环熔断、冷却回基数。
export function recordLaneSuccess(providerId: string, modelId: string): void {
  laneStates.delete(`${providerId}:${modelId}`);
}

// 路由辅助：候选里第一个未被熔断挡住的；全挡则返回 null（调用方照走 primary）。
export interface RouteCandidate<T> {
  lane: T;
  providerId: string;
  modelId: string;
}
export function firstOpenLane<T>(
  candidates: readonly RouteCandidate<T>[],
  now: number = Date.now()
): T | null {
  for (const c of candidates) {
    if (!isLaneOpen(c.providerId, c.modelId, now)) return c.lane;
  }
  return null;
}

// melt-test support
export function resetBreaker(): void {
  laneStates.clear();
}

export function breakerSnapshot(): ReadonlyMap<string, LaneState> {
  return laneStates;
}
