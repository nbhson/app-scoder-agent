/**
 * Unit tests cho config.js — loadConfig precedence + edge cases.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadPermissionLists } from "../dist/config.js";

const TMP = join("/tmp", `coder-config-test-${process.pid}`);

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CODER_API_KEY;
  delete process.env.CODER_LOG_FILE;
  delete process.env.CODER_PERMISSION;
  delete process.env.CODER_MODEL;
  delete process.env.CODER_BASE_URL;
  delete process.env.CODER_PROVIDER;
  delete process.env.CODER_MAX_STEPS;
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

  it("CODER_LOG_FILE=1 -> boolean true (auto path), KHÔNG phải file tên '1'", () => {
    process.env.CODER_LOG_FILE = "1";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.logFile, true, "'1' phải map sang true");
  });

  it("CODER_LOG_FILE=/path/x.jsonl -> path giữ nguyên", () => {
    process.env.CODER_LOG_FILE = "/var/log/coder.jsonl";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.logFile, "/var/log/coder.jsonl");
  });

  it("rc file: model + buildCmd + maxSteps được đọc", () => {
    writeFileSync(join(TMP, ".coderrc.json"), JSON.stringify({
      model: "llama3", buildCmd: "make test", maxSteps: 77,
    }));
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "llama3");
    assert.equal(cfg.buildCmd, "make test");
    assert.equal(cfg.maxSteps, 77);
  });

  it("env override rc file", () => {
    writeFileSync(join(TMP, ".coderrc.json"), JSON.stringify({ model: "from-rc" }));
    process.env.CODER_MODEL = "from-env";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "from-env");
  });

  it("cli override env", () => {
    process.env.CODER_MODEL = "from-env";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test", model: "from-cli" });
    assert.equal(cfg.model, "from-cli");
  });

  it("rc hỏng (JSON lỗi) -> bỏ qua, không crash", () => {
    writeFileSync(join(TMP, ".coderrc.json"), "{not valid json");
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.model, "gpt-4o-mini");
  });

  it("anthropic auto-detect từ model claude-*", () => {
    const cfg = loadConfig({ workdir: TMP, apiKey: "test", model: "claude-sonnet-4-5" });
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.baseUrl, "https://api.anthropic.com/v1");
  });

  it("permission mode từ env", () => {
    process.env.CODER_PERMISSION = "ask";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.permissionMode, "ask");
  });

  it("permission mode sai giá trị -> fallback auto", () => {
    process.env.CODER_PERMISSION = "yolo";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.permissionMode, "auto");
  });

  it("CODER_MAX_STEPS không phải số -> fallback 40, không NaN (BUG: steps < NaN)", () => {
    process.env.CODER_MAX_STEPS = "abc";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.maxSteps, 40);
  });

  it("CODER_MAX_STEPS <= 0 hoặc NaN -> fallback 40", () => {
    process.env.CODER_MAX_STEPS = "0";
    assert.equal(loadConfig({ workdir: TMP, apiKey: "test" }).maxSteps, 40);
    process.env.CODER_MAX_STEPS = "-5";
    assert.equal(loadConfig({ workdir: TMP, apiKey: "test" }).maxSteps, 40);
    process.env.CODER_MAX_STEPS = "NaN";
    assert.equal(loadConfig({ workdir: TMP, apiKey: "test" }).maxSteps, 40);
  });

  it("CODER_MAX_STEPS hợp lệ (số thập phân) -> được floor", () => {
    process.env.CODER_MAX_STEPS = "12.9";
    const cfg = loadConfig({ workdir: TMP, apiKey: "test" });
    assert.equal(cfg.maxSteps, 12);
  });
});

describe("loadPermissionLists", () => {
  it("đọc allowCommands/denyCommands từ rc", () => {
    writeFileSync(join(TMP, ".coderrc.json"), JSON.stringify({
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
    writeFileSync(join(TMP, ".coderrc.json"), JSON.stringify({
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
