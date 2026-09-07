# Benchmark & Stress Testing Plan

## Goal

Determine server capacity limits and identify bottlenecks under realistic and extreme load.
All tests accept `--accountUrl` (or env `HULY_URL`) to target any environment.

## Architecture

```
dev/benchmarks/
  plan.md              # This file
  package.json         # Standalone package (ts-node, no pnpm build needed)
  tsconfig.json
  src/
    config.ts              # CLI args parsing, env vars
    helpers.ts             # Stats collection, reporting, project/issue factories
    profiler.ts            # CPU profiling start/stop via transactor HTTP API
    workspace-manager.ts   # Multi-workspace creation via account API
    run.ts                 # CLI entry point: select and run scenarios
    scenarios/
      01-workspace-setup.ts        # Create projects in a single workspace
      02-rest-throughput.ts         # REST API throughput limits (ramp up clients)
      03-multi-workspace.ts         # Multi-workspace simultaneous stress
      04-ws-throughput.ts           # WebSocket throughput limits
      05-concurrent-clients.ts      # Max simultaneous connections
      06-mixed-workload.ts          # Realistic mixed read/write
      07-spike.ts                   # Sudden burst load
      08-endurance.ts               # Long-running sustained load
```

## CLI Usage

```bash
cd dev/benchmarks
npx ts-node src/run.ts --url http://localhost:8083 \
  --email user1 --password 1234 \
  --workspace bench-ws \
  --scenario all
```

Individual scenarios:
```bash
npx ts-node src/run.ts --url http://localhost:8087 --scenario rest-throughput
npx ts-node src/run.ts --url http://localhost:8087 --scenario multi-workspace --workspaces 10 --clients 5
npx ts-node src/run.ts --url http://localhost:8087 --scenario spike --clients 100 --duration 30
```

With CPU profiling (requires `--transactor-url`):
```bash
npx ts-node src/run.ts --url http://localhost:8087 --scenario rest-throughput \
  --profile true --transactor-url http://localhost:3332 --profile-dir ./profiles
```

Multi-workspace with explicit workspace list:
```bash
npx ts-node src/run.ts --url http://localhost:8087 --scenario multi-workspace \
  --workspace-list bench-ws-000,bench-ws-001,bench-ws-002 --clients 10
```

## Scenarios

### 1. Workspace Setup (`01-workspace-setup.ts`)

Prepare test data. Create N workspaces with M projects each.

**Parameters:**
- `--workspaces N` (default: 10)
- `--projects-per-ws M` (default: 50)

**What it measures:**
- Project creation throughput
- Account service response time under batch creation

**Expected output:**
- Projects/sec
- Latency histogram

---

### 2. REST API Throughput (`02-rest-throughput.ts`)

Measure maximum REST request rate with increasing client count.

**Parameters:**
- `--clients` 1, 5, 10, 20, 50, 100 (ramp up)
- `--duration` seconds per step (default: 30)
- `--operations` findAll, createDoc, tx, mixed

**Sub-tests:**

| Test | Description |
|------|-------------|
| findAll-spaces | GET /api/v1/find-all - read all spaces |
| findAll-issues | GET /api/v1/find-all - read issues in a project |
| create-issue | POST /api/v1/addCollection - create single issue |
| update-issue | POST /api/v1/update - update issue fields |
| mixed-rw | 80% reads / 20% writes |

**What it measures:**
- Requests/sec at each client level
- Latency percentiles (p50, p95, p99, max)
- Error rate and error types
- At what client count does latency degrade >2x
- At what client count do errors start appearing

**Expected output per step:**
```
[REST findAll-spaces] clients=20 duration=30s
  requests: 9420  errors: 0  rate: 314 req/s
  latency: p50=62ms p95=89ms p99=124ms max=210ms
```

---

### 3. Multi-Workspace Stress (`03-multi-workspace.ts`) ✅

Simultaneous access to multiple workspaces — tests transactor isolation and resource sharing.

