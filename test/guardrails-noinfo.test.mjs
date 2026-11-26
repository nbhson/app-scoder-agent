/**
 * Unit tests cho hai lớp chống-loop bổ sung (bằng chứng từ log thật
 * ~/.scoder/sessions):
 *  - no-new-information: model fetch URL ĐẾM DẦN (angular-22-1, -2, -3…) — mọi
 *    chữ ký batch đều "mới" nên doom-loop đứng yên, nhưng cả 39 response là
 *    CÙNG một trang. Detector đo NỘI DUNG, không đo lệnh.
 *  - rescue summary: subagent kết thúc bằng marker suông ("Conversation turn
 *    complete.") hoặc hết max steps ⇒ parent không thấy kết quả; run-loop phải
 *    cứu câu trả lời thật gần nhất khỏi history.
 *
 * Chạy: npm run build && node --test test/guardrails-noinfo.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGuardrailEngine, announcesIntention } from "../dist/agent/guardrails.js";
import { lastSubstantiveAnswer } from "../dist/agent/run-loop.js";

const baseCtx = (over = {}) => ({
  step: 1,
  maxSteps: 40,
  text: "",
  message: null,
  hasToolCalls: true,
  buildPassedThisStep: false,
  buildCallPresent: false,
  filesModified: false,
  chatDone: false,
  planOpen: false,
  ...over,
});

/** web_fetch(url) với output cho trước — id tăng dần để signatures khác nhau. */
let n = 0;
function fetchStep(url, output) {
  n++;
  const id = `f${n}`;
  const message = { role: "assistant", content: null, tool_calls: [{ id, name: "web_fetch", arguments: JSON.stringify({ url }) }] };
  const toolResults = new Map([[id, { ok: true, output }]]);
  return baseCtx({ message, toolResults });
}

/** Nội dung trang Angular lặp lại — >5 dòng info, y hệt giữa các bước. */
const PAGE = [
  "Title: Home • Angular https://angular.dev (HTTP 200 OK, text/html; charset=utf-8)",
  "# Angular v22 is here",
  "Signals provide fine-grained reactivity with automatic dependency tracking.",
  "Control flow uses the new template syntax @if @for and @switch blocks.",
  "Deferrable views load templates on demand to keep the initial bundle small.",
  "Zoneless change detection removes the need for zone.js in new applications.",
].join("\n");

const noinfo = (ds) => ds.find((d) => d.rule === "no-new-information");

describe("no-new-information — loop không lặp args nhưng lặp NỘI DUNG", () => {
  it("URL đếm dần, trang trả về y hệt ⇒ inject rồi finish", async () => {
    const eng = createGuardrailEngine({ doomLoopRepeats: 2 });
    let sawInject = null;
    let step = 0;
    let last = null;
    for (let i = 1; i <= 8; i++) {
      step++;
      const ds = await eng.evaluate(fetchStep(`https://angular.dev/what-new/angular-22-${i}`, PAGE));
      const d = noinfo(ds);
      if (!d) continue;
      if (d.action.kind === "inject" && !sawInject) {
        sawInject = { step, reason: d.reason };
        eng.markNoInfoIntervention();
      }
      if (d.action.kind === "finish") {
        last = { step, reason: d.reason };
        break;
      }
    }
    assert.ok(sawInject, "phải inject nhắc trước khi finish");
    assert.ok(last, "phải finish được sau can thiệp");
    assert.ok(last.step <= 8, `finish muộn ở step ${last.step}`);
    assert.match(last.reason, /consecutive tool steps returned under/);
  });

  it("mỗi bước có nội dung MỚI thật ⇒ không kích hoạt", async () => {
    const eng = createGuardrailEngine({ doomLoopRepeats: 2 });
    for (let i = 1; i <= 8; i++) {
      const body = PAGE + `\nUnique fact number ${i} about release notes ${i} describes feature area ${i}.\nSecond fresh sentence ${i}: changelog entry ${i} lists breaking changes and migration guides.`;
      const ds = await eng.evaluate(fetchStep(`https://angular.dev/blog/post-${i}`, body));
      assert.equal(noinfo(ds), undefined, `step ${i} bị nghi nhầm`);
    }
  });

  it("tool biến đổi chạy thành công ⇒ reset (đang sửa code, không phải loop)", async () => {
    const eng = createGuardrailEngine({ doomLoopRepeats: 2 });
    for (let i = 1; i <= 3; i++) await eng.evaluate(fetchStep(`https://a/${i}`, PAGE));
    const id = "w1";
    await eng.evaluate(
      baseCtx({
        message: { role: "assistant", content: null, tool_calls: [{ id, name: "edit_file", arguments: JSON.stringify({ path: "a.ts" }) }] },
        toolResults: new Map([[id, { ok: true, output: "patched a.ts" }]]),
      }),
    );
    for (let i = 4; i <= 5; i++) {
      const ds = await eng.evaluate(fetchStep(`https://a/${i}`, PAGE));
      assert.equal(noinfo(ds)?.action.kind, undefined, `reset thất bại ở step ${i}`);
    }
  });
});

