/**
 * T-09 unit tests — theme engine (getTheme resolution + hot-swap).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getTheme, setActiveTheme, useNamedTheme, THEMES, defaultThemeName } from "../dist/tui/theme.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "t09-"));
  setActiveTheme(THEMES.mission);
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));

describe("getTheme (T-09)", () => {
  it("no theme.json → mission default", () => {
    assert.equal(getTheme(workdir).brand, "magenta");
  });
  it("name: paper → paper palette", () => {
    mkdirSync(join(workdir, ".scoder"), { recursive: true });
    writeFileSync(join(workdir, ".scoder", "theme.json"), JSON.stringify({ name: "paper" }));
    assert.equal(getTheme(workdir).brand, "blue");
  });
  it("inline color override", () => {
    mkdirSync(join(workdir, ".scoder"), { recursive: true });
    writeFileSync(join(workdir, ".scoder", "theme.json"), JSON.stringify({ brand: "green" }));
    assert.equal(getTheme(workdir).brand, "green");
    assert.equal(getTheme(workdir).accent, "cyan"); // rest from mission
  });
  it("malformed json → default", () => {
    mkdirSync(join(workdir, ".scoder"), { recursive: true });
    writeFileSync(join(workdir, ".scoder", "theme.json"), "{oops");
    assert.equal(getTheme(workdir).brand, "magenta");
  });
});

describe("useNamedTheme (T-09)", () => {
  it("hot-swap mono", () => {
    const notice = useNamedTheme("mono");
    assert.match(notice, /mono/);
    assert.equal(THEMES.mono.success, "white");
    setActiveTheme(THEMES.mono);
  });
  it("unknown → ERROR", () => {
    assert.match(useNamedTheme("nope"), /^ERROR/);
  });
});

describe("T8 — theme pack + terminal caps", () => {
  it("6 theme builtin", () => {
    assert.deepEqual(Object.keys(THEMES).sort(), ["high-contrast", "light", "mission", "mono", "paper", "solarized"]);
  });
  it("/theme list → notice liệt kê", () => {
    const notice = useNamedTheme("list");
    assert.match(notice, /mission/);
    assert.match(notice, /solarized/);
    assert.doesNotMatch(notice, /^ERROR/);
  });
  it("defaultThemeName: TERM=dumb → mono (degrade)", () => {
    assert.equal(defaultThemeName({ TERM: "dumb" }), "mono");
    assert.equal(defaultThemeName({}), "mono");
    assert.equal(defaultThemeName({ TERM: "xterm-256color" }), "mission");
    assert.equal(defaultThemeName({ TERM: "xterm", COLOR_COUNT: "8" }), "mono");
  });
  it("getTheme không theme.json theo caps default", () => {
    assert.equal(getTheme(workdir).brand, "magenta"); // TERM thật trong test env ≠ dumb
  });
});
