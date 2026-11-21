# TUI UX Upgrade Plan — Polish + Sidebar Tabs + Harness Log

> Trạng thái: **CHỜ DUYỆT** (Plan mode). Ngày: 21/11/2026.
> Phạm vi: chỉ `src/tui/` + helpers thuần liên quan; **không đổi** event schema
> (`AgentEvent`), tool contract, CLI surface, reducer semantics hiện hữu.
> Deferred (vòng sau): `/undo` + checkpoint browser, Ctrl+F transcript search,
> `/export`, theme picker preview, custom keybinds.

## Mục lục

1. [Nguyên tắc chung](#1-nguyên-tắc-chung)
2. [P1 — Quick wins (S)](#p1--quick-wins-s)
3. [P2 — Command palette tương tác (M)](#p2--command-palette-tương-tác-m)
4. [P3 — Full view pager + word-level diff (M–L)](#p3--full-view-pager--word-level-diff-m-l)
5. [P4 — Scroll UX (S)](#p4--scroll-ux-s)
6. [P5 — Syntax highlight đa ngôn ngữ (M)](#p5--syntax-highlight-đa-ngôn-ngữ-m)
7. [P6 — Notify khi xong (S–M)](#p6--notify-khi-xong-s-m)
8. [P7 — Git context trên BuildRail (S)](#p7--git-context-trên-buildrail-s)
9. [P8 — Sidebar tabs + Harness Log (L)](#p8--sidebar-tabs--harness-log-l)
10. [Thứ tự thực hiện](#10-thứ-tự-thực-hiện)
11. [Chiến lược kiểm thử & gate](#11-chiến-lược-kiểm-thử--gate)
12. [Quyết định cần duyệt](#12-quyết-định-cần-duyệt)

---

## 1. Nguyên tắc chung

- Mọi display string qua `text-width.ts` (cấm `padEnd`/`slice`/`.length` đo
  chuỗi hiển thị — `chrome.tsx` palette và `/help` hiện vi phạm, sửa ở P1/P2).
- Mọi glyph qua `charset.ts`, có ASCII fallback (`SCODER_ASCII=1` / `TERM=dumb`).
- Màu chỉ qua `theme` proxy (Ink color names, tôn trọng NO_COLOR).
- Logic ở reducer thuần (`state.ts` + helper mới); components chỉ render.
- `ChatItemView` memoized — mọi update state phải immutable (`patchItem`).
- **Gate mỗi phase:** `npm test` + `npm run lint` + `npm run typecheck` +
  `npm run check:layers` + `npm run docs:check` xanh; cập nhật `docs/tui.md`,
  `src/tui/README.md`, CHANGELOG.

---

## P1 — Quick wins (S)

| # | Việc | Files | Ghi chú |
|---|------|-------|---------|
| A2 | Tool row cuối dòng thêm marker `✓ ok` / `✗ fail` / spinner `running` (glyph qua `charset`, có fallback) — docs hứa ✔/✘ nhưng code chỉ đổi màu tên tool | `chat-views.tsx`, `charset.ts` | Fail: giữ tên đỏ + `✗` để quét transcript bằng mắt |
| A3 | Badge `⇢ N` trên StatusBar khi `state.queue.pending > 0` — data đã có trong reducer, chưa nơi nào render | `chrome.tsx` | Reset theo event `queue` đã có |
| A6 | Terminal <100 cols (sidebar ẩn): StatusBar phải hiện `ctx 41% · $0.12` | `chrome.tsx` + extract helper | Tách phép tính cost/ctx khỏi `sidebar.tsx` METRICS thành helper thuần `runCost(state)` / `ctxPct(state)` dùng chung; unit test |
| A7 | Thống nhất UI microcopy một ngôn ngữ (đề xuất: **English** cho label/hint, docs giữ tiếng Việt) — hết cảnh "type a task to start" cạnh "tắt mouse tracking để tô đen kéo chuột" | `app.tsx`, `use-keybinds.ts`, `use-submit.ts` | Không đụng copy giải thích guardrail (vốn tiếng Việt theo prompt) |

## P2 — Command palette tương tác (M)

A1: palette Ctrl+P hiện là list tĩnh `SLASH_COMMANDS.slice(0, 40)` + `padEnd`
— không search, không điều hướng, vi phạm invariant đo cell.

- Component mới `src/tui/palette.tsx`: overlay có search input riêng, xếp hạng
  fuzzy bằng `fuzzysort` (dep đã có trong package.json).
- Nguồn item: builtin commands + aliases + custom commands
  (`discoverCustomCommands`), themes, agents, permission modes, recent sessions.
- Điều hướng: `↑/↓` chọn · `⏎` chạy ngay (hoặc đưa vào input khi command cần
  arg) · `esc`/`⌃P` đóng · nhóm có header (COMMANDS / THEMES / AGENTS / …).
- Gate "đang chạy" kế thừa từ registry dispatch — palette không tự nới gate.
- Layout qua `text-width` (thay `padEnd`), màu theme tokens.
- Test: `palette-items.test.mjs` (pure ranking/group) + render snapshot 80/120.

## P3 — Full view pager + word-level diff (M–L)

A4: hết cảnh cap 20 dòng diff / 5 dòng output / 60 dòng code mà không đường xem nốt.

**`word-diff.ts` (helper thuần trong `src/tui/`):**
- Input: unified diff text. Ghép cặp dòng `-/+` trong cùng hunk có độ tương
  đồng ≥ ngưỡng → tokenize theo word+whitespace → render 1 dòng: phần giữ
  nguyên dim, phần xóa nền đỏ, phần thêm nền xanh (pattern `git --word-diff`).
- Dòng không cặp được giữ nguyên như hiện tại. Chỉ đổi **render**, không đổi
  data trong state.

**`pager.tsx` (overlay full-screen trong chat pane, pattern theo
`session-picker.tsx`):**
- Nguồn hiển thị: `item.output` (reducer đã giữ tới **20k chars** — đủ dùng),
  `item.text` của diff (đầy đủ), code block dài, và harness-log entry (P8).
- Diff → render qua `DiffLine` + word-diff; output → `wrapCells` theo width
  viewport; số dòng ứng viên được ước lượng bằng `estimateItemRows` đã có.
- Keys: `↑↓ jk PgUp/PgDn Home End` scroll · `q`/`esc` đóng · `⇥`/`⇧⇥` nhảy
  giữa các tool/diff gần nhất (stack dẫn từ transcript) · `y` copy toàn bộ
  (OSC 52 nếu TTY, fallback ghi `.scoder/tmp/last-output.txt`).
- Mouse wheel route vào pager khi modal mở (nối `mouse.ts`; hiện modal chưa
  nhận wheel).
- Entry point: phím `v` khi idle mở pager của tool/diff cuối; hint `v` xuất
  hiện ở StatusBar-right.
- Test: `word-diff.test.mjs` (cặp dòng, unicode, không đổi thứ tự), pager
  render snapshot, PTY e2e mở/scroll/đóng.

## P4 — Scroll UX (S)

A5:
- **Pill nội dung mới:** khi `scrollOffset > 0` mà `estimateTotalRows` tăng →
  1 dòng nổi ở đáy chat pane: `▼ +N dòng mới · End`. Tự biến mất khi về đáy.
  Tính bằng so sánh row-count delta ở render memo — không cần field state mới.
- **Scroll thumb mảnh** ở mép phải chat pane khi `maxScroll > 0`: column glyph
  `▁▃▅█` tỉ lệ viewport/content, dùng số đo thật từ `useScrollMetrics`; tắt khi
  `selectMode`.
- Test: pure helper `newContentPill(prevRows, nextRows, offset)` + snapshot.

## P5 — Syntax highlight đa ngôn ngữ (M)

A8: `markdown/render.tsx` hiện chỉ keyword-set JS/TS regex.
- Table-driven: `LANG_RULES: Record<lang, { keywords, lineComment,
  blockComment, strings }>` cho `python, go, rust, java, c, cpp, sql, bash,
  sh, yaml, json, toml, ts, tsx, js`; lang chưa có trong map → highlight chung
  như hiện tại (không regression).
- **Không** dùng tree-sitter cho render: native dep + chi phí parse mỗi dòng
  code trên hot path (precedent: `repo-map.ts` đã chốt không kéo grammar mới).
- Fixtures `test/fixtures/markdown/highlight-*.md` × snapshot 40/80/120 +
  fuzz hiện hữu bảo đảm không throw.

## P6 — Notify khi xong (S–M)

- `mouse.ts` thêm `FOCUS_ENABLE`/`FOCUS_DISABLE` (`CSI ?1004h/l`) +
  `parseFocus(chunk)` nhận `\x1b[I` (focus in) / `\x1b[O` (focus out).
  **Lọc ở raw stdin level** (cùng chỗ với `parseWheel`) để escape sequence
  không lọt thành keystroke vào Input — bug phổ biến khi bật 1004.
- App track `focused` (default true; terminal không hỗ trợ → không bao giờ
  nhận `O`, xem như luôn focused).
- Khi reducer nhận `finish` (success/failed, không abort):
  - `focused === false` → gửi OSC 777 `notify;SCoder;<status> · <summary clipped>`
    (iTerm2/kitty/VTE hiểu; terminal khác bỏ qua vô hại) + BEL fallback.
  - Không focus-reporting được (fallback): notify khi run `> 45s`, bất kể focus.
- Chỉ ghi escape ra stdout khi alt-screen TTY && `TERM !== dumb`.
- Bật/tắt: rc `"notify": true|false` (đề xuất default **bật**) + env
  `SCODER_NOTIFY=0`.
- Test: `parseFocus` unit (không lọt byte vào input path), builder chuỗi notify
  pure, e2e giả stdin có `O` → finish → stdout chứa OSC 777.

## P7 — Git context trên BuildRail (S)

- Hook `use-git-status.ts`: `branch` + `±N files` (dirty count) — reuse lazy
  async git probe đã có trong `workspace/snapshot.ts` (commit perf 165a8…);
  refresh ~5s khi idle + ngay sau `finish`; cache 1 slot, **không bao giờ
  blocking render** (stale-while-revalidate như `file-index`).
- Render giữa BuildRail khi idle: ` main · ±3` (branch dim; dirty badge màu
  `warn`); ẩn khi không phải git repo / probe lỗi. Khi running ưu tiên guardrail
  / breadcrumb như hiện tại (git info dồn sang StatusBar-left nếu hết chỗ).
- Test: pure parser `git status --porcelain` output (rename/unmerged/deleted),
  hook mock exec.

---

## P8 — Sidebar tabs + Harness Log (L) — **tính năng chính**

### 8.1 Yêu cầu

- Sidebar phải thành **2 tab**:
  - **Tab 1 — OVERVIEW**: toàn bộ nội dung hiện tại (SESSION → MCP → METRICS →
    PHASES → PLAN → SUBAGENTS → BUILD, greedy-fit), **không đổi gì**.
  - **Tab 2 — HARNESS LOG**: live log mọi hoạt động của agent — tool call, LLM
    request/response, shell command, MCP, subagent, guardrail, permission,
    context/compaction… kiểu deepseek harness: scroll lại được, xem payload.
- Keyboard-first; terminal hẹp (<100 cols) vẫn xem được log qua lệnh `/log`
  (mở pager P3 full-screen).

### 8.2 Luồng dữ liệu — nguyên tắc "1 event stream, 2 view"

Mọi thứ đã có sẵn: `agent.onEvent → useEventQueue → applyEvent` (reducer thuần).
Harness Log KHÔNG采集 ở tầng UI — **reducer là nguồn duy nhất**, nên CLI/REPL
và `scoder serve` không đổi.

**Model mới trong `state.ts`:**

```ts
export interface LogEntry {
  id: number;              // monotonic
  ts: number;              // unix ms (event đến)
  cat: LogCat;             // xem bảng categories
  text: string;            // 1 dòng summary, đã clip khi render (không clip khi store)
  /** Reference tới payload lớn — KHÔNG copy output 20k chars vào log.
   *  Pager/detail resolve qua callId/step từ state.items hoặc events.jsonl. */
  ref?: { kind: "item"; step: number; callId?: string };
  meta?: { ms?: number; tokensIn?: number; tokensOut?: number;
           cached?: number; exit?: boolean | null; chunks?: number;
           bytes?: number; pct?: number; count?: number };
}
export type LogCat =
  | "run" | "llm" | "tool" | "shell" | "file" | "build" | "mcp"
  | "sub" | "guard" | "perm" | "sys";
```

- `TuiState.log: LogEntry[]` — **ring buffer cap 800** entry, drop oldest
  (kèm counter `logDropped` để header hiện `+1.2k`).
- Xây trong `applyEvent` (pure, immutable như các field khác): mỗi case hiện
  hữu append thêm `logEntry` tương ứng — một chỗ duy nhất, test được không cần
  render.

**Bảng category ← event type (toàn bộ 24 `AgentEvent`):**

| cat | glyph·màu | Event nguồn | Nội dung 1 dòng |
|-----|-----------|-------------|-----------------|
| run | `◆` brand | `run_start`, `finish`, `step` | task clipped / `success · 12 steps · $0.34` / `step 3/40` |
| llm | `⇅` accent | `llm_usage` + **aggregate** `llm_delta`/`llm_reasoning` | `#7 gpt-5 · in 18.2k out 940 (cache 12.1k) · 4.2s · 118 chunks` |
| tool | toolIcon·dim | `tool_call`, `tool_result`, `tool_progress` | `read_file src/a.ts → ok · 0.4s` (progress merge `▸ 3/10`) |
| shell | `⚡` yellow | `tool_call/run_command` + `tool_output` (**aggregate** byte) | `npm test → exit 0 · 1.2s · stdout 4.2k` |
| file | `✎` brand | `tool_result` có `diff` | `+38 -4 src/user.js` |
| build | `▣` ok/fail | `build` | `npm run build → PASS/FAIL` |
| mcp | `🔌` dim | `mcp_status` | `fs ready · 12 tools` |
| sub | `⊙` thinking | `agent_start`, `agent_end` | `reviewer done · 9 steps` |
| guard | `⚠` warn | `guardrail` | `text-only-streak → nudge` |
| perm | `⛔` accent | `permission_request`, `question_request` | `ask: shell `rm -rf tmp/`` (answer do UI ghi note khi resolve) |
| sys | `·` dim | `context`, `compaction`, `queue`, `steer_*`, `warmup`, `error`, `todo` | `ctx 41% (83k/200k)` / `compact 96k→18k` / `steer +1` |

**Chính sách anti-spam (bắt buộc):**
- `llm_delta`, `llm_reasoning`, `tool_output` **không bao giờ tạo dòng mới** —
  merge counter (`chunks`, `bytes`) vào entry `llm`/`shell` đang mở của cùng
  call (resolve qua callId/step). Entry đang mở render hậu tố `…` để phân biệt
  live/final.
- `warmup` chỉ log khi stage đổi; `todo` log khi count đổi (bỏ incremental).
- Cap throughput: flush gộp theo event-queue batch hiện hữu (~20fps), log
  không render nhanh hơn.

### 8.3 UI tab & layout

Tab state nằm ở **app level** (`useState` trong `TuiApp`, không vào `TuiState` —
đây là prefs UI, không phải transcript). Props xuống `Sidebar`, đồng bộ vào
`use-keybinds` (cần cho routing phím + `/log`).

```
┌ Sidebar ─────────────────────────────┐
│ ▌OVERVIEW │ HARNESS LOG ▸ 812 · ALL │  ← tab bar (1 dòng)
│──────────────────────────────────────│
│ 22:58:01.4 ◆ run_start fix the bug   │  ↑ newest-bottom tail
│ 22:58:01.9 ⇅ llm #1 in 41.2k out 812 │     (wrapCells-free: 1 entry 1 dòng,
│ 22:58:03.0 📖 read_file src/a.ts ✓0.4s│      clip theo INNER width)
│ 22:58:03.1 ⇅ #2 … 118ch              │     ◂ entry đang stream (merge)
│ 22:58:04.2 ⚡ npm test → exit 0 · 1.2s│
│ 22:58:05.7 ✎ +38 -4 src/user.js      │
│ …                                    │
│ ─ DETAIL ────────────────────────────│  ← panel chọn (≤8 dòng, gập bằng `d`)
│ ⚡ run_command                        │
│   args {"command":"npm test"}        │
│   exit 0 · 1.2s · stdout 4.2k ch     │
│   ⏎ full · y json · esc close        │
└──────────────────────────────────────┘
```

- **Tab bar:** 2 pill; active = nền accent chữ black (Ink `backgroundColor`),
  inactive dim. Right pill hiện thêm `filter` đang chọn (ALL/LLM/TOOL/…).
- **Tail mode:** mặc định bám đáy (follow); scroll lên → freeze + pill
  `▼ tail` — **reuse đúng cơ chế `scrollOffset` của chat pane** (P4 pattern).
- **Ngân sách chiều cao:** LOG tab dùng full `rows` sidebar: header 1 +
  list = rows−1−detailRows; DETAIL ≤ 8 dòng. Không dùng greedy-fit ở tab này.
- **Filter `f`:** chu kỳ `ALL → LLM → TOOL(+SHELL+FILE) → MCP → SUB → SYS →
  ALL`; lọc pure ở selectors (`filterLog(entries, cat)`), remember per-tab.
- **Chọn entry:** `↑/↓` di chuyển cursor (giữ selection khi list grow — index
  neo theo `id`), `⏎` mở **P3 pager** full màn hình với payload đầy đủ
  (`tool_result.output` từ items; khi item bị MAX_ITEMS eviction → resolve từ
  `.scoder/logs/<session>.jsonl` qua `JsonlLogger.read`), `y` copy entry JSON
  (OSC 52/fallback file), `d` toggle DETAIL panel.

**Key routing (quan trọng nhất của phase):**
- `⌃B`: toggle sidebar tab (OVERVIEW ⇄ LOG). Thêm hint `⌃B log` vào StatusBar
  keybinds khi idle.
- Khi tab LOG active **và input trống** (cùng quy ước repo với `⇧P`, `?`):
  `↑/↓/PgUp/PgDn/Home/End/f/d/⏎/y` thuộc về log; input nhận focus trở lại ngay
  khi người dùng gõ chữ thường. Khi LOG inactive → hành vi y hệt hiện tại.
- Esc: đang mở DETAIL → gập DETAIL; không → quay OVERVIEW; không → về tail.
- Session picker / palette / permission modal / pager mở → chúng giành phím
  (modalRef pattern hiện hữu).
- `/log [cat]`: mở log ở P3 pager full-screen (dùng được cả terminal hẹp);
  `log` là CommandDef mới, `visibility: "tui-only"`.

**Customization (nhẹ, không over-engineer):**
- rc `"logFilter"`, `"sidebarTab"` (default `overview`), `"logMax"` (800).
- Theme: `charset` glyphs có ASCII fallback; màu theo tokens, thêm 1 token
  optional `logTs` (dim mặc định) vào Theme interface.

### 8.4 Performance & invariants

- Chat transcript **không re-render** vì log: `state.log` là field riêng,
  các memo comparator cũ (`chatItemEqual`) không đổi; Sidebar memo theo
  `(tab, logLen, selection, filter)` — log update 20fps chỉ re-render sidebar.
- Entry store không giữ chuỗi lớn (ref pattern); `text` mỗi entry ≤ 200 chars
  ngay khi build (measure-free, clip chỉ ở render qua `clipCells`).
- Ring buffer splice immutable (`slice(-800)`), không mutate in-place
  (bài học freeze-streaming đã ghi trong README).
- Alt-screen height budget: tab LOG không được push tổng height vượt `rows` —
 沿用 measurement pattern của Sidebar hiện hữu; test snapshot chiều cao 24/30.

### 8.5 Test P8

- `tui-log.test.mjs`: reducer thuần — feed sequence events fixture
  (`run_start → llm_delta* → llm_usage → tool_call → tool_output* → tool_result
  → build → finish`), assert: đúng category/glyph/merge counter, ring cap 800,
  `+N` dropped, không dòng nào vượt INNER 44 cells khi render.
- `tui-log-nav.test.mjs`: `filterLog`, selection neo theo id khi list grow,
  follow/tail semantics.
- Render snapshot: tab OVERVIEW output **byte-identical** với snapshot cũ
  (bảo chứng "tab 1 không đổi gì") + tab LOG snapshot 3 terminal heights.
- PTY e2e: `⌃B` → log hiện, `↑` chọn, `⏎` pager mở, `esc`, gõ chữ thường quay
  lại input; `TERM=dumb` không glyph ngoài ASCII.
- `npm run eval` không đổi (không đụng prompt/agent).

---

## 10. Thứ tự thực hiện

```
P1 ─ P2 ─ P4 ─ P7          (S/M — nhanh, độc lập, xanh từng bước)
P3 ────┴──► P8             (P8 dùng pager của P3 cho ⏎ full view — làm sau P3)
P5, P6                     (độc lập, chèn bất kỳ lúc nào)
```

Đề xuất: **P1 → P2 → P3 → P4 → P8 → P5 → P6 → P7**.

## 11. Chiến lược kiểm thử & gate

| Tầng | Phủ |
|------|-----|
| Unit thuần | word-diff, runCost/ctxPct, palette ranking, filterLog/selection, log reducer, parseFocus, git porcelain parser |
| Render snapshot | fixture mới × width 80/120 × height 24/30; OVERVIEW byte-identical gate |
| PTY e2e | key routing `⌃B`/log/pager, anti-spam merge không leak escape vào input |
| Env | ASCII mode, NO_COLOR, TERM=dumb (notify không ghi control bytes) |
| Every phase | `npm test` · `npm run lint` · `npm run typecheck` · `npm run check:layers` · `npm run docs:check` · `npm run eval` |

Docs phải cập nhật theo từng phase: `docs/tui.md` (layout mới, keys, `/log`),
`docs/commands.md` (CommandDef `log`), `src/tui/README.md` (invariants: log
ref-pattern, tab routing), `.scoderrc.example.json` (`notify`, `sidebarTab`,
`logFilter`, `logMax`).

## 12. Quyết định cần duyệt

- **Q1 — Ngôn ngữ microcopy (A7):** English (đề xuất) hay tiếng Việt nhất quán?
- **Q2 — Notify default:** bật (đề xuất) hay tắt cho tới khi bật trong rc?
- **Q3 — Phím tab sidebar:** `⌃B` (đề xuất, VS Code "toggle panel" quen) hay
  `⇥` khi input trống / `⌃⇥`? (`⇧⇥` đã dành cho cycle-agent — không dùng được.)
- **Q4 — Ring buffer size:** 800 entry (đề xuất ≈ 1–2 run dài) hay 2000?
  (Render chỉ show ~20 dòng nên memory là chi phí duy nhất — ~200KB.)
- **Q5 — Entry `⏎` khi item bị evict:** resolve fallback từ
  `events.jsonl` (đề xuất, đã có `JsonlLogger.read`) hay chịu không xem được?
