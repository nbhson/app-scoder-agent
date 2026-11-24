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

let parseFlowchart, renderFlowchart, cleanMermaidLabel, measure, parseMarkdown;
let resolveFocus, pulseMarks, paintCells, PULSE_FRAMES;

before(async () => {
  const g = await import(`file://${GRAPH}`);
  ({ parseFlowchart, renderFlowchart, cleanMermaidLabel, resolveFocus, pulseMarks, paintCells, PULSE_FRAMES } = g);
  ({ measure } = await import(`file://${TW}`));
  ({ parseMarkdown } = await import(`file://${join(here, "..", "dist", "tui", "markdown", "parse.js")}`));
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

// 16 nodes / 18 edges with heavy fan-out (A has six children) and one cycle —
// the real shape that regressed: too tall for `layered` at BAND 3, it fell
// through to chain layout, which draws only chain-consecutive edges and left
// an unreadable grid of 16 boxes with 4 of 18 connectors.
const BRANCHING_TALL = `flowchart TD
  A[JavaScript Runtime] --> B[Call Stack]
  A --> C[Heap / Memory]
  A --> D[Web APIs<br/>(Browser)]
  A --> E[Task Queue<br/>(Macrotask)]
  A --> F[Microtask Queue]
  A --> G[Console / DOM]
  B --> H{Stack empty?}
  H -->|Yes| I[Drain Microtask Queue]
  H -->|No| J[Execute Function]
  I --> K{Microtasks done?}
  K -->|Yes| L[Render / Paint]
  K -->|No| I
  L --> M[Request Animation Frame]
  M --> N[Next Event Loop Cycle]
  D --> E
  D --> F
  E --> O[setTimeout, setInterval, I/O, UI events]
  F --> P[Promise.then, queueMicrotask, MutationObserver]`;

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
    assert.ok(r.edges >= 8, "chain layout kept its edges");
    assertFits(r, 40, 40);
  });
  it("tightens the routing band instead of losing a tall branching graph's shape", () => {
    // Regression: the finished event-loop diagram (49 rows at BAND 3) fell
    // through to chain layout and drew 4 of 18 edges — while the partial
    // source during streaming still rendered as a real graph.
    const r = renderFlowchart(flow(BRANCHING_TALL), 140, 40);
    assert.ok(r, "expected a graph, got fallback");
    assert.equal(r.mode, "layered");
    assert.equal(r.nodes, 16);
    assert.ok(r.edges >= 14, `only ${r.edges}/17 non-cycle edges drawn`);
    assertFits(r, 140, 40);
  });
  it("never chain-lays-out a branching graph — it degrades to the summary", () => {
    for (const width of [40, 60, 80]) {
      const r = renderFlowchart(flow(BRANCHING_TALL), width, 40);
      assert.ok(!r || r.mode === "layered", `width ${width}: got ${r?.mode}`);
      if (r) assertFits(r, width, 40);
    }
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

// ── Streaming fences (bug: every repaint exported its partial source) ───────

describe("mermaid fence open flag", () => {
  it("marks an unclosed fence as open so partial sources are never exported", () => {
    const open = parseMarkdown("```mermaid\nflowchart TD\n  A --> B");
    assert.equal(open[0].kind, "mermaid");
    assert.equal(open[0].open, true);
    const closed = parseMarkdown("```mermaid\nflowchart TD\n  A --> B\n```");
    assert.equal(closed[0].kind, "mermaid");
    assert.equal(closed[0].open, undefined);
  });
});

// ── P2.3: focus, pipe lanes, packet overlay ─────────────────────────────────

describe("focus declaration channels", () => {
  it(":::focus after a shape marks the active node and pipes its edges", () => {
    const g = parseFlowchart(flow(`flowchart LR
      A[Start]:::focus --> B[Middle] --> C[End]`));
    assert.equal(g.focus, "A");
    assert.equal(g.labels.get(g.edges[0]), "*");
    assert.equal(g.labels.has(g.edges[1]), false);
  });
  it(":::focus attached to a bare id (chain tail) also works", () => {
    const g = parseFlowchart(flow(`flowchart TD
      A --> B --> C:::focus`));
    assert.equal(g.focus, "C");
  });
  it("%% focus directive wins over nothing; unknown id is dropped", () => {
    assert.equal(parseFlowchart(flow(`flowchart TD
      %% focus: C
      A --> B --> C`)).focus, "C");
    assert.equal(parseFlowchart(flow(`flowchart TD
      %% focus: ZZZ
      A --> B`)).focus, undefined);
  });
  it("unfocused graph carries no pipe labels at all", () => {
    const g = parseFlowchart(flow(SIMPLE));
    assert.equal(g.focus, undefined);
    for (const v of g.labels.values()) assert.notEqual(v, "*");
  });
});

describe("lanes & focus overlay", () => {
  it("layered raster carries a lane per drawn edge, inside bounds", () => {
    const r = renderFlowchart(flow(SIMPLE), 80, 40);
    assert.ok(r.lanes.length >= 4, "expected lanes for the drawn edges");
    for (const l of r.lanes) {
      assert.match(l.id, /^.+>.+$/, `lane id: ${l.id}`);
      assert.ok(l.cells.length > 0);
      for (const c of l.cells) {
        assert.ok(c.x >= 0 && c.x < r.width && c.y >= 0 && c.y < r.height, `lane cell out of raster: ${JSON.stringify(c)}`);
      }
      assert.equal(l.pipe, undefined, "no pipes without focus");
    }
  });
  it("focused graph pipes exactly the focus edges", () => {
    const r = renderFlowchart(flow(`${SIMPLE}\n  %% focus: B`), 80, 40);
    assert.equal(r.focus, "B");
    assert.deepEqual(r.lanes.filter((l) => l.pipe).map((l) => l.id).sort(), ["A>B", "B>C", "B>D"]);
    assertFits(r, 80, 40);
  });
  it("packet walks the pipe across the burst, then rests", () => {
    const r = renderFlowchart(flow(`${SIMPLE}\n  %% focus: B`), 80, 40);
    assert.deepEqual(pulseMarks(r, "B", null, -1), []);
    assert.deepEqual(pulseMarks(r, null, null, 2), []);
    const seen = [];
    for (let f = 0; f < PULSE_FRAMES; f++) {
      const m = pulseMarks(r, "B", null, f);
      assert.equal(m.length, 1);
      seen.push(`${m[0].x},${m[0].y}`);
      const pipe = new Set();
      for (const l of r.lanes.filter((x) => x.pipe)) for (const c of l.cells) pipe.add(`${c.x},${c.y}`);
      assert.ok(pipe.has(seen[f]), `frame ${f} packet left the pipe: ${seen[f]}`);
    }
    assert.ok(new Set(seen).size > 1, "packet never moved");
  });
  it("prev→focus direct lane beats the merged pipe", () => {
    const r = renderFlowchart(flow(`flowchart LR
      %% focus: C
      A[One] --> B[Two] --> C[Three] --> D[Four]`), 100, 40);
    const lane = r.lanes.find((l) => l.id === "B>C");
    assert.ok(lane && lane.pipe);
    const on = new Set(lane.cells.map((c) => `${c.x},${c.y}`));
    for (let f = 0; f < PULSE_FRAMES; f++) {
      const [m] = pulseMarks(r, "C", "B", f);
      assert.ok(on.has(`${m.x},${m.y}`), `frame ${f} left the direct lane`);
    }
  });
  it("paintCells replaces exactly one glyph, keeps every row width", () => {
    const r = renderFlowchart(flow(`${SIMPLE}\n  %% focus: B`), 80, 40);
    const widths = r.rows.map((segs) => segs.reduce((w, s) => w + measure(s.text), 0));
    const marks = [];
    for (const l of r.lanes) if (l.pipe) marks.push(l.cells[0]);
    assert.ok(marks.length >= 3);
    for (const c of marks) {
      const painted = paintCells(r.rows, [{ y: c.y, x: c.x, ch: "◆" }]);
      painted.forEach((segs, y) => {
        assert.equal(segs.reduce((w, s) => w + measure(s.text), 0), widths[y], `row ${y} width shifted`);
        if (y !== c.y) assert.equal(segs, r.rows[y], "untouched rows must keep identity");
      });
      assert.ok(painted[c.y].map((s) => s.text).join("").includes("◆"));
      assert.ok(painted[c.y].some((s) => s.kind === "arrow" && s.text.includes("◆")));
    }
  });
  it("paintCells is width-safe on CJK labels (wide glyph under the dot)", () => {
    const r = renderFlowchart(flow(`flowchart LR
      %% focus: A
      A[中文标签] --> B[下一个]`), 80, 40);
    const widths = r.rows.map((segs) => segs.reduce((w, s) => w + measure(s.text), 0));
    for (let y = 0; y < r.rows.length; y++) {
      for (let x = 0; x < widths[y]; x++) {
        const after = paintCells(r.rows, [{ y, x, ch: "◆" }])[y];
        assert.equal(after.reduce((w, s) => w + measure(s.text), 0), widths[y], `y${y} x${x} shifted`);
      }
    }
  });
});

describe("resolveFocus", () => {
  const src = flow(SIMPLE);
  it("accepts node ids and exact labels (case-insensitive)", () => {
    assert.equal(resolveFocus(src, "", "B")?.id, "B");
    assert.equal(resolveFocus(src, "", "valid?")?.id, "B");
    assert.equal(resolveFocus(src, undefined, "  Done ")?.id, "E");
  });
  it("a diagram hint that is absent from the block rejects the match", () => {
    assert.equal(resolveFocus(src, "event loop", "B"), null);
    assert.equal(resolveFocus(src, "Start", "B")?.id, "B");
  });
  it("unknown node / empty node → null (never paint a wrong box)", () => {
    assert.equal(resolveFocus(src, "", "ZZ"), null);
    assert.equal(resolveFocus(src, "", "   "), null);
    assert.equal(resolveFocus(flow("sequenceDiagram\n  A->>B: hi"), "", "A"), null);
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
