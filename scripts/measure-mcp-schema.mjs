#!/usr/bin/env node
/**
 * P0-3 / P2-4: đo kích thước tool schema gửi lên model mỗi lượt — và DỰ ĐOÁN
 * kết quả sau khi áp trần (`limits.mcpSchemaTokens`) / allowlist (`mcpTools`).
 *
 * Baseline prompt = system prompt + message history + TOÀN BỘ tool schema.
 * Script này tách riêng phần schema để biết bao nhiêu token là "chi phí cố
 * định" trả cho MCP (RC-2) và theo dõi sau khi fix.
 *
 *   node scripts/measure-mcp-schema.mjs                 # cấu hình hiện tại
 *   node scripts/measure-mcp-schema.mjs --offline       # bỏ qua MCP servers
 *   node scripts/measure-mcp-schema.mjs --cap 6000      # mô phỏng local profile
 *   node scripts/measure-mcp-schema.mjs --cap 6000 --include "mcp__github-mcp__get_*"
 */
import { encode } from "gpt-tokenizer";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allToolSpecs } from "../dist/tools/registry.js";

const offline = process.argv.includes("--offline");
const tokens = (value) => encode(JSON.stringify(value)).length;
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const cap = Number(argOf("cap", "0"));
const include = argOf("include", "").split(",").map((s) => s.trim()).filter(Boolean);
const exclude = argOf("exclude", "").split(",").map((s) => s.trim()).filter(Boolean);

function configuredServers() {
  if (offline) return {};
  for (const p of [join(process.cwd(), ".scoderrc.json"), join(homedir(), ".scoder", "config.json")]) {
    if (!existsSync(p)) continue;
    try {
      const rc = JSON.parse(readFileSync(p, "utf8"));
      if (rc.mcpServers && Object.keys(rc.mcpServers).length > 0) return rc.mcpServers;
    } catch {
      /* malformed file — bỏ qua, MCP sẽ báo lỗi riêng */
    }
  }
  return {};
}

const builtins = allToolSpecs();
const report = {
  builtin: { count: builtins.length, tokens: tokens(builtins) },
  mcp: { count: 0, tokens: 0, perServer: {}, descriptionChars: 0, parameterChars: 0, top: [] },
};

const servers = configuredServers();
if (Object.keys(servers).length > 0) {
  const { McpManager } = await import("../dist/mcp/manager.js");
  const manager = new McpManager(servers);
  manager.onStatus = (line) => console.error("·", line);
  await manager.connectAll();
  const specs = [...manager.toToolSpecs(), ...manager.resourceToolSpecs()];
  for (const spec of specs) {
    const server = spec.function.name.split("__")[1] ?? "(unknown)";
    report.mcp.perServer[server] = (report.mcp.perServer[server] ?? 0) + tokens(spec);
    report.mcp.descriptionChars += spec.function.description?.length ?? 0;
    report.mcp.parameterChars += JSON.stringify(spec.function.parameters ?? {}).length;
    report.mcp.top.push({ name: spec.function.name, tokens: tokens(spec), descriptionChars: spec.function.description?.length ?? 0 });
  }
  report.mcp.count = specs.length;
  report.mcp.tokens = tokens(specs);
  report.mcp.top.sort((a, b) => b.tokens - a.tokens);
  report.mcp.top = report.mcp.top.slice(0, 10);
  manager.killAll();
}

report.total = report.builtin.tokens + report.mcp.tokens;

// Dự đoán sau khi áp filter + trần schema (P0-3) — dùng đúng code production.
if (Object.keys(servers).length > 0 && (cap > 0 || include.length > 0 || exclude.length > 0)) {
  const { filterToolNames } = await import("../dist/mcp/tool-filter.js");
  const { capMcpSchemaTokens } = await import("../dist/agent/mcp-bridge.js");
  const { estimateSchemaTokens } = await import("../dist/context/compaction.js");
  const all = await collectMcpSpecs(servers);
  const filtered = filterToolNames(all, (s) => s.function.name, { include, exclude });
  const capped = capMcpSchemaTokens(filtered, cap, (line) => console.error("·", line));
  report.projected = {
    filter: { include, exclude, capTokens: cap },
    beforeTools: all.length,
    afterTools: capped.length,
    // `budgetTokens` = cách agent đếm (estimateSchemaTokens — chính là số so
    // với limits.mcpSchemaTokens); `wireTokens` = JSON thật của tool spec.
    budgetBefore: estimateSchemaTokens(all),
    budgetAfter: estimateSchemaTokens(capped),
    wireBefore: tokens(all),
    wireAfter: tokens(capped),
    savedWireTokens: tokens(all) - tokens(capped),
    dropped: all.filter((s) => !capped.includes(s)).map((s) => s.function.name),
  };
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);

/** Kết nối lại một lần nữa để lấy spec thô (chưa qua filter per-server). */
async function collectMcpSpecs(cfg) {
  const { McpManager } = await import("../dist/mcp/manager.js");
  const manager = new McpManager(cfg);
  manager.onStatus = () => {};
  await manager.connectAll();
  const specs = [...manager.toToolSpecs(), ...manager.resourceToolSpecs()];
  manager.killAll();
  return specs;
}
