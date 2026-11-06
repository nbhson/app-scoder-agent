import process from "node:process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import * as ui from "../ui.js";

/**
 * `scoder init` — first-run wizard: asks for the essentials, writes
 * .scoderrc.json, then offers a live connection test against the provider.
 */
export async function runInit(): Promise<void> {
  const { existsSync, writeFileSync } = await import("node:fs");
  const rcPath = resolve(process.cwd(), ".scoderrc.json");

  ui.banner("scoder init — configure this project", [
    ["file", rcPath],
    ["note", "answers are saved to .scoderrc.json (env vars still override)"],
  ]);

  if (existsSync(rcPath)) {
    const rl0 = createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await new Promise<string>((res) =>
      rl0.question(`.scoderrc.json already exists — overwrite? [y/N] `, res),
    );
    rl0.close();
    if (!/^y(es)?$/i.test(overwrite.trim())) {
      ui.info("kept the existing .scoderrc.json");
      return;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def: string) =>
    new Promise<string>((res) => rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => res(a.trim() || def)));

  // I-03: probe local engines first — suggest when found (no auto-switch when
  // a cloud key exists; user always decides).
  ui.info("probing local engines (ollama :11434, lmstudio :1234, vllm :8000)…");
  const { discoverLocalEngines } = await import("../provider-registry.js");
  const locals = await discoverLocalEngines();
  for (const e of locals) {
    ui.info(`  found ${e.provider.id} at ${e.provider.baseUrl} — ${e.models.length} model(s), e.g. ${e.models[0]}`);
  }

  const suggestBase = locals[0]?.provider.baseUrl ?? "https://api.openai.com/v1";
  const suggestModel = locals[0]?.models[0] ?? "gpt-4o-mini";
  const baseUrl = await ask("API base URL (OpenAI-compatible)", suggestBase);
  const apiKey = await ask("API key (SCODER_API_KEY/OPENAI_API_KEY also work at runtime)", "");
  const model = await ask("Model", suggestModel);
  const buildCmd = await ask("Build command (empty = auto-detect)", "");
  const permission = (await ask("Permission mode (auto | ask | readonly)", "auto")).toLowerCase();
  rl.close();

  const provider = /api\.anthropic\.com/.test(baseUrl) || /^claude-/i.test(model) ? "anthropic" : "openai";
  const rc: Record<string, unknown> = {
    model,
    baseUrl,
    provider,
    ...(buildCmd ? { buildCmd } : {}),
    permissions: { mode: ["auto", "ask", "readonly"].includes(permission) ? permission : "auto" },
  };
  writeFileSync(rcPath, JSON.stringify(rc, null, 2) + "\n");
  ui.success(`wrote ${rcPath} (provider: ${provider})`);

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const doTest = await new Promise<string>((res) => rl2.question("Test the connection now? [Y/n] ", res));
  rl2.close();
  if (!/^y(es)?$/i.test(doTest.trim()) && doTest.trim() !== "") {
    ui.info("skipped connection test");
    return;
  }
  if (!apiKey) {
    ui.warn("no API key provided — set SCODER_API_KEY/OPENAI_API_KEY before running tasks");
    return;
  }
  ui.info(`connecting to ${baseUrl} (${provider}) …`);
  try {
    const { LlmClient } = await import("../llm.js");
    const { AnthropicClient } = await import("../provider-anthropic.js");
    const client =
      provider === "anthropic"
        ? new AnthropicClient({ baseUrl, apiKey, model, maxTokens: 16, temperature: 0 })
        : new LlmClient({ baseUrl, apiKey, model, maxTokens: 16, temperature: 0 });
    const res = await client.chat([{ role: "user", content: "Reply with exactly: OK" }], []);
    const reply = (res.message.content ?? "").trim();
    ui.success(`connection OK — model replied: ${JSON.stringify(reply)}`);
  } catch (err) {
    ui.error(`connection test failed: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}

