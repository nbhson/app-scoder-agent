# config/ — configuration

**Responsibility:** `AgentConfig` shape and load precedence
(defaults < `.scoderrc.json` < env < CLI flags), rc file read/write.

**Public API:** `loadConfig`, `loadRcFile`, types — import from `./config.js`.

**Allowed imports:** `security/`, `llm/` (provider resolution), `io/reporter`,
`mcp` types, `shared/`.

**Anti-patterns:** changing precedence order or accepted keys silently.
