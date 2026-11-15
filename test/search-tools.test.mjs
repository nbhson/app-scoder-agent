/**
 * Unit tests cho grep/glob tools (I-07).
 * Chạy: node --test test/search-tools.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {toolGrep, toolGlob, globToRegExp} from "../dist/tools/search.js";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "search-"));
  mkdirSync(join(workdir, "src"), { recursive: true });
  mkdirSync(join(workdir, "node_modules"), { recursive: true });
  writeFileSync(join(workdir, "src", "a.ts"), "export function alpha() {}\nconst beta = 1;\n");
  writeFileSync(join(workdir, "src", "b.ts"), "import { alpha } from './a.js';\nbeta;\n");
  writeFileSync(join(workdir, "root.md"), "# alpha doc\n");
  writeFileSync(join(workdir, "node_modules", "c.js"), "alpha();\n"); // phải bị skip
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("toolGrep (I-07)", () => {
  it("tìm được hits dạng path:line:text", async () => {
    const r = await toolGrep(workdir, { pattern: "alpha" });
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/a\.ts:\d+:/);
    assert.match(r.output, /root\.md:\d+:/);
  });
  it("node_modules bị skip", async () => {
    const r = await toolGrep(workdir, { pattern: "alpha" });
    assert.ok(!r.output.includes("node_modules"));
  });
  it("include filter", async () => {
    const r = await toolGrep(workdir, { pattern: "alpha", include: "*.md" });
    assert.match(r.output, /root\.md/);
    assert.ok(!r.output.includes("a.ts"));
  });
  it("no matches → (no matches)", async () => {
    const r = await toolGrep(workdir, { pattern: "zzznotexist" });
    assert.equal(r.ok, true);
    assert.match(r.output, /no matches/);
  });
  it("pattern rỗng → lỗi", async () => {
    const r = await toolGrep(workdir, { pattern: "" });
    assert.equal(r.ok, false);
  });
});

describe("globToRegExp (I-07)", () => {
  it("** cross directories", async () => {
    const rx = globToRegExp("src/**/*.ts");
    assert.ok(rx.test("src/a/b/c.ts"));
    assert.ok(rx.test("src/x.ts"));
    assert.ok(!rx.test("root.md"));
  });
  it("* một level", async () => {
    const rx = globToRegExp("src/*.ts");
    assert.ok(rx.test("src/a.ts"));
    assert.ok(!rx.test("src/x/a.ts"));
  });
  it("? một ký tự", async () => {
    assert.ok(globToRegExp("?.ts").test("a.ts"));
    assert.ok(!globToRegExp("?.ts").test("ab.ts"));
  });
  it("{a,b} alternatives", async () => {
    const rx = globToRegExp("*.{ts,md}");
    assert.ok(rx.test("a.ts"));
    assert.ok(rx.test("b.md"));
    assert.ok(!rx.test("c.js"));
  });
});

describe("toolGlob (I-07)", () => {
  it("tìm files theo pattern", async () => {
    const r = toolGlob(workdir, { pattern: "src/**/*.ts" });
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/a\.ts/);
    assert.match(r.output, /src\/b\.ts/);
  });
  it("node_modules bị skip", async () => {
    const r = toolGlob(workdir, { pattern: "**/*.js" });
    assert.ok(!r.output.includes("node_modules"));
  });
  it("no match → (no files match)", async () => {
    const r = toolGlob(workdir, { pattern: "**/*.rs" });
    assert.match(r.output, /no files match/);
  });
});
