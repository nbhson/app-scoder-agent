import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Transform } from "node:stream";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * web_fetch — read-only HTTP(S) fetch with SSRF protection.
 *
 * - Only http/https; follows up to 5 redirects, validating every hop.
 * - Private/loopback/link-local addresses are blocked by default
 *   (env SCODER_WEB_ALLOW_PRIVATE=1 lifts the block for local dev/testing).
 * - SSRF is closed at the SOCKET level, not by inspection alone: DNS is
 *   resolved ONCE, every returned address is validated, and the connection
 *   is PINNED to that audited IP (custom `lookup` + `agent: false`). A
 *   nameserver rotating records between check and connect (DNS rebinding /
 *   TOCTOU) can no longer turn a vetted host into 127.0.0.1.
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
export function isPrivateAddress(ip: string): boolean {
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
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10 (fe80–febf)
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
    // IPv4-mapped ::ffff:10.0.0.1
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not parseable -> treat as private (fail closed)
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolve a hostname and REFUSE private addresses (unless explicitly allowed).
 * Returns the single IP the connection must be pinned to — the caller must
 * use THIS address (not the hostname) for the socket, closing the window
 * where DNS could answer differently at connect time than at check time.
 */
export async function resolvePinnedAddress(hostname: string): Promise<PinnedAddress> {
  const bare = hostname.replace(/^\[|\]$/g, ""); // IPv6 literals arrive bracketed from URL
  const literal = isIP(bare);
  if (literal) {
    if (!allowPrivate() && isPrivateAddress(bare)) throw privateBlockedError(hostname, bare);
    return { address: bare, family: literal === 6 ? 6 : 4 };
  }
  let addresses;
  try {
    addresses = await dnsLookup(bare, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for "${hostname}": ${(err as Error).message}`, { cause: err });
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for "${hostname}"`);
  }
  for (const addr of addresses) {
    if (!allowPrivate() && isPrivateAddress(addr.address)) {
      throw privateBlockedError(hostname, addr.address);
    }
  }
  // Validate EVERY answer, then pin the first — a public+private A/AAAA mix
  // (the classic rebinding payload) can no longer slip a private route in.
  const first = addresses[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function privateBlockedError(hostname: string, addr: string): Error {
  return new Error(
    `Blocked: "${hostname}" resolves to a private/loopback address (${addr}). ` +
      `web_fetch only reaches public hosts (set SCODER_WEB_ALLOW_PRIVATE=1 to allow local testing).`,
  );
}

/** The pinned socket destination — an unabortable re-resolve can miss it. */
export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  /** Body, decompressed and decoded as UTF-8, capped at MAX_BODY_BYTES. */
  text: string;
  truncated: boolean;
}

/**
 * GET `current` with the connection PINNED to `pinned`: the `lookup` override
 * hands the transport layer the audited IP directly, so no second resolution
 * happens, and `agent: false` guarantees no pooled keep-alive socket from an
 * earlier DNS answer is reused. TLS still verifies the cert against the
 * ORIGINAL hostname (servername/SNI + Host header).
 */
export function pinnedRequest(current: URL, pinned: PinnedAddress, signal: AbortSignal): Promise<PinnedResponse> {
  return new Promise((resolveP, rejectP) => {
    const secure = current.protocol === "https:";
    const port = Number(current.port) || (secure ? 443 : 80);
    const originalHost = current.hostname.replace(/^\[|\]$/g, "");
    // Node ≥20 connects through lookupAndConnectMultiple with `all: true`
    // (happy-eyeballs): the override must answer in the SAME shape, always
    // with the audited IP — nothing ever reaches the resolver.
    const pinLookup = (
      _h: string,
      o: unknown,
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ): void => {
      if (o && typeof o === "object" && (o as { all?: boolean }).all) {
        cb(null, [{ address: pinned.address, family: pinned.family }]);
      } else {
        cb(null, pinned.address, pinned.family);
      }
    };
    const req: ClientRequest = (secure ? httpsRequest : httpRequest)(
      {
        hostname: current.hostname, // Host header + SNI keep the real name
        port,
        path: `${current.pathname || "/"}${current.search}`,
        method: "GET",
        agent: false, // fresh, pinned, re-validated connection per hop
        lookup: pinLookup,
        ...(secure && !isIP(originalHost) ? { servername: originalHost } : {}),
        signal,
        headers: {
          "User-Agent": "scoder-agent (+https://github.com/nbhson/app-scoder-agent)",
          Accept: "text/html, application/json, text/plain;q=0.9, */*;q=0.1",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
    );

    req.on("response", (res) => {
      const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
      const decompressor: Transform | null = /gzip|x-gzip/.test(encoding)
        ? createGunzip()
        : encoding.includes("br")
          ? createBrotliDecompress()
          : encoding.includes("deflate")
            ? createInflate()
            : null;

      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) {
          rejectP(err);
          return;
        }
        resolveP({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers: res.headers,
          text: new TextDecoder("utf-8").decode(Buffer.concat(chunks)),
          truncated,
        });
      };

      const source: NodeJS.ReadableStream = decompressor ? res.pipe(decompressor) : res;
      source
        .on("data", (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (received >= MAX_BODY_BYTES) {
            truncated = true;
            finish(); // settle BEFORE destroying: the zlib 'EOM' error must not surface
            res.destroy();
            req.destroy();
          }
        })
        .on("end", () => finish())
        .on("error", (e: Error) => finish(e));
      res.on("error", (e: Error) => finish(e));
    });
    req.on("error", (err) => rejectP(err));
    // No callback form here — without end() the request would NEVER be sent
    // (headers stay buffered; lookup/connect never happen). GET: empty body.
    req.end();
  });
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
    // Redirect loop with per-hop resolve → validate → PIN (the pin is what
    // the socket actually connects to, so rotation between hops and checks
    // cannot matter — every hop is freshly vetted and freshly pinned).
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (signal.aborted) {
        return { ok: false, output: `ERROR: fetch aborted (${(signal.reason as Error)?.message ?? "aborted"})` };
      }
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        return { ok: false, output: `ERROR: redirect target uses unsupported protocol ${current.protocol}` };
      }
      const pinned = await resolvePinnedAddress(current.hostname);
      const res = await pinnedRequest(current, pinned, signal);

      // Follow redirects manually so every hop is validated + pinned
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.location;
        if (!loc) {
          return { ok: false, output: `ERROR: ${res.status} redirect without Location header at ${current.href}` };
        }
        if (hop === MAX_REDIRECTS) {
          return { ok: false, output: `ERROR: too many redirects (>${MAX_REDIRECTS}) fetching ${args.url}` };
        }
        current = new URL(loc, current);
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, output: `ERROR: HTTP ${res.status} ${res.statusText} for ${current.href}` };
      }

      const contentType = String(res.headers["content-type"] ?? "");
      if (/^(image|audio|video|font|application\/(octet-stream|zip|gzip|pdf|wasm))/i.test(contentType)) {
        return { ok: false, output: `ERROR: unsupported content-type "${contentType}" — web_fetch returns text only (html/json/plain).` };
      }

      const body = res.text;
      const truncated = res.truncated;

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
        `HTTP ${res.status} ${res.statusText}`.trimEnd(),
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