describe("announcesIntention — lời hứa hành động chưa thực hiện", () => {
  it("nhận ra 'Tôi sẽ tìm …' (log thật session 20261126-141447-93ef)", () => {
    assert.equal(announcesIntention("Tôi sẽ tìm hiểu những tính năng mới nhất của Angular cho bạn."), true);
    assert.equal(announcesIntention("Let me check the release notes for you."), true);
    assert.equal(announcesIntention("Để tôi đọc file cấu hình rồi báo lại."), true);
  });
  it("không nhận nhầm câu trả lời thật", () => {
    assert.equal(
      announcesIntention("Angular v22 có Signals, Control Flow @if/@for, Deferrable Views và zoneless change detection. Chi tiết trong các release notes chính thức."),
      false,
    );
    assert.equal(announcesIntention("Chào bạn! 👋 Tôi là Scoder, trợ lý lập trình. Bạn cần giúp gì hôm nay?"), false);
    assert.equal(announcesIntention("".padEnd(500, "x")), false); // dài = bài trả lời, không phải cụt
  });

  it("continue-nudge: bước tool-less hứa hành động ⇒ inject nhắc, không finish", async () => {
    const eng = createGuardrailEngine();
    const ds = await eng.evaluate(baseCtx({ hasToolCalls: false, text: "Tôi sẽ tìm thông tin mới nhất của Angular cho bạn." }));
    const d = ds.find((x) => x.rule === "continue-nudge");
    assert.ok(d, "phải có nudge");
    assert.equal(d.action.kind, "inject");
    assert.match(d.action.reminder, /used no tools/);
  });
});

describe("lastSubstantiveAnswer — run không kết thúc rỗng", () => {
  const M = (content) => ({ role: "assistant", content });
  it("lấy câu assistant đủ dài gần nhất, bỏ marker", () => {
    const msgs = [
      M("Angular v22 bổ sung signals với độ phản ứng chính xác cao, control flow mới bằng cú pháp @if @for @switch trong template, cùng deferrable views giảm kích thước bundle ban đầu."),
      M("<<CHAT_DONE>>"),
    ];
    const got = lastSubstantiveAnswer(msgs);
    assert.match(got, /^Angular v22/);
  });
  it("bỏ lời hứa hành động và câu cụt", () => {
    const msgs = [
      M("Kết quả phân tích: dự án dùng Angular 22 với standalone components, signals cho state cục bộ và routing lazy theo từng feature module rõ ràng."),
      M("Tôi sẽ tổng hợp lại cho bạn."),
      M("Ok."),
    ];
    assert.match(lastSubstantiveAnswer(msgs), /^Kết quả phân tích/);
  });
  it("không có gì substantive ⇒ chuỗi rỗng", () => {
    assert.equal(lastSubstantiveAnswer([{ role: "user", content: "hello" }, M("x")] ), "");
  });
});
