# Scoder Configuration Example

This file provides an example of all the configuration options supported by the `scoder` agent. You can use these settings in your configuration file (e.g., `.scoder/config.json` or via environment variables).

## 1. Core LLM Settings

| Property | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `baseUrl` | `string` | OpenAI-compatible base URL. | `https://api.openai.com/v1` |
| `apiKey` | `string` | Your API key for the provider. | `sk-...` |
| `model` | `string` | The model ID to use. | `gpt-4o` or `claude-3-5-sonnet-20240620` |
| `provider` | `"openai" \| "anthropic"` | Backend provider type. | `"openai"` |

## 2. Agent Behavior

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `workdir` | `string` | `.` | The directory the agent operates on. |
| `buildCmd` | `string \| null` | `null` | The command used as the stop condition. |
| `maxSteps` | `number` | - | Max autonomous loop iterations. |
| `temperature` | `number` | - | LLM temperature setting. |
| `maxTokens` | `number` | - | Max tokens for chat completions. |
| `yes` | `boolean` | - | If `true`, fails instead of prompting for input. |
| `snapshots` | `boolean` | - | Enable/disable Git shadow snapshots. |
| `reasoning` | `"off" \| "on"` | `"off"` | Enable/disable reasoning/thinking capabilities. |
| `allowSubagents`| `boolean` | - | Whether the agent can spawn subagents. |
| `formatter` | `boolean \| string` | - | Post-edit formatter setting. |
| `noSave` | `boolean` | - | Disable session auto-save. |

## 3. Advanced Settings

### Guardrails (`guardrails`)
Controls safety and loop prevention.
- `textOnlyStreakLimit`: Limit for consecutive text-only responses.
- `doomLoopRepeats`: Limit for repeated actions.
- `wrapUpStepsBeforeEnd`: Steps before wrap-up reminder.
- `tokenBudget`: Token budget for guardrails.

### Sandbox (`sandbox`)
- `mode`: `"readonly"`, `"workspace-write"`, or `"off"`.
- `wrapper`: `"sandbox-exec"`, `"bwrap"`, or `"docker"`.

### Runtime Limits (`limits`)
- `requestTimeoutMs`: LLM request timeout in ms.
- `maxOutputChars`: Max characters tool output into conversation.
- `toolConcurrency`: Parallel tool-call concurrency.
- `renderCap`: TUI render cap (number of items).

## 4. Example JSON Configuration

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "your-api-key-here",
  "model": "gpt-4o",
  "provider": "openai",
  "workdir": "./my-project",
  "buildCmd": "npm run build",
  "maxSteps": 50,
  "temperature": 0.7,
  "reasoning": "on",
  "allowSubagents": true,
  "limits": {
    "requestTimeoutMs": 60000,
    "toolConcurrency": 5
  }
}
```
