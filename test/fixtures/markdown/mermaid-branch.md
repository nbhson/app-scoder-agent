```mermaid
flowchart LR
  subgraph Pipeline
    A[Parser] --> B[Analyzer]
  end
  B -.-> C{OK?}
  C ==>|yes| D[Emit]
  C -->|no| E[Report]
  E --> B
```
