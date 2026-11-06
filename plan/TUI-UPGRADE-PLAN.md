# TUI Upgrade Plan — Render pipeline cho câu trả lời của agent

> Trạng thái: **ĐÃ THỰC HIỆN** (P0–P8 hoàn tất). Quyết định đã chốt khi thực
> hiện: Q1 = dùng `string-width` (user duyệt dùng thư viện); Q2 = structured
> summary + source fallback; Q3 = wrap (không truncate); Q4 = đúng thứ tự
> P3 → P4 → P5.

## Mục lục

1. [Mục tiêu & phạm vi](#1-mục-tiêu--phạm-vi)
2. [Hiện trạng kiến trúc render](#2-hiện-trạng-kiến-trúc-render)
3. [Catalog lỗi hiển thị (đã đối chiếu code)](#3-catalog-lỗi-hiển-thị)
4. [Nguyên tắc thiết kế](#4-nguyên-tắc-thiết-kế)
5. [Kiến trúc đích](#5-kiến-trúc-đích)
6. [Kế hoạch theo phase](#6-kế-hoạch-theo-phase)
7. [Chiến lược kiểm thử](#7-chiến-lược-kiểm-thử)
8. [Acceptance criteria](#8-acceptance-criteria)
9. [Edge cases](#9-edge-cases)
10. [Rủi ro & phương án dự phòng](#10-rủi-ro--phương-án-dự-phòng)
11. [Quyết định cần duyệt trước khi bắt đầu](#11-quyết định-cần-duyệt)

---

## 1. Mục tiêu & phạm vi

**Mục tiêu:** mọi nội dung markdown mà agent sinh ra phải render trên main chat
**đúng và chuẩn** trên terminal — không lệch viền, không tràn, không mất nội
dung, không vỡ layout khi resize — với trọng tâm là bảng (GFM table), Mermaid
diagram, code block và các block markdown còn lại.

**Trong phạm vi:**

- `src/tui/markdown.tsx` — toàn bộ pipeline parse + render markdown.
- `src/tui/chat-views.tsx` — cách assistant message được đưa vào chat (streaming
  vs finalized), `ToolItemView`/`DiffItemView` phần clip/preview.
- `src/tui/selectors.ts` — `estimateItemRows` (ảnh hưởng virtualization/scroll).
- `src/tui/theme.tsx` — `fit()` và các helper đo chuỗi.
- Phía agent: hướng dẫn format markdown trong system prompt
  (`src/context/prompt*.ts`) để agent sinh nội dung "terminal-friendly".
- Test: `test/markdown-table.test.mjs`, `test/tui-render.test.mjs` + test mới.

**Ngoài phạm vi:**

- Không thay đổi cấu trúc domain đã refactor, không thêm facade.
- Không đổi giao diện lệnh/CLI, không đổi event schema, không đổi tool contract.
- Không render ảnh thật (sixel/kitty protocol) cho Mermaid — ngoài tầm; chỉ
  cải thiện preview dạng text (xem [§11](#11-quyết định-cần-duyệt), Q2).

## 2. Hiện trạng kiến trúc render

Pipeline hiện tại (đã đọc code, đối chiếu từng dòng):

```
LLM stream → state.ts (applyEvent, accumulate assistant text)
  → app.tsx: state.items.map(<ChatItemView width={(columns ?? 100) - (sidebar ? 42 : 4)} />)
    → chat-views.tsx
        · streaming  → raw text, dim, con trỏ ▋ (KHÔNG qua markdown)
        · finalized  → <Markdown text width />  (markdown.tsx, 513 dòng, zero-dep, hand-rolled)
```

`markdown.tsx` tự parse: fenced code (+ highlight bằng regex), ```mermaid →
ASCII preview, ```chart/```timeline → render riêng, heading, GFM table, bullet/
task list, numbered list, quote, inline (`code`, `**bold**`, link).

Điểm yếu xuyên suốt: **mọi phép đo độ rộng đều dùng `string.length`**
(`clip()`, `padEnd`, `fit()`, table layout, chart, mermaid box) — tức đếm UTF-16
code units thay vì display cells. Đây là nguyên nhân gốc của phần lớn lỗi UI.

## 3. Catalog lỗi hiển thị

Mỗi lỗi ghi kèm vị trí code đã kiểm chứng. Mức: **S1** = vỡ layout/sai nội dung
rõ rệt, **S2** = sai trong điều kiện phổ biến, **S3** = thiếu tính năng/khó chịu.

### 3.1 Đo độ rộng sai (gốc — ảnh hưởng mọi block)

| # | Lỗi | Vị trí | Mức |
|---|-----|-----|-----|
| W1 | `clip()` cắt theo `line.length`: emoji/CJK (2 cells), dấu tiếng Việt dạng combining (0 cells), ZWJ sequences → cắt sai, đôi khi cắt đứt cả cụm emoji | `markdown.tsx:25` | S1 |
| W2 | Table: `naturalWidths`/`padEnd` đếm string length → cột chứa emoji/tiếng Việt lệch viền phải | `markdown.tsx:420-435` | S1 |
| W3 | Mermaid box: `padEnd(24)` + chuỗi space hardcode → viền phải `│` lệch ngay cả với ASCII thuần (tổng width phụ thuộc độ dài id/label) | `markdown.tsx:207,213,226` | S1 |
| W4 | Chart: `labelWidth`, bar `█`.repeat, pad theo length → lệch với label Unicode | `markdown.tsx:251-270` | S2 |
| W5 | `fit()` (theme) và clip trong `ToolItemView`/`DiffItemView` cùng bệnh | `theme.tsx:118`, `chat-views.tsx:107,175` | S2 |
| W6 | Không có dependency `string-width`/`wcwidth` nào trong repo — mọi nơi tự đếm | toàn `src/tui/` | S1 |

### 3.2 Bảng (GFM table)

| # | Lỗi | Vị trí | Mức |
|---|-----|-----|-----|
| T1 | Header row render bằng ký tự góc trên `┌ … ┬ … ┐` thay vì `│ … │ … │` — dòng tiêu đề nhìn như đường viền bị chữ đè; bảng không có viền trên thật | `markdown.tsx:438` | S1 |
| T2 | Không có viền dưới `└─┴─┘` → bảng "mở", dính vào nội dung dưới | `markdown.tsx:436-442` | S2 |
| T3 | `parseRow` split theo `|` thô: vỡ khi cell chứa `\|` escape hoặc `` `a\|b` `` trong code span | `markdown.tsx:412-413` | S1 |
| T4 | Bỏ qua alignment row (`:---`, `:--:`, `--:`) — luôn căn trái | `markdown.tsx:414-415` | S3 |
| T5 | Cell không qua `renderInline` → `**bold**`, `` `code` `` trong bảng hiện raw | `markdown.tsx:428-435` | S2 |
| T6 | Bảng rộng hơn pane: `clip(line, paneWidth)` có thể cắt mất viền phải; không có chế độ degrade (wrap cell / dạng key-value) | `markdown.tsx:434` | S1 |
| T7 | Không giới hạn số hàng — bảng 500 hàng chiếm toàn bộ transcript | `markdown.tsx:416-417` | S2 |

### 3.3 Mermaid

| # | Lỗi | Vị trí | Mức |
|---|-----|-----|-----|
| M1 | Node regex chỉ nhận id bắt đầu `[A-Z]` → node lowercase (`a[Start]`) bị bỏ sót, preview thiếu node | `markdown.tsx:196` | S1 |
| M2 | Edge label được regex bắt (`m[3]`) rồi **discard** — mất nhãn cạnh | `markdown.tsx:201-204` | S2 |
| M3 | Diagram không nhận diện được (classDiagram, gantt, pie, sequence phức tạp có `alt/loop/Note`, subgraph, alias `participant A as Alice`) → rơi về box chung chung, không hiện source, không nói rõ lý do | `markdown.tsx:187-231` | S2 |
| M4 | Box preview width cố định ~53 chars, không theo `paneWidth`, và không đo được do W3 | `markdown.tsx:185-243` | S2 |

### 3.4 Code block & inline

| # | Lỗi | Vị trí | Mức |
|---|-----|-----|-----|
| C1 | Dòng code dài bị **cắt mất** (`clip` + "…") thay vì wrap — mất nội dung agent trả lời. Docstring ghi "hard-wrapped" nhưng code là truncate | `markdown.tsx:155`, docstring dòng 16 | S1 |
| C2 | Comment regex `/\*[\s\S]*?\*/` chạy trên **từng dòng** → block comment nhiều dòng highlight sai | `markdown.tsx:157` | S3 |
| C3 | Highlight chỉ có bộ keyword JS/TS chung — Python/Rust/Go… không được nhận diện (chấp nhận được, nhưng cần ghi tài liệu) | `markdown.tsx:142-180` | S3 |
| C4 | Inline markdown tối thiểu: thiếu `*italic*`, `~~strike~~`, `__bold__`; `**a *b* c**` fail (regex `[^*\n]+`); link với URL chứa `()` fail | `markdown.tsx:311` | S2 |
| C5 | Quote clip ở `DEFAULT_WIDTH=100` cứng thay vì `paneWidth` → tràn khi pane hẹp hơn 100 | `markdown.tsx:494` | S1 |
| C6 | `MAX_CODE_LINES=60` truncate không có cách xem phần còn lại | `markdown.tsx:23,389` | S3 |

### 3.5 Luồng streaming & tương tác

| # | Lỗi | Vị trí | Mức |
|---|-----|-----|-----|
| S1* | Khi streaming kết thúc, item flip từ raw-text → markdown đã render → chiều cao đổi đột ngột (bảng/chart/code box xuất hiện) → **scroll jump** | `chat-views.tsx:221-237` | S2 |
| S2* | `<Markdown>` parse lại toàn bộ text mỗi lần render; mọi `ChatItemView` re-render khi state đổi (key = index, không memo) → với message dài + nhiều event, CPU tăng rõ | `app.tsx:211`, `chat-views.tsx:235` | S2 |
| S3* | `estimateItemRows` đo assistant item bằng `len/80 + số dòng` — markdown thật (table +2 viền, mermaid ~10 dòng, code box +2) làm estimate lệch lớn → virtualization window sai, scroll giật/clip | `selectors.ts:14-34` (đã có TODO "ponytail") | S1 |

### 3.6 Môi trường terminal

| # | Lỗi | Vị trí | Mức |
|---|-----|-----|-----|
| E1 | Không có ASCII fallback: box-drawing `┌─┐│`, block `█░`, spinner Braille vỡ trên terminal không Unicode (`TERM=dumb`, một số CI, Windows cũ) | toàn bộ render | S2 |
| E2 | Không tôn trọng `NO_COLOR`/`FORCE_COLOR` ở tầng theme | `theme.tsx` | S3 |
| E3 | Resize: `columns` đã reactive, nhưng các box width cố định (mermaid 53) và clip cứng 100 (C5) không theo | `markdown.tsx` | S2 |

## 4. Nguyên tắc thiết kế

1. **Đo trước khi vẽ.** Mọi quyết định layout (cắt, pad, căn, wrap) đi qua một
   display-width util duy nhất. Cấm `padEnd`/`slice` trực tiếp trên chuỗi hiển
   thị trong `src/tui/`.
2. **Parse ≠ render.** Tách parser markdown (pure, sync, testable) khỏi renderer
   Ink. Parser trả về block AST; renderer quyết định màu/viền/width.
3. **Degrade có chủ đích, không vỡ.** Khi không đủ chỗ/không hỗ trợ: fallback
   rõ ràng (bảng → key-value, mermaid → source + chú thích, box-drawing → ASCII)
   thay vì render nửa vời.
4. **Zero-dep khi hợp lý, thêm dep khi đúng chỗ.** Chỉ cân nhắc thêm
   `string-width` (xem Q1) — không kéo thêm markdown engine nặng.
5. **Không đổi contract.** Event schema, tool schema, CLI, prompt format giữ
   nguyên; thay đổi system prompt ở mức hướng dẫn format (không đổi semantics).
6. **Mỗi phase tự xanh:** `npm test` + `build` + `lint` + `check:layers` +
   `docs:check` pass sau mỗi phase.

## 5. Kiến trúc đích

```
src/tui/
  text-width.ts        (MỚI)  display-width: measure / clip / pad / wrap
  markdown/
    ast.ts             (MỚI)  Block type: paragraph|heading|code|table|list|quote|hr|mermaid|chart|timeline
    parse.ts           (MỚI)  markdown text → Block[]  (pure, sync, zero-dep)
    inline.ts          (MỚI)  inline tokens: code/bold/italic/strike/link (precedence đúng)
    render.tsx         (MỚI)  Block[] → Ink nodes (dùng text-width)
    table.tsx          (MỚI)  table renderer chuẩn (viền đủ, align, wrap, degrade)
    diagram.tsx        (MỚI)  mermaid summary box + chart + timeline preview
  markdown.tsx         (GIỮ)  re-export <Markdown> = parse + render (entry duy nhất, tránh sửa nhiều nơi)
```

Lưu ý: `src/tui/markdown/` là **folder con của domain `tui/`**, không vi phạm
cấu trúc domain; `check-layers` không đổi rule. `markdown.tsx` giữ nguyên export
surface (`Markdown`, `parseChartSpec`, `parseTimelineSpec`, `ChartSpec`…) để
test hiện hữu không đổi import.

Quyết định render quan trọng:

- **Bảng:** đủ 4 viền; header `│`; align theo separator row; cell wrap nhiều
  dòng khi vừa, degrade "key: value" khi pane quá hẹp (< ~40 cells) hoặc khi
  số cột × min-width > pane; clip theo display width; cap số hàng (50) + dòng
  "… N more rows".
- **Mermaid:** không vẽ đồ thị thật. Render **structured summary**: loại
  diagram, số node/edge (hoặc participants/messages), liệt kê có giới hạn,
  trong box đo đúng bằng text-width; kèm hint export. Diagram không nhận diện
  được → hiển thị source có highlight + note "preview không hỗ trợ loại này".
- **Code block:** wrap dòng dài (indent continuation, không cắt nội dung);
  gutter số dòng theo display width; giữ cap 60 dòng + footer đếm phần ẩn.
- **Streaming:** giữ raw-dim trong lúc stream (ổn định), nhưng chống jump khi
  finalize bằng: memo hoá render (`React.memo` trên `item.text`), và cập nhật
  `estimateItemRows` block-aware để virtualization không giật.

## 6. Kế hoạch theo phase

> Ước lượng effort theo quy mô diff: S <150 dòng, M 150–400, L >400.
> Trạng thái thực hiện: ✅ = done.

### P0 — Fixture corpus & reproduction harness (S) ✅

Mục tiêu: có bộ mẫu markdown "khó" để tái hiện mọi lỗi §3 trước khi sửa.

- Tạo `test/fixtures/markdown/` (~10 file): bảng unicode/emoji, bảng `\|` +
  code-span, bảng 8 cột hẹp, bảng 60 hàng, mermaid flowchart/sequence/
  classDiagram/subgraph, code dòng 200 chars, nested list 4 cấp, quote dài,
  inline lồng nhau, document hỗn hợp.
- Script `scripts/render-md.mjs`: render một fixture qua `<Markdown>` (Ink vào
  PassThrough như `tui-render.test.mjs`), strip ANSI, in ra — dùng để soi tay
  và làm input cho snapshot test ở P8.
- **Gate:** script chạy được, fixtures committed. Không đổi src.

### P1 — `text-width.ts` foundation (M) ✅ — *gốc của mọi fix*

- API: `measure(s)`, `clipCells(s, n)`, `padEndCells(s, n)`, `wrapCells(s, n)`
  — xử lý đúng: combining marks (tiếng Việt), emoji + ZWJ + VS16, CJK wide,
  strip ANSI trước khi đo.
- Quyết định dependency: ưu tiên thêm `string-width` (chuẩn, đã battle-tested);
  nếu muốn zero-dep thì port tối thiểu (wcwidth + emoji ranges) — xem Q1.
- Unit test `test/text-width.test.mjs`: ~30 case (combining, emoji, ZWJ, CJK,
  ANSI, tab, control chars).
- Migrate: `clip()`/`contentWidth` trong markdown.tsx, `fit()` trong theme.tsx,
  clip trong chat-views.tsx (`ToolItemView`, `DiffItemView`), sidebar/chrome nếu
  có pad thủ công.
- **Gate:** full test suite xanh; fixture bảng emoji (P0) render không lệch
  viền khi soi bằng script.

### P2 — Tách parser markdown (L) ✅

- Tạo `markdown/ast.ts` + `markdown/parse.ts`: chuyển toàn bộ nhánh parse từ
  `markdown.tsx` sang pure parser trả về `Block[]`. Xử lý đúng trong parser:
  unclosed fence (EOF), table với `\|`/code-span, alignment row, list lồng theo
  indent thật, hr (`---`/`***`), heading 1–6.
- Tạo `markdown/inline.ts`: tokenizer inline với precedence **code span trước**
  (nội dung trong backtick không parse tiếp), rồi bold/italic/strike/link;
  hỗ trợ escape `\*`, `\_`; link URL chứa `()` cân bằng một cấp.
- `markdown.tsx` chuyển thành orchestrator: `parse()` → render từng block
  (tạm tái dùng renderer cũ cho các block chưa nâng cấp).
- Test `test/markdown-parse.test.mjs`: snapshot AST (JSON) cho mọi fixture P0.
- **Rủi ro:** regression parse — được bảo vệ bởi snapshot AST + suite hiện hữu.
- **Gate:** suite xanh, không đổi output render (so snapshot text trước/sau
  bằng script P0).

### P3 — Table renderer chuẩn (`table.tsx`) (M) ✅

- Viền đủ: `┌─┬─┐` / header `│` (bold) / `├─┼─┤` / rows / `└─┴─┘` (fix T1, T2).
- Parse cell đúng: `\|`, code-span chứa `|` (fix T3); alignment từ separator
  row — căn phải/giữa theo display width (T4); inline markdown trong cell (T5).
- Layout: phân bổ width theo nội dung (min 3, ưu tiên cột hẹp trước), wrap cell
  nhiều dòng khi pane đủ rộng; **degrade** sang dạng `key: value` khi pane hẹp
  hoặc quá nhiều cột (fix T6); cap 50 hàng + "… N more rows" (T7).
- Test: bảng align phải/trái/giữa, bảng emoji không lệch viền (theo cells, không
  theo length), bảng hẹp → degrade, bảng dài → cap.
- **Gate:** fixture bảng của P0 render đúng trong 3 width: 40 / 80 / 120.

### P4 — Mermaid summary + chart/timeline polish (`diagram.tsx`) (M) ✅

- Parser mermaid tối thiểu nhưng **đúng**: nhận diện `graph/flowchart/
  sequenceDiagram/stateDiagram/erDiagram/classDiagram/gitGraph/pie/gantt`;
  node id lowercase + quoted labels (fix M1); giữ edge label (M2); participants
  có alias; message có nhãn.
- Render: box đo bằng text-width theo `paneWidth` (fix W3, M4), nội dung =
  tóm tắt có cấu trúc (loại, thành phần, tối đa N dòng + "…"), kèm hint
  `npx @mermaid-js/mermaid-cli`. Loại không hỗ trợ → source highlight + note
  thân thiện (M3).
- Chart/timeline: pad đo bằng cells (fix W4), **thêm viền phải** cho khung
  chart (hiện hàng `│{row}` không có viền phải), số âm/label Unicode căn đúng.
- Test: parse từng loại diagram trong fixture; box không lệch viền ở width
  40/80/120.
- **Gate:** fixture mermaid render sạch; không còn box lệch viền.

### P5 — Code block, inline render, streaming polish (M) ✅

- Code block: wrap thay vì truncate (fix C1), continuation indent + marker `↪`;
  gutter đo bằng cells; giữ cap 60 dòng + footer rõ ràng (C6: ghi đường dẫn/
  cách xem đầy đủ nếu có).
- Fix C5: mọi `clip` còn lại dùng `paneWidth`.
- Streaming: `React.memo` cho `ChatItemView` theo `item` reference; memo parse
  markdown theo `text` (cache Map nhỏ, key = text, LRU ~20) để không parse lại
  toàn bộ mỗi event (fix S2*); giữ raw-dim khi streaming.
- Chống scroll jump khi finalize (S1*): đảm bảo `estimateItemRows` (P6) khớp
  render thật; nếu vẫn giật, ghim scroll xuống đáy khi item cuối đổi height.
- **Gate:** test perf nhẹ (render 200 deltas < ngưỡng), PTY smoke xanh.

### P6 — Virtualization metrics block-aware (S–M) ✅

- `estimateItemRows` cho assistant: ước lượng theo **số block + dòng wrap**
  (parse nhẹ: đếm fence/table/heading) thay vì `len/80` (fix S3*). Không cần đo
  Ink thật ở phase này; chỉ cần sai số nhỏ hơn 1 viewport.
- Test `test/tui-virtual.test.mjs`: bổ sung case assistant chứa bảng/mermaid.
- **Gate:** scroll e2e (`tui.test.mjs`) ổn định, không flake tăng thêm.

### P7 — Terminal fallbacks & accessibility (S) ✅

- ASCII mode (`SCODER_ASCII=1` hoặc auto khi `TERM=dumb`/không UTF-8): map
  `┌─┐│├┼┤└┴┘┬` → `+-+|++++`, `█░` → `#.`, spinner Braille → `-\|/`, bullet
  `•` → `*` (fix E1).
- Tôn trọng `NO_COLOR` ở tầng theme (E2); kiểm tra mọi box width theo
  `columns` reactive khi resize (E3).
- Test: render fixture ở ASCII mode — không ký tự nào ngoài ASCII in được.
- **Gate:** e2e xanh; soi tay trên `TERM=dumb`.

### P8 — Test hardening & docs (M) ✅

- Snapshot test text (strip ANSI) cho mọi fixture ở width 40/80/120 —
  `test/markdown-snapshot.test.mjs` (so chuỗi, không dùng `renderToStaticMarkup`
  của react-dom như `markdown-table.test.mjs` hiện tại vì reconciler Ink khác;
  ưu tiên harness PassThrough của `tui-render.test.mjs`).
- Property/fuzz: sinh markdown ngẫu nhiên (ký tự lạ, fence lệch, bảng rách) —
  renderer không throw, mọi dòng output `measure() ≤ paneWidth`.
- Prompt-side: bổ sung 1 đoạn ngắn vào system prompt (`src/context/prompt*.ts`)
  hướng dẫn agent sinh markdown terminal-friendly (bảng ≤ 6 cột, cell ngắn,
  mermaid chỉ flowchart/sequence đơn giản, ưu tiên ```chart khi vẽ số liệu) —
  **chỉ thêm hướng dẫn format, không đổi semantics**.
- Docs: cập nhật `src/tui/README.md` (kiến trúc markdown/ mới), `docs/`
  nếu cần; chạy `docs:check`.
- **Gate:** ≥ 5 test mới (thực tế nhiều hơn), 835+ test xanh, fuzz 10k case
  không throw.

### Thứ tự & phụ thuộc

```
P0 → P1 → P2 ─┬→ P3 (table)        ─┐
              ├→ P4 (mermaid/chart) ─┼→ P8
              └→ P5 (code/streaming) ┤
P1 → P6 ─────────────────────────────┘
P1 → P7 ─────────────────────────────┘
```

P1 là bắt buộc trước mọi renderer mới. P3/P4/P5 độc lập nhau, có thể làm song
song hoặc đổi thứ tự theo ưu tiên lỗi thực tế gặp nhiều nhất (đề xuất P3 → P4
→ P5).

## 7. Chiến lược kiểm thử

| Tầng | Công cụ | Bao phủ |
|------|---------|---------|
| Unit thuần | `node --test` | text-width (30+ case), parser AST snapshot, mermaid parse, table layout |
| Render | Ink + PassThrough (strip ANSI) | mọi fixture × 3 width; assert không dòng nào vượt width, viền thẳng cột |
| Snapshot | text snapshot có review | chống regression render |
| Fuzz | generator ngẫu nhiên | không throw, không overflow |
| E2E | PTY (`tui.test.mjs`) | luồng đầy đủ không giật |
| Thủ công | checklist | macOS (iTerm/Terminal), Linux, Windows Terminal; `TERM=dumb`; NO_COLOR; resize |

Mọi phase kết thúc bằng: `npm test` (835+ xanh) · `npm run eval` (11/11) ·
`npm run lint` (0 error, ≤ budget warnings) · `npm run check:layers` ·
`npm run docs:check`.

## 8. Acceptance criteria

| AC | Tiêu chí | Đo bằng |
|----|----------|---------|
| AC1 | Mọi lỗi §3 (W1–W6, T1–T7, M1–M4, C1–C6, S1*–S3*, E1–E3) có fix hoặc quyết định defer được ghi rõ | checklist trong PR từng phase |
| AC2 | Component/module mới import sạch, build + typecheck pass | `npm run build`, `tsc --noEmit` |
| AC3 | Fixture corpus render đúng ở width 40/80/120: bảng đủ viền, thẳng cột, không tràn; mermaid box không lệch; code không mất nội dung (wrap) | snapshot test P8 |
| AC4 | Toàn bộ test hiện hữu (835) vẫn xanh | `npm test` |
| AC5 | ≥ 5 test mới (thực tế: text-width, parse, table, diagram, snapshot, fuzz, ASCII) | `node --test` |
| AC6 | `src/tui/README.md` cập nhật kiến trúc mới + ví dụ; docs:check xanh | docs |
| AC7 | Kế hoạch/tài liệu bằng tiếng Việt, cấu trúc rõ ràng | tài liệu này |

## 9. Edge cases

| Tình huống | Hành vi mong muốn |
|---|---|
| Bảng > 50 hàng hoặc > 8 cột | cap hàng + "… N more rows"; nhiều cột → degrade key-value hoặc wrap |
| Bảng rộng hơn pane dù đã nén | degrade key-value per row, không clip mất viền |
| Mermaid loại không hỗ trợ / cú pháp lỗi | source highlight + note rõ, không throw, không box rỗng |
| Dữ liệu chart âm / NaN / label Unicode rất dài | clamp hợp lý, clip theo cells, không NaN% |
| Terminal không Unicode | ASCII fallback toàn bộ ký tự vẽ |
| `NO_COLOR` / `FORCE_COLOR=0` | theme tắt màu, giữ đậm/nhạt tối thiểu |
| Tiếng Việt combining, emoji ZWJ trong bảng/code | viền thẳng theo display cells |
| Resize khi đang stream | block re-layout theo `columns` mới, không tràn |
| Fence không đóng (agent bị cắt giữa chừng) | parse tới EOF như hiện tại, không throw |
| Message rất dài (2000+ dòng) | virtualization + memo hoá; render không vượt ngưỡng thời gian |
| Inline lồng: `` `**code**` ``, `**a *b* c**`, link URL có `()` | precedence đúng, không render sai |

## 10. Rủi ro & phương án dự phòng

| Rủi ro | Xác suất | Giảm thiểu |
|---|---|---|
| Thêm dep `string-width` bị phản đối | TB | Q1 — phương án B: port wcwidth tối thiểu (≤200 dòng, có test đối chiếu) |
| Tách parser (P2) gây regression render | TB | Snapshot text trước/sau trên fixture corpus; phase riêng không lẫn fix |
| Estimate virtualization mới vẫn lệch | TB | Over-estimate an toàn (giữ nguyên tắc hiện hữu); nếu lệch > 1 viewport mới cân nhắc đo Ink thật |
| Wrap code làm transcript dài hơn | Thấp | Giữ cap 60 dòng; wrap chỉ trong khung width hiện có |
| Test snapshot giòn theo version Ink | Thấp | Snapshot text đã strip ANSI; pin ink trong package.json |
| Thay đổi system prompt ảnh hưởng eval | TB | Chạy `npm run eval` ngay trong P8; nếu tụt, rút đoạn hướng dẫn format |

## 11. Quyết định cần duyệt

Trước khi bắt đầu P1, cần chốt:

- **Q1 — Dependency cho display-width:** (a) thêm `string-width` (~không dep
  con đáng kể, chuẩn cộng đồng) — *khuyến nghị*; hay (b) tự port wcwidth tối
  thiểu để giữ zero-dep cho tầng này?
- **Q2 — Mermaid:** xác nhận phạm vi "structured summary + source fallback"
  (không vẽ đồ thị ASCII thật cho mọi loại). Nếu muốn vẽ flowchart thật,
  đó là phase riêng (L+) sau P4.
- **Q3 — Code block dài:** wrap (không mất nội dung, transcript dài hơn) hay
  giữ truncate + lệnh/phím để xem đầy đủ? *Đề xuất: wrap.*
- **Q4 — Thứ tự ưu tiên:** P3 (table) → P4 (mermaid) → P5 (code/streaming)
  như đề xuất, hay lỗi nào đang gặp nhiều nhất thực tế để làm trước?

---

## Kết quả thực hiện (ghi nhận sau khi xong)

- **P1**: `src/tui/text-width.ts` (measure/clipCells/sliceCells/padEndCells/
  padStartCells/wrapCells) trên `string-width@8` + `Intl.Segmenter` — không
  bao giờ cắt đứt grapheme cluster hay ANSI sequence. 24 unit test.
  `fit()` (theme) và các clip trong `chat-views.tsx` đã migrate.
- **P2**: parser tách thành `src/tui/markdown/{ast,parse,inline}.ts`;
  `markdown.tsx` chỉ còn là orchestrator với export surface giữ nguyên +
  LRU parse cache (50 entries). Khác plan: các fix render được gộp luôn vào
  renderer mới thay vì move-verbatim trước (snapshot test P8 bảo vệ).
- **P3**: `markdown/table.tsx` — đủ 4 viền, header `│`, alignment row
  (trái/giữa/phải), cell wrap nhiều dòng, `\|` và `` `a|b` `` an toàn, inline
  markdown trong cell, degrade key-value khi pane < 28c hoặc cột không fit,
  cap 50 hàng.
- **P4**: `markdown/diagram.tsx` — mermaid flowchart/sequence → summary box
  (nodes + edges **kèm label**, participants + messages, node id lowercase OK,
  edge có shape `A[Start] --> B` parse đúng); loại khác → source + note +
  export hint. `ContentBox` đo theo cells → viền không bao giờ lệch. Chart/
  timeline có viền phải (trước thiếu), off-by-N width đã fix.
- **P5**: code block wrap với continuation `↪` (không mất nội dung), block
  comment `/* */` đa dòng highlight đúng, quote wrap theo paneWidth (trước
  clip cứng 100). `ChatItemView` memo với field-level equality (state mutate
  in-place → reference equality sẽ đóng băng streaming; đã tránh).
- **P6**: `estimateMarkdownRows` block-aware trong selectors; thinking giờ
  khớp render thật (collapse 4 dòng). Lưu ý: app hiện render toàn bộ items
  (virtualization chưa wire — `visibleWindow` mới chỉ dùng trong test).
- **P7**: `src/tui/charset.ts` — mọi glyph vẽ (box, block, spinner, markers)
  qua một chỗ; ASCII fallback khi `SCODER_ASCII=1`/`TERM=dumb`; Ink border
  `round`→`classic` ở ASCII mode. NO_COLOR/FORCE_COLOR do Ink/chalk xử lý —
  có test chứng minh (không SGR khi NO_COLOR=1).
- **P8**: 30 snapshot test (10 fixture × width 40/80/120, invariant: không
  dòng nào vượt width, đo bằng cells), fuzz 240 doc ngẫu nhiên × 4 width
  (không throw/không overflow), 2 test env (ASCII/NO_COLOR), prompt mới có
  section "Terminal markdown" hướng dẫn agent sinh nội dung terminal-friendly,
  `scripts/render-md.mjs` để soi render bằng mắt.
- Test hiện hữu điều chỉnh theo hành vi mới có chủ đích: cell bảng dài giờ
  wrap thay vì clip (`markdown-table.test.mjs`).
