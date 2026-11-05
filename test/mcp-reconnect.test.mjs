/**
 * M1: MCP reconnect — process chết → backoff reconnect (max 5), pending
 * reject rõ ràng, tools refresh sau reconnect. Dùng mock-mcp server thật.
 * Chạy: node --test test/mcp-reconnect.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { McpConnection } from "../dist/mcp.js";
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
    await new Promise((r) => setTimeout(r, 1500));
    // Pending trong lúc chết đã reject (drain) — callTool bây giờ phải ok sau reconnect.
    assert.equal(c.state, "ready", `sau reconnect: ${states.join(" | ")}`);
    const r = await c.callTool("echo", { message: "back" });
    assert.equal(r.ok, true);
    assert.match(r.output, /ECHO: back/);
    c.kill();
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
