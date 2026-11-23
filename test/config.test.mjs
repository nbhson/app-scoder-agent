/**
 * Unit tests cho config.js — loadConfig precedence + edge cases.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadPermissionLists } from "../dist/config/config.js";

const TMP = join("/tmp", `scoder-config-test-${process.pid}`);

const GLOBAL_ISOLATION = join(TMP, "no-global-config.json"); // không tồn tại

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  // Cách ly khỏi ~/.scoder/config.json thật trên máy — test phải độc lập môi trường.
  process.env.SCODER_CONFIG = GLOBAL_ISOLATION;
  // Các test này kiểm tra precedence/merge của rc, không kiểm tra trust gate
  // (test/project-trust.test.mjs lo cái đó) — bypass trust cho deterministic.
  process.env.SCODER_TRUST_PROJECT = "1";
  delete process.env.SCODER_TRUST_FILE;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.SCODER_TRUST_PROJECT;
  if (process.env.SCODER_CONFIG === GLOBAL_ISOLATION) delete process.env.SCODER_CONFIG;
  delete process.env.SCODER_API_KEY;
  delete process.env.SCODER_LOG_FILE;
  delete process.env.SCODER_PERMISSION;
  delete process.env.SCODER_MODEL;
  delete process.env.SCODER_BASE_URL;
  delete process.env.SCODER_PROVIDER;
  delete process.env.SCODER_MAX_STEPS;
  delete process.env.SCODER_THEME;
});

describe("loadConfig", () => {
  it("defaults: openai provider, gpt-4o-mini, maxSteps 40, stream on, auto permission", () => {
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.model, "gpt-4o-mini");
    assert.equal(cfg.maxSteps, 40);
    assert.equal(cfg.stream, true);
    assert.equal(cfg.permissionMode, "auto");
  });

  it("SCODER_LOG_FILE=1 -> boolean true (auto path), KHÔNG phải file tên '1'", () => {
    process.env.SCODER_LOG_FILE = "1";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.logFile, true, "'1' phải map sang true");
  });

  it("SCODER_LOG_FILE=/path/x.jsonl -> path giữ nguyên", () => {
    process.env.SCODER_LOG_FILE = "/var/log/scoder.jsonl";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.logFile, "/var/log/scoder.jsonl");
  });

  it("rc file: model + buildCmd + maxSteps được đọc", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      model: "llama3", buildCmd: "make test", maxSteps: 77,
    }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "llama3");
    assert.equal(cfg.buildCmd, "make test");
    assert.equal(cfg.maxSteps, 77);
  });

  it("env override rc file", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ model: "from-rc" }));
    process.env.SCODER_MODEL = "from-env";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "from-env");
  });

  it("cli override env", () => {
    process.env.SCODER_MODEL = "from-env";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test", model: "from-cli" });
    assert.equal(cfg.model, "from-cli");
  });

  it("rc hỏng (JSON lỗi) -> bỏ qua, không crash", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), "{not valid json");
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "gpt-4o-mini");
  });

  it("anthropic auto-detect từ model claude-*", () => {
    const cfg = loadConfig({ workdir: TMP, apiKey: "test", model: "claude-sonnet-4-5" });
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.baseUrl, "https://api.anthropic.com/v1");
  });

  it("permission mode từ env", () => {
    process.env.SCODER_PERMISSION = "ask";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.permissionMode, "ask");
  });

  it("permission mode sai giá trị -> fallback auto", () => {
    process.env.SCODER_PERMISSION = "yolo";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.permissionMode, "auto");
  });

  it("SCODER_MAX_STEPS không phải số -> fallback 40, không NaN (BUG: steps < NaN)", () => {
    process.env.SCODER_MAX_STEPS = "abc";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.maxSteps, 40);
  });

  it("SCODER_MAX_STEPS <= 0 hoặc NaN -> fallback 40", () => {
    process.env.SCODER_MAX_STEPS = "0";
    assert.equal(loadConfig({ workdir: TMP, apiKey: "test" }).maxSteps, 40);
    process.env.SCODER_MAX_STEPS = "-5";
    assert.equal(loadConfig({ workdir: TMP, apiKey: "test" }).maxSteps, 40);
    process.env.SCODER_MAX_STEPS = "NaN";
    assert.equal(loadConfig({ workdir: TMP, apiKey: "test" }).maxSteps, 40);
  });

  it("SCODER_MAX_STEPS hợp lệ (số thập phân) -> được floor", () => {
    process.env.SCODER_MAX_STEPS = "12.9";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.maxSteps, 12);
  });
});

describe("loadPermissionLists", () => {
  it("đọc allowCommands/denyCommands từ rc", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      permissions: {
        mode: "ask",
        allowCommands: ["npm ", "git "],
        denyCommands: ["curl ", "sudo "],
      },
    }));
    const lists = loadPermissionLists(TMP);
    assert.deepEqual(lists.allowCommands, ["npm ", "git "]);
    assert.deepEqual(lists.denyCommands, ["curl ", "sudo "]);
  });

  it("lọc bỏ phần tử không phải string", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      permissions: { allowCommands: ["npm ", 42, null, "git "], denyCommands: "not-an-array" },
    }));
    const lists = loadPermissionLists(TMP);
    assert.deepEqual(lists.allowCommands, ["npm ", "git "]);
    assert.deepEqual(lists.denyCommands, []);
  });

  it("không có rc -> lists rỗng", () => {
    const lists = loadPermissionLists(TMP);
    assert.deepEqual(lists.allowCommands, []);
    assert.deepEqual(lists.denyCommands, []);
  });
});

describe("global config (~/.scoder/config.json, override bằng SCODER_CONFIG)", () => {
  const SAVED = process.env.SCODER_CONFIG;
  const GLOBAL = join("/tmp", `scoder-global-test-${process.pid}.json`);

  afterEach(() => {
    if (SAVED === undefined) delete process.env.SCODER_CONFIG;
    else process.env.SCODER_CONFIG = SAVED;
    rmSync(GLOBAL, { force: true });
  });

  it("global rc cung cấp giá trị khi project không set", () => {
    process.env.SCODER_CONFIG = GLOBAL;
    writeFileSync(GLOBAL, JSON.stringify({ model: "global-model", maxSteps: 55 }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "global-model");
    assert.equal(cfg.maxSteps, 55);
  });

  it("project rc ghi đè global theo field", () => {
    process.env.SCODER_CONFIG = GLOBAL;
    writeFileSync(GLOBAL, JSON.stringify({ model: "global-model", buildCmd: "make" }));
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ model: "project-model" }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "project-model");
    assert.equal(cfg.buildCmd, "make");
  });

  it("mcpServers: global + project gộp theo tên, project thắng", () => {
    process.env.SCODER_CONFIG = GLOBAL;
    writeFileSync(GLOBAL, JSON.stringify({
      mcpServers: {
        shared: { command: "global-cmd" },
        onlyGlobal: { command: "x" },
      },
    }));
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      mcpServers: { shared: { command: "project-cmd" } },
    }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.deepEqual(cfg.mcpServers?.shared, { command: "project-cmd" });
    assert.deepEqual(cfg.mcpServers?.onlyGlobal, { command: "x" });
  });

  it("permissions lists: global + project nối cùng nhau", () => {
    process.env.SCODER_CONFIG = GLOBAL;
    writeFileSync(GLOBAL, JSON.stringify({
      permissions: { allowCommands: ["docker "], denyCommands: ["sudo "] },
    }));
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      permissions: { allowCommands: ["npm "] },
    }));
    const lists = loadPermissionLists(TMP);
    assert.deepEqual(lists.allowCommands, ["docker ", "npm "]);
    assert.deepEqual(lists.denyCommands, ["sudo "]);
  });

  it("global rc hỏng -> bỏ qua, không crash", () => {
    process.env.SCODER_CONFIG = GLOBAL;
    writeFileSync(GLOBAL, "{ not json");
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "gpt-4o-mini");
  });
});

describe("loadConfig — theme (rc/env/flag precedence)", () => {
  it('rc "theme" được đọc vào cfg.theme', () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ theme: "paper" }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.theme, "paper");
  });

  it("SCODER_THEME env thắng rc", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ theme: "paper" }));
    process.env.SCODER_THEME = "solarized";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.theme, "solarized");
  });

  it("flag (overrides) thắng env", () => {
    process.env.SCODER_THEME = "solarized";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test", theme: "mono" });
    assert.equal(cfg.theme, "mono");
  });

  it("không cấu hình -> theme undefined (TUI tự detect caps)", () => {
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.theme, undefined);
  });
});

// ── P2.1 (plan/P2-01-provider-config.md): provider block kiểu opencode ──────

const BOX_RC = {
  provider: {
    "box-api": {
      npm: "@ai-sdk/openai-compatible",
      name: "Box API",
      options: { baseURL: "https://api.ai-box.vn/v1", apiKey: "{env:BOX_TEST_KEY}" },
      models: {
        "kimi-k3": { name: "kimi-k3" },
        "kimi-k2.7-code": { name: "kimi-k2.7-code" },
        "glm-5.3": { name: "glm-5.3" },
        "qwen3.8-flash": { name: "qwen3.8-flash", limit: { context: 262144 }, cost: { input: 0.2, output: 0.8 } },
      },
    },
  },
};

describe("loadConfig — provider block (P2.1)", () => {
  let saved;
  beforeEach(() => {
    saved = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      BOX_TEST_KEY: process.env.BOX_TEST_KEY,
    };
    delete process.env.OPENAI_API_KEY; // deterministic key chain
    delete process.env.ANTHROPIC_API_KEY;
    process.env.BOX_TEST_KEY = "sk-box-1234567890";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('"model": "box-api/kimi-k3" → baseUrl + inline key + provider id đúng', () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ ...BOX_RC, model: "box-api/kimi-k3" }));
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.model, "kimi-k3");
    assert.equal(cfg.baseUrl, "https://api.ai-box.vn/v1");
    assert.equal(cfg.apiKey, "sk-box-1234567890");
    assert.equal(cfg.apiKeySource, "provider-rc");
    assert.equal(cfg.providerDef.id, "box-api");
    assert.equal(cfg.providerDef.displayName, "Box API");
    assert.equal(cfg.provider, "openai");
  });

  it("bare \"qwen3.8-flash\" tự route vào owner + contextWindow từ rc", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ ...BOX_RC, model: "qwen3.8-flash" }));
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.providerDef.id, "box-api");
    assert.equal(cfg.baseUrl, "https://api.ai-box.vn/v1");
    assert.equal(cfg.contextWindow, 262144);
  });

  it("key chain: SCODER_API_KEY > apiKeyEnv env > inline > rc.apiKey", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ ...BOX_RC, model: "box-api/kimi-k3", apiKey: "sk-rc-legacy" }));
    process.env.SCODER_API_KEY = "sk-shared";
    let cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.apiKey, "sk-shared");
    assert.equal(cfg.apiKeySource, "env");
    delete process.env.SCODER_API_KEY;
    cfg = loadConfig({ workdir: TMP }); // inline {env:BOX_TEST_KEY} thắng rc.apiKey
    assert.equal(cfg.apiKey, "sk-box-1234567890");
    assert.equal(cfg.apiKeySource, "provider-rc");
    delete process.env.BOX_TEST_KEY;
    cfg = loadConfig({ workdir: TMP }); // không env nào → rc.apiKey
    assert.equal(cfg.apiKey, "sk-rc-legacy");
    assert.equal(cfg.apiKeySource, "rc");
    process.env.BOX_TEST_KEY = "sk-box-1234567890";
  });

  it("ambiguity: 2 provider cùng declaring 1 id → warn, giữ active provider", () => {
    const rc = {
      ...BOX_RC,
      provider: {
        ...BOX_RC.provider,
        "other-api": { options: { baseURL: "https://other/v1" }, models: { "kimi-k3": {} } },
      },
      model: "kimi-k3",
    };
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify(rc));
    const warns = [];
    const orig = console.error;
    console.error = (...a) => warns.push(a.join(" "));
    let cfg;
    try {
      cfg = loadConfig({ workdir: TMP });
    } finally {
      console.error = orig;
    }
    assert.match(warns.find((w) => /several providers/.test(w)) ?? "", /write "<provider>\/kimi-k3"/);
    assert.equal(cfg.providerDef.id, "openai"); // active mặc định, không đoán bừa
  });

  it("rc.provider dạng STRING (legacy selector) vẫn chạy y hệt — discrimination theo shape", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5" }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "k" });
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.baseUrl, "https://api.anthropic.com/v1");
  });

  it("format cũ `providers.<id>` không đổi hành vi khi có thêm block mới", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      ...BOX_RC,
      providers: { "my-llm": { baseUrl: "https://llm.example.com/v1", apiKeyEnv: "MY_LLM_KEY" } },
      model: "my-llm/llama3",
    }));
    process.env.MY_LLM_KEY = "k-legacy";
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.baseUrl, "https://llm.example.com/v1");
    assert.equal(cfg.apiKey, "k-legacy");
    assert.equal(cfg.apiKeySource, "env");
    delete process.env.MY_LLM_KEY;
  });

  it("cost từ models.<id>.cost vào modelPricing; rc modelPricing vẫn thắng", () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({
      ...BOX_RC,
      model: "box-api/kimi-k3",
      modelPricing: { "qwen3.8-flash": { input: 9, output: 9 } },
    }));
    const cfg = loadConfig({ workdir: TMP });
    assert.deepEqual(cfg.modelPricing["qwen3.8-flash"], { input: 9, output: 9 }); // rc override thắng
    assert.equal(cfg.modelPricing["kimi-k2.7-code"], undefined); // id không khai cost → không có entry
    assert.deepEqual(cfg.modelPricing["box-api/qwen3.8-flash"], { input: 0.2, output: 0.8 }); // key qualified lấy theo provider cost
  });

  it("config model thắng catalog: contextWindowFor sau loadConfig dùng rc", async () => {
    writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify({ ...BOX_RC, model: "box-api/qwen3.8-flash" }));
    loadConfig({ workdir: TMP });
    const { contextWindowFor, lookupModel } = await import("../dist/llm/model-catalog.js");
    assert.equal(contextWindowFor("openai", "qwen3.8-flash"), 262144); // alias theo kind để sidebar tra
    assert.equal(lookupModel("box-api", "qwen3.8-flash").pricing.input, 0.2);
  });
});
