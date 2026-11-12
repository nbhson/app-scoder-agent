#!/usr/bin/env node
/**
 * Prompt capture proxy — ghi lại ĐÚNG request body mà một agent (scoder,
 * OpenCode, bất kỳ client OpenAI-compatible nào) gửi cho llama.cpp, kèm usage
 * và thời gian của phản hồi, rồi forward để client chạy bình thường.
 *
 * Vì sao cần: muốn biết "agent A nhanh hơn agent B" là do prompt nhỏ hơn hay
 * do KV-cache reuse, phải đo trên CÙNG engine. Log của mỗi agent tự ước lượng
 * theo cách riêng nên không so được.
 *
 * Usage: node scripts/capture-prompt-proxy.mjs [listen] [upstream]
 *   mặc định: 8099  http://0.0.0.0:8080
 * Output (thư mục $SCODER_CAPTURE_DIR):
 *   req-<n>.json   body đã parse
 *   meta.jsonl     idx, url, user-agent, auth tail, model, bytes, tools, msgs
 *   usage.jsonl    idx, ttftMs, totalMs, usage thật của phản hồi
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";

const [LISTEN_ARG = "8099", UPSTREAM_ARG = "http://0.0.0.0:8080"] = process.argv.slice(2);
const LISTEN = Number(LISTEN_ARG);
const UPSTREAM = UPSTREAM_ARG.replace(/\/$/, "");
if (!Number.isInteger(LISTEN) || LISTEN <= 0 || LISTEN > 65535) {
  console.error(`[capture] port không hợp lệ: ${LISTEN_ARG}`);
  process.exit(2);
}
const DIR =
  process.env.SCODER_CAPTURE_DIR || "/private/var/folders/bl/8cp9kd_s0yx6q541cqdz3tpm0000gn/T/opencode/prompt-capture";
mkdirSync(DIR, { recursive: true });

const nextIdx = () => readdirSync(DIR).filter((f) => /^req-\d+\.json$/.test(f)).length;

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);

  let idx = -1;
  let parsed = null;
  if (req.method === "POST" && raw.length > 0) {
    try {
      parsed = JSON.parse(raw.toString("utf8"));
      idx = nextIdx();
      writeFileSync(`${DIR}/req-${idx}.json`, JSON.stringify(parsed));
      appendFileSync(
        `${DIR}/meta.jsonl`,
        JSON.stringify({
          idx,
          isPrompt: Array.isArray(parsed.messages) && parsed.messages.length > 0,
          url: req.url,
          ts: new Date().toISOString(),
          agent: /opencode/i.test(req.headers["user-agent"] || "") ? "opencode" : "other",
          userAgent: req.headers["user-agent"] ?? null,
          authTail: req.headers.authorization ? String(req.headers.authorization).slice(-6) : null,
          model: parsed.model ?? null,
          bytes: raw.length,
          messages: (parsed.messages || []).length,
          tools: (parsed.tools || []).length,
        }) + "\n",
      );
    } catch (err) {
      console.error("[capture] body không phải JSON:", String(err).slice(0, 120));
    }
  }

  const target = new URL(req.url ?? "/", UPSTREAM);
  const headers = { ...req.headers, host: `${target.hostname}:${target.port}` };
  if (raw.length) headers["content-length"] = String(raw.length);
  else delete headers["content-length"];

  const t0 = Date.now();
  let ttft = null;
  let tail = "";
  try {
    const up = await fetch(target, { method: req.method, headers, body: raw.length ? raw : undefined });
    res.writeHead(up.status, Object.fromEntries(up.headers));
    if (up.body) {
      for await (const c of up.body) {
        if (ttft == null) ttft = Date.now() - t0;
        res.write(c);
        tail = (tail + Buffer.from(c).toString("utf8")).slice(-12000);
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "capture proxy: upstream failed", detail: String(err) }));
  }

  if (idx >= 0) {
    let usage = null;
    for (const line of tail.split("\n")) {
      const s = (line.startsWith("data:") ? line.slice(5) : line).trim();
      if (!s || s === "[DONE]") continue;
      try {
        const j = JSON.parse(s);
        if (j.usage && (j.usage.prompt_tokens || j.usage.total_tokens)) usage = j.usage;
      } catch {}
    }
    if (usage) {
      appendFileSync(
        `${DIR}/usage.jsonl`,
        JSON.stringify({ idx, agent: parsed?.model ? undefined : undefined, ts: new Date(t0).toISOString(), ttftMs: ttft, totalMs: Date.now() - t0, usage }) + "\n",
      );
    }
  }
});

server.listen(LISTEN, "127.0.0.1", () => {
  console.log(`[capture] http://127.0.0.1:${LISTEN}/v1  ->  ${UPSTREAM}   (dir: ${DIR})`);
});
