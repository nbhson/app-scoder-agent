# P2.3 — Diagram focus & animation (highlight "active" như tab ROUTER)

> Trạng thái: ✅ ĐÃ SHIP phases 1–5 (11/2026) · phase 6 để ngỏ (tùy chọn) · Phụ thuộc: fix layout 11/2026 (`layered` band 3→2→1, `strip` chain-guard) đã merge · Liên quan: `plan/P2-02-model-router.md` (packet pulse), `src/tui/README.md` (markdown pipeline)

## Mục tiêu

Muốn chart/flowchart trong transcript có **trạng thái active + animation** giống
tab ROUTER: node đang được nói tới thì highlight accent, và khi focus **chuyển
giữa 2 node** thì một "packet" `◆` chạy trên cạnh nối giữa chúng (~0,7 s rồi nghỉ,
không reflow, không tốn CPU).

```
◉ flowchart TD · 16 nodes · 15 edges
┌────────────────────┐
│ JavaScript Runtime │
└────────────────────┘
   ◆──▶┌────────────┐        ← packet chạy Call Stack → Stack trống?
       │ Call Stack │
       └────────────┘
     ╱──────────────╲
     │ Stack trống? │        ← node active: accent + bold + ◆ đứng
     ╲──────────────╱
```

Cấp độ theo nhu cầu:

1. **Active node** (tỉnh, không timer): node được focus vẽ accent/bold, có marker.
2. **Packet animation**: dot chạy trên cạnh `prev → active` khi focus đổi (burst
   6 frame × 110 ms y hệt `useRoutePulse`).
3. **Điều khiển focus**: agent chủ động highlight từng bước khi giải thích
   (tool mới), hoặc người dùng tự cycle bằng phím.

## Hiện trạng

| Vị trí | Có gì | Còn thiếu cho tính năng này |
|---|---|---|
| `graph.ts` `Canvas` | per-cell `kinds` (box/label/edge/arrow/elabel) → `Seg{text,kind}` → `cellStyle(kind)` color | **không còn danh tính node/edge** sau raster → không biết cell nào thuộc node nào |
| `graph.ts` `routeEdge` | biết chính xác từng cell của từng cạnh khi vẽ (`drawAlong`, `arrow`) | không ghi lại **đường đi theo thứ tự** (cần cho packet) |
| `diagram.tsx` `FlowchartView` | render seg theo kind, notes, export hint | không nhận prop focus; không overlay nào |
| `sidebar.tsx` `useRoutePulse` + `laneSegs` | pattern animation burst chuẩn: event ts → 6 frame → nghỉ; tôn trọng `SCODER_ANIM=0` / `SCODER_NO_MOTION=1` / `--no-motion`; grid-stable | hook nằm trong sidebar — cần extract dùng chung |
| `charset.active` (`◆`, ASCII `>`) | glyph packet/active đã charset-safe | — |
| `diagramSlug(source)` | slug **ổn định theo nội dung** (memo WeakMap) — định danh diagram không cần id mới | chưa được expose ra ngoài diagram.tsx |
| `state.ts` | `activeRoute {ref,tier,step,ts}` — model state cho "what's hot" | chưa có `diagramFocus` |
| `parse.ts` `scanStatement` | **nuốt** `:::class` (`/^:::[\w-]+/`) rồi bỏ qua | chỉ cần *giữ lại* class là có kênh focus khai báo trong nguồn |
| `prompt.ts` V5/V6 | đã dạy model convention ` ```mermaid ` ≤12 nodes, ` ```chart ` | chưa biết convention focus nào |
| `ChartPreview` / `TimelinePreview` | bar/pie theo dòng; timeline **đã có** `status:"active"` + icon `◆` | chart fence chưa có khái niệm active row |
| `test/graph-layout.test.mjs` | harness raster thuần (dist, không Ink) | cần test owner-tagging + lane path |

## Thiết kế

### A. Raster mang danh tính: `Seg.owner` + `Raster.lanes`

