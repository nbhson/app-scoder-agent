/**
 * P2 — Command palette: model building + fuzzy ranking (pure), and a render
 * smoke test of the overlay (Ink → PassThrough, ANSI stripped).
 * Chạy: node --test test/tui-palette.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { buildPaletteItems, rankPaletteItems, Palette } from "../dist/tui/palette.js";

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

const custom = [
  { name: "commit", description: "draft a commit message", visibility: "public", aliases: [], body: "x", source: "project", filePath: "/p/commit.md" },
];
const agents = ["build", "plan", "review"];

describe("palette — model", () => {
  it("builds grouped catalog incl. actions/commands/custom/agents/themes/permissions", () => {
    const items = buildPaletteItems({ agents, custom, themes: ["mission", "light"] });
    const groups = [...new Set(items.map((i) => i.group))];
    assert.deepEqual(groups, ["ACTIONS", "COMMANDS", "CUSTOM", "AGENTS", "THEMES", "PERMISSION"]);
    const sessions = items.find((i) => i.invoke.action === "sessions");
    assert.ok(sessions, "opens the session picker as an action");
    const themeItem = items.find((i) => i.label === "theme: light");
    assert.equal(themeItem.invoke.text, "/theme light");
    const permItem = items.find((i) => i.label === "permission: ask");
    assert.equal(permItem.invoke.text, "/permission ask");
    const commit = items.find((i) => i.label === "/commit");
    assert.equal(commit.invoke.text, "/commit");
  });

  it("empty query keeps group order, capped at limit", () => {
    const items = buildPaletteItems({ agents, custom });
    const shown = rankPaletteItems(items, "");
    assert.equal(shown[0].group, "ACTIONS");
    assert.ok(shown.length <= 14);
  });

  it("ranks label matches above description matches", () => {
    const items = buildPaletteItems({ agents, custom });
    const shown = rankPaletteItems(items, "model");
    assert.equal(shown[0].label, "/model", "/model beats '/agent build (switch primary agent…)'");
  });

  it("subsequence + typo-ish fuzzy still finds /permission", () => {
    const items = buildPaletteItems({ agents, custom });
    const shown = rankPaletteItems(items, "perm");
    assert.ok(shown.some((i) => i.label === "/permission" || i.label.startsWith("permission:")));
  });

  it("no match → empty list (never crashes, never falls back to all)", () => {
    const items = buildPaletteItems({ agents, custom });
    assert.deepEqual(rankPaletteItems(items, "zzqqx"), []);
  });
});

describe("palette — render", () => {
  it("shows search line, group headers and hints; clipped rows never exceed width", async () => {
    const stream = new PassThrough();
    stream.columns = 100;
    stream.rows = 30;
    // useInput needs a raw-mode-capable stdin; a fake TTY PassThrough suffices.
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    let out = "";
    stream.on("data", (c) => (out += String(c)));
    const app = render(
      React.createElement(Palette, {
        agents,
        custom,
        onInvoke: () => {},
        onClose: () => {},
      }),
      { stdout: stream, stderr: stream, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await new Promise((r) => setTimeout(r, 80));
    app.unmount();
    await app.waitUntilExit();
    const text = stripAnsi(out);
    assert.match(text, /⌕/);
    assert.match(text, /ACTIONS/);
    assert.match(text, /search commands, agents, themes/);
    assert.match(text, /Up\/Down select · Enter run · Esc close/);
    for (const line of text.split("\n")) {
      assert.ok(stringWidth(line) <= 100, `row overflow: ${line}`);
    }
  });
});
