// Quick eyeball: render the empty-state TuiApp into a virtual terminal.
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { TuiApp } from "../dist/tui/app.js";

const stream = new PassThrough();
stream.columns = Number(process.argv[2] ?? 100);
stream.rows = Number(process.argv[3] ?? 30);
let out = "";
stream.on("data", (c) => (out += String(c)));

// Fake TTY stdin so Ink's useInput doesn't throw outside a real terminal.
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};

const cfg = { workdir: "/tmp/demo", model: "gpt-4o", permissionMode: "auto", mcpServers: {} };
const app = render(React.createElement(TuiApp, { config: cfg, initialTask: null }), {
  // debug: mỗi render ghi FULL frame (không diff/cursor move) — dễ eyeball.
  stdout: stream, stderr: stream, stdin, patchConsole: false, exitOnCtrlC: false, debug: true,
});
await new Promise((r) => setTimeout(r, 300));
app.unmount();
await app.waitUntilExit();
const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const lines = plain.split("\n");
const rows = stream.rows;
console.log(lines.slice(-rows - 1, -1).join("\n"));
