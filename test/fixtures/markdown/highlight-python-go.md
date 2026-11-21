# Python

```python
# count matching lines
import re
from typing import Iterable


def lines(text: str, pattern: str) -> list[str]:
    """Return all matching lines."""
    rx = re.compile(pattern)
    return [ln for ln in text.splitlines() if rx.search(ln)]  # list comprehension


class Index:
    def __init__(self):
        self.entries = {}

    def add(self, key: str, value=None) -> bool:
        if key in self.entries:
            return False
        self.entries[key] = value
        return True
```

# Go

```go
package store

import (
	"errors"
	"sync"
)

// Store is safe for concurrent use.
type Store struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func New() *Store {
	return &Store{data: make(map[string][]byte)}
}

func (s *Store) Get(key string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.data[key]
	if !ok {
		return nil, errors.New("miss: " + key)
	}
	return v, nil
}
```
