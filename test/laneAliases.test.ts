import { describe, expect, it } from "vitest";

import { deriveLaneAliases } from "../src/providers/laneAliases.js";
import { BUILTIN_PROVIDERS } from "../src/providers/registry.js";
import type { Provider, ProviderModel } from "../src/providers/types.js";

function makeProvider(
  id: string,
  models: Array<Partial<ProviderModel> & { id: string }>
): Provider {
  const builtinModels: ProviderModel[] = models.map((m) => ({
    displayName: m.displayName ?? m.id,
    ...m,
  }));
  return {
    id,
    shortcut: id,
    displayName: id,
    defaultBaseUrl: "http://upstream.example/v1",
    baseUrlEnv: `${id.toUpperCase()}_BASE_URL`,
    envKeys: [`${id.toUpperCase()}_API_KEY`] as const,
    defaultModel: models[0]?.id ?? "",
    builtinModels,
    resolveModel(clientModel: string) {
      for (const m of builtinModels) {
        if (m.id === clientModel) return m;
        if (m.aliases?.includes(clientModel)) return m;
      }
      return null;
    },
    detectFlags() {
      return {};
    },
    preprocessResponses(req: unknown) {
      return req as never;
    },
    preprocessChat(req: unknown) {
      return req as never;
    },
    enhanceError() {
      return null;
    },
  } as unknown as Provider;
}

describe("deriveLaneAliases", () => {
  it("adds `<model-id>@<provider-id>` aliases to models declared by 2+ providers", () => {
    const alphaLane = makeProvider("primary", [{ id: "shared-model" }]);
    const betaLane = makeProvider("beta", [{ id: "shared-model" }]);
    deriveLaneAliases([alphaLane, betaLane]);

    expect(alphaLane.resolveModel("shared-model@primary")?.id).toBe("shared-model");
    expect(betaLane.resolveModel("shared-model@beta")?.id).toBe("shared-model");
    // Bare id still routes via each provider's own catalog (first registered
    // wins in byClientModel — that is selectProvider's concern).
    expect(alphaLane.resolveModel("shared-model")?.id).toBe("shared-model");
  });

  it("aliases single-lane models too", () => {
    const solo = makeProvider("primary", [{ id: "solo-model" }]);
    deriveLaneAliases([solo]);
    expect(solo.resolveModel("solo-model@primary")?.id).toBe("solo-model");
  });

  it("makes built-in lane aliases resolvable by their own providers", () => {
    const previous = BUILTIN_PROVIDERS.map((provider) =>
      provider.builtinModels.map((model) => model.aliases)
    );
    try {
      deriveLaneAliases(BUILTIN_PROVIDERS);
      for (const provider of BUILTIN_PROVIDERS) {
        for (const model of provider.builtinModels) {
          expect(provider.resolveModel(`${model.id}@${provider.id}`)?.id).toBe(model.id);
        }
      }
    } finally {
      BUILTIN_PROVIDERS.forEach((provider, providerIndex) => {
        provider.builtinModels.forEach((model, modelIndex) => {
          model.aliases = previous[providerIndex][modelIndex];
        });
      });
    }
  });

  it("uses the provider id as the only alias suffix", () => {
    const a = makeProvider("laneA", [{ id: "shared" }]);
    const b = makeProvider("laneB", [{ id: "shared" }]);
    deriveLaneAliases([a, b]);
    expect(a.resolveModel("shared@laneA")?.id).toBe("shared");
    expect(b.resolveModel("shared@laneB")?.id).toBe("shared");
  });

  it("preserves hand-written aliases and does not duplicate derived ones", () => {
    const a = makeProvider("primary", [
      { id: "shared-model", aliases: ["legacy-name"] },
    ]);
    deriveLaneAliases([a, makeProvider("beta", [{ id: "shared-model" }])]);
    expect(a.builtinModels[0].aliases).toEqual(["legacy-name", "shared-model@primary"]);
    // Idempotent re-run must not append a second copy.
    deriveLaneAliases([a]);
    expect(a.builtinModels[0].aliases?.filter((x) => x === "shared-model@primary")).toHaveLength(1);
  });

  it("skips open-catalog providers (empty models)", () => {
    const open = makeProvider("open", []);
    const b = makeProvider("b", [{ id: "shared" }]);
    deriveLaneAliases([open, b]);
    expect(open.builtinModels).toHaveLength(0);
    expect(b.resolveModel("shared@b")?.id).toBe("shared");
  });
});
