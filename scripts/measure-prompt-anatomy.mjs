#!/usr/bin/env node
/**
 * Đo chi phí fixed-prompt của MỘT request thật trên CHÍNH engine của người dùng.
 *
 * Vì sao cần: mọi con số "agent A nhẹ hơn agent B", "block X đắt hơn block Y"
 * đều phải đếm bằng tokenizer của model thật. Log của agent tự estimate theo
 * cách riêng (cl100k + hệ số) nên không so sánh được, và ChatML framing thì
 * estimator không nhìn thấy (đo ra: thiếu ~19–22% cho nguyên prompt).
 *
 * Cách đo: replay request body đã capture (scripts/capture-prompt-proxy.mjs)
 * với max_tokens=1 → engine trả usage.prompt_tokens (đếm thật) và
 * usage.prompt_tokens_details.cached_tokens (bao nhiêu prefix được reuse).
 *
 * Modes:
 *   anatomy  <dir[,dir2]> [idxList]  FULL / -tools / -system / bare → ai trả gì
 *   blocks   <dir> [idx]            chi phí TỪNG BLOCK động trong system prompt
 *                                    (đo bằng mẹo nối đuôi vào prefix đã ấm)
 *   warmcold <dir[,dir2]> [idx]     cùng 1 prompt gửi lại N lần (ấm) vs đổi
 *                                    prefix (lạnh) → giá thật của KV-cache
 *   scatter  <dir> [idxA] [idxB]    xen kẽ 2 prompt, có/không pin slot_id →
 *                                    server chia slot làm mất cache bao nhiêu
 *
 * Usage:
 *   node scripts/measure-prompt-anatomy.mjs anatomy /tmp/cap-scoder,/tmp/cap-oc 1,4
 *   SCODER_ENGINE=http://127.0.0.1:8080/v1 node scripts/measure-prompt-anatomy.mjs blocks /tmp/cap
 * Cờ: --reps N (warmcold, mặc định 3) · --pin N (slot_id) · --json (in JSON rows)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const MODE = argv.shift() || "anatomy";
const DIRS_ARG = argv.shift() || "";
// Cờ --name [giá-trị] tách khỏi idx định vị (tránh "--reps 3" bị hiểu là req-3).
const POS = [];
const FLAG = new Map();
while (argv.length) {
  const a = argv.shift();
  if (a.startsWith("--")) {
    FLAG.set(a.slice(2), argv[0] != null && !argv[0].startsWith("--") ? argv.shift() : "1");
  } else POS.push(a);
}
const REPS = Number(FLAG.get("reps") ?? 3) || 3;
const PIN = FLAG.has("pin") ? Number(FLAG.get("pin")) : null;
const AS_JSON = FLAG.has("json");

const rcPath = process.env.SCODER_CONFIG || join(process.env.HOME, ".scoder", "config.json");
const rc = existsSync(rcPath) ? JSON.parse(readFileSync(rcPath, "utf8")) : {};
const BASE = (process.env.SCODER_ENGINE || rc.baseUrl || "http://0.0.0.0:8080/v1").trim().replace(/\/$/, "");
const KEY = process.env.SCODER_ENGINE_KEY || rc.apiKey;
const UPSTREAM = BASE.replace(/\/v1$/, "").replace(/\/$/, "");

/** Các anchor block động trong system prompt scoder (xem prompt-builder.ts). */
const BLOCKS = {
  "REPO MAP": "REPO MAP —",
  "skills": "AVAILABLE SKILLS (",
  "subagents": "SUBAGENTS (",
  "mcp servers": "MCP SERVERS (",
  "AGENTS.md": "AGENTS.md (",
};

const dirs = DIRS_ARG.split(",").map((d) => d.trim()).filter(Boolean);
if (!dirs.length) {
  console.error("Thiếu capture dir. Ví dụ: ... anatomy /tmp/cap 1");
  process.exit(2);
}

