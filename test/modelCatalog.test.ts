import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexModelCatalog,
  resolveCodexCatalogPath,
} from "../src/codex/modelCatalog.js";
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
    baseUrlEnv: "X_BASE_URL",
    envKeys: ["X_API_KEY"] as const,
    defaultModel: models[0]?.id ?? "",
    builtinModels,
    resolveModel(clientModel: string) {
      return builtinModels.find((m) => m.id === clientModel) ?? null;
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

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("resolveCodexCatalogPath", () => {
  it("falls back to resolveDataDir when dataDir is blank (admin disabled)", () => {
    // config.ts passes "" when --no-admin; the catalog must NOT relocate to CWD.
    const path = resolveCodexCatalogPath({}, "");
    expect(path.endsWith(join(".mimo2codex", "codex-catalog.json"))).toBe(true);
  });

  it("honors MIMO2CODEX_CODEX_CATALOG over everything", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-catalog-path-"));
    tmpDirs.push(dataDir);
    const path = join(dataDir, "custom.json");
    writeFileSync(path, JSON.stringify({ models: [] }));
    expect(resolveCodexCatalogPath({ MIMO2CODEX_CODEX_CATALOG: path }, "")).toBe(
      path
    );
  });

  it("fails for a missing explicitly configured catalog", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-catalog-missing-"));
    tmpDirs.push(dataDir);
    const missing = join(dataDir, "missing.json");
    expect(() => resolveCodexCatalogPath({ MIMO2CODEX_CODEX_CATALOG: missing }, dataDir))
      .toThrow(/explicitly configured file does not exist/);
    writeFileSync(join(dataDir, "providers.json"), JSON.stringify({
      codexCatalog: "missing.json", providers: [],
    }));
    expect(() => resolveCodexCatalogPath({}, dataDir))
      .toThrow(/explicitly configured file does not exist/);
  });
});

