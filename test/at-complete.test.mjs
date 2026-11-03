/**
 * T-01 unit tests — @ fuzzy autocomplete engine (pure logic).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { atQuery, suggest, applySuggestion } from "../dist/tui/at-complete.js";

describe("atQuery", () => {
  it("detects @ at start", () => {
    assert.deepEqual(atQuery("@src"), { start: 0, query: "src" });
  });
  it("detects @ mid-token after space", () => {
    assert.deepEqual(atQuery("fix bug in @src/tu"), { start: 11, query: "src/tu" });
  });
  it("no query mid-word", () => {
    assert.equal(atQuery("email@@x"), null);
    assert.equal(atQuery("plain text"), null);
  });
  it("empty query right after @", () => {
    assert.deepEqual(atQuery("look @"), { start: 5, query: "" });
  });
});

describe("suggest", () => {
  const files = ["src/tui/app.tsx", "src/tui/state.ts", "src/agent.ts", "package.json", "README.md", "src/tui/deep/nested/f.ts"];
  it("empty query → dirs first files", () => {
    const hits = suggest(files, "");
    assert.ok(hits.length <= 8);
    assert.ok(hits.some((h) => h.endsWith("/")), "dir prefixes present");
  });
  it("fuzzy match", () => {
    const hits = suggest(files, "stte");
    assert.ok(hits.includes("src/tui/state.ts"), JSON.stringify(hits));
  });
  it("subtree mode: trailing slash narrows to dir", () => {
    const hits = suggest(files, "src/tui/");
    assert.ok(hits.every((h) => h.startsWith("src/tui/")), JSON.stringify(hits));
    assert.ok(hits.includes("src/tui/app.tsx"));
  });
  it("limit 8", () => {
    const many = Array.from({ length: 50 }, (_, i) => `dir/file${i}.ts`);
    assert.equal(suggest(many, "file").length, 8);
  });
});

describe("applySuggestion", () => {
  it("file suggestion appends space", () => {
    assert.equal(applySuggestion("fix @ap", { start: 4, query: "ap" }, "app.tsx"), "fix @app.tsx ");
  });
  it("dir suggestion keeps trailing slash (subtree continue)", () => {
    assert.equal(applySuggestion("@sr", { start: 0, query: "sr" }, "src/"), "@src/");
  });
  it("preserves prefix, replaces to end of token (rest dropped — active token is at end)", () => {
    assert.equal(applySuggestion("refactor @stat", { start: 9, query: "stat" }, "src/tui/state.ts"), "refactor @src/tui/state.ts ");
  });
});
