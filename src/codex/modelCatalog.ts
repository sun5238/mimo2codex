import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDataDir } from "../db/dataDir.js";
import { locateProvidersFile } from "../providers/genericLoader.js";
import type { Provider } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Codex-side model catalog (`model_catalog_url`).
//
// codex-catalog.json is a complete Codex ModelsResponse keyed by bare model
// ids, usable as model_catalog_json. The gateway validates it against the
// active providers and expands each model into provider-qualified instances
// for model_catalog_url, changing only slug and display_name.

// Metadata file resolution order:
//   1. $MIMO2CODEX_CODEX_CATALOG — explicit override
//   2. `codexCatalog` root key in providers.json (path relative to dataDir)
//   3. <dataDir>/codex-catalog.json — default
export function resolveCodexCatalogPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  const explicit = env.MIMO2CODEX_CODEX_CATALOG;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`codex catalog ${explicit}: explicitly configured file does not exist`);
    }
    return explicit;
  }
  // config.ts blanks cfg.dataDir when admin is disabled (no sqlite → no DB
  // dir needed), but the catalog file still lives there. Re-resolve through
  // the same layers the CLI uses (cli flag > env > pointer > ~/.mimo2codex)
  // so --no-admin doesn't silently relocate the codex-catalog lookup to the
  // process CWD.
  const dir = dataDir || resolveDataDir(undefined, env);
  const located = locateProvidersFile(env, dir);
  if (located?.exists) {
    let root: { codexCatalog?: unknown };
    try {
      root = JSON.parse(readFileSync(located.path, "utf-8")) as { codexCatalog?: unknown };
    } catch (err) {
      throw new Error(`codex catalog: cannot read ${located.path}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (typeof root.codexCatalog === "string" && root.codexCatalog.trim()) {
      const catalogPath = join(dir, root.codexCatalog);
      if (!existsSync(catalogPath)) {
        throw new Error(`codex catalog ${catalogPath}: explicitly configured file does not exist`);
      }
      return catalogPath;
    }
  }
  return join(dir, "codex-catalog.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Update alongside codex-rs/protocol/src/openai_models.rs when Codex changes.
// Optional fields stay absent when not configured: Codex owns their defaults.
const REQUIRED_MODEL_INFO_FIELDS: ReadonlyArray<[string, (value: unknown) => boolean]> = [
  ["slug", (value) => typeof value === "string" && value.trim().length > 0],
  ["display_name", (value) => typeof value === "string" && value.trim().length > 0],
  ["supported_reasoning_levels", (value) => Array.isArray(value) && value.every(
    (item) => isRecord(item) && typeof item.effort === "string" && typeof item.description === "string"
  )],
  ["shell_type", (value) => typeof value === "string"],
  ["visibility", (value) => typeof value === "string"],
  ["supported_in_api", (value) => typeof value === "boolean"],
  ["priority", (value) => typeof value === "number" && Number.isInteger(value)],
  ["support_verbosity", (value) => typeof value === "boolean"],
  ["truncation_policy", (value) => isRecord(value)
    && (value.mode === "tokens" || value.mode === "bytes")
    && typeof value.limit === "number" && Number.isInteger(value.limit)],
  ["experimental_supported_tools", (value) => Array.isArray(value)
    && value.every((tool) => typeof tool === "string")],
];

function validateModelInfo(model: Record<string, unknown>, catalogPath: string): void {
  const slug = typeof model.slug === "string" ? model.slug : "<unknown>";
  for (const [field, valid] of REQUIRED_MODEL_INFO_FIELDS) {
    if (!valid(model[field])) {
      throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} requires a valid ${field}`);
    }
  }
  const template = isRecord(model.model_messages) && model.model_messages.instructions_template;
  if (typeof template !== "string" && typeof model.base_instructions !== "string") {
    throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} requires base_instructions or model_messages.instructions_template`);
  }
  for (const field of ["context_window", "max_context_window", "auto_compact_token_limit"]) {
    const value = model[field];
    if (value != null && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} requires a nonnegative ${field}`);
    }
  }
  const percent = model.effective_context_window_percent;
  if (percent !== undefined && (!Number.isSafeInteger(percent) || (percent as number) < 1 || (percent as number) > 100)) {
    throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} requires effective_context_window_percent between 1 and 100`);
  }
}

export interface BuiltCatalog {
  body: string;
  etag: string;
}

// Boot-time snapshot (P3): the providers list and the metadata file both
// finalize at startup (no hot reload — documented invariant), so the catalog
// body + ETag are computed ONCE and served from memory. `warmCodexModelCatalog`
// is called from cli.ts after buildConfig; requests fall back to lazy warm on
// the first hit (tests, embedders).
let snapshot: BuiltCatalog | null = null;

export function warmCodexModelCatalog(
  providers: readonly Provider[],
  catalogPath: string
): BuiltCatalog {
  snapshot = buildCodexModelCatalog(providers, catalogPath);
  return snapshot;
}

export function getCodexModelCatalog(
  providers: readonly Provider[],
  catalogPath: string
): BuiltCatalog {
  return snapshot ?? warmCodexModelCatalog(providers, catalogPath);
}

export function buildCodexModelCatalog(
  providers: readonly Provider[],
  catalogPath: string
): BuiltCatalog {
  let body: string;
  try {
    body = readFileSync(catalogPath, "utf-8");
  } catch (err) {
    throw new Error(`codex catalog ${catalogPath}: cannot read file: ${(err as Error).message}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (err) {
    throw new Error(`codex catalog ${catalogPath}: invalid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error(`codex catalog ${catalogPath}: required field "models" must be a nonempty array`);
  }

  const expected = new Map<string, Set<number>>();
  for (const provider of providers) {
    for (const model of provider.builtinModels ?? []) {
      const windows = expected.get(model.id) ?? new Set<number>();
      if (model.contextWindow !== undefined) windows.add(model.contextWindow);
      expected.set(model.id, windows);
    }
  }
  const byBaseId = new Map<string, Record<string, unknown>>();
  for (const model of parsed.models) {
    if (!isRecord(model)) {
      throw new Error(`codex catalog ${catalogPath}: each model must be an object`);
    }
    validateModelInfo(model, catalogPath);
    const slug = model.slug as string;
    if (byBaseId.has(slug)) {
      throw new Error(`codex catalog ${catalogPath}: duplicate model slug ${JSON.stringify(slug)}`);
    }
    if (!expected.has(slug)) {
      throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} is not declared by an active provider`);
    }
    if (model.display_name !== slug) {
      throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} must use its slug as display_name`);
    }
    for (const contextWindow of expected.get(slug)!) {
      if (model.context_window !== contextWindow) {
        throw new Error(`codex catalog ${catalogPath}: model ${JSON.stringify(slug)} context_window must match every providers.json contextWindow (${contextWindow}); one base entry cannot represent different provider windows`);
      }
    }
    byBaseId.set(slug, model);
  }
  for (const slug of expected.keys()) {
    if (!byBaseId.has(slug)) {
      throw new Error(`codex catalog ${catalogPath}: missing model ${JSON.stringify(slug)} declared by an active provider`);
    }
  }

  const models = providers.flatMap((provider) =>
    (provider.builtinModels ?? []).map((model) => {
      const slug = `${model.id}@${provider.id}`;
      return { ...byBaseId.get(model.id)!, slug, display_name: slug };
    })
  );
  const responseBody = JSON.stringify({ ...parsed, models });
  const etag = `W/"${createHash("sha256").update(responseBody).digest("hex")}"`;
  return { body: responseBody, etag };
}
