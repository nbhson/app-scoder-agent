# 🤖 Scoder: Autonomous Coding Agent CLI

[![CI](https://github.com/nbhson/app-scoder-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/nbhson/app-scoder-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**Scoder** is a high-performance, autonomous coding agent that lives in your terminal. It doesn't just suggest code—it **executes** it. Scoder writes, edits, runs tests, and debugs your codebase autonomously until your project builds successfully.

Inspired by the workflows of *Cline*, *Claude Code*, and *OpenCode*, Scoder is designed to be a lightweight yet powerful standalone CLI tool for developers.

---

## ✨ Key Features

- 🚀 **Autonomous Loop**: Writes code $\rightarrow$ Runs build $\rightarrow$ Fixes errors $\rightarrow$ Repeats until success.
- 🛠️ **Tool-Augmented Intelligence**: Uses a sophisticated set of tools (File System, Shell, Web Fetch, MCP) to interact with your environment.
- 🖥️ **Rich TUI (Terminal User Interface)**: A beautiful, interactive interface built with `Ink` for real-time streaming of LLM tokens, progress bars, and terminal-based code reviews.
- 🛡️ **Granular Permissions**: A robust permission system that allows you to control exactly what the agent can access and execute.
- 🔌 **MCP Support**: Integrates with the Model Context Protocol to extend its capabilities with external tools and data.
- 🧠 **Context-Aware**: Maintains session history and intelligently manages context to keep the agent focused on your goals.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: version `^20.0.0` or higher.
- **npm** or **pnpm**.

### Installation

You can install Scoder globally via npm:

```bash
npm install -g @nbhson/scoder
```

*Note: Ensure you have your LLM API keys (e.g., `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) set in your environment variables.*

### Quick Start

Navigate to your project directory and run:

```bash
scoder
```

Once the agent starts, simply describe your task:
> *"Add a new endpoint to the Express server that returns the current system time."*

---

## ⚙️ Configuration

Scoder is highly configurable via environment variables and configuration files.

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | `sk-ant-...` |
| `OPENAI_API_KEY` | Your OpenAI API key | `sk-...` |
| `SCODER_POLICY` | Default permission policy | `allow-all`, `ask-always` |

### Advanced Configuration

Scoder supports custom providers and complex permission rules. You can define fine-grained access control using JSON policy files to restrict the agent's ability to read/write specific directories or execute certain shell commands.

---

## 🛠️ Development

If you want to contribute to Scoder or run it from source:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/nbhson/app-scoder-agent.git
   cd app-scoder-agent
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```

4. **Run in development mode:**
   ```bash
   npm run dev
   ```

5. **Run tests:**
   ```bash
   npm test
   ```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

Built with ❤️ by [nbhson](https://github.com/nbhson)
