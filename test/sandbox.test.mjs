/**
 * G4: sandbox layer cho run_command — plan/argv build + detection.
 * Chạy: node --test test/sandbox.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxArgv, planSandbox, sandboxWritePaths } from "../dist/sandbox.js";
import { toolRunCommand } from "../dist/tools.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildSandboxArgv (G4)", () => {
  it("sandbox-exec: readonly — profile chứa deny file-write*, không subpath rw", () => {
    const argv = buildSandboxArgv("sandbox-exec", "readonly", "/ws", "ls -la");
    assert.equal(argv[0], "sandbox-exec");
    assert.equal(argv[1], "-p");
    assert.match(argv[2], /deny file-write\*/);
    assert.ok(!argv[2].includes("allow file-write*"));
    assert.equal(argv[3], "/bin/sh");
    assert.equal(argv[4], "-c");
    assert.equal(argv[5], "ls -la");
  });

  it("sandbox-exec: workspace-write — allow write trong workspace + /tmp", () => {
    const argv = buildSandboxExecArgvSafe();
    assert.match(argv, /allow file-write\*/);
    function buildSandboxExecArgvSafe() {
      const a = buildSandboxArgv("sandbox-exec", "workspace-write", "/ws", "x");
      return String(a[2]);
    }
  });

  it("bwrap: readonly — workspace ro; workspace-write — workspace rw", () => {
    const ro = buildSandboxArgv("bwrap", "readonly", "/ws", "x");
    assert.ok(!ro.includes("--bind /ws"), "readonly không có rw bind workspace");
    const rw = buildSandboxArgv("bwrap", "workspace-write", "/ws", "x");
    assert.ok(rw.includes("--bind"));
    assert.ok(rw.some((a, i) => a === "--bind" && rw[i + 1] === "/ws"));
  });

  it("docker: volume workspace, entrypoint sh", () => {
    const argv = buildSandboxArgv("docker", "readonly", "/ws", "x");
    assert.equal(argv[0], "docker");
    assert.ok(argv.some((a) => String(a).startsWith("/workspace")));
  });
});

describe("planSandbox (G4)", () => {
  it("mode off / không set → null (chạy trực tiếp)", () => {
    assert.equal(planSandbox({}, "/ws", "x"), null);
    assert.equal(planSandbox({ mode: "off" }, "/ws", "x"), null);
  });

  it("mode readonly → plan với wrapper mặc định theo platform", () => {
    const p = planSandbox({ mode: "readonly" }, "/ws", "x");
    assert.ok(p);
    assert.equal(p.profile, "readonly");
    assert.equal(p.wrapper, process.platform === "darwin" ? "sandbox-exec" : "bwrap");
  });

  it("wrapper override được tôn trọng", () => {
    const p = planSandbox({ mode: "workspace-write", wrapper: "docker" }, "/ws", "x");
    assert.equal(p?.wrapper, "docker");
  });
});

describe("sandboxWritePaths (G4)", () => {
  it("workspace + tmp", () => {
    const paths = sandboxWritePaths("/ws");
    assert.ok(paths.includes("/ws"));
    assert.ok(paths.includes("/tmp"));
  });
});

describe("toolRunCommand sandbox wiring (G4, e2e nhẹ)", () => {
  it("mode off → hành vi cũ (echo chạy bình thường)", async () => {
    const r = await toolRunCommand(process.cwd(), { command: "echo sandbox-off-ok" }, undefined, undefined, { mode: "off" });
    assert.equal(r.ok, true);
    assert.match(r.output, /sandbox-off-ok/);
  });

  it("sandbox-exec readonly (macOS) — ghi trong workspace vẫn được khi profile workspace-write", async () => {
    if (process.platform !== "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "sbx-"));
    try {
      const r = await toolRunCommand(dir, { command: "echo hi > inside.txt && cat inside.txt" }, undefined, undefined, { mode: "workspace-write" });
      assert.equal(r.ok, true, `output: ${r.output}`);
      assert.match(r.output, /hi/);
      assert.match(readFileSync(join(dir, "inside.txt"), "utf8"), /hi/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