describe("buildCodexModelCatalog", () => {
  function info(slug: string, fields: Record<string, unknown> = {}) {
    return {
      slug,
      display_name: slug,
      supported_reasoning_levels: [],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 100,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [],
      model_messages: { instructions_template: "Custom instructions" },
      ...fields,
    };
  }

  it("expands bare Codex models per provider and only changes slug/display_name", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-catalog-"));
    tmpDirs.push(dataDir);
    const path = join(dataDir, "codex-catalog.json");
    const catalog = JSON.stringify({
      $schema: "../schemas/codex-catalog.schema.json",
      models: [
        info("shared-model", { context_window: 256000, custom_codex_field: "future", description: "Custom description" }),
        info("other-model"),
      ],
    });
    writeFileSync(path, catalog);
    const alphaLane = makeProvider("primary", [{ id: "shared-model", displayName: "Ignored" }]);
    const betaLane = makeProvider("beta", [
      { id: "shared-model" },
      { id: "other-model" },
    ]);
    const { body, etag } = buildCodexModelCatalog([alphaLane, betaLane], path);
    const source = JSON.parse(catalog);
    const response = JSON.parse(body);
    expect(response.$schema).toBe(source.$schema);
    expect(response.models.map((m: { slug: string }) => m.slug)).toEqual([
      "shared-model@primary", "shared-model@beta", "other-model@beta",
    ]);
    for (const model of response.models) {
      const base = model.slug.slice(0, model.slug.lastIndexOf("@"));
      const original = source.models.find((m: { slug: string }) => m.slug === base);
      const { slug: _slug, display_name: _displayName, ...metadata } = model;
      const { slug: _baseSlug, display_name: _baseDisplayName, ...sourceMetadata } = original;
      expect(model.display_name).toBe(model.slug);
      expect(metadata).toEqual(sourceMetadata);
    }
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
  });

  it("requires a catalog file and never supplies missing ModelInfo defaults", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-empty-"));
    tmpDirs.push(dataDir);
    const solo = makeProvider("p", [{ id: "m1", displayName: "Friendly Solo" }]);
    const path = join(dataDir, "codex-catalog.json");
    const build = () => buildCodexModelCatalog([solo], path);
    expect(build).toThrow(/cannot read file/);
    writeFileSync(path, JSON.stringify({ models: [{ slug: "m1", display_name: "m1" }] }));
    expect(build).toThrow(/model "m1" requires a valid supported_reasoning_levels/);
  });

  it("leaves Codex-owned optional defaults absent and accepts either instruction field", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-partial-"));
    tmpDirs.push(dataDir);
    const catalogPath = join(dataDir, "codex-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [info("m1", {
      model_messages: undefined,
      base_instructions: "Legacy instructions",
    })] }));
    const { body } = buildCodexModelCatalog([makeProvider("p", [{ id: "m1" }])], catalogPath);
    const model = JSON.parse(body).models[0];
    expect(model.slug).toBe("m1@p");
    expect(model).not.toHaveProperty("context_window");
    expect(model).not.toHaveProperty("default_reasoning_level");
    expect(model).not.toHaveProperty("effective_context_window_percent");
    expect(model).not.toHaveProperty("input_modalities");
  });

  it("rejects invalid existing metadata instead of silently using defaults", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-invalid-"));
    tmpDirs.push(dataDir);
    const catalogPath = join(dataDir, "codex-catalog.json");
    const build = () => buildCodexModelCatalog([makeProvider("p", [{ id: "m1" }])], catalogPath);

    writeFileSync(catalogPath, "{broken");
    expect(build).toThrow(/invalid JSON/);
    writeFileSync(catalogPath, JSON.stringify({}));
    expect(build).toThrow(/required field "models"/);
    writeFileSync(catalogPath, JSON.stringify({ models: [] }));
    expect(build).toThrow(/required field "models"/);
  });

  it("names the model and required field when a ModelInfo is invalid", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-required-"));
    tmpDirs.push(dataDir);
    const catalogPath = join(dataDir, "codex-catalog.json");
    const build = () => buildCodexModelCatalog([makeProvider("p", [{ id: "m1" }])], catalogPath);

    writeFileSync(catalogPath, JSON.stringify({ models: [info("m1", { shell_type: null })] }));
    expect(build).toThrow(/model "m1" requires a valid shell_type/);
    writeFileSync(catalogPath, JSON.stringify({ models: [info("m1", { supported_reasoning_levels: [{}] })] }));
    expect(build).toThrow(/model "m1" requires a valid supported_reasoning_levels/);
    writeFileSync(catalogPath, JSON.stringify({ models: [info("m1", { truncation_policy: { mode: "tokens" } })] }));
    expect(build).toThrow(/model "m1" requires a valid truncation_policy/);
    writeFileSync(catalogPath, JSON.stringify({ models: [info("m1", { model_messages: null })] }));
    expect(build).toThrow(/model "m1" requires base_instructions or model_messages.instructions_template/);
    writeFileSync(catalogPath, JSON.stringify({ models: [info("m1", { context_window: -3 })] }));
    expect(build).toThrow(/model "m1" requires a nonnegative context_window/);
  });

  it("requires every active provider model exactly once and never rewrites catalog fields", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m2c-inventory-"));
    tmpDirs.push(dataDir);
    const path = join(dataDir, "codex-catalog.json");
    const provider = makeProvider("p", [{ id: "m1", contextWindow: 180000 }, { id: "m2" }]);
    const build = () => buildCodexModelCatalog([provider], path);

    writeFileSync(path, JSON.stringify({ models: [info("m1", { context_window: 180000 })] }));
    expect(build).toThrow(/missing model "m2"/);
    writeFileSync(path, JSON.stringify({ models: [info("m1"), info("m2")] }));
    expect(build).toThrow(/context_window must match every providers.json contextWindow/);
    writeFileSync(path, JSON.stringify({ models: [
      info("m1", { context_window: 180000 }), info("m2"), info("m2"),
    ] }));
    expect(build).toThrow(/duplicate model slug "m2"/);
    writeFileSync(path, JSON.stringify({ models: [
      info("m1", { context_window: 180000 }), info("m2", { display_name: "Other" }),
    ] }));
    expect(build).toThrow(/must use its slug as display_name/);
    writeFileSync(path, JSON.stringify({ models: [
      info("m1", { context_window: 180000 }), info("m2"), info("ghost"),
    ] }));
    expect(build).toThrow(/not declared by an active provider/);
  });

  it("rejects conflicting provider windows for a shared base model", () => {
    const dir = mkdtempSync(join(tmpdir(), "m2c-windows-"));
    tmpDirs.push(dir);
    const path = join(dir, "codex-catalog.json");
    writeFileSync(path, JSON.stringify({ models: [info("shared", { context_window: 180000 })] }));
    expect(() => buildCodexModelCatalog([
      makeProvider("a", [{ id: "shared", contextWindow: 180000 }]),
      makeProvider("b", [{ id: "shared", contextWindow: 256000 }]),
    ], path)).toThrow(/one base entry cannot represent different provider windows/);
  });
});
