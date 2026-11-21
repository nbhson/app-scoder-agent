# SQL & Bash & YAML & JSON

```sql
/* find the top spenders */
SELECT u.name, SUM(o.total) AS spend
FROM users u
  INNER JOIN orders o ON o.user_id = u.id
WHERE o.created_at >= '2026-01-01'
GROUP BY u.name
HAVING SUM(o.total) > 1000
ORDER BY spend DESC
LIMIT 10;
```

```bash
#!/usr/bin/env bash
# deploy when tests pass
set -euo pipefail
if npm test --silent; then
  echo "deploying ${ENV:-prod}"  # parameter expansion
  kubectl rollout status deploy/api || exit 1
fi
```

```yaml
service:
  name: api        # the public name
  replicas: 3
  enabled: true
  env:
    - KEY: "value with #not-a-comment"
    - OTHER: 'single'
  tags: [a, b, null]
```

```json
{ "ok": true, "count": 42, "name": "scoder", "nested": { "v": null } }
```

```rust
fn main() {
    let v: Vec<i32> = (1..=5).map(|x| x * x).collect();
    match v.first() {
        Some(n) => println!("{n}"),
        None => println!("empty"),
    }
}
```
