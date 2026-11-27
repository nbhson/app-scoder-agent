/**
 * `/shortcut` — pure cheat-sheet helpers (shortcuts.ts) + wiring checks.
 * Chạy: node --test test/tui-shortcuts.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shortcutSections, formatShortcuts } from "../dist/tui/shortcuts.js";
import { parseSlashCommand, resolveCommandDef, SLASH_COMMANDS } from "../dist/commands/definitions.js";

describe("shortcutSections", () => {
  it("has a GLOBAL section and every row carries keys + what", () => {
    const secs = shortcutSections();
    assert.ok(secs.some((s) => s.title === "GLOBAL"), "GLOBAL section present");
    for (const s of secs) {
      assert.ok(s.rows.length > 0, `${s.title} is not empty`);
      for (const r of s.rows) {
        assert.ok(r.keys.trim().length > 0, `${s.title}: every row has a key`);
        assert.ok(r.what.trim().length > 0, `${s.title}: every row has a description`);
      }
    }
  });

  it("documents the headline bindings the app actually handles", () => {
    const all = shortcutSections().flatMap((s) => s.rows.map((r) => r.keys));
    for (const k of ["Ctrl+P", "Ctrl+S", "Ctrl+B", "Ctrl+O", "Ctrl+T", "Shift+Tab", "Shift+P", "?", "/view", "Esc", "Ctrl+C"]) {
      assert.ok(all.includes(k), `keybinding ${k} listed`);
    }
  });

  it("spells out modifiers — no ⌃ ⇧ ⏎ ⇥ glyphs anywhere in the sheet", () => {
    for (const s of shortcutSections()) {
      for (const r of s.rows) {
        assert.ok(!/[⌃⇧⏎⇥⌥]/.test(r.keys), `keys column is plain text: "${r.keys}"`);
        assert.ok(!/[⌃⇧⏎⇥⌥]/.test(r.what), `description is plain text: "${r.what}"`);
      }
      assert.ok(!/[⌃⇧⏎⇥⌥]/.test(s.title), `section title is plain text: "${s.title}"`);
    }
  });
});

describe("formatShortcuts", () => {
  it("renders section titles + aligned rows as viewer text", () => {
    const text = formatShortcuts(76);
    assert.match(text, /── GLOBAL ─+/);
    assert.match(text, /Enter\s+send the task/);
    // No line exceeds the requested width (viewer wraps at columns-10, so a
    // 76-col sheet always fits narrow terminals).
    for (const line of text.split("\n")) assert.ok(line.length <= 90, `line within budget: ${line}`);
  });
});

describe("/shortcut command wiring", () => {
  it("is a registered tui-only command", () => {
    const def = resolveCommandDef("/shortcut");
    assert.ok(def, "resolves");
    assert.equal(def.visibility, "tui-only");
    assert.ok(SLASH_COMMANDS.some((c) => c.cmd === "/shortcut"), "listed in help/completion");
  });

  it("parseSlashCommand canonicalizes the aliases", () => {
    assert.equal(parseSlashCommand("/shortcut")?.cmd, "/shortcut");
    assert.equal(parseSlashCommand("/shortcuts")?.cmd, "/shortcut");
    assert.equal(parseSlashCommand("/keys")?.cmd, "/shortcut");
  });
});

// The viewer used to open on the bare `v` key. The key is gone (so "v" types
// normally as the first character of a message); /view is the only way in.
describe("/view command wiring", () => {
  it("is a registered tui-only command", () => {
    const def = resolveCommandDef("/view");
    assert.ok(def, "resolves");
    assert.equal(def.visibility, "tui-only");
    assert.ok(SLASH_COMMANDS.some((c) => c.cmd === "/view"), "listed in help/completion");
  });

  it("parseSlashCommand canonicalizes the alias", () => {
    assert.equal(parseSlashCommand("/view")?.cmd, "/view");
    assert.equal(parseSlashCommand("/viewer")?.cmd, "/view");
  });

  it("the sheet advertises /view and no longer binds a bare v", () => {
    const rows = shortcutSections().flatMap((s) => s.rows);
    assert.ok(rows.some((r) => r.keys === "/view"), "/view documented");
    assert.ok(!rows.some((r) => r.keys === "v"), "bare v is a typed character again");
  });
});
