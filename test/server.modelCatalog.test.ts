import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { createGenericProvider } from "../src/providers/generic.js";
import { initRegistry } from "../src/providers/registry.js";
import { startServer } from "../src/server.js";

let server: Server | undefined;
const dirs: string[] = [];

function config(dataDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    exposeReasoning: true,
    verbose: false,
    userAgent: "mimo2codex/test",
    defaultProviderId: "test-provider",
    providers: {
      mimo: null,
      deepseek: null,
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "sk-test", flags: {} },
    },
    dataDir,
    adminEnabled: false,
  } as Config;
}

async function start(dataDir: string): Promise<string> {
  initRegistry([createGenericProvider({
    id: "test-provider",
    baseUrl: "https://example.test/v1",
    envKey: "TEST_PROVIDER_API_KEY",
    defaultModel: "m",
    models: [{ id: "m" }],
  })]);
  server = startServer(config(dataDir));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  initRegistry([]);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("GET /model_catalog", () => {
  it("returns 503 for an absent default catalog without disabling proxy health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m2c-no-catalog-"));
    dirs.push(dir);
    const url = await start(dir);

    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const response = await fetch(`${url}/model_catalog`);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("model_catalog_unavailable");
  });

  it("expands bare catalog slugs while preserving metadata and ETag/304", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m2c-catalog-http-"));
    dirs.push(dir);
    const body = JSON.stringify({ models: [{
      slug: "m",
      display_name: "m",
      supported_reasoning_levels: [],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 100,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [],
      model_messages: { instructions_template: "Test instructions" },
    }] });
    writeFileSync(join(dir, "codex-catalog.json"), body);
    const url = await start(dir);

    const response = await fetch(`${url}/model_catalog`);
    expect(response.status).toBe(200);
    const model = (await response.json()).models[0];
    const source = JSON.parse(body).models[0];
    expect(model.slug).toBe("m@test-provider");
    expect(model.display_name).toBe("m@test-provider");
    const { slug: _slug, display_name: _displayName, ...metadata } = model;
    const { slug: _baseSlug, display_name: _baseDisplayName, ...sourceMetadata } = source;
    expect(metadata).toEqual(sourceMetadata);
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
    const cached = await fetch(`${url}/model_catalog`, { headers: { "if-none-match": etag! } });
    expect(cached.status).toBe(304);
  });
});
