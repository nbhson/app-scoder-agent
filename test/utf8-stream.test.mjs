/**
 * P1-15 — streamed bytes must be decoded as ONE UTF-8 stream.
 *
 * Node splits pipes/sockets at arbitrary byte offsets. `chunk.toString("utf8")`
 * per chunk turns any character straddling a boundary into U+FFFD, which
 * corrupted Vietnamese/emoji tool output, `scoder serve` request bodies, and
 * MCP JSON-RPC frames. These tests cover the shared helper AND the real
 * child-process paths that used to do it by hand.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Utf8Buffer, Utf8LineFramer, Utf8Stream } from "../dist/shared/decode.js";
import { toolRunCommand } from "../dist/tools/run-command.js";

const TEXT = "sửa lỗi cho module add(a, b) — 🚀 ship it ✨ ";

/** Split a Buffer every `n` bytes (worst case: mid-character chunks). */
function slice(buf, n) {
  const out = [];
  for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, Math.min(i + n, buf.length)));
  return out;
}

describe("Utf8Stream / Utf8Buffer", () => {
  it("documents the bug: per-chunk toString corrupts, decoder does not", () => {
    const buf = Buffer.from(TEXT.repeat(20), "utf8");
    const naive = slice(buf, 7).map((c) => c.toString("utf8")).join("");
    assert.ok(naive.includes("\uFFFD"), "the old pattern must visibly corrupt");
    const s = new Utf8Stream();
    let fixed = "";
    for (const c of slice(buf, 7)) fixed += s.write(c);
    fixed += s.end();
    assert.equal(fixed, TEXT.repeat(20));
  });

  it("accumulates every chunk size without loss", () => {
    const buf = Buffer.from(TEXT, "utf8");
    for (const n of [1, 2, 3, 4, 5, 13, 64]) {
      const b = new Utf8Buffer();
      for (const c of slice(buf, n)) b.push(c);
      assert.equal(b.finish(), TEXT, `chunk=${n}`);
      assert.ok(!b.text.includes("\uFFFD"));
    }
  });

  it("honours the character cap and reports length seen", () => {
    const b = new Utf8Buffer(10);
    // "xạ" × 6 = 24 bytes = 12 characters, fed in 2-byte chunks (every "ạ"
    // straddles a boundary).
    const d = Buffer.from("xạ", "utf8");
    for (const c of slice(Buffer.concat(Array(6).fill(d)), 2)) b.push(c);
    assert.equal(b.text, "xạxạxạxạxạ"); // first 10 characters, lossless
    assert.equal(b.length, 12);
  });

  it("resolves a runtime-tunable limit per chunk", () => {
    let cap = 3;
    const b = new Utf8Buffer(() => cap);
    b.push("abc");
    cap = 6;
    b.push("def");
    assert.equal(b.text, "abcdef");
  });

  it("flushes a dangling partial byte at end", () => {
    const b = new Utf8Buffer();
    b.push(Buffer.from([0xe1, 0xbb])); // first 2 bytes of U+1EEB
    const done = b.finish();
    assert.equal(done.length, 1); // replacement char, not a silent drop
    assert.ok(done.includes("\uFFFD"));
  });
});

describe("Utf8LineFramer (MCP JSON-RPC)", () => {
  it("reassembles frames split mid-character and mid-line", () => {
    const payloads = [
      { jsonrpc: "2.0", id: 1, result: { text: "đã xong 🚀" } },
      { jsonrpc: "2.0", method: "notifications/message", params: { m: "báo lỗi tiếng Việt" } },
    ];
    const raw = Buffer.from(payloads.map((p) => JSON.stringify(p) + "\n").join(""), "utf8");
    const f = new Utf8LineFramer();
    const got = [];
    for (const c of slice(raw, 5)) got.push(...f.feed(c));
    const rest = f.rest();
    if (rest) got.push(rest);
    assert.deepEqual(got.map((l) => JSON.parse(l)), payloads);
  });

  it("returns only complete lines and keeps the remainder", () => {
    const f = new Utf8LineFramer();
    assert.deepEqual(f.feed("a\nb"), ["a"]);
    assert.deepEqual(f.feed("\nc\n"), ["b", "c"]);
    assert.equal(f.rest(), "");
  });

  it("does not grow unbounded on a stream with no newlines", () => {
    const f = new Utf8LineFramer();
    for (let i = 0; i < 2000; i++) f.feed("x".repeat(8192));
    assert.ok(f.rest().length <= 8 * 1024 * 1024);
  });
});

