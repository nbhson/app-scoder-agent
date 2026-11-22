import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { Utf8Buffer } from "../shared/decode.js";
import { Agent, type AgentEvent, type AgentRunResult } from "../agent.js";
import type { AgentConfig } from "../config/config.js";

/**
 * `scoder serve` — HTTP API that runs agent tasks in the background and
 * streams progress as Server-Sent Events (SSE).
 *
 * Endpoints (all under /api):
 *   GET  /api/health              -> { ok, version, runs }
 *   GET  /api/runs                -> list of runs (status, task, timing)
 *   POST /api/runs                -> start a run { task, workdir?, buildCmd?, model?, provider?, maxSteps?, permission? }
 *                                  -> 202 { id, eventsUrl }
 *   GET  /api/runs/:id            -> run status + result
 *   GET  /api/runs/:id/events     -> SSE stream (full replay, then live, closes on finish)
 *   POST /api/runs/:id/abort      -> abort a running run (like SIGINT)
 *   POST /api/runs/:id/steer      -> steer a running run { text } (delivered at next step boundary)
 *
 * Auth: EVERY request must send `Authorization: Bearer <token>`. The token
 * is SCODER_SERVER_TOKEN when set, otherwise one is generated at startup and
 * printed by `scoder serve` — an unauthenticated agent server is remote code
 * execution, so there is no "no auth" default. Browser drive-by defenses:
 * a loopback bind rejects foreign Host headers (DNS rebinding), requests
 * carrying an Origin/Referer must be same-origin (CSRF), and JSON endpoints
 * demand `Content-Type: application/json` (no CORS-simple text/plain form
 * POSTs). Token compare is constant-time.
 * Runs are always non-interactive; permission "ask" is rejected because a
 * server cannot prompt.
 */

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Max concurrently running agent tasks (extra requests get 429). */
  maxConcurrent?: number;
  /**
   * Authorization token override. Defaults to SCODER_SERVER_TOKEN, then to a
   * freshly generated random token — authentication is never optional in the
   * default path. Pass a value in tests/embedding to make it deterministic.
   */
  token?: string;
}

export interface RunRequest {
  task: string;
  workdir?: string;
  buildCmd?: string;
  model?: string;
  provider?: "openai" | "anthropic";
  maxSteps?: number;
  permission?: "auto" | "readonly";
}

type RunStatus = "running" | "success" | "failed" | "error" | "aborted";

interface RunRecord {
  id: string;
  task: string;
  workdir: string;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  events: AgentEvent[];
  /**
   * P-perf (leak): ring buffer — sau MAX_EVENTS_PER_RUN, event cũ nhất bị
   * bỏ khỏi bộ nhớ (agent dài ngày với tool_output dày đặc từng giữ chuỗi
   * delta vô hạn). `dropped` = số event đã bỏ ở HEAD; mọi chỉ số trong
   * đường SSE dùng seq TUYỆT ĐỐI (dropped + index) nên client đang kết nối
   * không lệch vị trí.
   */
  dropped: number;
  subscribers: Set<() => void>;
  agent: Agent | null;
  abortRequested: boolean;
  result: AgentRunResult | null;
  error: string | null;
}

const MAX_BODY_BYTES = 1024 * 1024;
/** P-perf: trần event giữ trong bộ nhớ mỗi run (replay cho client reconnect). */
export const MAX_EVENTS_PER_RUN = 5_000;
/** P-perf: số run hoàn tất giữ lại cho GET /api/runs (LRO theo insertion). */
export const MAX_RETAINED_RUNS = 200;