**Parameters:**
- `--workspaces N` (default: 10) — number of workspaces to create
- `--clients` (first value used as clients-per-workspace, default: 5)
- `--duration` seconds (default: 15)
- `--region` (optional) — target region for workspace creation
- `--workspace-list ws1,ws2,...` (optional) — connect to existing workspaces instead of creating new ones

**Protocol:**
1. Create N workspaces via account API (or connect to existing ones via `--workspace-list`)
2. For each workspace: create a test project, seed data
3. Launch `clients-per-workspace` REST clients per workspace, all simultaneously
4. Each client runs mixed workload: 40% findAll-spaces, 30% findAll-issues, 25% create-issue, 5% update-issue
5. Collect per-workspace and aggregate statistics

**What it measures:**
- Does load on workspace A degrade latency for workspace B?
- Total throughput across all workspaces
- Per-workspace error distribution (are some workspaces starved?)
- Connection/token management overhead for many workspaces

**Expected output:**
```
[multi-workspace] 10 ws x 5 clients = 50 total
  bench-ws-000:  62 ops/s avg=78ms p95=120ms errors=0
  bench-ws-001:  58 ops/s avg=85ms p95=130ms errors=0
  ...
  total ops/s: 590  total errors: 0
```

---

### 4. WebSocket Throughput (`04-ws-throughput.ts`)

Same as REST but over persistent WebSocket connections using `connect()` from `@hcengineering/api-client`.

**Parameters:**
- `--clients` 1, 5, 10, 20, 50, 100
- `--duration` seconds per step

**Sub-tests:**

| Test | Description |
|------|-------------|
| ws-findAll | findAll via WebSocket protocol |
| ws-create-issue | addCollection via WebSocket |
| ws-mixed | 80% reads / 20% writes |
| ws-subscribe | Open live queries, measure push latency |

**What it measures:**
- Operations/sec at each level
- Connection establishment time
- Message latency (send -> receive)
- Memory pressure (backpressure events)
- Push notification delay (create doc on client A, measure time until client B sees it)

---

### 5. Concurrent Clients (`05-concurrent-clients.ts`)

Find the maximum number of simultaneous connections the server can handle.

**Parameters:**
- `--max-clients` (default: 500)
- `--ramp-step` (default: 50)
- `--ramp-interval` seconds (default: 10)

**Protocol:**
1. Open N REST sessions (unique tokens via same user)
2. Open N WebSocket connections
3. Each client does 1 findAll per second (heartbeat)
4. Ramp N from 50 to max-clients in steps
5. At each step measure: success rate, latency, connection errors

**What it measures:**
- Max REST clients before errors/timeouts
- Max WebSocket clients before connection refused
- Server memory/CPU behavior at each level (correlate with docker stats)
- Session cache eviction behavior (RPC session map in rpc.ts)

**Expected output:**
```
[concurrent-clients]
  REST:  50 ok | 100 ok | 200 ok | 300 ok | 400 errors=12 | 500 errors=89
  WS:    50 ok | 100 ok | 200 ok | 250 refused | ...
  max stable REST: 300
  max stable WS: 200
```

---

### 6. Mixed Workload (`06-mixed-workload.ts`)

Simulate realistic multi-user activity across multiple workspaces.

**Parameters:**
- `--workspaces` (default: 10)
- `--clients-per-ws` (default: 5)
- `--duration` seconds (default: 60)

**Activity per client (loop):**
1. findAll issues in their project (read)
2. Create a new issue (write)
3. Update a random existing issue (write)
4. findAll spaces (read)
5. Sleep 100-500ms (simulate think time)

**What it measures:**
- Operations/sec across all clients
- Per-workspace latency (do some workspaces starve?)
- Cross-workspace interference
- Error rate over time (does it degrade?)

---

### 7. Spike Test (`07-spike.ts`)

Sudden burst of connections and requests.

**Parameters:**
- `--idle-clients` (default: 20, maintained before spike)
- `--spike-clients` (default: 200, opened simultaneously)
- `--spike-duration` seconds (default: 10)
- `--cooldown` seconds (default: 30)

