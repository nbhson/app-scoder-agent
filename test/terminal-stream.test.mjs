/**
 * P-stream: the plain-CLI assistant stream must have the same visual rhythm
 * as the finalized view — no runs of 3+ blank lines "while generating", no
 * blank line after "assistant:" when the model starts with newlines, and no
 * spurious trailing blank when the text already ends at a line break.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { llmStreamStart, llmStreamChunk, llmStreamEnd } from "../dist/io/terminal.js";

function capture(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (c) => {
    out += String(c);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

describe("terminal llm stream — newline normalization", () => {
  it("plain text still streams verbatim", () => {
    const out = capture(() => {
      llmStreamStart("assistant");
      llmStreamChunk("Hello ");
      llmStreamChunk("world");
      llmStreamEnd();
    });
    assert.equal(out, "assistant: Hello world\n");
  });

  it("leading newlines dropped; 3+ blank runs collapse to one break", () => {
    const out = capture(() => {
      llmStreamStart("assistant");
      llmStreamChunk("\n\n\nSure — let me check.\n\n\n\nTwo files.\n");
      llmStreamEnd();
    });
    assert.equal(out, "assistant: Sure — let me check.\n\nTwo files.\n");
  });

  it("no double newline when the stream already ends on a line break", () => {
    const out = capture(() => {
      llmStreamStart("assistant");
      llmStreamChunk("done.\n");
      llmStreamEnd();
    });
    assert.equal(out, "assistant: done.\n", "llmStreamEnd must not add a blank row");
  });

  it("\r stripped (CRLF-safe), single paragraph breaks preserved", () => {
    const out = capture(() => {
      llmStreamStart("assistant");
      llmStreamChunk("a\r\n\r\nb");
      llmStreamEnd();
    });
    assert.equal(out, "assistant: a\n\nb\n");
  });

  it("llmStreamEnd returns the FULL raw text (transcripts keep source)", () => {
    let line = "";
    capture(() => {
      llmStreamStart("assistant");
      llmStreamChunk("\n\n\nraw\r\nsource\n\n\n\nend");
      line = llmStreamEnd();
    });
    assert.equal(line, "\n\n\nraw\r\nsource\n\n\n\nend");
  });
});