- `Canvas` thêm `owners: (string|undefined)[][]`; `put/line/text` nhận thêm
  `owner` (id node với box/label; `"<from>→<to>"` với edge/arrow/elabel).
- `toRows()` tách run khi **kind hoặc owner đổi** → `Seg { text, kind, owner? }`.
  Chi phí: số seg tăng nhẹ (vẫn O(cells)), không đổi hình dạng render.
- Khi route cạnh, ghi thứ tự cell vào `lanes: Map<edgeId, {x,y}[]>`
  (`drawAlong`/`arrow` đã đi qua từng cell — chỉ cần push). Đưa vào `Raster`.
- `cellStyle(kind, owner, focus)` — owner == focus.node → accent + bold;
  cạnh `prev→node` → nền animation (xem C). Cache `renderFlowchart` **không**
  đổi key: focus áp ở tầng render, raster tĩnh.

### B. Nguồn focus — 2 kênh, ưu tiên theo phase

**Khai báo trong nguồn (v1, không cần tool mới):**
- `A[Call Stack]:::focus` — parser đang nuốt `:::class`; giữ class `focus`
  → `FlowGraph.focus?: string`. Thêm `%% focus: B` (comment directive) cho
  ai không muốn đụng styling.
- `chart` fence: `{"type":"bar","focus":"Q3","data":[…]}` hoặc dòng
  `label | value | active`.
- `timeline` đã xong (`status:"active"`).
- Kênh này cho phép **model chủ động** highlight bằng cách re-emit diagram —
  phù hợp tài liệu xuất PDF/text (focus nằm trong nguồn), nhưng trong TUI thì
  re-emit làm spam transcript → chỉ là fallback, không phải cách chính.

**Tool `diagram_focus` (v2 — cách "Router-like" đúng nghĩa):**
- Tool mới trong registry: `{ diagram: <first node label hoặc slug>, node: <id>, step?: n }`.
- Handler resolve slug bằng chính `diagramSlug` (import từ diagram.tsx —
  tách sang `markdown/slug.ts` thuần để tránh vòng import), map `node` qua
  `parseFlowchart` để validate id + lấy label; **không hợp lệ → tool error
  sạch, không vẽ gì sai**.
- Event `diagram_focus` → `state.diagramFocus = { slug, node, prev, ts }`
  (prev = node focus trước đó *cùng slug*, để packet biết cạnh nào để chạy).
- Prompt V5/V6 thêm 2 dòng: khi giải thích sơ đồ từng bước, gọi
  `diagram_focus` thay vì in lại diagram.

**Phím (v3, optional):** `Ctrl+B` cycle sidebar tab đã chiếm mặt bằng phím;
đề xuất `f` khi con trỏ transcript đứng trên dòng diagram (chọn diagram
"current" = block mermaid cuối đã finalize trong window render) → focus bước
theo topological order, Shift+f lùi. Chỉ làm khi A+B xong và thấy nhu cầu thật.

### C. Animation — copy pattern ROUTER, không sáng tạo thêm

- Extract `useRoutePulse` → `hooks/use-pulse.ts` (`usePulse(ts, frames=6, ms=110)`),
  sidebar dùng lại — giữ nguyên hành vi ROUTER (test snapshot không đổi).
- `FlowchartView` gọi `usePulse(focus?.ts)`; frame `f` → tra `lanes[prev→node]`,
  đặt `charset.active` tại cell thứ `floor(f/(frames-1)*(lane.length-1))`
  (đầu cuối = node đích). Nghỉ (f=-1) → không overlay.
- Node active đứng: label seg owner==node → `theme.accent` + bold + `◆` appended
  trong ô box (chừa 2 cell khi `sizeBoxes` nếu node có thể được focus? **Không** —
  marker vẽ đè cell border trên cùng của box, grid-stable, khỏi đổi layout).
