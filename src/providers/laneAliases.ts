import type { Provider } from "./types.js";

// ---------------------------------------------------------------------------
// Lane-alias derivation (instance-slug scheme).
//
// Every declared model gets a synthetic alias `<model-id>@<provider-id>`, including
// single-lane and built-in models. The client-facing name only exists between
// client and gateway; the routing layer resolves it
// back to the bare upstream id via the existing alias mechanism
// (`upstreamModel = resolved.id` in selectProvider).
//
// - The provider id is the sole suffix and routing identity. No second lane
//   name needs to be configured or kept in sync.
// - Bare `<id>` remains routable by existing provider resolvers, but is not
//   advertised by the Codex model catalog.
// - models[] alias arrays are mutated in place at boot; this also includes
//   built-ins, so repeated calls must stay idempotent. Hand-written aliases
//   are preserved and existing derived aliases are not duplicated.
export function deriveLaneAliases(providers: readonly Provider[]): void {
  for (const p of providers) {
    if (!p.builtinModels) continue;
    for (const m of p.builtinModels) {
      const alias = `${m.id}@${p.id}`;
      if (m.aliases?.includes(alias)) continue;
      m.aliases = [...(m.aliases ?? []), alias];
    }
  }
}
