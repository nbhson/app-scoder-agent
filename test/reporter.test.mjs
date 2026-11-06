import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePrimaryConfig } from "../dist/agent.js";

function reporter() {
  const warnings = [];
  const noop = () => {};
  return {
    warnings,
    info: noop,
    step: noop,
    success: noop,
    warn: (message) => warnings.push(message),
    error: noop,
    llm: noop,
    toolCall: noop,
    toolResult: noop,
    buildStatus: noop,
    header: noop,
    banner: noop,
    llmStreamStart: noop,
    llmStreamChunk: noop,
    llmStreamEnd: () => "",
    toolStreamStart: noop,
    toolStreamChunk: noop,
    toolStreamEnd: noop,
    isToolStreamOpen: () => false,
    printDiff: noop,
    diffSummary: noop,
  };
}

describe("Reporter output port", () => {
  it("routes primary-agent warnings to the injected reporter", () => {
    const sink = reporter();
    resolvePrimaryConfig({
      workdir: process.cwd(),
      agent: "does-not-exist",
      provider: "openai",
      baseUrl: "http://localhost:0",
      apiKey: "test",
      model: "test",
      buildCmd: null,
      maxSteps: 1,
      maxTokens: 1,
      temperature: 0,
      yes: true,
      reporter: sink,
    }, sink);
    assert.equal(sink.warnings.length, 1);
    assert.match(sink.warnings[0], /does-not-exist/);
  });
});
