/**
 * P0-4 — `/permission` mode switch must not detach the prompt handler.
 * P0-5 — `/model provider/model` must re-resolve endpoint + key.
 *
 * Both are hot-swap state bugs: the old code rebuilt the PermissionChecker
 * without `promptHandler` (shell/edit prompts then read stdin inside the TUI
 * alt-screen) and rebuilt the cross-provider client with the endpoint/key of
 * the provider being LEFT (anthropic/… POSTed to api.openai.com).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";
import { resolveSwapConnection, createClientRuntime } from "../dist/agent/provider-runtime.js";
import { BUILTIN_PROVIDERS } from "../dist/llm/provider-registry.js";

let workdir;
const savedEnv = {};

function env(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "swap-"));
  mkdirSync(join(workdir, ".scoder"), { recursive: true });
  process.env.SCODER_CONFIG = join(workdir, "rc.json");
  writeFileSync(process.env.SCODER_CONFIG, JSON.stringify({}));
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  delete process.env.SCODER_CONFIG;
  rmSync(workdir, { recursive: true, force: true });
});

function baseConfig(extra = {}) {
  return {
    workdir,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-current",
    model: "gpt-4o",
    maxSteps: 2,
    permissionMode: "auto",
    noSave: true,
    snapshots: false,
    ...extra,
  };
}

describe("P0-4 setPermissionMode keeps the checker wired", () => {
  it("promptHandler survives the switch", () => {
    const a = new Agent(baseConfig());
    assert.ok(a.permissions.promptHandler, "handler present at startup");
    a.setPermissionMode("ask");
    assert.ok(a.permissions.promptHandler, "handler must survive /permission");
  });

  it("ctx.permissions is the SAME instance the agent uses", () => {
    const a = new Agent(baseConfig());
    a.setPermissionMode("ask");
    assert.equal(a.ctx.permissions, a.permissions, "tool layer must not hold a stale checker");
    assert.equal(a.ctx.permissionMode, "ask");
  });

  it("the live checker really evaluates the new mode", async () => {
    const a = new Agent(baseConfig());
    assert.equal(a.permissions.classify("echo hi").decision, "allow", "auto mode at startup");
    a.setPermissionMode("ask");
    assert.equal(a.permissions.mode, "ask");
    assert.equal(a.ctx.permissions.classify("echo hi").decision, "ask", "ctx must see the new mode");
    // The prompt goes through the handler (never stdin/readline in alt-screen).
    const seen = [];
    a.permissions.promptHandler = (req) => {
      seen.push(req.kind);
      return Promise.resolve("no");
    };
    assert.equal(await a.permissions.confirm("echo hi"), false);
    assert.deepEqual(seen, ["shell"]);
  });

  it("readonly mode reaches the tool layer through ctx", () => {
    const a = new Agent(baseConfig());
    a.setPermissionMode("readonly");
    assert.equal(a.ctx.permissions.mode, "readonly");
    assert.equal(a.ctx.permissions.classify("npm test").decision, "deny");
  });

  it("same-mode call is a no-op (session approvals are kept)", () => {
    const a = new Agent(baseConfig({ permissionMode: "ask" }));
    const before = a.permissions;
    a.setPermissionMode("ask");
    assert.equal(a.permissions, before, "no needless rebuild");
  });
});

describe("P0-5 resolveSwapConnection", () => {
  it("the target provider endpoint wins over the outgoing baseUrl", () => {
    const c = resolveSwapConnection(baseConfig(), BUILTIN_PROVIDERS.anthropic);
    assert.equal(c.baseUrl, "https://api.anthropic.com/v1");
    assert.equal(c.endpointFromDef, true);
  });

  it("an env-derived key is re-resolved against the new provider", () => {
    env({ ANTHROPIC_API_KEY: "sk-ant-new", SCODER_API_KEY: undefined, OPENAI_API_KEY: "sk-current" });
    const c = resolveSwapConnection(baseConfig({ apiKeySource: "env" }), BUILTIN_PROVIDERS.anthropic);
    assert.equal(c.apiKey, "sk-ant-new");
    assert.equal(c.keySource, "provider-env");
  });

  it("SCODER_API_KEY is the shared fallback", () => {
    env({ ANTHROPIC_API_KEY: undefined, SCODER_API_KEY: "sk-shared" });
    const c = resolveSwapConnection(baseConfig({ apiKeySource: "env" }), BUILTIN_PROVIDERS.anthropic);
    assert.equal(c.apiKey, "sk-shared");
    assert.equal(c.keySource, "shared-env");
  });

  it("a pinned key (--api-key / rc apiKey) is never replaced", () => {
    env({ ANTHROPIC_API_KEY: "sk-ant-new", SCODER_API_KEY: undefined });
    for (const source of ["flag", "rc", undefined]) {
      const c = resolveSwapConnection(baseConfig({ apiKeySource: source }), BUILTIN_PROVIDERS.anthropic);
      assert.equal(c.apiKey, "sk-current", `source=${source}`);
      assert.equal(c.keySource, "pinned");
    }
  });

  it("an empty key still consults the provider env var", () => {
    env({ ANTHROPIC_API_KEY: "sk-ant-new", SCODER_API_KEY: undefined });
    const c = resolveSwapConnection(baseConfig({ apiKey: "", apiKeySource: "none" }), BUILTIN_PROVIDERS.anthropic);
    assert.equal(c.apiKey, "sk-ant-new");
  });

  it("a provider without an endpoint (openai-compatible) keeps the current baseUrl", () => {
    const def = { ...BUILTIN_PROVIDERS["openai-compatible"], id: "openai-compatible" };
    const c = resolveSwapConnection(baseConfig({ baseUrl: "http://127.0.0.1:1234/v1" }), def);
    assert.equal(c.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(c.endpointFromDef, false);
  });
});

describe("P0-5 Agent.setModel cross-provider", () => {
  it("rebuilds against the target endpoint, not the outgoing one", () => {
    env({ ANTHROPIC_API_KEY: undefined, SCODER_API_KEY: undefined });
    const a = new Agent(baseConfig({ apiKeySource: "flag" }));
    const notice = a.setModel("anthropic/claude-sonnet-4-5");
    assert.doesNotMatch(notice, /^ERROR/);
    assert.equal(a.config.provider, "anthropic");
    assert.equal(a.config.model, "claude-sonnet-4-5");
    // The bug: config.baseUrl stayed https://api.openai.com/v1 and the
    // Anthropic client then POSTed /messages there.
    assert.equal(a.config.baseUrl, "https://api.anthropic.com/v1");
    assert.match(notice, /api\.anthropic\.com/);
    assert.equal(a.config.apiKey, "sk-current", "flag-pinned key is kept");
  });

  it("custom rc providers win over built-in endpoints", () => {
    writeFileSync(
      process.env.SCODER_CONFIG,
      JSON.stringify({ providers: { anthropic: { baseUrl: "https://proxy.example/v1", apiKeyEnv: "ANTHROPIC_API_KEY", kind: "anthropic" } } }),
    );
    env({ ANTHROPIC_API_KEY: "sk-ant-new", SCODER_API_KEY: undefined });
    const a = new Agent(baseConfig({ apiKeySource: "env", apiKey: "sk-old" }));
    a.setModel("anthropic/claude-sonnet-4-5");
    assert.equal(a.config.baseUrl, "https://proxy.example/v1");
    assert.equal(a.config.apiKey, "sk-ant-new");
  });

  it("a provider id that is not openai/anthropic maps to the openai kind", () => {
    writeFileSync(
      process.env.SCODER_CONFIG,
      JSON.stringify({ providers: { groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" } } }),
    );
    const a = new Agent(baseConfig());
    a.setModel("groq/llama-3.3-70b");
    assert.equal(a.config.provider, "openai");
    assert.equal(a.config.baseUrl, "https://api.groq.com/openai/v1");
  });

  it("the swapped client sends requests to the new endpoint", async () => {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return new Response(
        JSON.stringify({ id: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      env({ ANTHROPIC_API_KEY: "sk-ant-new", SCODER_API_KEY: undefined });
      const a = new Agent(baseConfig({ apiKeySource: "env" }));
      a.setModel("anthropic/claude-sonnet-4-5");
      await a.client.chat([{ role: "user", content: "hi" }], []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
      assert.equal(calls[0].headers["x-api-key"], "sk-ant-new");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reasoning survives the swap (thinking budget is rebuilt)", () => {
    const a = new Agent(baseConfig({ reasoning: "on" }));
    a.setModel("anthropic/claude-sonnet-4-5");
    assert.equal(a.config.reasoning, "on");
    assert.ok(a.client instanceof Object);
  });

  it("construction and swap share one builder (openai → its own runtime)", () => {
    const client = createClientRuntime(baseConfig({ clientFactory: undefined }));
    assert.equal(typeof client.chat, "function");
    assert.equal(client.model, "gpt-4o");
  });
});
