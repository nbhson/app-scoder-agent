/**
 * Public entry-point contract: the main dist modules must keep exporting
 * their public surface.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const contracts = {
  "agent.js": ["Agent", "EVENT_SCHEMA_VERSION", "resolvePrimaryConfig"],
  "tools/registry.js": ["AGENT_TOOLS", "allToolSpecs", "getTool"],
  "tools/path-safety.js": ["setMaxOutputChars"],
  "mcp/manager.js": ["McpManager"],
  "tui/image.js": ["detectImageCaps", "detectImageBytes", "halfblockRows", "imageSize"],
  "tui/at-complete.js": ["applySuggestion", "atQuery", "fileIndex", "invalidateFileIndex", "suggest"],
};

describe("public module entry points", () => {
  for (const [path, names] of Object.entries(contracts)) {
    it(`${path} exports its compatibility surface`, async () => {
      const module = await import(`../dist/${path}`);
      for (const name of names) assert.ok(name in module, `${path} missing export ${name}`);
    });
  }
});
