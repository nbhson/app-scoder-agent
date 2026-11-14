/**
 * WARMUP (plan/WARMUP-PLAN.md): request prefill nền khi mở session REPL/TUI.
 * Chạy: node --test test/warmup.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";
import { setMaxToolOutputChars } from "../dist/tools/path-safety.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 3_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

/** Stub OpenAI-compatible server: record mọi body, trả text "ok" (step kết thúc). */
function startStub() {
  const bodies = [];
  const server = createServer((req, res) => {
    if (!req.url.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        // body có thể bị cắt giữa chừng nếu warm-up abort — vẫn record phần đã nhận
      }
      bodies.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1234, completion_tokens: 1 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        bodies,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

const baseCfg = (workdir, port, extra = {}) => ({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: "test-key",
  model: "test/model",
  provider: "openai",
  workdir,
  buildCmd: null,
  maxSteps: 3,
  maxTokens: 100,
  temperature: 0,
  yes: true,
  noSave: true,
  permissionMode: "auto",
  stream: false,
  // Probe (P1-1) skip khi đặt tường minh — test không phụ thuộc /props.
  contextWindow: 8192,
  ...extra,
});

describe("WARMUP: prefix prefill nền", () => {
  let stub;
  let dir;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "warmup-"));
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("warmup() gửi đúng 1 request max_tokens=1, không stream, không vào history", async () => {
    const agent = new Agent(baseCfg(dir, stub.port));
    try {
      await agent.warmup();
      assert.equal(stub.bodies.length, 1, `đúng 1 request warm-up, got ${stub.bodies.length}`);
      const body = stub.bodies[0];
      assert.equal(body.max_tokens, 1);
      assert.equal(body.stream, false);
      const sys = body.messages.find((m) => m.role === "system");
      assert.ok(sys && sys.content.length > 500, "system prompt phải có trong prefix");
      assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "tools phải được quảng cáo");
      assert.ok(
        body.messages.some((m) => m.role === "user" && m.content.includes("[warmup]")),
        "task placeholder [warmup]",
      );
      // History của agent KHÔNG bị nhiễm request warm-up.
      assert.equal(agent.messages.length, 0, "warm-up không được đụng this.messages");
    } finally {
      agent.dispose();
    }
  });

  it("idempotent: gọi warmup() lần 2 không gửi thêm request", async () => {
    const agent = new Agent(baseCfg(dir, stub.port));
    try {
      await Promise.all([agent.warmup(), agent.warmup()]);
      await agent.warmup();
      assert.equal(stub.bodies.length, 1);
    } finally {
      agent.dispose();
    }
  });

  it("cache-key alignment: system + tools của warm GIỐNG HẾT với của run thật", async () => {
    const agent = new Agent(baseCfg(dir, stub.port));
    try {
      await agent.warmup();
      await agent.run("hello there");
      const warm = stub.bodies[0];
      const runBody = stub.bodies.find((b) =>
        (b.messages ?? []).some((m) => m.role === "user" && m.content === "hello there"),
      );
      assert.ok(runBody, "phải có request của run()");
      const sysOf = (b) => (b.messages ?? []).find((m) => m.role === "system")?.content;
      assert.equal(sysOf(runBody), sysOf(warm), "system prompt phải trùng byte giữa warm và run");
      assert.equal(JSON.stringify(runBody.tools), JSON.stringify(warm.tools), "tools phải trùng byte");
      assert.equal(stub.bodies.filter((b) => b.max_tokens === 1).length, 1, "không có warm thứ hai");
    } finally {
      agent.dispose();
    }
  });

  it("race: run() tới khi warm còn bay → abort warm, run vẫn đúng 1 request", async () => {
    const agent = new Agent(baseCfg(dir, stub.port));
    try {
      const w = agent.warmup();
      await agent.run("hello race");
      await w;
      const warmReqs = stub.bodies.filter((b) => (b.messages ?? []).some((m) => String(m.content).includes("[warmup]")));
      const runReqs = stub.bodies.filter((b) => (b.messages ?? []).some((m) => m.content === "hello race"));
      assert.ok(warmReqs.length <= 1, `warm request tối đa 1, got ${warmReqs.length}`);
      assert.equal(runReqs.length, 1, "run thật đúng 1 request");
    } finally {
      agent.dispose();
    }
  });

  it('rc "warmup": false → no-op, 0 request', async () => {
    const agent = new Agent(baseCfg(dir, stub.port, { warmup: false }));
    try {
      await agent.warmup();
      assert.equal(stub.bodies.length, 0);
    } finally {
      agent.dispose();
    }
  });

  it("clientFactory (harness eval I-12) → warmup no-op, không ăn lượt kịch bản", async () => {
    let factoryChatCalls = 0;
    const fake = {
      model: "scripted",
      lastPartialToolCalls: [],
      setModel() {},
      chat: async () => {
        factoryChatCalls++;
        return { message: { role: "assistant", content: "ok" }, usage: {} };
      },
      async *streamChat() {
        yield { message: { role: "assistant", content: "ok" }, usage: undefined, finishReason: "stop" };
      },
    };
    const agent = new Agent(baseCfg(dir, stub.port, { clientFactory: () => fake }));
    try {
      await agent.warmup();
      assert.equal(factoryChatCalls, 0, "scripted client không được nhận request warm-up");
      assert.equal(stub.bodies.length, 0);
    } finally {
      agent.dispose();
    }
  });

  it("P1: read budget co theo context window (local, user không đặt)", async () => {
    const big = new Agent(baseCfg(dir, stub.port, { contextWindow: 96000 }));
    const small = new Agent(baseCfg(dir, stub.port, { contextWindow: 16128 }));
    const pinned = new Agent(baseCfg(dir, stub.port, { contextWindow: 96000, limits: { toolOutputChars: 3000 } }));
    try {
      // applyContextProbe return sớm khi window đã đặt → budget cũng apply path đó.
      await big.warmup();
      await small.warmup();
      await pinned.warmup();
      assert.equal(big.config.limits.toolOutputChars, 16000, "96k window → trần 16k chars");
      assert.equal(small.config.limits.toolOutputChars, 6000, "16k window → sàn 6k như cũ");
      assert.equal(pinned.config.limits.toolOutputChars, 3000, "user đặt tường minh luôn thắng");
    } finally {
      big.dispose();
      small.dispose();
      pinned.dispose();
      setMaxToolOutputChars(6000); // trả module budget về mặc định cho test khác
    }
  });

  it("P3: idle heartbeat re-warm — lần 2 bằng placeholder, sau run bằng HISTORY THẬT", async () => {
    const agent = new Agent(baseCfg(dir, stub.port, { contextWindow: 8192 }));
    agent.warmupIdleRefreshMs = 200; // test knob
    try {
      await agent.warmup();
      assert.equal(stub.bodies.length, 1);
      // Nhịp 1: timer fires sau 200ms → request warm thứ hai (vẫn placeholder, chưa có lượt thật).
      await waitUntil(() => stub.bodies.filter((b) => b.max_tokens === 1).length >= 2, 3000);
      // Run thật → finish() re-arm; heartbeat sau đó phải gửi HISTORY (không placeholder).
      await agent.run("hello heartbeat");
      await waitUntil(() => stub.bodies.some((b) => b.max_tokens === 1 && JSON.stringify(b.messages).includes("hello heartbeat")), 3000);
      const rewarms = stub.bodies.filter((b) => b.max_tokens === 1);
      assert.ok(rewarms.length >= 3, `≥3 request warm (1 khởi đầu + ≥2 heartbeat), got ${rewarms.length}`);
      // dispose phải chặn heartbeat: đếm, chờ, không tăng nữa.
      agent.dispose();
      const frozen = stub.bodies.length;
      await sleep(500);
      assert.equal(stub.bodies.length, frozen, "dispose() tắt timer");
    } finally {
      agent.dispose();
    }
  });

  it("P3: heartbeat guard — chỉ arm khi đã warmup THẬT và baseUrl local", async () => {
    const agent = new Agent(baseCfg(dir, stub.port));
    agent.warmupIdleRefreshMs = 200;
    try {
      // Chưa từng warmup (mode serve/run-once): schedule là no-op.
      agent.scheduleWarmupRefresh();
      assert.equal(agent.warmupIdleTimer, null, "serve/run-once không heartbeat");
      await agent.warmup(); // local baseUrl → cycle 1 chạy + arm timer
      assert.ok(agent.warmupIdleTimer, "warmup local xong → timer armed");
      // Cloud → guard chặn.
      const savedBase = agent.config.baseUrl;
      agent.config.baseUrl = "https://api.openai.com/v1";
      agent.scheduleWarmupRefresh();
      assert.equal(agent.warmupIdleTimer, null, "API trả phí: không đốt tiền giữ cache");
      agent.config.baseUrl = savedBase;
    } finally {
      agent.dispose();
    }
  });
});
