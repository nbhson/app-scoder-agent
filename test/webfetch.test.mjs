/**
 * Unit tests cho web_fetch tool — fetch URL, SSRF guard, HTML→text, redirect,
 * content-type refusal, truncation. Chạy: node --test test/webfetch.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getTool } from "../dist/tools.js";
import { htmlToText, toolWebFetch } from "../dist/webfetch.js";

// Test server chạy trên 127.0.0.1 (private) — cho phép trong env test
process.env.SCODER_WEB_ALLOW_PRIVATE = "1";

const ctx = { workdir: process.cwd(), permissionMode: "auto" };

// ── Test HTTP server ─────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  switch (url.pathname) {
    case "/html":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Scoder Docs</title>
        <style>body { color: red; }</style>
        <script>console.log("evil");</script></head>
        <body><h1>Hello</h1><p>World &amp; more</p><!-- comment --></body></html>`);
      return;
    case "/json":
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ b: 2, a: 1 }));
      return;
    case "/plain":
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("just plain text");
      return;
    case "/binary":
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    case "/redirect":
      res.writeHead(302, { Location: "/html" });
      res.end();
      return;
    case "/redirect-loop":
      res.writeHead(302, { Location: "/redirect-loop" });
      res.end();
      return;
    case "/not-found":
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("nope");
      return;
    case "/big":
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(50_000));
      return;
    default:
      res.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await new Promise((res) => server.once("listening", res));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  delete process.env.SCODER_WEB_ALLOW_PRIVATE;
});

const fetchTool = getTool("web_fetch");

describe("web_fetch — registry & prompt integration", () => {
  it("tool được đăng ký trong AGENT_TOOLS", () => {
    assert.ok(fetchTool, "web_fetch phải có trong registry");
    assert.match(fetchTool.spec.function.description, /WHEN TO USE/);
    assert.match(fetchTool.spec.function.description, /WHEN NOT TO/);
  });
});

describe("web_fetch — fetch & conversion", () => {
  it("HTML → text: strip script/style, decode entities, giữ title", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/html` });
    assert.equal(r.ok, true);
    assert.match(r.output, /Title: Scoder Docs/);
    assert.match(r.output, /Hello/);
    assert.match(r.output, /World & more/);
    assert.doesNotMatch(r.output, /console\.log/);
    assert.doesNotMatch(r.output, /color: red/);
    assert.doesNotMatch(r.output, /comment/);
  });

  it("JSON được pretty-print", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/json` });
    assert.equal(r.ok, true);
    assert.match(r.output, /\{\n  "b": 2,\n  "a": 1\n\}/);
  });

  it("text/plain giữ nguyên", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/plain` });
    assert.equal(r.ok, true);
    assert.match(r.output, /just plain text/);
  });

  it("redirect được theo dõi (302 → /html)", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/redirect` });
    assert.equal(r.ok, true);
    assert.match(r.output, /Hello/);
  });

  it("max_chars cắt output và ghi chú truncated", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/big`, max_chars: 1000 });
    assert.equal(r.ok, true);
    assert.ok(r.output.length < 2000);
    assert.match(r.output, /truncated, \d+ more chars/);
  });
});

describe("web_fetch — error handling", () => {
  it("HTTP 404 → ok=false", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/not-found` });
    assert.equal(r.ok, false);
    assert.match(r.output, /HTTP 404/);
  });

  it("binary content-type bị từ chối", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/binary` });
    assert.equal(r.ok, false);
    assert.match(r.output, /unsupported content-type/);
  });

  it("invalid URL → error", async () => {
    const r = await fetchTool.run(ctx, { url: "not a url" });
    assert.equal(r.ok, false);
    assert.match(r.output, /invalid URL/);
  });

  it("scheme không phải http/https bị từ chối (file://)", async () => {
    const r = await fetchTool.run(ctx, { url: "file:///etc/passwd" });
    assert.equal(r.ok, false);
    assert.match(r.output, /only http\/https/);
  });

  it("redirect loop > 5 hops → error", async () => {
    const r = await fetchTool.run(ctx, { url: `${base}/redirect-loop` });
    assert.equal(r.ok, false);
    assert.match(r.output, /too many redirects/);
  });
});

describe("web_fetch — SSRF guard", () => {
  it("chặn private IP khi SCODER_WEB_ALLOW_PRIVATE không bật", async () => {
    delete process.env.SCODER_WEB_ALLOW_PRIVATE;
    try {
      const r = await toolWebFetch(ctx, { url: `${base}/html` });
      assert.equal(r.ok, false);
      assert.match(r.output, /private\/loopback address/);
    } finally {
      process.env.SCODER_WEB_ALLOW_PRIVATE = "1";
    }
  });

  it("chặn file:// và các scheme lạ ngay cả khi allowPrivate", () => {
    // đã test ở trên — guard scheme chạy trước assertPublicHost
  });
});

describe("htmlToText — unit", () => {
  it("strip script/style/comment, block tags thành newline", () => {
    const out = htmlToText("<div>A</div><script>x()</script><style>.y{}</style><p>B</p>");
    assert.match(out, /^A\nB$/);
  });

  it("decode entity số & named", () => {
    assert.equal(htmlToText("<p>&#65;&#x42;&amp;lt;</p>"), "AB&lt;");
  });

  it("collapse whitespace", () => {
    assert.equal(htmlToText("<span>  a   b  </span>  <span>c</span>"), "a b c");
  });
});
