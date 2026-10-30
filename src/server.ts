import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { Agent, type AgentEvent, type AgentRunResult } from "./agent.js";
import type { AgentConfig } from "./config.js";

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
 *
 * Auth: when SCODER_SERVER_TOKEN is set, every request must send
 * `Authorization: Bearer <token>`. The server binds 127.0.0.1 by default.
 * Runs are always non-interactive; permission "ask" is rejected because a
 * server cannot prompt.
 */

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Max concurrently running agent tasks (extra requests get 429). */
  maxConcurrent?: number;
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
  subscribers: Set<() => void>;
  agent: Agent | null;
  abortRequested: boolean;
  result: AgentRunResult | null;
  error: string | null;
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.byteLength;
      if (size > maxBytes) {
        reject(new Error(`request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      body += c.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

export interface RunningServer {
  server: Server;
  port: number;
  /** Stop the HTTP server and abort any in-flight runs. */
  close: () => Promise<void>;
}

export function startServer(baseConfig: AgentConfig, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const token = process.env.SCODER_SERVER_TOKEN || "";

  /** id -> run record; Map preserves insertion order (= creation order). */
  const runs = new Map<string, RunRecord>();

  const publicRun = (r: RunRecord) => ({
    id: r.id,
    task: r.task,
    workdir: r.workdir,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    eventCount: r.events.length,
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
      record.events.push(ev);
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
        record.events.push({ type: "error", message: record.error });
        record.events.push({ type: "finish", success: false, steps: 0, summary: `run failed: ${record.error}` });
        record.status = "error";
        record.finishedAt = new Date().toISOString();
        for (const sub of record.subscribers) sub();
      });
  };

  const handleEventsSSE = (req: IncomingMessage, res: ServerResponse, record: RunRecord): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let sent = 0;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();

    /** Replay buffered events + live ones; ends the stream on a terminal event. */
    const flush = (): void => {
      while (sent < record.events.length) {
        const ev = record.events[sent++];
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.type === "finish" || ev.type === "error") {
          res.end();
          record.subscribers.delete(flush);
          return;
        }
      }
    };

    record.subscribers.add(flush);
    flush(); // replays the buffer, then stays live via the subscription
    req.on("close", () => {
      record.subscribers.delete(flush);
      clearInterval(heartbeat);
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

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
          subscribers: new Set(),
          agent: null,
          abortRequested: false,
          result: null,
          error: null,
        };
        runs.set(record.id, record);
        launchRun(record, cfg, body.task);
        sendJson(res, 202, publicRun(record));
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // ── /api/runs/:id[...] ──
    const runMatch = path.match(/^\/api\/runs\/([0-9a-f-]{36})(\/events|\/abort)?$/i);
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
