# session/ — durable session state

**Responsibility:** event-sourced session store (`session.ts`), JSONL event log
(`logger.ts`), steering inbox (`steering.ts`), cost aggregation (`cost.ts`).

**Anti-patterns:** changing the on-disk event/snapshot JSON shapes — sessions
from older versions must keep loading.
