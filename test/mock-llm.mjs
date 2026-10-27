// Mock OpenAI-compatible LLM server for integration testing.
// Script: list -> write buggy file -> build (fail) -> fix -> build (pass) -> done.
// Supports both non-streaming and SSE streaming (stream:true) requests.
import { createServer } from "node:http";

let call = 0;

const scripted = [
  // 1: look around
  {
    tool_calls: [
      { id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } },
    ],
    content: null,
  },
  // 2: write a file with a deliberate bug
  {
    tool_calls: [
      {
        id: "c2",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "lib.js", content: "module.exports.add = (a, b) => a - b; // BUG\n" }),
        },
      },
    ],
    content: null,
  },
  // 3: run the build (fails because lib.js is wrong)
  {
    tool_calls: [
      { id: "c3", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node build.js" }) } },
    ],
    content: null,
  },
  // 4: fix the bug
  {
    tool_calls: [
      {
        id: "c4",
        type: "function",
        function: {
          name: "edit_file",
          arguments: JSON.stringify({
            path: "lib.js",
            old_string: "a - b; // BUG",
            new_string: "a + b;",
          }),
        },
      },
    ],
    content: null,
  },
  // 5: rebuild -> passes -> agent stops
  {
    tool_calls: [
      { id: "c5", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node build.js" }) } },
    ],
    content: null,
  },
  // 6: final answer (should not normally be reached)
  { tool_calls: [], content: "All done." },
];

function sse(res, msg) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Stream content deltas (if any text)
  if (msg.content) {
    for (const piece of msg.content.match(/.{1,8}/gs) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n`);
    }
  }

  // Tool calls arrive as one delta (index 0) each
  if (msg.tool_calls?.length) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: i, id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } },
                ],
              },
            }],
          })}\n`,
      );
    }
  }

  // finish_reason + [DONE]
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })}\n`,
  );
  res.write("data: [DONE]\n");
  res.end();
}

const server = createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // ignore
    }
    // Readiness probes (no messages array) get an empty 200 without consuming a scripted step
    if (!Array.isArray(parsed.messages)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [] }));
      return;
    }
    call++;
    const msg = scripted[Math.min(call - 1, scripted.length - 1)];
    console.error(`[mock-llm] call #${call} -> ${msg.tool_calls?.length ? msg.tool_calls.map((t) => t.function.name).join(",") : "text"}`);

    const wantsStream = parsed.stream === true;

    if (wantsStream) {
      sse(res, msg);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: msg.content, tool_calls: msg.tool_calls } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      );
    }
  });
});

// Bind to a random free port to avoid conflicts between parallel test runs.
// run-e2e.mjs waits for the "MOCK_LLM_PORT=<n>" line to know the port.
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`MOCK_LLM_PORT=${server.address().port}\n`);
  console.error("[mock-llm] listening");
});
