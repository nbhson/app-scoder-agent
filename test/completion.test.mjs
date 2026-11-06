/**
 * T-02 unit tests — completion-provider interface + ghost text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completionProviders, ghostText } from "../dist/commands/definitions.js";

const sources = {
  skills: ["commit", "review-pr"],
  agents: ["build", "plan", "explore"],
  files: ["src/tui/app.tsx", "src/tui/state.ts", "src/agent.ts", "package.json"],
};
const providers = completionProviders(sources);

describe("completionProviders", () => {
  it("commands provider owns /token", () => {
    const p = providers.find((x) => x.id === "commands");
    assert.ok(p.match("/sk"));
    const c = p.candidates("/sk");
    assert.deepEqual(c.map((x) => x.label), ["/skill"]);
  });
  it("files provider fuzzy", () => {
    const p = providers.find((x) => x.id === "files");
    assert.ok(p.match("@stte"));
    assert.ok(p.candidates("@stte")[0].insert.includes("state.ts"));
  });
  it("skills provider matches @name", () => {
    const p = providers.find((x) => x.id === "skills");
    assert.ok(p.match("@comm"));
    assert.equal(p.candidates("@comm")[0].insert, "@commit ");
  });
  it("agents provider", () => {
    const p = providers.find((x) => x.id === "agents");
    assert.equal(p.candidates("@pl")[0].label, "@plan");
  });
  it("no provider owns plain word", () => {
    assert.ok(providers.every((p) => !p.match("hello")));
  });
});

describe("ghostText", () => {
  it("unique command candidate → ghost rest", () => {
    const g = ghostText("/cl", providers);
    assert.ok(g);
    assert.equal(g.insert, "/clear ");
  });
  it("ambiguous → null", () => {
    assert.equal(ghostText("/s", providers), null);
  });
  it("no token → null", () => {
    assert.equal(ghostText("", providers), null);
    assert.equal(ghostText("fix bug ", providers), null);
  });
  it("plain word (no provider) → null", () => {
    assert.equal(ghostText("hello", providers), null);
  });
  it("partial ghost only shows remainder", () => {
    const g = ghostText("/mo", providers);
    assert.ok(g);
    assert.equal(g.insert, "/model ");
    assert.equal(g.rest, "del ");
  });
});
