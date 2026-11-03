/**
 * Unit tests cho provider registry (I-01).
 * Chạy: node --test test/provider-registry.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PROVIDERS,
  createRuntime,
  parseCustomProviders,
  resolveProvider,
  splitProviderModel,
} from "../dist/provider-registry.js";
import { LlmClient } from "../dist/llm.js";
import { AnthropicClient } from "../dist/provider-anthropic.js";

describe("splitProviderModel", () => {
  it("provider/model → [provider, model]", () => {
    assert.deepEqual(splitProviderModel("anthropic/claude-sonnet-4-5"), ["anthropic", "claude-sonnet-4-5"]);
    assert.deepEqual(splitProviderModel("groq/llama-3"), ["groq", "llama-3"]);
  });
  it("plain model → [null, model]", () => {
    assert.deepEqual(splitProviderModel("gpt-4o-mini"), [null, "gpt-4o-mini"]);
  });
  it("empty → [null, '']", () => {
    assert.deepEqual(splitProviderModel(""), [null, ""]);
  });
  it("leading slash → unchanged", () => {
    assert.deepEqual(splitProviderModel("/weird"), [null, "/weird"]);
  });
});

describe("resolveProvider", () => {
  it("builtin ids resolve", () => {
    for (const id of ["openai", "anthropic", "ollama", "gemini", "openai-compatible"]) {
      const r = resolveProvider(id);
      assert.ok("def" in r, id);
    }
  });
  it("anthropic has cache+reasoning flags", () => {
    const r = resolveProvider("anthropic");
    assert.ok("def" in r && r.def.supportCache === true && r.def.supportReasoning === true);
  });
  it("unknown → clean error listing available", () => {
    const r = resolveProvider("nope");
    assert.ok("error" in r);
    assert.match(r.error, /available: openai, anthropic/);
  });
  it("custom providers take precedence over builtins", () => {
    const custom = parseCustomProviders({ openai: { baseUrl: "https://my-proxy.io/v1", apiKeyEnv: "MY_KEY" } });
    const r = resolveProvider("openai", custom);
    assert.ok("def" in r);
    assert.equal(r.def.baseUrl, "https://my-proxy.io/v1");
    assert.equal(r.def.apiKeyEnv, "MY_KEY");
  });
});

describe("parseCustomProviders", () => {
  it("valid entries parsed", () => {
    const out = parseCustomProviders({
      deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", kind: "openai" },
    });
    assert.equal(out.deepseek.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(out.deepseek.kind, "openai");
  });
  it("missing baseUrl dropped", () => {
    const out = parseCustomProviders({ bad: { apiKeyEnv: "X" } });
    assert.deepEqual(out, {});
  });
  it("non-object → empty", () => {
    assert.deepEqual(parseCustomProviders("x"), {});
    assert.deepEqual(parseCustomProviders(42), {});
  });
});

describe("createRuntime", () => {
  const opts = { baseUrl: "", apiKey: "k", model: "m", maxTokens: 100, temperature: 0.1 };
  it("anthropic kind → AnthropicClient", () => {
    const r = createRuntime(BUILTIN_PROVIDERS.anthropic, opts);
    assert.ok(r instanceof AnthropicClient);
    assert.equal(r.model, "m");
  });
  it("openai kind → LlmClient", () => {
    const r = createRuntime(BUILTIN_PROVIDERS.openai, opts);
    assert.ok(r instanceof LlmClient);
  });
  it("empty baseUrl falls back to def.baseUrl", () => {
    const r = createRuntime(BUILTIN_PROVIDERS.ollama, opts);
    assert.ok(r); // constructed without throwing
  });
});
