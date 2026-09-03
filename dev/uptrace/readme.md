# Uptrace local dev

## Run

```
./up.sh
```

UI: http://localhost:14318

## Dashboards

Import `dashboard-foundation.yaml`:

1. Open Uptrace UI
2. Project -> Dashboards -> New -> Import YAML
3. Paste/upload `dashboard-foundation.yaml`

Contains charts for:
- sessions / workspaces by kind
- find / tx in-flight grouped by domain (gauges)
- db.query.duration histograms: p50/p95/p99 by op, by domain, slow ops table
- request / loadModel / startWorkspace / addSession in-flight
- msg-receive-delta / msg-send-delta / receive-data
- clientSendBytes

Metrics `domainRequest` / `fulltext` removed from dashboard - they are created lazily on first call and may not exist at import time. Add them back manually once they have been emitted at least once.
