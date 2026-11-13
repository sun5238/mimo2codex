import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

// The JSON Schemas shipped in schemas/ are the editor-facing contract for the
// two user-editable config files. These tests keep them honest against real
// fixtures — a schema that drifts from the loader is worse than no schema.

const SCHEMAS_DIR = join(__dirname, "../schemas");

function loadValidator(schemaFile: string) {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, schemaFile), "utf-8"));
  const opts = { allErrors: true, strict: false, validateFormats: false };
  const ajv = schema.$schema?.includes("draft-07") ? new Ajv(opts) : new Ajv2020(opts);
  return { validate: ajv.compile(schema), errorsText: () => ajv.errorsText() };
}

describe("schemas/providers.schema.json", () => {
  it("accepts an editor schema reference and loader-compatible uppercase ids", () => {
    const { validate, errorsText } = loadValidator("providers.schema.json");
    const doc = {
      $schema: "../mimo2codex-fork/schemas/providers.schema.json",
      codexCatalog: "codex-catalog.json",
      providers: [{ id: "Qwen", baseUrl: "https://example.test/v1", envKey: "QWEN_KEY", defaultModel: "qwen" }],
    };
    expect(validate(doc), errorsText()).toBe(true);
  });

  it("accepts a realistic two-lane providers.json fixture", () => {
    const { validate, errorsText } = loadValidator("providers.schema.json");
    const doc = {
      codexCatalog: "codex-catalog.json",
      providers: [
        {
          id: "primary",
          shortcut: "primary",
          displayName: "Primary lane",
          baseUrl: "https://primary.example/v1",
          envKey: "PRIMARY_API_KEY",
          defaultModel: "solo-model",
          wireApi: "responses",
          docsUrl: "https://primary.example/docs",
          models: [
            { id: "solo-model", displayName: "Solo Model" },
            { id: "shared-model", contextWindow: 256000, maxOutputTokens: 16384, note: "needs approval" },
          ],
        },
        {
          id: "alpha",
          baseUrl: "http://alpha.example/v1",
          envKey: "ALPHA_API_KEY",
          defaultModel: "shared-model",
          wireApi: "chat",
          models: [{ id: "shared-model" }],
          features: { nonStreamingUpstream: true, extractThinkTags: true },
        },
      ],
    };
    expect(validate(doc), errorsText()).toBe(true);
  });

  it("rejects the removed lane field so provider id is the only alias suffix", () => {
    const { validate } = loadValidator("providers.schema.json");
    expect(validate({ providers: [{
      id: "anoe", lane: "ducky", baseUrl: "https://example.test/v1",
      envKey: "ANOE_API_KEY", defaultModel: "m",
    }] })).toBe(false);
  });

  it("rejects reserved ids, missing required fields, and bogus wireApi", () => {
    const { validate } = loadValidator("providers.schema.json");
    expect(validate({ providers: [] })).toBe(true);
    // reserved built-in id
    expect(
      validate({
        providers: [
          { id: "mimo", baseUrl: "http://x/v1", envKey: "K", defaultModel: "m" },
        ],
      })
    ).toBe(false);
    // missing baseUrl/envKey/defaultModel
    expect(validate({ providers: [{ id: "x" }] })).toBe(false);
    // bogus wireApi
    expect(
      validate({
        providers: [
          { id: "x", baseUrl: "http://x/v1", envKey: "K", defaultModel: "m", wireApi: "grpc" },
        ],
      })
    ).toBe(false);
    // nonStreamingUpstream lives under features, not top-level
    expect(
      validate({
        providers: [
          {
            id: "x",
            baseUrl: "http://x/v1",
            envKey: "K",
            defaultModel: "m",
            nonStreamingUpstream: true,
          },
        ],
      })
    ).toBe(false);
  });
});

describe("schemas/codex-catalog.schema.json", () => {
  function info(fields: Record<string, unknown> = {}) {
    return {
      slug: "shared-model",
      display_name: "shared-model",
      supported_reasoning_levels: [],
      shell_type: "unified_exec",
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

  it("accepts complete Codex ModelInfo entries with known and future optional fields", () => {
    const { validate, errorsText } = loadValidator("codex-catalog.schema.json");
    const doc = {
      $schema: "../schemas/codex-catalog.schema.json",
      models: [info({
        context_window: 256000,
        default_reasoning_level: "ultra",
        supported_reasoning_levels: [{ effort: "ultra", description: "Deep" }],
        input_modalities: ["text", "image", "audio"],
        some_future_codex_field: { nested: true },
      })],
    };
    expect(validate(doc), errorsText()).toBe(true);
  });

  it("accepts empty effort lists and future nonempty effort names", () => {
    const { validate, errorsText } = loadValidator("codex-catalog.schema.json");
    expect(validate({ models: [info(), info({
      slug: "another-model",
      display_name: "another-model",
      default_reasoning_level: "future-effort",
      supported_reasoning_levels: [{ effort: "future-effort", description: "Future" }],
    })] }), errorsText()).toBe(true);
  });

  it("rejects missing required fields or instructions and invalid optional values", () => {
    const { validate } = loadValidator("codex-catalog.schema.json");
    expect(validate({ families: {} })).toBe(false);
    expect(validate({ models: [info({ shell_type: undefined })] })).toBe(false);
    expect(validate({ models: [info({ model_messages: undefined })] })).toBe(false);
    expect(validate({ models: [info({ default_reasoning_level: "" })] })).toBe(false);
    expect(validate({ models: [info({ supported_reasoning_levels: [{ effort: "low" }] })] })).toBe(false);
    expect(validate({ models: [info({ context_window: -3 })] })).toBe(false);
  });

  it("includes the complete Codex ModelInfo schema and serde's shell alias", () => {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, "codex-catalog.schema.json"), "utf-8"));
    const model = schema.definitions.ModelInfo;
    expect(Object.keys(model.properties).length).toBeGreaterThan(40);
    expect(model.required).toContain("shell_type");
    expect(schema.definitions.ModelMessages).toBeDefined();
    expect(schema.definitions.ConfigShellToolType.enum).toContain("shell_command");
    const { validate, errorsText } = loadValidator("codex-catalog.schema.json");
    expect(validate({ models: [info({ shell_type: "shell_command" })] }), errorsText()).toBe(true);
  });
});
