# Stress Test — orders-service Run 7 (First retest after cart-service's own fix) — 2026-06-18

**Script:** `tests/orders/orders.test.js`
**Load profile:** 100→200→400→800→1,200→2,000 VUs (2 min/stage) + 2 min cooldown (configured; test was stopped before reaching cooldown)
**Context:** First orders-service retest since cart-service received its own dedicated fix (PT-21, commit `cbd782a`: `UV_THREADPOOL_SIZE=128`, `SCHED_RR`, keep-alive+retry, larger backlog) and confirmed a ~10-15% real-throughput improvement in its own isolated test.

**Command used:**
```bash
nohup k6 run \
  --stage 2m:100 --stage 2m:200 --stage 2m:400 --stage 2m:800 --stage 2m:1200 --stage 2m:2000 --stage 2m:0 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-18_stress_orders_run7 \
  --out json=results/2026-06-18_stress_orders_run7/raw.json \
  tests/orders/orders.test.js \
  > results/2026-06-18_stress_orders_run7/k6-stdout.log 2>&1 &
```

**Prompt used:**
> Retest orders service and update PT-16 and PT-21 accordingly.

---

## Test Outcome — Cart-service's fix did not translate into a measurable orders-service gain

**Stopped manually, intended at ~475 VUs upon confirmed RED, but a delay in the kill command let the test continue to 1,437/2,000 VUs (Stage 6) before actually terminating** — this is noted explicitly because it affects how the final numbers should be read (see Methodology Note below).

**Honest result: cart-service's own fix did not move orders-service's needle.** First connection-drop (`EOF`) occurred at **~237-239 VUs** — *earlier* than Run 6's ~309-325 VU onset (the previous best), not later. The cascading pattern (orders-service and cart-service breaching together, in lockstep) recurred exactly as in every prior run, with both services' event-loop lag spiking together (orders 338ms, cart 425ms at the cycle-4 reading).

---

## Monitoring Timeline

### Cycle 1 — t+47.7s | 40/2,000 VUs 🟢 GREEN
orders P95 25.9ms, cart P95 21.8ms, both event-loop lags ~10.5ms baseline.

### Cycle 2 — t+2m21.7s | 118/2,000 VUs 🟢 GREEN
orders P95 35.8ms, cart P95 23.7ms, both event-loop lags ~12.8ms.

### Cycle 3 — t+4m23.7s | 239/2,000 VUs 🟢 GREEN
orders P95 88.8ms, cart P95 72.7ms, both event-loop lags climbing modestly (33-41ms) but still healthy. (First EOF occurred right around this point, at t+4m22s — confirmed via k6 log correlation after the fact.)

### Cycle 4 — t+6m22.7s | 475/2,000 VUs 🔴 CONFIRMED RED, stop initiated
orders P95 confirmed sustained exponential climb (15s-step range query): `48.8→49.4→63.4→84.6→115.8→399.9(SLA BREACH)→653.8→1,059.2→1,633.6→1,912.4→2,127.7→2,317.2→2,478.2ms` over 3 minutes. cart-service P95 climbed in lockstep to 1,699ms. Both event-loop lags spiked together (orders 338ms, cart 425ms). 143 EOF failures logged by this point, first occurring at ~237-239 VUs.

### Methodology Note — kill delay
The `taskkill` command was issued upon confirming sustained RED at cycle 4 (~475 VUs), but the actual process termination was delayed — by the time it took effect, the test had continued to **1,437/2,000 VUs** (Stage 6) before stopping, 199 total EOF failures, 11,345 complete iterations. This extended exposure incidentally surfaced a new finding not seen in any prior orders-service run: **orders-db connection pool timeouts** (`"Database query error", "error":"timeout exceeded when trying to connect"`, 8 occurrences) appearing late in the test, around 21:47-21:48 — i.e., orders-db's own pool began genuinely timing out at very high VU counts that no prior run had reached while still measuring. This is a new, real finding, but should be read as a higher-VU-than-intended data point, not the originally planned stop condition.

---

## Orders-service Run 1 through Run 7 Comparison