**Protocol:**
1. Establish idle-clients, run steady state for 10s, record baseline latency
2. Open spike-clients simultaneously, all doing findAll in tight loop
3. After spike-duration, close spike clients
4. Continue measuring idle clients for cooldown period
5. Report: how long until latency returns to baseline

**What it measures:**
- Latency impact on existing clients during spike
- Error rate during spike
- Recovery time after spike
- Rate limiter effectiveness (429 responses)

---

### 8. Endurance Test (`08-endurance.ts`)

Long-running sustained load to find memory leaks, connection pool exhaustion, etc.

**Parameters:**
- `--clients` (default: 20)
- `--duration` minutes (default: 30)
- `--report-interval` seconds (default: 60)

**What it measures:**
- Latency trend over time (increasing = leak)
- Error rate trend
- Memory usage trend (docker stats)
- Connection count stability

---

## CPU Profiling Integration

The benchmark suite can automatically capture CPU profiles from the transactor during test runs.

**How it works:**
1. Before running scenarios, the runner sends `PUT /api/v1/manage?operation=profile-start` to the transactor
2. After all scenarios complete, it sends `PUT /api/v1/manage?operation=profile-stop` and saves the `.cpuprofile` file
3. The profile can be opened in Chrome DevTools (Performance tab) or VS Code for flame graph analysis

**CLI flags:**
- `--profile true` — enable profiling
- `--transactor-url http://localhost:3332` — transactor HTTP endpoint (required for profiling)
- `--profile-dir ./profiles` — directory to save profile files (default: `./profiles`)

**Typical workflow:**
```bash
# Run stress test with profiling
npx ts-node src/run.ts --url http://localhost:8087 \
  --scenario rest-throughput --clients 1,10,20,50 --duration 30 \
  --profile true --transactor-url http://localhost:3332

# Open the saved .cpuprofile in Chrome DevTools
```

**Environment-specific transactor URLs:**
| Environment | Transactor URL |
|-------------|---------------|
| dev (postgres) | `http://localhost:3332` |
| ws-tests mongo | `http://localhost:3334` |
| ws-tests cockroach (europe) | `http://localhost:3335` |

---

## Metrics Collection

Every scenario collects:
- **Latency histogram**: min, p50, p95, p99, max
- **Throughput**: operations/sec (real wall clock)
- **Errors**: count by error type/message
- **Timeline**: metrics per reporting interval for trend analysis

Output format: console table + optional JSON file (`--output results.json`).

## Environment Requirements

- Docker containers running (via `ws-tests/prepare.sh` or `dev/docker-compose.yaml`)
- At least one workspace created
- For WebSocket tests: `ws` npm package (already in deps)

## Key Questions to Answer

1. **REST capacity**: How many concurrent REST clients can one transactor handle before p95 > 500ms?
2. **WebSocket capacity**: How many persistent WS connections before connection refused?
3. **Write throughput**: Max issues/sec on cockroach (transactor-europe) vs mongo?
4. **Read/write interference**: Does heavy writing degrade read latency? By how much?
5. **Multi-workspace**: Does load on workspace A affect workspace B on the same transactor?
6. **Recovery**: After overload, how fast does the server recover?
7. **Rate limiter**: Does the 25000/1000ms rate limit actually protect the server?
8. **Session management**: Does the RPC session cache (rpc.ts:149) leak under churn?

## Baseline Reference (from ws-tests stress results)

| Metric | Mongo (transactor) | Cockroach (transactor-europe) |
|--------|-------------------|-------------------------------|
| Project create | 13 ops/s | 12 ops/s |
| Issue create (20 clients) | 235 iss/s | 154 iss/s |
| findAll under write load | 94 ops/s | 67 ops/s |
| Spike findAll (20 clients) | 317 req/s | 160 req/s |
| Write latency p95 | 109ms | 157ms |
| Read latency p95 | 13ms | 20ms |