function pushEvent(record: RunRecord, ev: AgentEvent): void {
  record.events.push(ev);
  if (record.events.length > MAX_EVENTS_PER_RUN) {
    record.events.shift();
    record.dropped++;
  }
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    // P1-15: the body is UTF-8 JSON (task prompts are Vietnamese + emoji);
    // decoding each socket chunk on its own turned a split multi-byte
    // character into U+FFFD inside the user's own task text.
    const body = new Utf8Buffer();
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.byteLength;
      if (size > maxBytes) {
        reject(new Error(`request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      body.push(c);
    });
    req.on("end", () => resolve(body.finish()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true; // only via explicit ServeOptions.token override
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length), "utf8");
  const want = Buffer.from(token, "utf8");
  // Constant-time: a `===` here leaks the token's length + common prefix to
  // an attacker probing timing across the network (however unlikely on LAN).
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Hostnames a loopback bind will accept in Host/Origin headers. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function stripPort(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close >= 0 ? h.slice(0, close + 1) : h; // [::1] or [::1]:port
  }
  const colon = h.indexOf(":");
  return colon > 0 ? h.slice(0, colon) : h; // host:port
}

/**
 * DNS-rebinding / CSRF guard. Loopback binds accept only loopback Hostnames
 * (an attacker page re-resolving evil.com → 127.0.0.1 arrives with
 * Host: evil.com). Origin/Referer, when present, must use a loopback scheme
 * +hostname too — browsers always send Origin on cross-origin POSTs, so this
 * closes the form-drive-by hole even if a token leaks into a referrable URL.
 */
function browserGuard(req: IncomingMessage, loopbackBind: boolean): string | null {
  const hostHdr = stripPort(req.headers.host ?? "");
  if (loopbackBind && !LOOPBACK_HOSTS.has(hostHdr)) {
    return `host not allowed: ${hostHdr} (this server binds to loopback)`;
  }
  const originHdr = req.headers.origin ?? req.headers.referer ?? "";
  if (!originHdr) return null;
  let o: string;
  try {
    const u = new URL(originHdr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "origin scheme not allowed";
    o = u.hostname.toLowerCase() === "::1" ? "[::1]" : u.hostname.toLowerCase();
  } catch {
    return "malformed Origin header";
  }
  if (loopbackBind && !LOOPBACK_HOSTS.has(o)) return `cross-origin request blocked: ${originHdr}`;
  return null;
}

/** JSON endpoints refuse text/plain — a no-preflight "simple" CORS body. */
function isJsonRequest(req: IncomingMessage): boolean {
  return /^application\/json/i.test(req.headers["content-type"] ?? "");
}

export interface RunningServer {
  server: Server;
  port: number;
  /** The token every request must present (generated when unset). */
  token: string;
  /** True when the token came from SCODER_SERVER_TOKEN (else generated). */
  tokenFromEnv: boolean;
  /** Stop the HTTP server and abort any in-flight runs. */
  close: () => Promise<void>;
}

export function startServer(baseConfig: AgentConfig, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const envToken = process.env.SCODER_SERVER_TOKEN || "";
  const token = opts.token ?? (envToken || randomBytes(24).toString("base64url"));
  const loopbackBind = LOOPBACK_HOSTS.has(host === "0.0.0.0" ? "" : host === "::1" ? "[::1]" : host.toLowerCase());

  /** id -> run record; Map preserves insertion order (= creation order). */
  const runs = new Map<string, RunRecord>();

  const publicRun = (r: RunRecord) => ({
    id: r.id,
    task: r.task,
    workdir: r.workdir,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    eventCount: r.dropped + r.events.length,
    result: r.result,
    error: r.error,
    eventsUrl: `/api/runs/${r.id}/events`,
  });

  const runningCount = () =>
    [...runs.values()].filter((r) => r.status === "running").length;

  /** Launch an agent run in the background, wiring events into the record. */
  const launchRun = (record: RunRecord, cfg: AgentConfig, task: string): void => {
    const agent = new Agent(cfg);
    record.agent = agent;
    agent.onEvent = (ev: AgentEvent) => {
      pushEvent(record, ev);
      if (ev.type === "finish") {
        record.status = ev.success ? "success" : record.abortRequested ? "aborted" : "failed";
        record.finishedAt = new Date().toISOString();
      }
      for (const sub of record.subscribers) sub();
    };
    agent
      .run(task)
      .then((result) => {
        record.result = result;
        if (record.status === "running") {
          // Should not happen (finish event always arrives first), but be safe.
          record.status = result.success ? "success" : record.abortRequested ? "aborted" : "failed";
          record.finishedAt = new Date().toISOString();
        }
      })
      .catch((err: unknown) => {
        record.error = (err as Error).message;
        // Synthetic terminal events so SSE clients always see a stream end.
        pushEvent(record, { type: "error", message: record.error });
        pushEvent(record, { type: "finish", success: false, steps: 0, summary: `run failed: ${record.error}` });
        record.status = "error";
        record.finishedAt = new Date().toISOString();
        for (const sub of record.subscribers) sub();
      })
      // MCP connections live for the agent lifetime — each server run owns an
      // ephemeral agent, so dispose it here (never leak child processes).
      .finally(() => agent.dispose());
  };

  const handleEventsSSE = (req: IncomingMessage, res: ServerResponse, record: RunRecord): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Absolute sequence cursor: record.events[seq - record.dropped].
    // Starts at `dropped` → a late-joining client gets the retained tail.
    let sent = record.dropped;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();

    /** Replay buffered events + live ones; ends the stream on a terminal event. */
    const flush = (): void => {
      while (sent < record.dropped + record.events.length) {
        const ev = record.events[sent - record.dropped];
        sent++;
        const terminal = ev.type === "finish" || ev.type === "error";
        // P-perf: honor backpressure — a slow/stalled consumer used to grow
        // the socket queue unboundedly (every event written regardless).
        // res.once("drain") resumes the pump; terminal events still close.
        const ok = res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (terminal) {
          res.end();
          record.subscribers.delete(flush);
          return;
        }
        if (!ok && !res.writableEnded) {
          res.once("drain", flush);
          return;
        }
      }
    };

    record.subscribers.add(flush);
    flush(); // replays the buffer, then stays live via the subscription
    req.on("close", () => {
      record.subscribers.delete(flush);
      res.removeListener("drain", flush);
      clearInterval(heartbeat);
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Rebinding/CSRF guard runs BEFORE auth: it must reject even correctly
    // tokened requests arriving via a rogue Host/Origin (token + attacker
    // page means nothing if the browser is being driven cross-site).
    const guard = browserGuard(req, loopbackBind);
    if (guard) {
      sendJson(res, 403, { error: guard });
      return;
    }

    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { error: "unauthorized (set Authorization: Bearer <SCODER_SERVER_TOKEN>)" });
      return;
    }

    // ── GET /api/health ──
    if (path === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, running: runningCount(), runs: runs.size });
      return;
    }

    // ── /api/runs ──
    if (path === "/api/runs") {
      if (req.method === "GET") {
        sendJson(res, 200, { runs: [...runs.values()].map(publicRun) });
        return;
      }
      if (req.method === "POST") {
        if (runningCount() >= maxConcurrent) {
          sendJson(res, 429, { error: `too many concurrent runs (max ${maxConcurrent}) — retry later` });
          return;
        }
        if (!isJsonRequest(req)) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        let body: RunRequest;
        try {
          body = JSON.parse(await readBody(req)) as RunRequest;
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return;
        }
        if (typeof body.task !== "string" || body.task.trim().length === 0) {
          sendJson(res, 400, { error: 'field "task" (non-empty string) is required' });
          return;
        }
        const cfg = { ...baseConfig, yes: true };
        if (body.workdir) {
          const abs = resolve(body.workdir);
          if (!existsSync(abs) || !statSync(abs).isDirectory()) {
            sendJson(res, 400, { error: `workdir does not exist or is not a directory: ${body.workdir}` });
            return;
          }
          cfg.workdir = abs;
        }
        const permission = body.permission ?? cfg.permissionMode;
        if (permission === "ask") {
          sendJson(res, 400, { error: 'permission "ask" is not supported by the server (it cannot prompt). Use "auto" or "readonly".' });
          return;
        }
        cfg.permissionMode = permission;
        if (body.buildCmd) cfg.buildCmd = body.buildCmd;
        if (body.model) cfg.model = body.model;
        if (body.provider) cfg.provider = body.provider;
        if (body.maxSteps) cfg.maxSteps = Math.min(Math.max(body.maxSteps, 1), 500);

        const record: RunRecord = {
          id: randomUUID(),
          task: body.task,
          workdir: cfg.workdir,
          status: "running",
          createdAt: new Date().toISOString(),
          finishedAt: null,
          events: [],
          dropped: 0,
          subscribers: new Set(),
          agent: null,
          abortRequested: false,
          result: null,
          error: null,
        };
        runs.set(record.id, record);
        // P-perf (leak): Map giữ theo thứ tự khởi tạo — bỏ run cũ NHẤT đã
        // kết nối khi vượt trần; run đang chạy không bao giờ bị xoá.
        while (runs.size > MAX_RETAINED_RUNS) {
          let victim: string | null = null;
          for (const [id, r] of runs) {
            if (r.status === "running") continue;
            victim = id;
            break;
          }
          if (victim === null) break; // mọi run đều đang chạy — không xoá gì
          runs.delete(victim);
        }
        launchRun(record, cfg, body.task);
        sendJson(res, 202, publicRun(record));
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // ── /api/runs/:id[...] ──
    const runMatch = path.match(/^\/api\/runs\/([0-9a-f-]{36})(\/events|\/abort|\/steer)?$/i);
    if (runMatch) {
      const record = runs.get(runMatch[1]);
      if (!record) {
        sendJson(res, 404, { error: `unknown run id: ${runMatch[1]}` });
        return;
      }
      if (runMatch[2] === "/events" && req.method === "GET") {
        handleEventsSSE(req, res, record);
        return;
      }
      if (runMatch[2] === "/abort" && req.method === "POST") {
        if (record.status !== "running" || !record.agent) {
          sendJson(res, 409, { error: `run is not running (status: ${record.status})` });
          return;
        }
        record.abortRequested = true;
        record.agent.abort();
        sendJson(res, 200, { ok: true, status: "running (aborting...)" });
        return;
      }
      if (runMatch[2] === "/steer" && req.method === "POST") {
        if (record.status !== "running" || !record.agent) {
          sendJson(res, 409, { error: `run is not running (status: ${record.status})` });
          return;
        }
        if (!isJsonRequest(req)) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        // P1-15: shared reader (multi-byte safe + size-capped) instead of an
        // ad-hoc per-chunk decode here.
        let body: string;
        try {
          body = await readBody(req, 1_000_000);
        } catch {
          sendJson(res, 413, { error: "request body too large" });
          return;
        }
        try {
          const text = (JSON.parse(body) as { text?: unknown }).text;
          if (typeof text !== "string" || !text.trim()) {
            sendJson(res, 400, { error: "body must be {text: string}" });
            return;
          }
          record.agent?.steer(text);
          sendJson(res, 200, { ok: true, delivered: "next step boundary" });
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
        }
        return;
      }
      if (!runMatch[2] && req.method === "GET") {
        sendJson(res, 200, publicRun(record));
        return;
      }
    }

    sendJson(res, 404, { error: `not found: ${req.method} ${path}` });
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.writableEnded) sendJson(res, 500, { error: "internal server error" });
    });
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        server,
        port,
        token,
        tokenFromEnv: opts.token === undefined && envToken !== "",
        close: () =>
          new Promise<void>((res) => {
            // Abort in-flight runs so background work does not keep the loop alive.
            for (const r of runs.values()) {
              if (r.status === "running") {
                r.abortRequested = true;
                r.agent?.abort();
              }
            }
            server.close(() => res());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
