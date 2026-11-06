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
  it("tìm được hits dạng path:line:text", () => {
    const r = toolGrep(workdir, { pattern: "alpha" });
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/a\.ts:\d+:/);
    assert.match(r.output, /root\.md:\d+:/);
  });
  it("node_modules bị skip", () => {
    const r = toolGrep(workdir, { pattern: "alpha" });
    assert.ok(!r.output.includes("node_modules"));
  });
  it("include filter", () => {
    const r = toolGrep(workdir, { pattern: "alpha", include: "*.md" });
    assert.match(r.output, /root\.md/);
    assert.ok(!r.output.includes("a.ts"));
  });
  it("no matches → (no matches)", () => {
    const r = toolGrep(workdir, { pattern: "zzznotexist" });
    assert.equal(r.ok, true);
    assert.match(r.output, /no matches/);
  });
  it("pattern rỗng → lỗi", () => {
    const r = toolGrep(workdir, { pattern: "" });
    assert.equal(r.ok, false);
  });
});

describe("globToRegExp (I-07)", () => {
  it("** cross directories", () => {
    const rx = globToRegExp("src/**/*.ts");
    assert.ok(rx.test("src/a/b/c.ts"));
    assert.ok(rx.test("src/x.ts"));
    assert.ok(!rx.test("root.md"));
  });
  it("* một level", () => {
    const rx = globToRegExp("src/*.ts");
    assert.ok(rx.test("src/a.ts"));
    assert.ok(!rx.test("src/x/a.ts"));
  });
  it("? một ký tự", () => {
    assert.ok(globToRegExp("?.ts").test("a.ts"));
    assert.ok(!globToRegExp("?.ts").test("ab.ts"));
  });
  it("{a,b} alternatives", () => {
    const rx = globToRegExp("*.{ts,md}");
    assert.ok(rx.test("a.ts"));
    assert.ok(rx.test("b.md"));
    assert.ok(!rx.test("c.js"));
  });
});

describe("toolGlob (I-07)", () => {
  it("tìm files theo pattern", () => {
    const r = toolGlob(workdir, { pattern: "src/**/*.ts" });
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/a\.ts/);
    assert.match(r.output, /src\/b\.ts/);
  });
  it("node_modules bị skip", () => {
    const r = toolGlob(workdir, { pattern: "**/*.js" });
    assert.ok(!r.output.includes("node_modules"));
  });
  it("no match → (no files match)", () => {
    const r = toolGlob(workdir, { pattern: "**/*.rs" });
    assert.match(r.output, /no files match/);
  });
});
