```mermaid
flowchart TD
    A[Start] -->|user input| B{Valid?}
    B -->|yes| C[Process data]
    B -->|no| D[Show error]
    C --> E((Done))
    D --> A
```
