/**
 * Unit tests cho các fix trong plan/performance-issue.md (P0-2, P0-3, P1-1,
 * P1-2, P1-3). Chạy: node --test test/perf-p0-p1.test.mjs (sau khi build).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, estimateSchemaTokens, shouldCompact, DEFAULT_COMPACTION } from "../dist/context/compaction.js";
import { historyTokenBudget } from "../dist/context/context.js";
import { matchToolPattern, toolAllowed, filterToolNames } from "../dist/mcp/tool-filter.js";
import { capMcpSchemaTokens } from "../dist/agent/mcp-bridge.js";
import { workspaceFingerprint } from "../dist/workspace/fingerprint.js";
import { normalizeUsage } from "../dist/llm/llm.js";
import { probeContextWindow, resetContextProbeCache } from "../dist/llm/context-probe.js";
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
    const m = /\{"path":"big\.txt","offset":(\d+)\}/.exec(r.output);
    assert.ok(m, "footer phải có offset kế tiếp");
    assert.equal(Number(m[1]), Number(/\[lines 1-(\d+)/.exec(r.output)[1]) + 1);
    // FILE-READ-PERF P2: footer gợi ý CẢ offset thứ hai (batch song song 1 bước)
    const m2 = /\{"path":"big\.txt","offset":\d+\},\s*\{"path":"big\.txt","offset":(\d+)\}/.exec(r.output);
    assert.ok(m2, "footer phải có offset thứ hai để đọc song song");
    assert.ok(Number(m2[1]) > Number(m[1]), "offset sau phải lớn hơn");
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

describe("P1-1: probeContextWindow đọc đúng server thật", () => {
  let srv;
  let port;
  const MODEL = "qwen3.6:35b";

  const serve = (props) =>
    new Promise((resolve) => {
      srv = createServer((req, res) => {
        const auth = req.headers.authorization || "";
        if (req.method === "GET" && req.url === "/props") {
          // llama.cpp bật --api-key: /props cũng phải có Bearer mới trả 200
          if (auth !== "Bearer secret") {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: 401, message: "Invalid API Key" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(props));
          return;
        }
        if (req.method === "POST" && req.url === "/api/show") {
          // Ollama-only endpoint: llama.cpp trả 404, probe phải bỏ qua
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not found" } }));
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
      srv.listen(0, "127.0.0.1", () => {
        port = srv.address().port;
        resolve();
      });
    });

  afterEach(() => {
    if (srv) srv.close();
    srv = undefined;
    resetContextProbeCache();
  });

  it("llama.cpp: n_ctx nằm trong default_generation_settings (không phải top level)", async () => {
    await serve({ default_generation_settings: { n_ctx: 16128 }, total_slots: 2 });
    const r = await probeContextWindow(`http://127.0.0.1:${port}/v1`, MODEL, 1500, { apiKey: "secret" });
    assert.equal(r.source, "llama.cpp");
    assert.equal(r.tokens, 16128, `phải đọc 16128, nhận ${JSON.stringify(r)}`);
    assert.match(r.detail, /2 slot/, "nhiều slot = KV-cache rải nhau, phải nói rõ");
  });

  it("thiếu API key -> /props 401 -> trả null (giữ fallback, không đoán sai)", async () => {
    await serve({ default_generation_settings: { n_ctx: 16128 }, total_slots: 1 });
    assert.equal(await probeContextWindow(`http://127.0.0.1:${port}/v1`, MODEL, 1500), null);
  });

  it("total_n_ctx không được thắng per-slot (window của MỘT hội thoại)", async () => {
    await serve({ default_generation_settings: { n_ctx: 16128 }, total_n_ctx: 32256, total_slots: 2 });
    const r = await probeContextWindow(`http://127.0.0.1:${port}/v1`, MODEL, 1500, { apiKey: "secret" });
    assert.equal(r.tokens, 16128);
  });

  it("baseUrl có khoảng trắng thừa (rc thật) vẫn probe được", async () => {
    await serve({ default_generation_settings: { n_ctx: 8192 }, total_slots: 1 });
    const r = await probeContextWindow(` http://127.0.0.1:${port}/v1`, MODEL, 1500, { apiKey: "secret" });
    assert.equal(r.tokens, 8192);
  });
});

describe("P1-1: historyTokenBudget không để reply ăn hết history", () => {
  it("window 16k + schema 8k + reserve 8k -> history còn ~5.4k, không rớt sàn", () => {
    const b = historyTokenBudget(16_128, 8_065, 8_192);
    assert.ok(b > 4_000, `ngân sách history ${b} quá nhỏ (sàn 2000)`);
    assert.ok(b < 16_128 * 0.95 - 8_065, "vẫn phải trừ chỗ cho reply");
  });
  it("reserve nhỏ thì trừ đúng theo reserve (không đổi hành vi cũ)", () => {
    assert.equal(historyTokenBudget(32_000, 0, 2_000), Math.floor(32_000 * 0.95) - 2_000);
    assert.equal(historyTokenBudget(131_072), 124_518, "1 tham số: scale theo window như trước");
  });
  it("window không đủ chứa schema -> sàn 2k, không âm", () => {
    assert.equal(historyTokenBudget(4_000, 9_000, 8_192), 2_000);
  });
});

describe("P1-3: usage + prompt metrics", () => {  it("normalizeUsage nâng cached_tokens từ prompt_tokens_details", () => {
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

describe("P1-1+: trần MCP schema co theo context window THẬT", () => {
  it("effectiveMcpSchemaCap: 0 = tắt, window lớn = giữ trần rc, window 16k = siết", async () => {
    const { effectiveMcpSchemaCap, SCHEMA_SHARE_OF_WINDOW } = await import("../dist/agent/mcp-bridge.js");
    assert.equal(effectiveMcpSchemaCap(0, 16128, 2086), 0, "trần 0 = người dùng tắt, không đoán");
    assert.equal(effectiveMcpSchemaCap(6000, 0, 2086), 6000, "chưa biết window -> giữ nguyên rc");
    assert.equal(effectiveMcpSchemaCap(6000, 131072, 2086), 6000, "window lớn: 35% còn rộng hơn trần rc");
    const tight = effectiveMcpSchemaCap(6000, 16128, 2086);
    assert.ok(tight > 1000 && tight < 6000, `16k window phải siết: ${tight}`);
    assert.equal(tight, Math.floor(16128 * SCHEMA_SHARE_OF_WINDOW) - 2086);
    assert.equal(effectiveMcpSchemaCap(6000, 4096, 3000), 1200, "không siết xuống dưới sàn 1200");
  });

  it("governedMcpSpecs: window nhỏ -> giữ ít tool hơn trần rc, warn đúng một lần", async () => {
    const { governedMcpSpecs } = await import("../dist/agent/mcp-bridge.js");
    const specs = Array.from({ length: 30 }, (_, i) => spec(`mcp__s__w${i}`, "w".repeat(900) + i));
    const each = estimateSchemaTokens([specs[0]]);
    const lines = [];
    const runtime = (contextWindow) => ({
      config: { limits: { mcpSchemaTokens: each * 20 }, contextWindow },
      reporter: { warn: (l) => lines.push(l) },
      getMcp: () => ({ toToolSpecs: () => specs, resourceToolSpecs: () => [] }),
    });
    const big = governedMcpSpecs(runtime(131072));
    assert.ok(big.length <= 20 && big.length > 10, `window lớn: theo trần rc (${big.length})`);
    const small = governedMcpSpecs(runtime(16128));
    assert.ok(small.length < big.length, `window 16k phải giữ ít hơn: ${small.length} < ${big.length}`);
    assert.ok(lines.some((l) => /35% window/.test(l)), "phải giải thích vì sao trần bị hạ");
    const n = lines.length;
    governedMcpSpecs(runtime(16128));
    assert.equal(lines.length, n, "cùng signature -> không warn lặp");
  });
});

describe("P1-1+: calibration chi phí cố định từ prompt_tokens của engine", () => {
  const mkAgent = async (promptTokens) => {
    const { Agent } = await import("../dist/agent.js");
    const wd = mkdtempSync(join(tmpdir(), "scoder-calib-"));
    class ScriptedClient {
      get model() { return "scripted/mock"; }
      async chat() {
        return {
          message: { role: "assistant", content: "xong", stop_reason: "stop", tool_calls: undefined },
          usage: { prompt_tokens: promptTokens, completion_tokens: 5 },
        };
      }
      async *streamChat() {
        yield { contentDelta: "xong", done: false };
        yield { final: await this.chat(), done: true };
      }
    }
    const agent = new Agent({
      baseUrl: "https://calib.invalid/v1",
      apiKey: "k",
      model: "scripted/mock",
      provider: "openai",
      workdir: wd,
      buildCmd: null,
      maxSteps: 3,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      clientFactory: () => new ScriptedClient(),
    });
    return { agent, wd };
  };

  it("engine báo số lớn -> dùng số đo thật (có token đóng gói của chat template)", async () => {
    const { allToolSpecs } = await import("../dist/tools/registry.js");
    const { agent, wd } = await mkAgent(20000);
    try {
      assert.equal(agent.fixedPromptSource(), "estimate", "trước lượt gọi đầu chỉ có ước lượng");
      await agent.run("chào");
      assert.equal(agent.fixedPromptSource(), "measured");
      assert.ok(
        agent.fixedPromptTokens() > estimateSchemaTokens(allToolSpecs()),
        `phải lớn hơn ước lượng schema: ${agent.fixedPromptTokens()}`,
      );
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("mock báo prompt_tokens nhỏ -> không tin bừa, giữ ước lượng", async () => {
    const { agent, wd } = await mkAgent(10);
    try {
      await agent.run("chào");
      assert.equal(agent.fixedPromptSource(), "estimate");
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});
