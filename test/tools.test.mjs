/**
 * Unit tests cho tools.js — đặc biệt là safePath (path traversal / symlink).
 * Chạy: node --test test/tools.test.mjs (sau khi npm run build)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTool, toolRunCommand } from "../dist/tools.js";

const TMP = join("/tmp", `coder-tools-test-${process.pid}`);
const workdir = join(TMP, "workdir");
mkdirSync(join(workdir, "sub"), { recursive: true });

const listFiles = getTool("list_files");
const readFile = getTool("read_file");
const writeFile = getTool("write_file");
const editFile = getTool("edit_file");

const ctx = { workdir, permissionMode: "auto", permissions: undefined };

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("safePath — path traversal", () => {
  it("deny: ../ thoát khỏi workdir", async () => {
    const r = await readFile.run(ctx, { path: "../outside.txt" });
    assert.equal(r.ok, false);
    assert.match(r.output, /escapes working directory/i);
  });

  it("deny: absolute path ngoài workdir", async () => {
    const r = await readFile.run(ctx, { path: "/etc/hostname" });
    assert.equal(r.ok, false);
    assert.match(r.output, /escapes working directory/i);
  });

  it("deny: đường dẫn trông hợp lệ nhưng chứa .. ở giữa", async () => {
    const r = await readFile.run(ctx, { path: "sub/../../etc/passwd" });
    assert.equal(r.ok, false);
  });
});

describe("safePath — symlink escape", () => {
  it("deny: ghi qua symlink trỏ ra ngoài workdir", async () => {
    // Tạo file ngoài workdir + symlink bên trong trỏ ra đó
    const outside = join(TMP, "outside.txt");
    writeFileSync(outside, "original");
    symlinkSync(outside, join(workdir, "evil-link"));

    const r = await writeFile.run(ctx, { path: "evil-link", content: "PWNED" });
    assert.equal(r.ok, false, "write qua symlink phải bị chặn");
    assert.match(r.output, /escapes working directory/i);
    assert.equal(readFileSync(outside, "utf8"), "original", "file ngoài không bị ghi");
  });
});

describe("read_file — size cap", () => {
  it("deny: file > 2MB với gợi ý dùng grep/head", async () => {
    const big = join(workdir, "big.txt");
    writeFileSync(big, "x".repeat(3 * 1024 * 1024));
    const r = await readFile.run(ctx, { path: "big.txt" });
    assert.equal(r.ok, false);
    assert.match(r.output, /limit 2MB/);
    assert.match(r.output, /grep|head|tail/);
  });

  it("deny: read_file trên directory", async () => {
    const r = await readFile.run(ctx, { path: "sub" });
    assert.equal(r.ok, false);
    assert.match(r.output, /is a directory/);
  });
});

describe("write_file / edit_file", () => {
  it("write_file tạo file + parent dirs, trả số dòng", async () => {
    const r = await writeFile.run(ctx, { path: "sub/deep/new.txt", content: "a\nb\nc" });
    assert.equal(r.ok, true);
    assert.match(r.output, /Wrote 3 lines/);
  });

  it("edit_file: old_string không tồn tại -> error rõ ràng", async () => {
    const r = await editFile.run(ctx, { path: "sub/deep/new.txt", old_string: "KHONGCO", new_string: "x" });
    assert.equal(r.ok, false);
    assert.match(r.output, /not found/);
  });

  it("edit_file: old_string xuất hiện 2 lần -> yêu cầu context nhiều hơn", async () => {
    const p = "sub/dup.txt";
    await writeFile.run(ctx, { path: p, content: "same\nsame\n" });
    const r = await editFile.run(ctx, { path: p, old_string: "same", new_string: "diff" });
    assert.equal(r.ok, false);
    assert.match(r.output, /matches 2 locations/);
  });

  it("edit_file: new_string chứa $-pattern ($&, $`, $') -> chèn LITERAL không interpolate", async () => {
    const p = "sub/dollar.txt";
    await writeFile.run(ctx, { path: p, content: "echo PLACEHOLDER\n" });
    // $& và $' là special replacement patterns — phải được chèn nguyên văn
    const r = await editFile.run(ctx, {
      path: p,
      old_string: "echo PLACEHOLDER",
      new_string: "echo '$&' $` $' $1",
    });
    assert.equal(r.ok, true);
    assert.equal(
      readFileSync(join(workdir, "sub/dollar.txt"), "utf8"),
      "echo '$&' $` $' $1\n",
      "literal $-patterns phải giữ nguyên, không bị interpolate",
    );
  });
});

describe("list_files", () => {
  it("liệt kê + bỏ qua node_modules/.git/dist", async () => {
    mkdirSync(join(workdir, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(workdir, ".git"), { recursive: true });
    writeFileSync(join(workdir, "node_modules/pkg/index.js"), "x");
    writeFileSync(join(workdir, "visible.txt"), "x");
    const r = await listFiles.run(ctx, {});
    assert.equal(r.ok, true);
    assert.match(r.output, /visible\.txt/);
    assert.doesNotMatch(r.output, /node_modules\/pkg/);
    assert.doesNotMatch(r.output, /\.git\//);
  });
});

describe("toolRunCommand (async spawn)", () => {
  it("exit 0 -> ok=true, có stdout", async () => {
    const r = await toolRunCommand(workdir, { command: "echo hello" });
    assert.equal(r.ok, true);
    assert.match(r.output, /\(exit 0\)/);
    assert.match(r.output, /echo hello/);
  });

  it("exit != 0 -> ok=false, có stderr", async () => {
    const r = await toolRunCommand(workdir, { command: "echo err >&2; exit 3" });
    assert.equal(r.ok, false);
    assert.match(r.output, /\(exit 3\)/);
    assert.match(r.output, /--- stderr ---/);
    assert.match(r.output, /err/);
  });

  it("timeout_secs=1 -> lệnh treo bị kill sau timeout (BUG: execFileSync block)", async () => {
    const r = await toolRunCommand(workdir, { command: "sleep 30", timeout_secs: 1 });
    assert.equal(r.ok, false);
    assert.match(r.output, /timed out after 1s/);
    assert.ok(r.output.includes("sleep 30"), "phải trả về output đã thu được trước khi kill");
  }, 15_000);

  it("abort signal -> lệnh bị giết ngay, trả về 'interrupted by user'", async () => {
    const ac = new AbortController();
    const p = toolRunCommand(workdir, { command: "sleep 30" }, ac.signal);
    setTimeout(() => ac.abort(new DOMException("interrupted", "AbortError")), 300);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.output, /interrupted by user/);
  }, 15_000);

  it("output lớn -> clamp ở MAX_OUTPUT_CHARS", async () => {
    const r = await toolRunCommand(workdir, { command: "yes A | head -c 100000" });
    assert.ok(r.output.length < 100_000, "output phải được truncate");
    assert.match(r.output, /\[truncated/);
  });

  it("không block event loop: Promise.all chạy song song", async () => {
    const t0 = Date.now();
    await Promise.all([
      toolRunCommand(workdir, { command: "sleep 1" }),
      toolRunCommand(workdir, { command: "sleep 1" }),
    ]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1900, `2 lệnh sleep 1s song song phải xong ~1s (thực tế ${elapsed}ms)`);
  }, 10_000);
});
