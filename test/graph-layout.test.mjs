/**
 * Flowchart layout engine tests (markdown/graph.ts).
 *
 * The engine is pure (no Ink, no I/O) so most cases run in-process against
 * dist/. The ASCII-charset case needs a child process because charset
 * resolves at module load (SCODER_ASCII), same pattern as
 * markdown-ascii-nocolor.test.mjs.
 *
 * Run: node --test test/graph-layout.test.mjs  (after npm run build)
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GRAPH = join(here, "..", "dist", "tui", "markdown", "graph.js").replace(/\\/g, "/");
const TW = join(here, "..", "dist", "tui", "text-width.js").replace(/\\/g, "/");

let parseFlowchart, renderFlowchart, cleanMermaidLabel, measure;

before(async () => {
  const g = await import(`file://${GRAPH}`);
  ({ parseFlowchart, renderFlowchart, cleanMermaidLabel } = g);
  ({ measure } = await import(`file://${TW}`));
});

const flow = (body) => body.split("\n").map((l) => l.trim()).filter((l) => l !== "");

// ── Label cleanup (bug: <br/> shown literally) ──────────────────────────────

describe("cleanMermaidLabel", () => {
  it("turns <br/> into a space instead of showing it", () => {
    assert.equal(cleanMermaidLabel("AngularJS 1.x<br/>2016"), "AngularJS 1.x 2016");
    assert.equal(cleanMermaidLabel("a <br> b <BR/> c"), "a b c");
  });
  it("drops other html tags and decodes entities", () => {
    assert.equal(cleanMermaidLabel("Deploy <b>now</b> &amp; verify"), "Deploy now & verify");
    assert.equal(cleanMermaidLabel("A &gt; B &#65;"), "A > B A");
    assert.equal(cleanMermaidLabel("x&#0;"), "x&#0;"); // control codes stay escaped
  });
  it("strips quotes and collapses whitespace", () => {
    assert.equal(cleanMermaidLabel('"  spaced   out "'), "spaced out");
    assert.equal(cleanMermaidLabel("'single'"), "single");
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("parseFlowchart", () => {
  it("returns null for non-flowchart sources", () => {
    assert.equal(parseFlowchart(flow("sequenceDiagram\n  A->>B: hi")), null);
    assert.equal(parseFlowchart(flow("gantt\n  title x")), null);
    assert.equal(parseFlowchart(flow("")), null);
  });
  it("reads direction, shapes and chain statements", () => {
    const g = parseFlowchart(flow(`flowchart LR
      A[Start] --> B{Valid?} --> C((Done))`));
    assert.equal(g?.direction, "LR");
    assert.deepEqual(g.nodes.map((n) => n.shape), ["rect", "diamond", "circle"]);
    assert.deepEqual(g.edges.map((e) => `${e.from}>${e.to}`), ["A>B", "B>C"]);
  });
  it("parses edge labels in both syntaxes and styles", () => {
    const g = parseFlowchart(flow(`graph TD
      A -- yes --> B
      C -.->|dotted| D
      E ==> F`));
    const [e1, e2, e3] = g.edges;
    assert.deepEqual([e1.label, e1.style], ["yes", "solid"]);
    assert.deepEqual([e2.label, e2.style], ["dotted", "dotted"]);
    assert.deepEqual([e3.label, e3.style], ["", "thick"]);
  });
  it("flattens subgraphs, ignores styling lines and comments", () => {
    const g = parseFlowchart(flow(`flowchart TD
      %% a comment
      subgraph Core
        A --> B
      end
      style A fill:#f9f9
      classDef x color:red
      B --> C`));
    assert.deepEqual(g.nodes.map((n) => n.id), ["A", "B", "C"]);
    assert.equal(g.edges.length, 2);
    assert.ok(g.notes.some((n) => n.includes("subgraph")));
  });
  it("notes self-loops and dedupes repeated edges", () => {
    const g = parseFlowchart(flow(`flowchart TD
      A --> A
      A --> B
      A --> B`));
    assert.equal(g.edges.length, 1);
    assert.ok(g.notes.some((n) => n.includes("self-loop")));
  });
});

// ── Rasterization invariants ─────────────────────────────────────────────────

const SIMPLE = `flowchart TD
  A[Start] -->|user input| B{Valid?}
  B -->|yes| C[Process data]
  B -->|no| D[Show error]
  C --> E((Done))
  D --> A`;

const CHAIN = `flowchart LR
  A[Plan] --> B[Design] --> C[Implement] --> D[Unit test] --> E[Review]
  E --> F[Staging] --> G[Perf test] --> H[Docs] --> I[Release] --> J[Monitor]`;

function assertFits(raster, width, maxRows) {
  for (const segs of raster.rows) {
    const line = segs.map((s) => s.text).join("");
    assert.ok(measure(line) <= width, `row overflows ${width}c: ${JSON.stringify(line)}`);
  }
  assert.ok(raster.height <= maxRows, `height ${raster.height} > ${maxRows}`);
  assert.ok(raster.width <= width);
}

const rowText = (r) => r.rows.map((segs) => segs.map((s) => s.text).join("")).join("\n");

describe("renderFlowchart", () => {
  it("draws the branching flowchart with every node label visible", () => {
    const r = renderFlowchart(flow(SIMPLE), 80, 40);
    assert.ok(r, "expected a graph, got fallback");
    assert.equal(r.mode, "layered");
    assert.equal(r.nodes, 5);
    for (const label of ["Start", "Valid?", "Process data", "Show error", "Done"]) {
      assert.ok(rowText(r).includes(label), `label missing: ${label}`);
    }
    assert.ok(rowText(r).includes("user input")); // edge label kept
    assert.ok(r.notes.some((n) => n.includes("cycle")), "D → A must be reported, not drawn");
    assertFits(r, 80, 40);
  });
  it("switches a long chain to strip layout in narrow panes", () => {
    const r = renderFlowchart(flow(CHAIN), 40, 40);
    assert.ok(r);
    assert.equal(r.mode, "strip");
    assert.equal(r.nodes, 10);
    assertFits(r, 40, 40);
  });
  it("shrinks label caps until the graph fits instead of clipping", () => {
    for (const width of [24, 28, 34, 40, 60, 80, 120]) {
      const r = renderFlowchart(flow(SIMPLE), width, 40);
      if (r) assertFits(r, width, 40); // null = degrade to summary, also valid
    }
  });
  it("never throws and always fits (deterministic garbage + stress)", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ids = ["A", "B", "C", "D", "E", "sub graph", "x--y", "(((w)))", "[", "]", "-->"];
    for (let doc = 0; doc < 60; doc++) {
      const lines = ["flowchart TD"];
      const n = 1 + Math.floor(rand() * 14);
      for (let i = 0; i < n; i++) {
        const a = ids[Math.floor(rand() * ids.length)];
        const b = ids[Math.floor(rand() * ids.length)];
        const op = ["-->", "-.->", "==>", "---", "-->|lbl|"][Math.floor(rand() * 5)];
        lines.push(`${a}${op}${b}`);
      }
      const r = renderFlowchart(lines, 20 + Math.floor(rand() * 100), 40);
      if (r) assertFits(r, 120, 40);
    }
  });
  it("gives the same raster for the same input (cache path)", () => {
    const a = renderFlowchart(flow(SIMPLE), 60, 40);
    const b = renderFlowchart(flow(SIMPLE), 60, 40);
    assert.equal(rowText(a), rowText(b));
  });
  it("degrades to null for things it cannot draw", () => {
    assert.equal(renderFlowchart(flow("sequenceDiagram\n  A->>B: x"), 80, 40), null);
    assert.equal(renderFlowchart(["flowchart TD"], 80, 40), null); // no statements
  });
});

// ── ASCII fallback (charset resolves at import → child process) ─────────────

describe("ascii mode", () => {
  it("draws graphs with ASCII glyphs only when SCODER_ASCII=1", () => {
    const script = join(here, `.graph-ascii-test-${Date.now()}.mjs`);
    writeFileSync(script, `
import { renderFlowchart } from ${JSON.stringify(`file://${GRAPH}`)};
const r = renderFlowchart(
  "flowchart LR\\nA[Start] --> B{Ok?} --> C[Go]".split("\\n"), 60, 40);
const rows = r.rows.map((segs) => segs.map((s) => s.text).join(""));
process.stdout.write(rows.join("\\n") + "\\n" + (r ? "OK" : "NULL"));
`);
    try {
      const res = spawnSync(process.execPath, [script], {
        env: { ...process.env, TERM: "xterm-256color", SCODER_ASCII: "1" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /OK$/);
      const rows = res.stdout.replace(/OK$/, "");
      const nonAscii = [...rows].filter((ch) => ch !== "\n" && (ch < " " || ch > "~"));
      assert.deepEqual(nonAscii, [], `non-ASCII in ascii raster: ${nonAscii.join(" ")}`);
      assert.match(rows, /\+-+\+/); // boxes still drawn
      assert.match(rows, />/);     // arrowheads still drawn
    } finally {
      unlinkSync(script);
    }
  });
});
