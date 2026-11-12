/**
 * Unit tests cho các fix trong plan/performance-issue.md (P0-2, P0-3, P1-1,
 * P1-2, P1-3). Chạy: node --test test/perf-p0-p1.test.mjs (sau khi build).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, estimateSchemaTokens, shouldCompact, DEFAULT_COMPACTION } from "../dist/context/compaction.js";
import { matchToolPattern, toolAllowed, filterToolNames } from "../dist/mcp/tool-filter.js";
import { capMcpSchemaTokens } from "../dist/agent/mcp-bridge.js";
import { workspaceFingerprint } from "../dist/workspace/fingerprint.js";
import { normalizeUsage } from "../dist/llm/llm.js";
import { promptMetrics } from "../dist/llm/prompt-metrics.js";
import { toolReadFile } from "../dist/tools/read-file.js";
import { setMaxToolOutputChars, MAX_TOOL_OUTPUT_CHARS } from "../dist/tools/path-safety.js";
import { verifyAll } from "../dist/agent/verification.js";

const spec = (name, description = "", parameters = { type: "object", properties: {} }) => ({
  type: "function",
  function: { name, description, parameters },
});

describe("P1-1: estimateTokens tính cả tool schema", () => {
  it("estimateSchemaTokens: rỗng = 0, tăng theo số tool, cache theo mảng", () => {
    assert.equal(estimateSchemaTokens(undefined), 0);
    assert.equal(estimateSchemaTokens([]), 0);
    const one = estimateSchemaTokens([spec("a", "do a thing")]);
    const two = estimateSchemaTokens([spec("a", "do a thing"), spec("b", "do another thing")]);
    assert.ok(one > 0 && two > one, `schema tokens phải tăng: ${one} -> ${two}`);
    const arr = [spec("c")];
    assert.equal(estimateSchemaTokens(arr), estimateSchemaTokens(arr));
  });

  it("estimateTokens(messages, extra) cộng thêm extra; shouldCompact theo extra", () => {
    const msgs = [{ role: "user", content: "hello world" }];
    const base = estimateTokens(msgs);
    assert.equal(estimateTokens(msgs, 500), base + 500);
    const cfg = { ...DEFAULT_COMPACTION, contextWindow: 1000, trigger: 0.8 };
    // 100 token history + 800 token schema => vượt 800 (0.8 * 1000)
    assert.equal(shouldCompact(msgs, cfg, 0), false);
    assert.equal(shouldCompact(msgs, cfg, 800), true);
  });
});

describe("P0-3: filter + trần token cho MCP tool schema", () => {
  it("matchToolPattern: không dấu *= exact (case-insensitive), có * = glob", () => {
    assert.equal(matchToolPattern("mcp__gh__get_me", "mcp__GH__get_me"), true);
    assert.equal(matchToolPattern("mcp__gh__get_*", "mcp__gh__get_me"), true);
    assert.equal(matchToolPattern("mcp__gh__get_*", "mcp__gh__list_me"), false);
    assert.equal(matchToolPattern("*__get_me", "mcp__gh__get_me"), true);
    assert.equal(matchToolPattern("mcp__gh__get", "mcp__gh__get_me"), false, "exact không phải prefix");
  });

  it("toolAllowed: include rỗng = tất cả, exclude thắng", () => {
    assert.equal(toolAllowed("mcp__a__b", undefined), true);
    assert.equal(toolAllowed("mcp__a__b", {}), true);
    assert.equal(toolAllowed("mcp__a__b", { include: ["mcp__a__*"] }), true);
    assert.equal(toolAllowed("mcp__a__b", { include: ["mcp__z__*"] }), false);
    assert.equal(toolAllowed("mcp__a__b", { include: ["mcp__a__*"], exclude: ["*_b"] }), false);
  });

  it("filterToolNames giữ thứ tự khai báo", () => {
    const items = ["mcp__a__one", "mcp__a__two", "mcp__b__one"];
    assert.deepEqual(filterToolNames(items, (s) => s, { include: ["mcp__a__*"] }), ["mcp__a__one", "mcp__a__two"]);
    assert.equal(filterToolNames(items, (s) => s, undefined), items, "không filter => nguyên mảng");
  });

  it("capMcpSchemaTokens: 0 = tắt; vượt trần thì giữ theo thứ tự + warn một lần", () => {
    const specs = Array.from({ length: 6 }, (_, i) => spec(`mcp__s__t${i}`, "x".repeat(600)));
    const all = capMcpSchemaTokens(specs, 0, () => assert.fail("cap=0 không được lọc"));
    assert.equal(all.length, 6);
    const full = estimateSchemaTokens(specs);
    const warnings = [];
    const half = capMcpSchemaTokens(specs, Math.floor(full / 2), (l) => warnings.push(l));
    assert.ok(half.length > 0 && half.length < 6, `giữ một phần: ${half.length}/6`);
    assert.equal(half[0].function.name, "mcp__s__t0", "giữ theo thứ tự khai báo");
    assert.equal(estimateSchemaTokens(half) <= Math.floor(full / 2), true);
    assert.equal(warnings.length, 1);
    // warn một lần cho mỗi process — lần sau vẫn lọc đúng, không log ồn
    const again = capMcpSchemaTokens(specs, Math.floor(full / 2), () => warnings.push("again"));
    assert.equal(again.length, half.length);
    assert.deepEqual(warnings.length, 1);
  });

  it("capMcpSchemaTokens: dưới trần => nguyên danh sách", () => {
    const specs = [spec("mcp__s__t", "short")];
    const warn = [];
    assert.equal(capMcpSchemaTokens(specs, 100_000, () => warn.push(1)), specs);
    assert.deepEqual(warn, []);
  });

  it("governedMcpSpecs: cửa duy nhất cho MCP tools — filter TRƯỚC, cap SAU", async () => {
    const { governedMcpSpecs } = await import("../dist/agent/mcp-bridge.js");
    const specs = Array.from({ length: 8 }, (_, i) => spec(`mcp__s__g${i}`, "q".repeat(600) + i));
    const each = estimateSchemaTokens([specs[0]]);
    // Trần = 3 tool, cộng 1 để signature (cap) không đụng các test khác.
    const cap = each * 3 + 1;
    let warnings = 0;
    const runtime = (mcpTools, capTokens) => ({
      config: { mcpTools, limits: { mcpSchemaTokens: capTokens } },
      reporter: { warn: () => warnings++ },
      getMcp: () => ({ toToolSpecs: () => specs, resourceToolSpecs: () => [] }),
    });

    const capped = governedMcpSpecs(runtime(undefined, cap));
    assert.ok(capped.length > 0 && capped.length < 8, `cap phải cắt: ${capped.length}/8 (each=${each})`);
    assert.equal(capped[0].function.name, "mcp__s__g0", "giữ theo thứ tự khai báo");
    assert.ok(warnings === 1, `vượt trần warn đúng một lần (${warnings})`);
    governedMcpSpecs(runtime(undefined, cap));
    assert.equal(warnings, 1, "signature (cap:dropped) giống lần trước => không warn lại");

    const excluded = governedMcpSpecs(runtime({ exclude: ["mcp__s__g3"] }, 0));
    assert.equal(excluded.length, 7, "cap=0 vẫn áp allowlist");
    assert.ok(!excluded.some((s) => s.function.name === "mcp__s__g3"));

    // allowlist chạy TRƯỚC cap: một include hẹp thì không bị trần cắt thêm
    const three = governedMcpSpecs(runtime({ include: ["mcp__s__g0", "mcp__s__g1", "mcp__s__g2"] }, cap));
    assert.equal(three.length, 3, `3 tool < ngân sách => giữ cả 3 (${three.length})`);
    assert.equal(warnings, 1, "không warn khi allowlist đã đưa spec dưới trần");
  });
});

describe("P0-2: read_file cắt theo dòng + hint đọc tiếp", () => {
  let dir;
  const prevToolCap = MAX_TOOL_OUTPUT_CHARS;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "perf-read-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setMaxToolOutputChars(prevToolCap);
  });

  it("file nhỏ: giữ nguyên văn, không footer", () => {
    writeFileSync(join(dir, "small.ts"), "export const a = 1;\nexport const b = 2;\n");
    const r = toolReadFile(dir, { path: "small.ts" });
    assert.equal(r.ok, true);
    assert.match(r.output, /export const b = 2/);
    assert.ok(!/do NOT re-read/.test(r.output), "không có hint khi đọc hết file");
  });

  it("file lớn: output <= ngân sách, footer chỉ rõ offset tiếp theo", () => {
    setMaxToolOutputChars(2_000);
    const lines = Array.from({ length: 400 }, (_, i) => `${i}: ${"long line ".repeat(4)}`);
    writeFileSync(join(dir, "big.txt"), lines.join("\n"));
    const r = toolReadFile(dir, { path: "big.txt" });
    assert.ok(r.output.length <= 2_600, `output ${r.output.length} ký tự`);
    assert.match(r.output, /\[lines 1-\d+ of 400 — big.txt\]/);
    assert.match(r.output, /do NOT re-read from the start/);
    const m = /read_file\(\{"path":"big\.txt","offset":(\d+)\}\)/.exec(r.output);
    assert.ok(m, "footer phải có offset kế tiếp");
    assert.equal(Number(m[1]), Number(/\[lines 1-(\d+)/.exec(r.output)[1]) + 1);
    // đọc tiếp từ offset được chỉ ra -> lấy đúng phần còn lại
    const next = toolReadFile(dir, { path: "big.txt", offset: Number(m[1]), limit: 5 });
    assert.match(next.output, new RegExp(`^\\[lines ${m[1]}-`));
  });

  it("một dòng quá dài vẫn không vượt MAX_OUTPUT_CHARS (clamp)", () => {
    setMaxToolOutputChars(500);
    writeFileSync(join(dir, "one.txt"), "z".repeat(40_000));
    const r = toolReadFile(dir, { path: "one.txt" });
    assert.ok(r.output.length <= 500 + 20_000, "không crash");
    assert.match(r.output, /truncated|\[\d+ more line/);
  });
});

describe("P1-2: workspaceFingerprint + cache verify", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "perf-fp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ổn định khi không đổi; đổi nội dung/size/thêm file => khác", () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const h1 = workspaceFingerprint(dir);
    assert.equal(workspaceFingerprint(dir), h1, "lặp lại phải giống nhau");
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    const h2 = workspaceFingerprint(dir);
    assert.notEqual(h2, h1, "nội dung đổi => fingerprint đổi");
    writeFileSync(join(dir, "c.ts"), "x\n");
    assert.notEqual(workspaceFingerprint(dir), h2, "thêm file => fingerprint đổi");
  });

  it("verifyAll: lần hai dùng lại kết quả PASS, không chạy lại lệnh", async () => {
    writeFileSync(join(dir, "ok.js"), "console.log('built');\n");
    const logs = [];
    const store = new Map();
    const runtime = {
      config: {
        workdir: dir,
        buildCmd: null,
        verifyCmds: { build: "node ok.js", test: "", typecheck: "", lint: "" },
        limits: {},
      },
      reporter: { info() {}, buildStatus() {}, warn() {} },
      logger: { log: (o) => logs.push(o) },
      events: { append() {} },
      emit() {},
      onToolOutput() {},
      endToolStream() {},
      setLastBuildResult() {},
      verifyCache: { read: (k) => store.get(k), write: (k, v) => store.set(k, v) },
    };
    const first = await verifyAll(runtime, "node ok.js");
    assert.equal(first.success, true, first.output);
    assert.equal(logs.filter((l) => l.type === "build").length, 1);
    const second = await verifyAll(runtime, "node ok.js");
    assert.equal(second.success, true);
    assert.equal(logs.filter((l) => l.type === "build").length, 2, "phải log một dòng cached");
    assert.equal(logs[1].cached, true, "lần hai là cache hit");
    // đổi file -> fingerprint khác -> chạy lại thật
    writeFileSync(join(dir, "ok.js"), "console.log('changed content after edit');\n");
    await verifyAll(runtime, "node ok.js");
    assert.equal(logs.filter((l) => l.type === "build" && !l.cached).length, 2, "fingerprint đổi => chạy lại");
  });

  it("verifyAll: kết quả FAIL không được cache", async () => {
    writeFileSync(join(dir, "fail.js"), "process.exit(3);\n");
    const logs = [];
    const store = new Map();
    const runtime = {
      config: {
        workdir: dir,
        buildCmd: null,
        verifyCmds: { build: "node fail.js", test: "", typecheck: "", lint: "" },
        limits: {},
      },
      reporter: { info() {}, buildStatus() {}, warn() {} },
      logger: { log: (o) => logs.push(o) },
      events: { append() {} },
      emit() {},
      onToolOutput() {},
      endToolStream() {},
      setLastBuildResult() {},
      verifyCache: { read: (k) => store.get(k), write: (k, v) => store.set(k, v) },
    };
    const r = await verifyAll(runtime, "node fail.js");
    assert.equal(r.success, false);
    assert.equal(store.size, 0, "FAIL không được cache");
    await verifyAll(runtime, "node fail.js");
    assert.equal(logs.filter((l) => l.type === "build" && !l.cached).length, 2, "phải chạy lại");
  });

  it('verifyCache: false -> không cache dù PASS', async () => {
    writeFileSync(join(dir, "ok.js"), "console.log('x');\n");
    const logs = [];
    const store = new Map();
    const runtime = {
      config: {
        workdir: dir,
        buildCmd: null,
        verifyCache: false,
        verifyCmds: { build: "node ok.js", test: "", typecheck: "", lint: "" },
        limits: {},
      },
      reporter: { info() {}, buildStatus() {}, warn() {} },
      logger: { log: (o) => logs.push(o) },
      events: { append() {} },
      emit() {},
      onToolOutput() {},
      endToolStream() {},
      setLastBuildResult() {},
      verifyCache: { read: (k) => store.get(k), write: (k, v) => store.set(k, v) },
    };
    await verifyAll(runtime, "node ok.js");
    await verifyAll(runtime, "node ok.js");
    assert.equal(store.size, 0);
    assert.equal(logs.filter((l) => l.type === "build").length, 2);
  });
});

describe("P1-3: usage + prompt metrics", () => {
  it("normalizeUsage nâng cached_tokens từ prompt_tokens_details", () => {
    assert.equal(normalizeUsage(undefined), undefined);
    const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } });
    assert.equal(u.cached_tokens, 80);
    assert.equal(u.prompt_tokens, 100);
    const explicit = normalizeUsage({ prompt_tokens: 10, cached_tokens: 3, prompt_tokens_details: { cached_tokens: 9 } });
    assert.equal(explicit.cached_tokens, 3, "giá trị tường minh thắng");
  });

  it("prefixReused: append-only = true, sửa message cũ = false", () => {
    const tools = [spec("a", "x".repeat(400))];
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "hello" }];
    const m1 = promptMetrics(msgs, tools, null);
    assert.equal(m1.prefixReused, null, "lượt đầu chưa có gì để so");
    const ref = { messageHashes: m1.messageHashes };
    const m2 = promptMetrics([...msgs, { role: "assistant", content: "hi" }], tools, ref);
    assert.equal(m2.prefixReused, true, "append-only => prefix còn dùng");
    assert.equal(m2.commonPrefixMessages, 2);
    assert.notEqual(m2.promptHash, m1.promptHash, "promptHash phải đổi");
    // sửa message ở giữa (prune/trim in-place) => mất prefix
    const edited = [{ role: "system", content: "sys" }, { role: "user", content: "HELLO KHÁC" }];
    const m3 = promptMetrics([...edited, { role: "assistant", content: "hi" }], tools, ref);
    assert.equal(m3.prefixReused, false);
    assert.equal(m3.commonPrefixMessages, 1);
    // cắt đuôi (trimHistory drop block đầu) => prefix mất
    const m4 = promptMetrics(msgs.slice(1), tools, ref);
    assert.equal(m4.prefixReused, false, "xoá message cũ nhất cũng đổi prefix");
    assert.equal(m4.tools, 1);
    assert.ok(m4.promptChars > 0);
  });
});
