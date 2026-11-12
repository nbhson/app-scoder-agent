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

/** Tuỳ chọn xác thực — server local vẫn có thể bật --api-key. */
export interface ProbeAuth {
  apiKey?: string;
  /** Header bổ sung (vd. Authorization đã có sẵn trong rc.headers). */
  headers?: Record<string, string>;
}

/** Cache theo (origin, model) — một engine một window, không probe lại mỗi bước. */
const cache = new Map<string, ProbedWindow | null>();

function originOf(baseUrl: string): string | null {
  try {
    // baseUrl có thể có space thừa (" http://0.0.0.0:8080/v1" trong rc thật) —
    // URL() tự trim, nên parse được cả khi user gõ dư khoảng trắng.
    const u = new URL(baseUrl.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function authHeaders(auth?: ProbeAuth): Record<string, string> {
  const h: Record<string, string> = { ...(auth?.headers ?? {}) };
  if (auth?.apiKey && !h.authorization && !h["x-api-key"]) h.authorization = `Bearer ${auth.apiKey}`;
  return h;
}

async function jsonFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  auth?: ProbeAuth,
): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...authHeaders(auth), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null; // 401 khi server bật --api-key: probe im lặng, giữ fallback
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

async function probeLlamaCpp(
  origin: string,
  timeoutMs: number,
  auth?: ProbeAuth,
): Promise<ProbedWindow | null> {
  type Props = {
    n_ctx?: unknown;
    total_n_ctx?: unknown;
    n_ctx_slot?: unknown;
    total_slots?: unknown;
    default_generation_settings?: { n_ctx?: unknown; params?: { n_ctx?: unknown } };
  };
  const props = (await jsonFetch(`${origin}/props`, { method: "GET" }, timeoutMs, auth)) as Props | null;
  if (!props) return null;
  // llama.cpp hiện để window ở default_generation_settings.n_ctx (per-slot),
  // KHÔNG ở top level; các build cũ hơn dùng n_ctx / n_ctx_slot / total_n_ctx.
  const perSlot =
    asNumber(props.default_generation_settings?.n_ctx) ??
    asNumber(props.default_generation_settings?.params?.n_ctx) ??
    asNumber(props.n_ctx_slot) ??
    asNumber(props.n_ctx);
  // total_n_ctx = perSlot * total_slots: dùng perSlot vì MỘT hội thoại sống
  // trong MỘT slot; lấy total sẽ phóng to window lên số lần sai.
  const n = perSlot ?? asNumber(props.total_n_ctx);
  if (!n) return null;
  const slots = asNumber(props.total_slots);
  return {
    tokens: n,
    source: "llama.cpp",
    detail: `GET /props n_ctx=${n}${slots && slots > 1 ? ` (server chia ${slots} slot — request rải nhau nên KV-cache ít được dùng lại hơn)` : ""}`,
  };
}

async function probeOllama(
  origin: string,
  model: string,
  timeoutMs: number,
  auth?: ProbeAuth,
): Promise<ProbedWindow | null> {
  const show = (await jsonFetch(
    `${origin}/api/show`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) },
    timeoutMs,
    auth,
  )) as { parameters?: unknown; model_info?: unknown; context_window?: unknown } | null;
  if (!show) return null;
  const runtime = numCtxFromParameters(show.parameters) ?? asNumber(show.context_window);
  if (runtime) return { tokens: runtime, source: "ollama", detail: `POST /api/show num_ctx=${runtime}` };
  const declared = ctxLengthFromModelInfo(show.model_info);
  if (declared) return { tokens: declared, source: "ollama", detail: `model_info ctx_length=${declared} (server không đặt num_ctx)` };
  return null;
}

async function probeVllm(
  baseUrl: string,
  origin: string,
  model: string,
  timeoutMs: number,
  auth?: ProbeAuth,
): Promise<ProbedWindow | null> {
  // baseUrl OpenAI-compatible thường đã gồm /v1 → GET {base}/models; thử thêm
  // {origin}/v1/models cho server đặt root khác.
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  for (const url of [`${trimmed}/models`, `${origin}/v1/models`]) {
    const list = (await jsonFetch(url, { method: "GET" }, timeoutMs, auth)) as
      | { data?: Array<{ id?: string; max_model_len?: unknown; created?: unknown }> }
      | null;
    if (!list?.data?.length) continue;
    const entry = list.data.find((m) => m.id === model) ?? list.data[0];
    const n = asNumber(entry?.max_model_len);
    if (n) return { tokens: n, source: "vllm", detail: `GET ${url} max_model_len=${n}` };
  }
  return null;
}

/**
 * Probe window thật của (baseUrl, model). null = không xác định được (giữ
 * cách xử lý cũ). Không bao giờ throw — agent vẫn chạy bình thường với server
 * không expose metadata.
 */
export async function probeContextWindow(
  baseUrl: string,
  model: string,
  timeoutMs = 1_500,
  auth?: ProbeAuth,
): Promise<ProbedWindow | null> {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  const key = `${origin}|${model}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const found =
    (await probeOllama(origin, model, timeoutMs, auth)) ??
    (await probeLlamaCpp(origin, timeoutMs, auth)) ??
    (await probeVllm(baseUrl, origin, model, timeoutMs, auth));
  cache.set(key, found);
  return found;
}

/** Test hook: xoá cache trong tiến trình (không dùng trong code production). */
export function resetContextProbeCache(): void {
  cache.clear();
}