- `SCODER_NO_MOTION` / `SCODER_ANIM=0` → `usePulse` trả -1 vĩnh viễn, không
  timer (đúng hợp đồng hiện tại của ROUTER, kể cả a11y prefers-reduced-motion).

### D. Chart fences & notes

- `ChartPreview`: `spec.focus` → dòng đó accent + `▸` đầu dòng; bar không animate
  (thiếu "đường đi" tự nhiên; packet cho bar = over-design). Pie: wedge label accent.
- Header flowchart thêm `· focus: <label>` khi có focus (dim) — người dùng scroll
  lên biết diagram nào đang được "chỉ".

## Các giai đoạn (mỗi cái ship độc lập, có test riêng)

| # | Việc | File | Rủi ro | Trạng thái |
|---|---|---|---|---|
| 1 | `owner` tagging + `lanes` trong Canvas/toRows; `Seg.owner`; test raster thuần | `graph.ts`, `graph-layout.test.mjs` | thấp — additive, snapshot cũ phải không đổi | ✅ DONE |
| 2 | `usePulse` extract + `cellStyle(kind,owner,focus)` + active node tĩnh (chưa packet) | `hooks/use-pulse.ts`, `sidebar.tsx`, `diagram.tsx` | thấp | ✅ DONE |
| 3 | Kênh nguồn `:::focus` / `%% focus:` / chart `focus` (parse + prompt V5/V6) | `graph.ts`, `parse.ts`? (scanStatement đã có class), `prompt.ts` | thấp | ✅ DONE |
| 4 | Packet lane animation prev→node | `diagram.tsx` | trung bình — index lane phải khớp crop() (crop dịch x! lưu lane SAU crop hoặc cộng offset) | ✅ DONE |
| 5 | Tool `diagram_focus` + event + `state.diagramFocus` + wiring app | `src/tools/*`, `state.ts`, `use-event-queue` | trung bình — chạm agent loop, cần eval prompt | ✅ DONE |
| 6 | (optional) phím cycle focus | `input.tsx`/`app.tsx` | cao hơn — focus management trong transcript virtualized |

## Test

- Unit (không Ink): owner của mọi cell trong box node == id; lane `prev→node`
  phủ đúng số cell `edge` giữa 2 box; `:::focus` parse ra `graph.focus`;
  focus id không tồn tại → tool trả error, raster không đổi.
- Snapshot: fixture `mermaid-focus.md` render @40/80/120 với `focus` khớp
  `lanes` — assert frame -1 (NO_MOTION) giống hệt snapshot cũ (overlay không
  làm đổi layout khi nghỉ).
- E2E: script mock emit `diagram_focus` 2 lần → screen buffer có `◆` ở cell
  giữa 2 node rồi biến mất sau burst; `SCODER_NO_MOTION=1` → không bao giờ có.
- Fuzz hiện có (`never throws and always fits`) phải pass nguyên với owner/lanes.

## Rủi ro & quyết định đã cân nhắc

- **Reflow**: mọi overlay chỉ thay glyph/màu trong grid đã đo — cùng nguyên tắc
  "không reflow" của ROUTER. Marker `◆` đè corner cell, không chèn text mới.
- **Perf**: burst 6 frame/event, không có idle timer (khác spinner). Repaint
  20 fps hiện tại không đổi.
- **Cache**: `renderFlowchart` cache theo source+width — focus KHÔNG nằm trong
  key, áp lúc render → một diagram nhiều lần focus không layout lại.
- **`crop()` dịch tọa độ**: lanes phải lưu sau crop (hoặc cộng offset) — điểm
  dễ sai nhất của phase 4, test đố chỉ vào đúng cell.
- **Tool mới**: model gọi `diagram_focus` sai id → hoàn tác im lặng + error
  string mô tả node ids hợp lệ (self-correcting như edit_file). Không vẽ bừa.
- **Không làm**: particle engine, fade/alpha (terminal grid không có), animate
  bar chart, focus đa node cùng lúc (1 focus = 1 "con trỏ giảng bài").
