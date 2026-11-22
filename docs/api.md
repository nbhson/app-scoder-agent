# HTTP Server API

Run scoder as an HTTP service — submit tasks programmatically and consume progress via Server-Sent Events.

## Starting Server

```bash
scoder serve                     # random port + auto-generated auth token (printed)
scoder serve --port 4114         # fixed port
SCODER_SERVER_TOKEN=secret scoder serve --host 127.0.0.1   # deterministic token
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Liveness: `{ ok, running, runs }` |
| `/api/runs` | POST | Start a run → `202 { id, eventsUrl }` |
| `/api/runs` | GET | List all runs with status/timing |
| `/api/runs/<id>` | GET | Run status + final result |
| `/api/runs/<id>/events` | GET | SSE stream (full replay + live) |
| `/api/runs/<id>/abort` | POST | Abort a running run |

## Start a Run

```bash
curl -X POST localhost:4114/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "add input validation to the CLI",
    "buildCmd": "npm run build",
    "model": "gpt-4o-mini",
    "maxSteps": 40
  }'
```

Response:
```json
{
  "id": "20261103-143022-a1b2",
  "eventsUrl": "/api/runs/20261103-143022-a1b2/events"
}
```

## SSE Stream

```bash
curl -N localhost:4114/api/runs/<id>/events
```

Event types:
- `run_start` — task, model, workdir (+ `provider`, `buildCmd`, `permission`,
  `agent`, `schemaVersion`). Emitted by `run()`, `runTurn()` and `resume()` —
  every entry point into the loop, so frontends can reset per-run timers and
  counters. `quiet: true` (only `resume()`) means "the transcript is already on
  screen, don't re-append the task".
- `step` — current step number
- `llm_delta` — assistant text delta (streaming)
- `llm_reasoning` — reasoning/thinking delta (if enabled)
- `llm_usage` — input/output/cached tokens
- `tool_call` — tool invocation
- `tool_output` — live stdout/stderr chunks
- `tool_result` — tool completion (includes diff for file writes)
- `build` — build result
- `guardrail` — guardrail intervention
- `finish` — run completion

The stream replays every event from the beginning, then stays live. Safe to reconnect at any time.

## Abort a Run

```bash
curl -X POST localhost:4114/api/runs/<id>/abort
```

## Authentication

Every request must send `Authorization: Bearer <token>` — there is no
unauthenticated mode (an agent server is remote code execution by design).
The token is `SCODER_SERVER_TOKEN` when set; otherwise one is generated at
startup and printed by `scoder serve`.

```bash
SCODER_SERVER_TOKEN=secret scoder serve --port 4114

curl -H 'Authorization: Bearer secret' localhost:4114/api/runs
```

Browser drive-by defenses (on top of the token): a loopback bind rejects
foreign `Host:` headers (DNS rebinding), any `Origin`/`Referer` must be
loopback (cross-site form CSRF), and the JSON endpoints demand
`Content-Type: application/json` (no CORS-simple `text/plain` POSTs). The
token comparison is constant-time.

## Per-Run Overrides

| Field | Description |
|-------|-------------|
| `task` | Task description |
| `workdir` | Working directory |
| `buildCmd` | Build command |
| `model` | Model name |
| `provider` | `openai` or `anthropic` |
| `maxSteps` | Max iterations |
| `permission` | `auto` or `readonly` — `ask` rejected: the server cannot prompt |

Every field is validated at the request boundary (`validateRunRequest`): non-object
bodies (`null`, arrays, scalars) and wrong types (e.g. `maxSteps: "abc"`, unknown
`provider`) get `400` with a precise message — nothing unvalidated reaches config.

## Limits

- POST bodies are size-capped and schema-checked (`400`), non-JSON content types get `415`, oversized bodies `413`
- Max 4 concurrent runs (extra requests get `429`)
- Runs are always non-interactive (`ask` mode rejected)