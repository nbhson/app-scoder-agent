/**
 * P2.1 (plan/P2-01-provider-config.md) — parser `provider` block kiểu opencode,
 * findModelOwner, resolveModelRef, npm→kind map, {env:} expand, chống entry hỏng.
 * Chạy: npm run build && node --test test/provider-config.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_PROVIDERS,
  parseProviderConfig,
  parseCustomProviders,
  findModelOwner,
  findModelOwners,
  resolveModelRef,
  splitProviderModel,
  expandEnvValue,
} from "../dist/llm/provider-registry.js";

/** Capture console.error lines produced while fn runs. */
function captureWarnings(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

const BOX = {
  "box-api": {
    npm: "@ai-sdk/openai-compatible",
    name: "Box API",
    options: {
      baseURL: "https://api.ai-box.vn/v1",
      apiKey: "{env:BOX_TEST_KEY}",
    },
    models: {
      "kimi-k3": { name: "kimi-k3" },
      "kimi-k2.7-code": { name: "kimi-k2.7-code" },
      "glm-5.3": { name: "glm-5.3", reasoning: true },
      "qwen3.8-flash": { name: "qwen3.8-flash", limit: { context: 262144, output: 32768 }, cost: { input: 0.2, output: 0.8 } },
      "tiny-no-tools": { tool_call: false },
    },
  },
};

describe("parseProviderConfig (opencode block)", () => {
  it("parse full schema — baseURL, name, models, limit, cost, flags", () => {
    process.env.BOX_TEST_KEY = "sk-test-box";
    const out = parseProviderConfig(BOX);
    const d = out["box-api"];
    assert.equal(d.baseUrl, "https://api.ai-box.vn/v1");
    assert.equal(d.displayName, "Box API");
    assert.equal(d.kind, "openai");
    assert.equal(d.apiKeyInline, "sk-test-box");
    assert.equal(d.models["qwen3.8-flash"].contextWindow, 262144);
    assert.equal(d.models["qwen3.8-flash"].maxTokens, 32768);
    assert.deepEqual(d.models["qwen3.8-flash"].pricing, { input: 0.2, output: 0.8 });
    assert.equal(d.models["glm-5.3"].supportReasoning, true);
    assert.equal(d.models["tiny-no-tools"].toolCall, false);
    delete process.env.BOX_TEST_KEY;
  });

  it("npm → kind map: anthropic SDK wins; unknown npm → openai + warn once", () => {
    const a = parseProviderConfig({ cc: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://x/v1" } } });
    assert.equal(a.cc.kind, "anthropic");
    const w1 = captureWarnings(() => parseProviderConfig({ zz: { npm: "@ai-sdk/mystery", options: { baseURL: "https://x/v1" } } }));
    assert.equal(w1.length, 1);
    assert.match(w1[0], /ignoring unknown npm "@ai-sdk\/mystery"/);
    assert.equal(parseProviderConfig({ zz: { npm: "@ai-sdk/mystery", options: { baseURL: "https://x/v1" } } }).zz.kind, "openai");
  });

  it("entry hỏng → bỏ qua + cảnh báo, không throw; id chứa / bị loại", () => {
    const warns = captureWarnings(() => {
      const out = parseProviderConfig({
        bad1: "string",
        "a/b": { options: { baseURL: "https://x/v1" } },
        noURL: { options: {} },
        ok: { options: { baseURL: "https://ok/v1" } },
      });
      assert.deepEqual(Object.keys(out), ["ok"]);
    });
    assert.equal(warns.length, 3);
    assert.match(warns.find((w) => /invalid provider "bad1"/.test(w)), /.*/);
    assert.match(warns.find((w) => /contains "\/"/.test(w)), /.*/);
    assert.match(warns.find((w) => /options\.baseURL is required/.test(w)), /.*/);
  });

  it("thiếu baseURL nhưng trùng id builtin → kế thừa endpoint của builtin", () => {
    const out = parseProviderConfig({ ollama: { models: { "llama3": {} } } });
    assert.equal(out.ollama.baseUrl, BUILTIN_PROVIDERS.ollama.baseUrl);
    assert.equal(out.ollama.apiKeyEnv, "OLLAMA_API_KEY");
  });

  it(" discriminate theo shape — string/array/null → {} (legacy selector không vào parser này)", () => {
    assert.deepEqual(parseProviderConfig("openai"), {});
    assert.deepEqual(parseProviderConfig(null), {});
    assert.deepEqual(parseProviderConfig([]), {});
  });

  it("legacy parseCustomProviders giữ nguyên hành vi (tương thích ngược)", () => {
    const out = parseCustomProviders({ deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DS_KEY" } });
    assert.equal(out.deepseek.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(out.deepseek.apiKeyEnv, "DS_KEY");
  });

  it("options.headers qua {env:} + chỉ nhận string", () => {
    process.env.HDR_TEST = "v1";
    const out = parseProviderConfig({ p: { options: { baseURL: "https://x/v1", headers: { "x-tier": "{env:HDR_TEST}", num: 42 } } } });
    assert.equal(out.p.headers["x-tier"], "v1");
    assert.equal(out.p.headers.num, undefined);
    delete process.env.HDR_TEST;
  });
});

describe("expandEnvValue", () => {
  it("mở rộng {env:VAR}, thiếu VAR → chuỗi rỗng, không có placeholder → nguyên văn", () => {
    process.env.EXPAND_A = "AAA";
    assert.equal(expandEnvValue("{env:EXPAND_A}/x"), "AAA/x");
    assert.equal(expandEnvValue("{env:EXPAND_MISSING_ZZ}"), "");
    assert.equal(expandEnvValue("sk-plain"), "sk-plain");
    delete process.env.EXPAND_A;
  });
});

describe("splitProviderModel — id chứa dấu chấm (khoá hành vi)", () => {
  it("chỉ tách ở slash đầu tiên", () => {
    assert.deepEqual(splitProviderModel("box-api/kimi-k2.7-code"), ["box-api", "kimi-k2.7-code"]);
    assert.deepEqual(splitProviderModel("ollama/gemma4:e4b"), ["ollama", "gemma4:e4b"]);
    assert.deepEqual(splitProviderModel("kimi-k2.7-code"), [null, "kimi-k2.7-code"]);
  });
});

describe("findModelOwner(s)", () => {
  const providers = parseProviderConfig({
    ...BOX,
    other: { options: { baseURL: "https://o/v1" }, models: { "glm-5.3": { name: "glm-5.3 alt" } } },
  });
  it("duy nhất 1 owner → trả provider + model config", () => {
    const o = findModelOwner("kimi-k3", providers);
    assert.equal(o.provider, "box-api");
    assert.equal(o.model.name, "kimi-k3");
  });
  it("nhiều owner → findModelOwner null, findModelOwners liệt kê hết", () => {
    assert.equal(findModelOwner("glm-5.3", providers), null);
    assert.deepEqual(findModelOwners("glm-5.3", providers).map((x) => x.provider.id), ["box-api", "other"]);
  });
  it("không ai sở hữu → null/[]", () => {
    assert.equal(findModelOwner("nope", providers), null);
    assert.deepEqual(findModelOwners("nope", providers), []);
  });
});

describe("resolveModelRef (đường resolve dùng chung)", () => {
  const providers = parseProviderConfig(BOX);
  it('"box-api/kimi-k3" → def + model', () => {
    const r = resolveModelRef("box-api/kimi-k3", providers);
    assert.equal(r.def?.id, "box-api");
    assert.equal(r.model, "kimi-k3");
  });
  it("bare id unique trong config → def của owner", () => {
    const r = resolveModelRef("qwen3.8-flash", providers);
    assert.equal(r.def?.id, "box-api");
  });
  it("bare id không ai có → def null (giữ provider hiện tại)", () => {
    const r = resolveModelRef("gpt-4o-mini", providers);
    assert.equal(r.def, null);
    assert.equal(r.model, "gpt-4o-mini");
  });
  it("provider lạ → error sạch", () => {
    const r = resolveModelRef("nope/x", providers);
    assert.ok("error" in r);
  });
  it("builtin ref vẫn chạy khi không có custom nào", () => {
    const r = resolveModelRef("anthropic/claude-sonnet-4-5");
    assert.equal(r.def?.kind, "anthropic");
    assert.equal(r.model, "claude-sonnet-4-5");
  });
});

describe("scoder models — liệt kê model từ config (P2.1 §6, spawn CLI)", () => {
  it("in dòng SOURCE=config cho provider block, KHÔNG lộ key thô", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "models-cli-"));
    process.env.BOX_TEST_KEY = "sk-supersecret-abcdef12";
    writeFileSync(
      join(dir, ".scoderrc.json"),
      JSON.stringify({
        provider: {
          "box-api": {
            npm: "@ai-sdk/openai-compatible",
            name: "Box API",
            options: { baseURL: "https://api.ai-box.vn/v1", apiKey: "{env:BOX_TEST_KEY}" },
            models: { "kimi-k3": { name: "kimi-k3" }, "qwen3.8-flash": { limit: { context: 262144 }, cost: { input: 0.2, output: 0.8 } } },
          },
        },
      }),
    );
    try {
      const res = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "models"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, HOME: dir, SCODER_CONFIG: join(dir, "none.json"), SCODER_NO_APIKEY_WARNING: "1", SCODER_TRUST_PROJECT: "1", NO_COLOR: "1" },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /box-api\/kimi-k3/);
      assert.match(res.stdout, /box-api\/qwen3.8-flash/);
      assert.match(res.stdout, /ctx=262k/);
      assert.match(res.stdout, /SOURCE=config/);
      assert.ok(!res.stdout.includes("sk-supersecret"), "key inline không được in ra");
    } finally {
      delete process.env.BOX_TEST_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
