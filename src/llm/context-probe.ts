/**
 * P1-1 (RC-4): lấy context window THẬT của engine đang phục vụ model.
 *
 * Vì sao cần: `contextWindowFor()` fallback 128k cho model lạ. Session
 * `20261106-023204-670b` chạy `qwen3.6:35b` trên Ollama/llama.cpp — server
 * thật chạy `num_ctx` nhỏ hơn nhiều. Agent tưởng còn 102k token để nén
 * (0.8 × 128k) trong khi server chỉ còn vài nghìn → server tự cắt history,
 * và mỗi lần server cắt là prefix đổi → mất KV-cache → re-prefill.
 *
 * Chiến lược (chỉ đọc, không gửi token nào):
 *   1. llama.cpp server: GET {origin}/props → n_ctx.
 *   2. Ollama: POST {origin}/api/show {model} → parameters "num_ctx N"
 *      (runtime), nếu không có thì model_info "*ctx_length" (window khai
 *      báo của model, floor theo catalog).
 *   3. OpenAI-compatible có `max_model_len` (vLLM): GET {origin}/v1/models.
 * Không chắc chắn → trả null, gọi giữ nguyên catalog fallback.
 */

export interface ProbedWindow {
  tokens: number;
  source: "llama.cpp" | "ollama" | "vllm";
  detail: string;
}

/** Cache theo (origin, model) — một engine một window, không probe lại mỗi bước. */
const cache = new Map<string, ProbedWindow | null>();

function originOf(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function jsonFetch(url: string, init: RequestInit, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // offline / không có endpoint này
  }
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/** "num_ctx 4096\nrope_freqscale 1" — chuỗi parameters của Ollama. */
function numCtxFromParameters(parameters: unknown): number | null {
  if (typeof parameters === "string") {
    const m = /(?:^|\s)num_ctx\s+(\d+)/i.exec(parameters);
    if (m) return Number(m[1]);
  }
  if (parameters && typeof parameters === "object") {
    return asNumber((parameters as Record<string, unknown>).num_ctx);
  }
  return null;
}

function ctxLengthFromModelInfo(info: unknown): number | null {
  if (!info || typeof info !== "object") return null;
  let best: number | null = null;
  for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
    if (!/ctx_length|context_length/i.test(k)) continue;
    const n = asNumber(v);
    if (n && (!best || n < best)) best = n; // window KHAI BÁO: lấy số nhỏ nhất (an toàn)
  }
  return best;
}

async function probeLlamaCpp(origin: string, timeoutMs: number): Promise<ProbedWindow | null> {
  const props = await jsonFetch(`${origin}/props`, { method: "GET" }, timeoutMs) as
    | { n_ctx?: unknown; total_n_ctx?: unknown; n_ctx_slot?: unknown }
    | null;
  if (!props) return null;
  const n = asNumber(props.total_n_ctx) ?? asNumber(props.n_ctx);
  if (!n) return null;
  return { tokens: n, source: "llama.cpp", detail: `GET /props n_ctx=${n}` };
}

async function probeOllama(origin: string, model: string, timeoutMs: number): Promise<ProbedWindow | null> {
  const show = await jsonFetch(
    `${origin}/api/show`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) },
    timeoutMs,
  ) as { parameters?: unknown; model_info?: unknown; context_window?: unknown } | null;
  if (!show) return null;
  const runtime = numCtxFromParameters(show.parameters) ?? asNumber(show.context_window);
  if (runtime) return { tokens: runtime, source: "ollama", detail: `POST /api/show num_ctx=${runtime}` };
  const declared = ctxLengthFromModelInfo(show.model_info);
  if (declared) return { tokens: declared, source: "ollama", detail: `model_info ctx_length=${declared} (server không đặt num_ctx)` };
  return null;
}

async function probeVllm(origin: string, model: string, timeoutMs: number): Promise<ProbedWindow | null> {
  const list = await jsonFetch(`${origin}/v1/models`, { method: "GET" }, timeoutMs) as
    { data?: Array<{ id?: string; max_model_len?: unknown; created?: unknown }> }
    | null;
  const entry = list?.data?.find((m) => m.id === model) ?? list?.data?.[0];
  const n = asNumber(entry?.max_model_len);
  return n ? { tokens: n, source: "vllm", detail: `GET /v1/models max_model_len=${n}` } : null;
}

/**
 * Probe window thật của (baseUrl, model). null = không xác định được (giữ
 * cách xử lý cũ). Không bao giờ throw — agent vẫn chạy bình thường với server
 * không expose metadata.
 */
export async function probeContextWindow(baseUrl: string, model: string, timeoutMs = 1_500): Promise<ProbedWindow | null> {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  const key = `${origin}|${model}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const found =
    (await probeOllama(origin, model, timeoutMs)) ??
    (await probeLlamaCpp(origin, timeoutMs)) ??
    (await probeVllm(origin, model, timeoutMs));
  cache.set(key, found);
  return found;
}

/** Test hook: xoá cache trong tiến trình (không dùng trong code production). */
export function resetContextProbeCache(): void {
  cache.clear();
}
