#!/usr/bin/env node
// Integration test: start mock LLM, create a temp project, run the agent, verify it fixes the bug.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const tmp = mkdtempSync(join(tmpdir(), "coder-agent-test-"));

// Build-checker script: passes only if lib.add(2,3) === 5
writeFileSync(join(tmp, "build.js"), `
const lib = require('./lib.js');
const r = lib.add(2, 3);
if (r !== 5) { console.error('FAIL: add(2,3)=' + r + ' expected 5'); process.exit(1); }
console.log('PASS: add(2,3)=5');
process.exit(0);
`);

// Placeholder lib.js (will be overwritten by agent via write_file tool)
// We don't write a buggy one here because the mock LLM already does write_file.
// Just put a stub so node build.js can fail with a clear error if agent hasn't fixed it yet.
writeFileSync(join(tmp, "lib.js"), "// placeholder — will be set by agent\n");

console.error("[test] temp dir:", tmp);
console.error("[test] build.js:", join(tmp, "build.js"));
console.error("[test] build.js content:", execFileSync("cat", [join(tmp, "build.js")], { encoding: "utf8" }).trim());

// Start mock LLM server (random port — printed to stdout as MOCK_LLM_PORT=<n>)
const mockServer = spawn("node", ["./test/mock-llm.mjs"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
mockServer.stderr.on("data", (c) => process.stderr.write(c));

const mockPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("mock LLM server did not report a port in time")), 10_000);
  mockServer.stdout.on("data", (c) => {
    const m = String(c).match(/MOCK_LLM_PORT=(\d+)/);
    if (m) {
      clearTimeout(timer);
      resolve(Number(m[1]));
    }
  });
  mockServer.on("exit", (c) => {
    clearTimeout(timer);
    resolve(null); // server crashed on startup
  });
});

// Readiness: poll until the server responds (robust on slow CI runners)
const BASE_URL = `http://127.0.0.1:${mockPort}`;
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${BASE_URL}/chat/completions`, { method: "POST", body: "{}" });
    break; // any HTTP response means the server is up
  } catch {
    await new Promise((res) => setTimeout(res, 100));
  }
}

// Run the agent
const agent = spawn("node", [join(process.cwd(), "dist/index.js"), "-m", "mock/model", "--base-url", `http://127.0.0.1:${mockPort}`, "-B", "node build.js", "-y", `Add an add function to lib.js that returns a + b (the correct formula). The build command is "node build.js" which tests that add(2,3) equals 5.`], {
  cwd: tmp,
  stdio: "inherit",
  env: { ...process.env, CODER_API_KEY: "mock-key" },
});

// Give it time to finish (max 30s)
const exitCode = await new Promise((res) => {
  const t = setTimeout(() => res("timeout"), 30_000);
  agent.on("exit", (c) => { clearTimeout(t); res(c); });
});

mockServer.kill();
rmSync(tmp, { recursive: true, force: true });

if (exitCode === 0) {
  console.log("\n✅ INTEGRATION TEST PASSED: agent closed-loop worked correctly");
  process.exit(0);
} else {
  console.error(`\n❌ INTEGRATION TEST FAILED: exit code=${exitCode} (expected 0)`);
  process.exit(1);
}
