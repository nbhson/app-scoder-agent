/**
 * Phase 0/1 compatibility contract: the historical dist entry points must
 * remain importable while implementations move into domain folders.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const contracts = {
  "agent.js": ["Agent", "EVENT_SCHEMA_VERSION", "resolvePrimaryConfig"],
  "tools.js": ["AGENT_TOOLS", "allToolSpecs", "getTool", "setMaxOutputChars"],
  "mcp.js": ["HttpTransport", "McpConnection", "McpManager", "StdioTransport", "parseSseEvent", "parseSseMessages"],
  "tui/image.js": ["detectImageCaps", "detectImageBytes", "halfblockRows", "imageSize"],
  "tui/at-complete.js": ["applySuggestion", "atQuery", "fileIndex", "invalidateFileIndex", "suggest"],
};

describe("legacy module facades", () => {
  for (const [path, names] of Object.entries(contracts)) {
    it(`${path} exports its compatibility surface`, async () => {
      const module = await import(`../dist/${path}`);
      for (const name of names) assert.ok(name in module, `${path} missing export ${name}`);
    });
  }
});
