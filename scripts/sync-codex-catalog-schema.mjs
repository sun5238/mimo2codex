#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const codexRepo = process.argv[2] || process.env.CODEX_REPO;
if (!codexRepo) {
  console.error("Usage: CODEX_REPO=/path/to/codex npm run schema:codex-catalog");
  process.exit(2);
}
const protocolDir = resolve(codexRepo, "codex-rs/protocol");
if (!existsSync(join(protocolDir, "Cargo.toml"))) {
  console.error(`Codex protocol crate not found at ${protocolDir}`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "mimo2codex-schema-"));
try {
  mkdirSync(join(scratch, "src"));
  copyFileSync(join(codexRepo, "codex-rs/Cargo.lock"), join(scratch, "Cargo.lock"));
  writeFileSync(join(scratch, "Cargo.toml"), `[package]
name = "mimo2codex-schema-sync"
version = "0.0.0"
edition = "2021"

[dependencies]
codex-protocol = { path = ${JSON.stringify(protocolDir)} }
schemars = "0.8.22"
serde_json = "1"
`);
  writeFileSync(join(scratch, "src/main.rs"), `fn main() {
    let schema = schemars::schema_for!(codex_protocol::openai_models::ModelsResponse);
    println!("{}", serde_json::to_string(&schema).expect("serialize Codex schema"));
}
`);
  const result = spawnSync("cargo", [
    "run", "--offline", "--quiet", "--manifest-path", join(scratch, "Cargo.toml"),
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exitCode = result.status || 1;
  } else {
    const schema = JSON.parse(result.stdout);
    const model = schema.definitions?.ModelInfo ?? schema.$defs?.ModelInfo;
    const shellType = schema.definitions?.ConfigShellToolType ?? schema.$defs?.ConfigShellToolType;
    if (!model?.properties || !schema.properties?.models || !shellType?.enum?.includes("unified_exec")) {
      throw new Error("Codex ModelsResponse schema changed; inspect its generated shape before syncing");
    }

    // Serde's custom ModelsResponse decoder requires an instruction template,
    // but schemars only sees ModelInfo's individually optional fields.
    model.allOf = [...(model.allOf ?? []), { anyOf: [
      { required: ["base_instructions"], properties: { base_instructions: { type: "string" } } },
      { required: ["model_messages"], properties: { model_messages: {
        type: "object", required: ["instructions_template"],
        properties: { instructions_template: { type: "string" } },
      } } },
    ] }];
    model.properties.base_instructions = { type: "string", description: "Legacy alternative to model_messages.instructions_template." };
    model.properties.slug.description = "Bare model id in this file; the gateway adds @provider.id only in its remote response.";
    model.properties.display_name.description = "Use the same bare name as slug; the gateway rewrites both fields together.";
    // Codex's i64 deserializer accepts negatives, but negative token windows
    // cannot be used for context accounting or gateway-side compaction.
    for (const field of ["context_window", "max_context_window", "auto_compact_token_limit"]) {
      if (!model.properties[field]) throw new Error(`Codex schema no longer defines ${field}`);
      model.properties[field].minimum = 0;
    }
    if (!model.properties.effective_context_window_percent) {
      throw new Error("Codex schema no longer defines effective_context_window_percent");
    }
    model.properties.effective_context_window_percent.minimum = 1;
    model.properties.effective_context_window_percent.maximum = 100;
    // schemars omits serde aliases, which are valid inputs to Codex's decoder.
    shellType.enum = [...shellType.enum, "default", "local", "shell_command"];
    schema.properties.models.minItems = 1;
    schema.properties.$schema = { type: "string" };
    schema.$id = "https://mimo2codex.dev/schemas/codex-catalog.schema.json";
    schema.description = "Generated from Codex ModelsResponse/ModelInfo. One bare model per base id; the gateway expands provider aliases on the wire. Gateway annotations cover the custom instruction requirement, serde shell_type aliases and nonnegative context windows.";

    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const output = join(root, "schemas/codex-catalog.schema.json");
    writeFileSync(output, JSON.stringify(schema, null, 2) + "\n");
    console.log(`Generated ${output} from ${protocolDir}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
