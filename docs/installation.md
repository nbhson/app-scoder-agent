# Installation

## Requirements

- **Node.js**: v20 or higher
- **npm**, **pnpm**, or **yarn**

## Install from npm (Recommended)

```bash
npm install -g s-app-scoder-agent
```

## Install from GitHub

```bash
npm install -g github:nbhson/app-scoder-agent
```

## Install from local clone

```bash
git clone https://github.com/nbhson/app-scoder-agent.git
cd app-scoder-agent
npm install
npm run build
npm install -g .
# Hoặc: npm link
```

## Try without installing

```bash
npx s-app-scoder-agent "your task here"
# Hoặc
npx github:nbhson/app-scoder-agent "your task here"
```

## Upgrade

```bash
# Từ npm
npm update -g s-app-scoder-agent

# Từ GitHub
git pull && npm install && npm run build && npm install -g .
```

## Verify installation

```bash
scoder --version
```
