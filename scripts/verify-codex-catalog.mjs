#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildCodexModelCatalog, resolveCodexCatalogPath } from "../dist/codex/modelCatalog.js";
import { resolveDataDir } from "../dist/db/dataDir.js";
import { loadGenericProviders } from "../dist/providers/genericLoader.js";

const codexRepo = process.argv[2] || process.env.CODEX_REPO;
if (!codexRepo) {
  console.error("Usage: CODEX_REPO=/path/to/codex npm run verify:codex-catalog");
  process.exit(2);
}
const protocolDir = resolve(codexRepo, "codex-rs/protocol");
if (!existsSync(join(protocolDir, "Cargo.toml"))) {
  console.error(`Codex protocol crate not found at ${protocolDir}`);
  process.exit(2);
}

const dataDir = resolveDataDir(undefined, process.env);
const providers = loadGenericProviders(process.env, dataDir);
if (!providers.some((provider) => provider.builtinModels.length > 0)) {
  console.error(`No declared generic models found in ${dataDir}/providers.json`);
  process.exit(2);
}
const sourcePath = resolveCodexCatalogPath(process.env, dataDir);
const { body } = buildCodexModelCatalog(providers, sourcePath);

// Validate both the static file and the provider-qualified wire response with
// the target Codex checkout's actual serde implementation.
const scratch = mkdtempSync(join(tmpdir(), "mimo2codex-catalog-check-"));
try {
  mkdirSync(join(scratch, "src"));
  copyFileSync(join(codexRepo, "codex-rs/Cargo.lock"), join(scratch, "Cargo.lock"));
  writeFileSync(join(scratch, "Cargo.toml"), `[package]
name = "mimo2codex-catalog-check"
version = "0.0.0"
edition = "2021"

[dependencies]
codex-protocol = { path = ${JSON.stringify(protocolDir)} }
serde_json = "1"
`);
  writeFileSync(join(scratch, "src/main.rs"), `fn main() {
    let path = std::env::args().nth(1).expect("catalog path");
    let body = std::fs::read_to_string(path).expect("read catalog");
    let parsed: codex_protocol::openai_models::ModelsResponse =
        serde_json::from_str(&body).expect("Codex cannot decode gateway model catalog");
    println!("Codex decoded {} models", parsed.models.len());
}
`);
  const catalog = join(scratch, "catalog.json");
  writeFileSync(catalog, body);
  for (const [name, path] of [["static", sourcePath], ["remote", catalog]]) {
    console.log(`Checking ${name} Codex model catalog`);
    const result = spawnSync("cargo", [
      "run", "--offline", "--quiet", "--manifest-path", join(scratch, "Cargo.toml"), "--", path,
    ], { stdio: "inherit", env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      break;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
