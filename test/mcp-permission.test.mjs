/**
 * G5: MCP tool call qua permission engine — readonly chặn, rule deny/allow.
 * Chạy: node --test test/mcp-permission.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionChecker } from "../dist/security/permissions.js";

const base = { mode: "auto", allowCommands: [], denyCommands: [], nonInteractive: true };

describe("G5 — MCP qua permission engine", () => {
  it("readonly mode: mọi mcp__* không có rule allow → chặn", () => {
    const c = new PermissionChecker({ ...base, mode: "readonly" });
    const d = c.classifyAction("mcp__mock__echo", "*");
    assert.notEqual(d?.decision, "allow");
  });

  it("readonly mode: rule mcp__mock__* allow → được phép", () => {
    const c = new PermissionChecker({
      ...base, mode: "readonly",
      rules: [{ action: "mcp__mock__*", resource: "*", effect: "allow" }],
    });
    assert.equal(c.classifyAction("mcp__mock__echo", "*")?.decision, "allow");
  });

  it("rule mcp__danger__* deny → deny kể cả auto mode", () => {
    const c = new PermissionChecker({
      ...base, mode: "auto",
      rules: [{ action: "mcp__danger__*", resource: "*", effect: "deny" }],
    });
    assert.equal(c.classifyAction("mcp__danger__exec", "*")?.decision, "deny");
  });

  it("auto mode: mcp tool không rule → không chặn (auto chạy)", () => {
    const c = new PermissionChecker({ ...base, mode: "auto" });
    assert.equal(c.classifyAction("mcp__mock__echo", "*"), null);
  });
});
