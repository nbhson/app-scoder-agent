/**
 * Unit tests cho .env read policy (H-04, dời từ P1).
 * Chạy: node --test test/env-policy.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, isProtectedEnvFile } from "../dist/tools.js";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "envpol-"));
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, ".env"), "SECRET_KEY=abc123\n");
  writeFileSync(join(workdir, ".env.example"), "SECRET_KEY=\n");
  writeFileSync(join(workdir, "src", "keep.ts"), "export {}\n");
  writeFileSync(join(workdir, "src", ".env"), "NESTED=1\n");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("isProtectedEnvFile (H-04)", () => {
  it(".env → ask", () => assert.equal(isProtectedEnvFile(".env"), "ask"));
  it("src/.env → ask", () => assert.equal(isProtectedEnvFile("src/.env"), "ask"));
  it(".env.local → ask", () => assert.equal(isProtectedEnvFile(".env.local"), "ask"));
  it(".env.example → allow", () => assert.equal(isProtectedEnvFile(".env.example"), "allow"));
  it("env.ts → null (không phải env file)", () => assert.equal(isProtectedEnvFile("src/env.ts"), null));
});

describe("toolReadFile .env policy", () => {
  const run = getTool("read_file").run;
  it(".env → ASK_PERMISSION, không trả nội dung", async () => {
    const r = await run({ workdir }, { path: ".env" });
    assert.equal(r.ok, false);
    assert.match(r.output, /ASK_PERMISSION/);
    assert.ok(!r.output.includes("abc123"), "secrets không được leak");
  });
  it(".env.example → đọc bình thường", async () => {
    const r = await run({ workdir }, { path: ".env.example" });
    assert.equal(r.ok, true);
    assert.match(r.output, /SECRET_KEY/);
  });
  it("nested .env cũng ask", async () => {
    const r = await run({ workdir }, { path: "src/.env" });
    assert.match(r.output, /ASK_PERMISSION/);
  });
});
