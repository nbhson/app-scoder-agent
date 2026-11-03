/**
 * G3: run_command redaction + child env allowlist.
 * Chạy: node --test test/redact-exec-env.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolRunCommand, buildChildEnv } from "../dist/tools.js";

describe("toolRunCommand redaction (G3)", () => {
  it("secret shape qua stdout → REDACTED trong output", async () => {
    const r = await toolRunCommand(process.cwd(), { command: "echo 'token sk-abcdefghijklmnop12'" });
    assert.ok(!r.output.includes("sk-abcdefghijklmnop12"), `phải redact: ${r.output}`);
    assert.match(r.output, /REDACTED/);
  });

  it("secret qua stderr → REDACTED", async () => {
    const r = await toolRunCommand(process.cwd(), { command: "echo 'ghp_abcdefghijklmnopqrstuvwxyz1234' >&2" });
    assert.ok(!r.output.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
    assert.match(r.output, /REDACTED/);
  });

  it("live onOutput stream cũng được redact", async () => {
    const chunks = [];
    await toolRunCommand(process.cwd(), { command: "echo Bearer abcdef123456" }, undefined, (_s, d) => chunks.push(d));
    const all = chunks.join("");    assert.ok(!all.includes("abcdef123456"));
    assert.match(all, /REDACTED/);
  });

  it("output thường không bị đổi", async () => {
    const r = await toolRunCommand(process.cwd(), { command: "echo hello world" });
    assert.equal(r.ok, true);
    assert.match(r.output, /hello world/);
  });
});

describe("buildChildEnv (G3)", () => {
  it("chỉ chứa base allowlist keys — không rò secret env", () => {
    process.env.SCROOGE_TEST_SECRET = "supersecret-value";
    const env = buildChildEnv(process.cwd());
    assert.ok(env.PATH, "PATH phải có");
    assert.equal(env.SCROOGE_TEST_SECRET, undefined, "secret ngoài allowlist không được kế thừa");
    delete process.env.SCROOGE_TEST_SECRET;
  });

  it("secret env KHÔNG qua con (end-to-end qua shell)", async () => {
    process.env.SCROOGE_TEST_SECRET = "leak-me-please";
    const r = await toolRunCommand(process.cwd(), { command: "echo $SCROOGE_TEST_SECRET" });
    assert.ok(!r.output.includes("leak-me-please"), `env phải bị chặn: ${r.output}`);
    delete process.env.SCROOGE_TEST_SECRET;
  });

  it("shellEnvAllow trong rc → var đó được pass qua (extraKeys allowlist)", () => {
    process.env.SCROOGE_TEST_SECRET = "allowed-value";
    const env = buildChildEnv(process.cwd(), ["SCROOGE_TEST_SECRET"]);
    assert.equal(env.SCROOGE_TEST_SECRET, "allowed-value");
    delete process.env.SCROOGE_TEST_SECRET;
  });
});