const loadBodies = (dir, picks) => {
  const all = readdirSync(dir)
    .filter((f) => /^req-\d+\.json$/.test(f))
    .map((f) => ({ idx: Number(f.match(/\d+/)[0]), file: join(dir, f), body: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .filter((r) => Array.isArray(r.body.messages) && r.body.messages.length > 0);
  if (!picks.length) return all;
  return all.filter((r) => picks.includes(r.idx));
};
/** idx chọn: `blocks <dir> 1`, `scatter <dir> 1 4`, `anatomy <dirs> 1,4`. */
const picks = [...new Set(POS.flatMap((a) => a.split(",")).filter((a) => /^\d+$/.test(a)).map(Number))];

async function call(body, { slot = PIN } = {}) {
  const payload = { ...body, stream: false, max_tokens: 1, temperature: 0 };
  delete payload.stream_options;
  delete payload.max_completion_tokens;
  if (slot != null) payload.slot_id = slot;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const d = j.usage?.prompt_tokens_details || {};
  return { tok: j.usage?.prompt_tokens ?? null, cached: d.cached_tokens ?? 0, ms: Date.now() - t0 };
}

const chars = (s) => (s == null ? 0 : typeof s === "string" ? s.length : JSON.stringify(s).length);
const sysOf = (b) => String(b.messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "");
const label = (b) => ((b.tools || []).some((t) => (t.function?.name || "").startsWith("mcp__")) ? "scoder+mcp" : "agent");

const pct = (r) => (r.tok ? `${Math.round((r.cached / r.tok) * 100)}%` : "-");
const row = (name, r, extra = "") =>
  console.log(`  ${String(name).padEnd(24)} ${String(r.tok ?? "?").padStart(6)} tok  cached=${String(r.cached ?? "?").padStart(6)} (${pct(r).padStart(4)})  ${String(r.ms).padStart(6)}ms${extra}`);

// ── anatomy: ai trả tiền cho cái gì ─────────────────────────────────────────
async function anatomy() {
  const out = [];
  for (const dir of dirs) {
    for (const { idx, body } of loadBodies(dir, picks)) {
      const tools = body.tools || [];
      const base = { dir: dir.split("/").pop(), idx, agent: label(body), tools: tools.length, sysChars: chars(sysOf(body)), schemaChars: chars(tools) };
      base.full = (await call(body)).tok;
      base.noTools = (await call({ ...body, tools: undefined })).tok;
      base.noSys = (await call({ ...body, messages: body.messages.filter((m) => m.role !== "system" && m.role !== "developer") })).tok;
      base.bare = (await call({ model: body.model, messages: [{ role: "user", content: "hi" }] })).tok;
      base.toolsCost = base.full - base.noTools;
      base.sysCost = base.full - base.noSys;
      base.restCost = base.noTools - base.sysCost - base.bare;
      out.push(base);
      console.log(JSON.stringify(base));
    }
  }
  if (AS_JSON) console.log(JSON.stringify(out, null, 2));
  console.log("\nidx  agent       tools   FULL  tools  system  rest   bare  schemaChars");
  for (const r of out) {
    console.log(
      `${String(r.idx).padStart(3)}  ${r.agent.padEnd(11)} ${String(r.tools).padStart(5)} ${String(r.full).padStart(5)}` +
        ` ${String(r.toolsCost).padStart(6)} ${String(r.sysCost).padStart(6)} ${String(r.restCost).padStart(6)} ${String(r.bare).padStart(5)} ${String(r.schemaChars).padStart(11)}`,
    );
  }
  writeFileSync(join(dirs[0], "anatomy.json"), JSON.stringify(out, null, 2));
}

// ── blocks: chi phí từng block động trong system prompt ─────────────────────
/** vị trí anchor kế tiếp (khác block hiện tại) sau i. */
function nextAnchor(sys, i, anchor) {
  let end = sys.length;
  for (const [k, h] of Object.entries(BLOCKS)) {
    if (k === anchor) continue;
    const j = sys.indexOf(h, i + h.length);
    if (j > -1 && j < end) end = j;
  }
  return end;
}
const sliceBlock = (sys, anchor) => {
  const i = sys.indexOf(BLOCKS[anchor]);
  return i < 0 ? "" : sys.slice(i, nextAnchor(sys, i, anchor));
};
const stripBlock = (sys, anchor) => {
  const i = sys.indexOf(BLOCKS[anchor]);
  return i < 0 ? sys : sys.slice(0, i) + sys.slice(nextAnchor(sys, i, anchor));
};

async function blocks() {
  const list = loadBodies(dirs[0], picks);
  if (!list.length) {
    console.error(`Không có request khớp (dir=${dirs[0]}, picks=${picks.join(",") || "tất cả"})`);
    process.exit(2);
  }
  const { idx, body } = list[0];
  const sys = sysOf(body);
  let stripped = sys;
  for (const k of Object.keys(BLOCKS)) stripped = stripBlock(stripped, k);
  const msgs = (s, tools) => ({ ...body, ...(tools ? { tools } : { tools: undefined }), messages: [{ role: "system", content: s }, { role: "user", content: "hi" }] });
  console.log(`req-${idx}: system ${sys.length}c, phần chỉ dẫn tĩnh ${stripped.length}c\n`);
  const bare = await call(msgs(stripped));
  row("chỉ dẫn tĩnh", bare);
  for (const k of Object.keys(BLOCKS)) {
    const blk = sliceBlock(sys, k);
    if (!blk) {
      console.log(`  ${k.padEnd(24)} (không có trong prompt)`);
      continue;
    }
    const r = await call(msgs(stripped + blk));
    row(`+ ${k}`, r, `  Δ=${r.tok - bare.tok} tok cho ${blk.length}c`);
  }
  console.log("\n// Δ lấy từ cùng prefix đã ấm: phần tĩnh được reuse, chỉ block mới phải prefill.");
  // Schema đắt nhất: prefix ấm + đúng MỘT tool → Δ là giá thật của tool đó
  // (llama.cpp render schema SAU messages nên đổi tool không phá prefix — xem §13.7).
  const perTool = [];
  for (const t of body.tools || []) perTool.push([t.function.name, (await call(msgs(stripped, [t]))).tok - bare.tok]);
  const big = perTool.sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log("schema đắt nhất (Δ tok): " + big.map(([n, d]) => `${n}=${d}`).join(" "));
}

// ── warmcold: giá của việc giữ nguyên prefix ────────────────────────────────
async function warmcold() {
  for (const dir of dirs) {
    for (const { idx, body } of loadBodies(dir, picks)) {
      console.log(`\n### ${dir.split("/").pop()} req-${idx} (${(body.tools || []).length} tools, ${label(body)})`);
      for (let i = 0; i < REPS; i++) row(`lặp lại ${i + 1}`, await call(body));
      // Ablation: thêm 1 dòng vào đầu system prompt = đổi prefix từ token số 0.
      const b2 = await call({ ...body, messages: body.messages.map((m, i) => (i === 0 ? { ...m, content: "x " + m.content } : m)) });
      row("đổi 1 ký tự đầu", b2, "  ← cold prefill thật");
      const noTools = await call({ ...body, tools: undefined });
      row("bỏ tools", noTools);
      const three = await call({ ...body, tools: (body.tools || []).slice(0, 3) });
      row("chỉ 3 tools", three);
    }
  }
}

// ── scatter: server chia slot có làm mất cache không ────────────────────────
async function scatter() {
  const list = loadBodies(dirs[0], picks);
  if (list.length < 2) {
    console.error("scatter cần 2 idx khác nhau (2 prompt xen kẽ).");
    process.exit(2);
  }
  const [a, b] = list;
  for (const slot of [null, Number(PIN ?? 0)]) {
    console.log(`\n### ${slot == null ? "KHÔNG pin slot" : `pin slot_id=${slot}`} — xen kẽ P${a.idx}/P${b.idx}`);
    let cold = 0;
    for (let i = 0; i < REPS; i++) {
      for (const p of [a, b]) {
        const r = await call(p.body, { slot });
        if (r.tok && r.cached / r.tok < 0.5) cold++;
        row(`vòng ${i + 1} P${p.idx}`, r);
      }
    }
    console.log(`  → ${cold}/${REPS * 2} lượt LẠNH (reuse < 50%)`);
  }
}

console.log(`engine: ${UPSTREAM} · mode: ${MODE} · capture: ${dirs.join(",")}${PIN != null ? ` · slot_id=${PIN}` : ""}\n`);
if (MODE === "anatomy") await anatomy();
else if (MODE === "blocks") await blocks();
else if (MODE === "warmcold") await warmcold();
else if (MODE === "scatter") await scatter();
else {
  console.error(`mode không rõ: ${MODE} (anatomy|blocks|warmcold|scatter)`);
  process.exit(2);
}
