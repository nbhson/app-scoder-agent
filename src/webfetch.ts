import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { ToolContext, ToolResult } from "./tools.js";

/**
 * web_fetch — read-only HTTP(S) fetch with SSRF protection.
 *
 * - Only http/https; follows up to 5 redirects, validating every hop.
 * - Private/loopback/link-local addresses are blocked by default
 *   (env SCODER_WEB_ALLOW_PRIVATE=1 lifts the block for local dev/testing).
 * - HTML is converted to plain text; JSON is pretty-printed; binary is refused.
 * - Output is capped so a huge page cannot flood the LLM context.
 */

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 20_000;

function allowPrivate(): boolean {
  return process.env.SCODER_WEB_ALLOW_PRIVATE === "1";
}

/** True if the address is private/loopback/link-local (IPv4 + IPv6). */
function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
    // IPv4-mapped ::ffff:10.0.0.1
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not parseable -> treat as private (fail closed)
}

/** Resolve hostname and refuse private addresses (unless explicitly allowed). */
async function assertPublicHost(hostname: string): Promise<void> {
  if (allowPrivate()) return;
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for "${hostname}": ${(err as Error).message}`, { cause: err });
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for "${hostname}"`);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr.address)) {
      throw new Error(
        `Blocked: "${hostname}" resolves to a private/loopback address (${addr.address}). ` +
        `web_fetch only reaches public hosts (set SCODER_WEB_ALLOW_PRIVATE=1 to allow local testing).`,
      );
    }
  }
}

/** Decode the HTML entities that actually appear in practice. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
    hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®",
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

/** Convert HTML to readable plain text (scripts/styles stripped, block tags → newlines). */
export function htmlToText(html: string): string {
  const out = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/section|\/article|\/header|\/footer|\/h[1-6]|\/li|\/tr|\/pre|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return decodeEntities(out);
}

/** Extract the <title> of an HTML document, if present. */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!m) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : null;
}

/** Read the response body as text, capped at MAX_BODY_BYTES, then cancel the stream. */
async function readBodyCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return { text: text + decoder.decode(), truncated: true };
    }
  }
  return { text: text + decoder.decode(), truncated: false };
}

export interface WebFetchArgs {
  url: string;
  max_chars?: number;
}

/** Implementation of the web_fetch tool. Also used by tests via the registry. */
export async function toolWebFetch(ctx: ToolContext, args: WebFetchArgs): Promise<ToolResult> {
  const maxChars = Math.min(Math.max(args.max_chars ?? DEFAULT_MAX_CHARS, 500), 100_000);

  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    return { ok: false, output: `ERROR: invalid URL: ${args.url}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, output: `ERROR: only http/https URLs are supported (got ${url.protocol})` };
  }

  // Combined timeout + external abort (SIGINT) — manual composition for Node 18 compat
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${FETCH_TIMEOUT_MS / 1000}s`)),
    FETCH_TIMEOUT_MS,
  );
  const onExternalAbort = () => controller.abort(new Error("interrupted by user"));
  if (ctx.signal?.aborted) onExternalAbort();
  else ctx.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const signal = controller.signal;

  let current = url;
  try {
    // Redirect loop with per-hop SSRF validation
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (signal.aborted) {
        return { ok: false, output: `ERROR: fetch aborted (${(signal.reason as Error)?.message ?? "aborted"})` };
      }
      await assertPublicHost(current.hostname);

      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "scoder-agent (+https://github.com/nbhson/app-scoder-agent)",
          Accept: "text/html, application/json, text/plain;q=0.9, */*;q=0.1",
        },
        signal,
      });

      // Follow redirects manually so every hop is validated against SSRF
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (!loc) {
          return { ok: false, output: `ERROR: ${res.status} redirect without Location header at ${current.href}` };
        }
        if (hop === MAX_REDIRECTS) {
          return { ok: false, output: `ERROR: too many redirects (>${MAX_REDIRECTS}) fetching ${args.url}` };
        }
        current = new URL(loc, current);
        continue;
      }

      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return { ok: false, output: `ERROR: HTTP ${res.status} ${res.statusText} for ${current.href}` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (/^(image|audio|video|font|application\/(octet-stream|zip|gzip|pdf|wasm))/i.test(contentType)) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return { ok: false, output: `ERROR: unsupported content-type "${contentType}" — web_fetch returns text only (html/json/plain).` };
      }

      const { text: body, truncated } = await readBodyCapped(res);

      let text: string;
      if (/json/i.test(contentType)) {
        text = prettyJson(body) ?? body;
      } else if (/html/i.test(contentType) || /^\s*</.test(body)) {
        text = htmlToText(body);
      } else {
        text = body;
      }
      const title = /text\/html/i.test(contentType) ? extractTitle(body) : null;

      const meta = [
        `HTTP ${res.status} ${res.statusText || ""}`.trimEnd(),
        contentType || "unknown content-type",
        truncated ? `body truncated at ${MAX_BODY_BYTES / 1024}KB` : null,
      ].filter(Boolean).join(", ");

      const out = `${text.slice(0, maxChars)}${text.length > maxChars ? `\n... [truncated, ${text.length - maxChars} more chars]` : ""}`;
      return {
        ok: true,
        output: `${title ? `Title: ${title}\n` : ""}${current.href}\n(${meta})\n\n${out}`,
      };
    }
    // unreachable
    return { ok: false, output: "ERROR: redirect loop" };
  } catch (err) {
    return { ok: false, output: `ERROR: fetch failed for ${current.href}: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function prettyJson(body: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return undefined;
  }
}
