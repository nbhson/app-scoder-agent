/**
 * Integration test cho `scoder serve` (HTTP API + SSE).
 * Mock LLM (test/mock-llm.mjs) + server; POST một task, đọc SSE events
 * cho tới finish, kiểm tra tool_output streaming và abort.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../dist/server.js";

// ── Temp project: build.js fails until lib.js is fixed ──────────────────────
const tmp = mkdtempSync(join(tmpdir(), "scoder-server-test-"));
writeFileSync(
  join(tmp, "build.js"),
  "const lib = require('./lib.js');\n" +
    "if (lib.add(2, 3) !== 5) { console.error('FAIL: add(2,3)=' + lib.add(2, 3)); process.exit(1); }\n" +
    "console.log('PASS');\n",
);
writeFileSync(join(tmp, "lib.js"), "module.exports.add = (a, b) => a - b; // BUG\n");

// ── Mock LLM server (scripted closed loop) ──────────────────────────────────
const mock = spawn("node", ["./test/mock-llm.mjs"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
const mockPort = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("mock LLM did not report a port")), 10_000);
  mock.stdout.on("data", (c) => {
    const m = String(c).match(/MOCK_LLM_PORT=(\d+)/);
    if (m) {
      clearTimeout(t);
      resolve(Number(m[1]));
    }
  });
  mock.on("exit", () => {
    clearTimeout(t);
    reject(new Error("mock LLM crashed on startup"));
  });
});
const BASE_URL = `http://127.0.0.1:${mockPort}`;

// Wait for the mock LLM to accept connections
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${BASE_URL}/chat/completions`, { method: "POST", body: "{}" });
    break;
  } catch {
    await new Promise((res) => setTimeout(res, 100));
  }
}

const cfg = {
  baseUrl: BASE_URL,
  apiKey: "mock-key",
  model: "mock/model",
  provider: "openai",
  workdir: tmp,
  buildCmd: "node build.js",
  maxSteps: 40,
  maxTokens: 8192,
  temperature: 0.2,
  yes: true,
  stream: true,
  permissionMode: "auto",
  noSave: true,
};

const srv = await startServer(cfg, { port: 0 });
const API = `http://127.0.0.1:${srv.port}`;

/** Collect SSE `data:` events from an /events URL until the stream closes. */
async function collectEvents(eventsUrl, timeoutMs = 40_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("SSE collect timeout")), timeoutMs);
  try {
    const res = await fetch(eventsUrl.startsWith("http") ? eventsUrl : `${API}${eventsUrl}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            events.push(JSON.parse(line.slice(6)));
          }
        }
      }
      if (events.some((e) => e.type === "finish" || e.type === "error")) break;
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

after(async () => {
  mock.kill();
  rmSync(tmp, { recursive: true, force: true });
  await srv.close();
});

describe("scoder serve — HTTP API", () => {
  it("GET /api/health -> ok", async () => {
    const res = await fetch(`${API}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("POST /api/runs -> 400 khi thiếu task", async () => {
    const res = await fetch(`${API}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/runs -> 400 khi permission=ask (server không prompt được)", async () => {
    const res = await fetch(`${API}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "x", permission: "ask" }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.json().then((b) => b.error), /ask.*not supported/);
  });

  it("closed loop qua SSE: run_start -> tool_call -> tool_output -> build -> finish(success)", async () => {
    const postRes = await fetch(`${API}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "Add an add function to lib.js that returns a + b" }),
    });
    assert.equal(postRes.status, 202);
    const created = await postRes.json();
    assert.ok(created.id, "phải trả về id");
    assert.equal(created.status, "running");
    assert.match(created.eventsUrl, /\/events$/);

    const events = await collectEvents(created.eventsUrl);
    const types = new Set(events.map((e) => e.type));

    assert.ok(types.has("run_start"), "phải có run_start");
    assert.ok(types.has("step"));
    assert.ok(types.has("tool_call"), "phải có tool_call");
    assert.ok(types.has("tool_result"), "phải có tool_result");
    assert.ok(types.has("tool_output"), "run_command phải phát tool_output (stream realtime)");
    assert.ok(types.has("build"), "phải có build event");
    assert.ok(types.has("finish"), "stream phải kết thúc bằng finish event");

    const runStart = events.find((e) => e.type === "run_start");
    assert.equal(runStart.buildCmd, "node build.js");

    // run_command streaming: tool_output của run_command phải chứa PASS
    const outputs = events.filter((e) => e.type === "tool_output").map((e) => e.delta).join("");
    assert.match(outputs, /PASS/, "output realtime của build phải nằm trong tool_output events");

    const finish = events.find((e) => e.type === "finish");
    assert.equal(finish.success, true, `task phải thành công (summary: ${finish.summary})`);

    // Run status sau khi xong
    const statusRes = await fetch(`${API}/api/runs/${created.id}`);
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.status, "success");
    assert.ok(status.finishedAt);
  }, 60_000);

  it("GET /api/runs liệt kê run đã hoàn thành", async () => {
    const res = await fetch(`${API}/api/runs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.runs.length >= 1);
    const finished = body.runs.find((r) => r.status === "success");
    assert.ok(finished, "run e2e trước đó phải success");
  });

  it("GET /api/runs/<id> lạ -> 404; method lạ -> 405", async () => {
    const notFound = await fetch(`${API}/api/runs/00000000-0000-4000-8000-000000000000`);
    assert.equal(notFound.status, 404);
    const res405 = await fetch(`${API}/api/runs`, { method: "DELETE" });
    assert.equal(res405.status, 405);
  });

  it("POST /api/runs/<id>/abort -> run bị hủy (status=aborted)", async () => {
    // Mock riêng: luôn trả run_command "sleep 30" → command đang chạy chờ abort.
    const slowMock = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "t1",
                      type: "function",
                      function: { name: "run_command", arguments: JSON.stringify({ command: "sleep 30", timeout_secs: 60 }) },
                    },
                  ],
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise((res) => slowMock.listen(0, "127.0.0.1", res));
    const slowPort = slowMock.address().port;

    const srv2 = await startServer({ ...cfg, baseUrl: `http://127.0.0.1:${slowPort}` }, { port: 0 });
    try {
      const postRes = await fetch(`http://127.0.0.1:${srv2.port}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "abort me" }),
      });
      assert.equal(postRes.status, 202);
      const created = await postRes.json();

      const eventsPromise = collectEvents(`http://127.0.0.1:${srv2.port}${created.eventsUrl}`, 30_000);
      // Đợi run_command (sleep 30) đang chạy rồi mới abort
      await new Promise((res) => setTimeout(res, 500));
      const abortRes = await fetch(`http://127.0.0.1:${srv2.port}/api/runs/${created.id}/abort`, { method: "POST" });
      assert.equal(abortRes.status, 200);

      const events = await eventsPromise;
      const finish = events.find((e) => e.type === "finish");
      assert.ok(finish, "abort phải sinh finish event");
      assert.equal(finish.success, false, `abort phải kết thúc không thành công (summary: ${finish.summary})`);

      const status = await (await fetch(`http://127.0.0.1:${srv2.port}/api/runs/${created.id}`)).json();
      assert.equal(status.status, "aborted");
    } finally {
      await srv2.close();
      slowMock.close();
    }
  }, 30_000);
});

describe("scoder serve — token auth", () => {
  it("SCODER_SERVER_TOKEN -> chặn request không có token", async () => {
    process.env.SCODER_SERVER_TOKEN = "test-secret";
    const srv2 = await startServer({ ...cfg, workdir: tmp }, { port: 0 });
    try {
      const noAuth = await fetch(`http://127.0.0.1:${srv2.port}/api/health`);
      assert.equal(noAuth.status, 401);
      const withAuth = await fetch(`http://127.0.0.1:${srv2.port}/api/health`, {
        headers: { Authorization: "Bearer test-secret" },
      });
      assert.equal(withAuth.status, 200);
    } finally {
      delete process.env.SCODER_SERVER_TOKEN;
      await srv2.close();
    }
  });
});