describe("run_command decodes multi-byte output", () => {
  const workdir = mkdtempSync(join(tmpdir(), "utf8-run-"));
  after(() => rmSync(workdir, { recursive: true, force: true }));

  it("large Vietnamese output survives 64KB pipe chunking", async () => {
    // >64KB of 3-byte characters: every pipe chunk after the first splits a
    // character (verified: the naive per-chunk decode yields 3 U+FFFD here).
    // The output budget is raised so the retained window covers a boundary.
    const { setMaxOutputChars } = await import("../dist/tools/path-safety.js");
    const DEFAULT_CAP = 20_000;
    setMaxOutputChars(60_000);
    try {
      writeFileSync(
        join(workdir, "emit.js"),
        'process.stdout.write("ok: thành công — tiếng Việt\\n" + "ạ".repeat(200000));',
      );
      const res = await toolRunCommand(workdir, { command: "node emit.js", timeout_secs: 60 });
      assert.equal(res.ok, true, res.output);
      assert.ok(!res.output.includes("\uFFFD"), "no replacement characters in tool output");
      assert.match(res.output, /ok: thành công — tiếng Việt/);
      assert.match(res.output, /ạạạ/);
    } finally {
      setMaxOutputChars(DEFAULT_CAP);
    }
  });

  it("small multi-byte output is exact", async () => {
    writeFileSync(join(workdir, "small.js"), 'process.stdout.write("chuỗi tiếng Việt — ă â ê ô ơ ư đ 🚀\\n");');
    const res = await toolRunCommand(workdir, { command: "node small.js", timeout_secs: 30 });
    assert.match(res.output, /chuỗi tiếng Việt — ă â ê ô ơ ư đ 🚀/);
  });
});

describe("workspace readers", () => {
  it("git status branch decodes per stream (workspace/git-status)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "utf8-git-"));
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["checkout", "-q", "-b", "feature/tiếng-việt"], { cwd: dir });
    writeFileSync(join(dir, "tệp.md"), "nội dung");
    const { probeGitContext } = await import("../dist/workspace/git-status.js");
    const ctx = await probeGitContext(dir, 5000);
    assert.equal(ctx?.branch, "feature/tiếng-việt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("file index keeps non-ASCII paths intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "utf8-idx-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "thư mục"), { recursive: true });
    writeFileSync(join(dir, "thư mục", "tệp mã nguồn.ts"), "export const a = 1;");
    const { rgFilesAsync } = await import("../dist/workspace/file-index.js");
    const files = await rgFilesAsync(dir);
    if (files === null) return; // rg not on PATH in this environment
    assert.ok(files.some((f) => f.includes("tệp mã nguồn.ts")), JSON.stringify(files));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("stdio transport frames", () => {
  it("a JSON-RPC message split across process chunks is parsed once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "utf8-mcp-"));
    // Child writes one line in 4-byte pieces, 5ms apart — Node delivers each
    // write as its own stdout chunk (verified), so every multi-byte character
    // straddles a chunk boundary.
    const script = `
      const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ạ".repeat(20) } }) + "\\n";
      const buf = Buffer.from(line, "utf8");
      let i = 0;
      const tick = () => {
        if (i >= buf.length) return process.exit(0);
        process.stdout.write(buf.subarray(i, i + 4));
        i += 4;
        setTimeout(tick, 5);
      };
      tick();
    `;
    writeFileSync(join(dir, "split.js"), script);
    const { StdioTransport } = await import("../dist/mcp/transport-stdio.js");
    const t = new StdioTransport({ name: "split", command: "node", args: [join(dir, "split.js")] });
    const messages = [];
    t.onMessage((m) => messages.push(m));
    await t.start();
    const deadline = Date.now() + 5000;
    while (messages.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    t.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(messages.length, 1, `expected exactly one frame, got ${JSON.stringify(messages)}`);
    assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: { text: "ạ".repeat(20) } });
  });
});
