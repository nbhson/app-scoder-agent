/**
 * M1: MCP reconnect — process chết → backoff reconnect (max 5), pending
 * reject rõ ràng, tools refresh sau reconnect. Dùng mock-mcp server thật.
 * Chạy: node --test test/mcp-reconnect.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {McpConnection} from "../dist/mcp/connection.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "mock-mcp.mjs");

const cfg = { command: "node", args: [MOCK] };

describe("M1 — McpConnection reconnect", () => {
  it("connect → callTool ok", async () => {
    const c = new McpConnection("m", cfg);
    await c.connect();
    const r = await c.callTool("echo", { message: "hi" });
    assert.equal(r.ok, true);
    assert.match(r.output, /ECHO: hi/);
    c.kill();
  });

  it("process chết → pending reject rõ ràng → reconnect → call ok lại", async () => {
    const c = new McpConnection("m", cfg);
    const states = [];
    c.onState = (s, d) => states.push(`${s}:${d}`);
    await c.connect();
    assert.equal(c.state, "ready");

    // Giết process tree — taskkill /T kill cả cmd.exe + node child (Windows fix
    // cho shell:true spawn orphaning).  SIGKILL only kills the shell, leaving
    // the real node child alive and holding stdout, so the test hangs.
    const pid = c.proc?.pid;
    if (pid && process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      c.proc?.kill("SIGKILL");
    }
    // Fix flaky (2 nguồn):
    // 1) SIGKILL tới OS nhanh nhưng 'exit' event tới node trễ ~ms — lúc vừa
    //    kill thì c.state VẪN "ready"; poll "tới khi ready" sẽ thoat ngay lap
    //    đầu rồi assert fail. Phải thấy chết trước (state rời "ready"), rồi
    //    mới chờ backoff reconnect đưa về "ready".
    // 2) Mọi fixed sleep (1500ms cũ) là coin-toss trên CI chậm.
    // Cap 10s cho mỗi giai đoạn; c.kill() trong finally — test fail không để
    // lại mock-mcp mồ côi giữ event-loop treo cả file.
    try {
      const t0 = Date.now();
      while (c.state === "ready" && Date.now() - t0 < 10_000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.notEqual(c.state, "ready", `phải thấy process chết: ${states.join(" | ")}`);
      const t1 = Date.now();
      while (c.state !== "ready" && Date.now() - t1 < 10_000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Pending trong lúc chết đã reject (drain) — callTool bây giờ phải ok sau reconnect.
      assert.equal(c.state, "ready", `sau reconnect: ${states.join(" | ")}`);
      const r = await c.callTool("echo", { message: "back" });
      assert.equal(r.ok, true);
      assert.match(r.output, /ECHO: back/);
    } finally {
      c.kill();
    }
    assert.equal(c.state, "dead");
  });

  it("healthy(): server sống → true", async () => {
    const c = new McpConnection("m", cfg);
    await c.connect();
    assert.equal(await c.healthy(3_000), true);
    c.kill();
  });

  it("healthy(): server chết → false (không treo)", async () => {
    const c = new McpConnection("m", cfg);
    await c.connect();
    const pid = c.proc?.pid;
    if (pid && process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      c.proc?.kill("SIGKILL");
    }
    // Chờ reconnect bắt đầu rồi đo healthy ngay (đang reconnect = alive false lúc đó)
    await new Promise((r) => setTimeout(r, 30));
    c.kill();
    assert.equal(await c.healthy(2_000), false);
  });
});
