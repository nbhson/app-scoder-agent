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

/**
 * CI determinism: defaultThemeName() đọc process.env — GitHub Actions runner
 * KHÔNG set TERM → "mono" (brand 'white') và mọi assertion mission/magenta
 * fail, trong khi máy dev có TERM thì xanh. Pin env cho toàn file (restore
 * sau mỗi test) — test vẫn asserted đúng logic caps, chỉ bỏ phụ thuộc môi trường.
 */
const CAPS_ENV = ["TERM", "COLORTERM", "NO_COLOR", "SCODER_THEME", "SCODER_PLAIN", "COLOR_COUNT"];
let savedCapsEnv = {};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "t09-"));
  setActiveTheme(THEMES.mission);
  for (const k of CAPS_ENV) savedCapsEnv[k] = process.env[k];
  for (const k of CAPS_ENV) delete process.env[k];
  process.env.TERM = "xterm-256color";
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  for (const k of CAPS_ENV) {
    if (savedCapsEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedCapsEnv[k];
  }
});

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