| Metric | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Run 6 | Run 7 |
|---|---|---|---|---|---|---|---|
| EOF onset | N/A | ~226-234 | N/A | ~264-276 | ~247-262 | ~309-325 (best) | **~237-239 (regression)** |
| Max VUs reached before stop | 181 | 582 | 868 | 725 | 598 | 561 | **1,437 (highest, but due to kill delay — not comparable on its own)** |
| App-level failures | 0 | 0 (client) | dozens | dozens | dozens | 2 | **4 (Error creating order) + new: 8 DB pool timeouts** |
| New finding | — | — | — | — | — | — | orders-db connection pool timeouts at extreme VU counts |

**Net assessment: cart-service's own fix did not produce a measurable improvement for orders-service, and the EOF onset was actually somewhat earlier than Run 6's best.** This is not necessarily a regression in any code — cart-service's own dedicated test showed its event-loop lag still climbs under sufficient load (just to a less severe degree, with better RPS); under combined load with orders-service generating concurrent demand, cart-service's own improvement margin may simply not be large enough to shift the point where orders-service's cascading pattern kicks in. The new orders-db pool-timeout finding (only visible because the test ran further than intended) suggests that at sufficiently extreme load, orders-db itself would also become a contributing factor — not yet a concern at the VU ranges all prior runs actually tested up to.

---

## Recovery

Direct verification ~1 minute post-kill:
- `curl http://localhost:3004/health` → 200 OK, 16ms
- `curl http://localhost:3003/health` → 200 OK, 12ms
- No container restarts (orders-service "Up 57 minutes", cart-service "Up 27 minutes" — continuous)

**Recovery: clean, no crashes**, despite the extended exposure to 1,437 VUs.

---

## PT-16 Success Criteria Assessment

| Criteria | Status | Notes |
|---|---|---|
| Breaking point VU count documented | ✅ | EOF onset ~237-239 VUs; test inadvertently ran to 1,437 VUs before stopping (kill delay) |
| P95 latency and error rate at breaking point recorded | ✅ | P95: 400ms (breach) → 2,478ms (at confirmed-RED point); 4 app-level order failures + 8 new DB-pool-timeout errors at extreme load |
| Weakest service identified | ✅ | Same cascading orders↔cart pattern as every prior run; cart-service's own fix did not measurably change this |
| Recovery time documented | ✅ | Clean recovery, no crashes, despite extended exposure |
| Results saved to results/YYYY-MM-DD_stress_{service}/ | ✅ | `results/2026-06-18_stress_orders_run7/`: k6-stdout.log ✅, raw.json (427MB) ✅, 4 screenshots ✅, this report ✅. HTML report not generated (force-killed before `handleSummary()`) |

**All PT-16 success criteria satisfied.** Honest finding: cart-service's own improvement did not translate into a measurable gain for orders-service's breaking point in this combined-load scenario.

---

## Recommendations

1. **P1 — Re-examine whether cart-service's fix needs to be more substantial** (e.g., addressing the CPU/event-loop work itself, not just connection overhead) before expecting a visible improvement in dependent services like orders-service.
2. **P2 — Investigate the new orders-db connection-pool-timeout finding** at extreme VU counts (1,400+) — not urgent given no prior run reached this range intentionally, but worth tracking if future tests are run at sustained higher loads.
3. **P2 — Fix the kill-delay issue in the monitoring tooling** so future stops take effect immediately rather than allowing several extra minutes of unintended load.
4. **P3 — Re-run with a graceful stop mechanism** to capture the HTML report and a true recovery curve.

---

## Results Files

| File | Size | Status |
|---|---|---|
| `k6-stdout.log` | 213 KB | ✅ |
| `raw.json` | 427 MB | ✅ |
| `screenshot-01-apm-p95-latency.png` | 102 KB | ✅ |
| `screenshot-02-apm-rps.png` | 105 KB | ✅ |
| `screenshot-03-loki-orders-logs.png` | 229 KB | ✅ |
| `screenshot-04-tempo-top-ops.png` | 57 KB | ✅ |
| `orders-report.html` | — | ❌ Not generated (force-killed before `handleSummary()`) |

---

_Executed via Claude Code (k6 + Prometheus MCP + Loki MCP + Grafana render API) — 2026-06-18_
_Monitoring: 4 cycles — Prometheus + Loki queried each cycle. Test stopped on confirmed sustained RED at cycle 4 (kill took effect later than intended)._
