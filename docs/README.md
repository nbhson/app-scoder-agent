# Scoder — Autonomous Coding Agent CLI

**Current version: 0.9.3**

**Scoder** là một CLI agent tự động chạy trong terminal. Nó không chỉ suggest code — nó **thực thi** code. Scoder tự động viết, sửa, chạy test và debug cho đến khi project build thành công.

Giống workflow của *Cline*, *Claude Code*, và *OpenCode*, nhưng chạy như một standalone CLI tool duy nhất.

[![CI](https://github.com/nbhson/app-scoder-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/nbhson/app-scoder-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![npm](https://img.shields.io/badge/npm-s--app--scoder--agent-orange)](https://www.npmjs.com/package/s-app-scoder-agent)

---

## Key Features

- **Autonomous Loop**: Viết code → Chạy build → Sửa lỗi → Lặp lại đến khi thành công
- **Tool-augmented Intelligence**: File system, Shell, Web fetch, MCP tools
- **Rich TUI**: Terminal UI với real-time token streaming, diff cards, build rail
- **Rich display**: Responsive Markdown tables, terminal-native bar/line/pie charts,
  timeline/event rails, responsive code/diff/tool output, and narrow-terminal fallbacks
- **Granular Permissions**: Kiểm soát chính xác agent được làm gì
- **MCP Support**: Tích hợp Model Context Protocol cho tools mở rộng
- **Guardrail Engine**: An toàn tự động, chống doom-loop, text-only streak breaker
- **Sessions & Resume**: Lưu trạng thái, resume sau crash hoặc interrupt
- **Cost Tracking**: Token usage & estimated cost từ JSONL logs

---

## Quick Start

```bash
# Cài đặt từ npm
npm install -g s-app-scoder-agent

# Hoặc từ GitHub
npm install -g github:nbhson/app-scoder-agent

# Setup wizard lần đầu
scoder init

# Chạy một task
scoder "add a ping function to src/network.ts"

# Interactive REPL
scoder
```

---

## Documentation

| File | Description |
|------|-------------|
| [Installation](installation.md) | Cách cài đặt chi tiết |
| [Configuration](configuration.md) | Environment variables, config file, permissions |
| [Commands](commands.md) | CLI commands & flags |
| [Architecture](architecture.md) | System design & module overview |
| [TUI Guide](tui.md) | Full-screen terminal UI |
| [Guardrails](guardrails.md) | Safety & progress engine |
| [MCP Integration](mcp.md) | Model Context Protocol servers |
| [HTTP API](api.md) | Server mode & SSE API |
| [Sessions](sessions.md) | Session persistence & resume |
| [Testing](testing.md) | Running tests & coverage |
| [Onboarding](onboarding.md) | 10 main flows — where each feature lives |
| [Performance](performance.md) | Benchmark harness, baseline & decisions |
| [Refactor decisions](refactor/decisions.md) | ADR log for the domain refactor |
| [Skills](skills.md) | Skill discovery & loading |
| [Architecture graph](architecture-graph.md) | Generated dependency graph (check-layers) |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Task completed — build passed |
| `1` | Build failed after max steps |
| `2` | Fatal error (no API key, network error, etc.) |

---

## License

MIT — see [LICENSE](../LICENSE)
