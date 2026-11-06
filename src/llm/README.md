# llm/ — LLM protocol & providers

**Responsibility:** chat protocol + OpenAI-compatible client (`llm.ts`),
Anthropic provider (`provider-anthropic.ts`), provider registry/runtime
(`provider-registry.ts`), model catalog (`model-catalog.ts`), retry
(`retry.ts`).

**Public API:** direct imports from this folder.

**Anti-patterns:** changing event/stream semantics; unbounded retries.
