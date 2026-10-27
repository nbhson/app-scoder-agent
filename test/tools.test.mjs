/**
 * Unit tests cho tools.js — đặc biệt là safePath (path traversal / symlink).
 * Chạy: node --test test/tools.test.mjs (sau khi npm run build)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTool } from "../dist/tools.js";

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
