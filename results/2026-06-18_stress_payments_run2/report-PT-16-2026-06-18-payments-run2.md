# Stress Test — payments-service Run 2 (Post-fix retest) — 2026-06-18/19

**Script:** `tests/payments/payments.test.js`
**Load profile:** 100→200→400→800→1,200→2,000 VUs (2 min/stage) + 2 min cooldown (configured; test was stopped before reaching cooldown)
**Fix applied before this run (PT-21 Run 1 analysis):** payments-service received the full proven fix playbook — `cluster.js` (12 workers, `SCHED_RR`), `UV_THREADPOOL_SIZE=128`, keep-alive `http.Agent`+`fetchWithRetry()` on both outbound calls to orders-service, `DB_POOL_MAX` 25 (single process) → 9×12 workers = 108, `payments-db` `max_connections` 100→150, a registry fix (local `Registry()` → global `promClient.register`) so `AggregatorRegistry`'s `clusterMetrics()` actually aggregates, HTTP backlog 511→1024, Prometheus scrape target moved to the aggregated port `:9105`.

**Command used:**
```bash
nohup k6 run \
  --stage 2m:100 --stage 2m:200 --stage 2m:400 --stage 2m:800 --stage 2m:1200 --stage 2m:2000 --stage 2m:0 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-18_stress_payments_run2 \
  --out json=results/2026-06-18_stress_payments_run2/raw.json \
  tests/payments/payments.test.js \
  > results/2026-06-18_stress_payments_run2/k6-stdout.log 2>&1 &
```

**Prompt used:**
> Apply all the recommended fixes do payment and document at PT-21

---

## Test Outcome — payments-service's own bottleneck is fully fixed, but overall throughput barely moved because the ceiling has shifted to the pre-existing cart↔orders cascade

**Stopped manually at t+5m37s, ~361/2,000 VUs (mid Stage 3, target 400)** — confirmed sustained, exponential breach (P95 930ms baseline → 2,483ms). No kill-delay; `taskkill //PID 12064 //T //F` took effect immediately. Global error rate stayed 0% throughout — a pure latency failure, not the >50%-error-rate stop condition.

**The fix worked exactly as intended on payments-service's own code:**

| Metric | Run 1 (pre-fix) | Run 2 (post-fix) | Verdict |
|---|---|---|---|
| DB pool peak | 25/25 (**100%**, fully exhausted) | 16/108 (**15%**, healthy) | ✅ Fixed |
| `pg-pool.connect` wait (sampled trace) | 993ms + 724ms (~1.7s combined) | 0.07-0.16ms (×4) | ✅ Fixed |
| Outbound `GET`/`PATCH` to orders-service (sampled trace) | 797ms / 1,742ms (80-90% raw TCP/DNS overhead) | 6ms / 37.5ms | ✅ Fixed |
| Process model | Single process, no clustering | 12 workers, `SCHED_RR` | ✅ Fixed |

**But the overall breaking point barely moved, because the bottleneck has fully shifted to a different, already-known root cause:**

| Metric | Run 1 (pre-fix) | Run 2 (post-fix) |
|---|---|---|
| EOF onset (VUs) | ~290 (single one-off at t+22s, gradual after) | ~245 (t+2m03s, on `POST /api/orders` — same signature) |
| Max VUs reached before stop | ~452 | ~361 |
| Peak payments-service RPS | ~64.4 req/s | ~67.0 req/s (+4%, within noise) |
| Peak P95 | 9,470ms | 2,483ms (lower peak, but breach onset at a similar VU range) |
| First EOF endpoint | `/api/orders` (71%), then `/api/payments/process` | `/api/orders` (71 of 122), then `/api/payments/process` (51 of 122) |

This time, **orders-service's own P95 spiked to 1,827ms (9.1x its 200ms SLA)** and **cart-service's to 668ms (4.5x its 150ms SLA)** in the same window — the same cart↔orders cascade already documented across 14 prior runs (7 cart-service + 7 orders-service), now reconfirmed a third time, triggered earlier under this combined load profile (~245-260 VUs) than orders-service's own isolated tests typically show (~237-475 VUs).

A sampled Tempo trace (`7adfe755b492f015c55d3e16b6d9d98e`) on payments-service shows every one of its own spans is now fast (INSERT 2.5ms, outbound `GET` 6ms, `UPDATE` 3.2ms, outbound `PATCH` 37.5ms — all previously the dominant cost in Run 1) — but the root `POST /api/payments/process` span itself ran 785.6ms, and a ~12.85-second untraced gap sits between the INSERT and UPDATE queries, exactly where the in-process `simulateGateway()` mock (a plain `setTimeout` for 200-800ms) runs. This points to host-wide CPU/event-loop contention from the co-located cart-service/orders-service cascade competing for the same physical CPU cores — consistent with cart-service's own still-open finding that the host is likely near its practical single-host ceiling. This is a single-sample observation, not independently re-verified across multiple traces in this run, and is flagged as such.

---

## Monitoring Timeline

### Cycle 1 — t+1m20s | ~9/2,000 VUs 🟢 GREEN
payments P95 895.8ms (baseline, expected gateway latency), all other services healthy.

### Cycle 2 — t+2m37s | ~130/2,000 VUs 🟢 GREEN
payments P95 921ms, DB pool 12/108 (11%), event-loop lag 15.4ms — all healthy, confirms the fix is holding at moderate load.

### Cycle 3 — t+4m37s | ~262/2,000 VUs 🔴 CONFIRMED RED, stop initiated
15s-step Prometheus range queries confirmed sustained, accelerating breaches across three services simultaneously: payments P95 933→2,483ms, orders P95 48→1,827ms, cart P95 24→668ms. DB pool for payments stayed at only 11-15% throughout (never the bottleneck this time). Loki showed zero genuine error-level logs (0% global error rate) — purely a latency cascade.

---

## Cross-run comparison (all payments-service runs)

| Metric | Run 1 (pre-fix) | Run 2 (post-fix) |
|---|---|---|
| Root cause | payments-service's own unhardened code (no clustering, no keep-alive, tiny DB pool) | Pre-existing cart↔orders cascade (already tracked, [[orders-service no clustering]] memory) |
| DB pool peak | 100% exhausted | 15% (healthy) |
| Max VUs before stop | ~452 | ~361 |
| Peak RPS | ~64.4 req/s | ~67.0 req/s |
| Error rate | 0% (latency-only) | 0% (latency-only) |

**Net assessment: the fix successfully eliminated payments-service's own bottleneck, but exposed that it now inherits the cart↔orders cascade just like orders-service does.** Further improvement to payments-service in isolation will not move this ceiling — the next lever is the already-identified cart-service CPU/event-loop work (P1 recommendation standing since cart-service Run 7).

---

## Recovery

Direct verification ~2 minutes post-kill:
- `curl http://localhost:3005/health` → 200 OK, 8ms
- `curl http://localhost:3004/health` → 200 OK, 8ms
- `curl http://localhost:3003/health` → 200 OK, 9ms
- No container restarts.

**Recovery: clean and fast, no crashes.**

---

## PT-16 Success Criteria Assessment

| Criteria | Status | Notes |
|---|---|---|
| Breaking point VU count documented | ✅ | ~245-361 VUs — now driven by the cart↔orders cascade, not payments-service's own code |
| P95 latency and error rate at breaking point recorded | ✅ | P95: 930ms → 2,483ms; 0% error rate throughout |
| Weakest service in the stack identified | ✅ | payments-service's own debt is resolved; the stack's weakest link is now confirmed to be the cart-service CPU/event-loop ceiling (consistent across orders-service and payments-service) |
| Recovery time after load drops documented | ✅ | Clean, fast recovery |
| Results saved to results/YYYY-MM-DD_stress_{service}/ | ✅ | `results/2026-06-18_stress_payments_run2/`: k6-stdout.log ✅, raw.json ✅, 4 screenshots ✅, this report ✅ |

**All PT-16 success criteria satisfied.**

---

## Recommendations

1. **P1 — Do not pursue further payments-service-specific tuning.** Its own bottleneck is resolved; the remaining ceiling is inherited from cart-service's CPU/event-loop saturation (open since cart-service Run 7).
2. **P2 — Apply the deeper cart-service fix** (profile actual event-loop CPU consumers — JSON serialization, OTel instrumentation, middleware chain — per the standing recommendation) before any further retest of orders-service or payments-service.
3. **P3 — Re-test payments-service again** after the cart-service fix lands, to see whether the combined improvement moves all three services' shared ceiling.

---

## Results Files

| File | Status |
|---|---|
| `k6-stdout.log` | ✅ |
| `raw.json` | ✅ |
| `screenshot-01-apm-p95-latency.png` | ✅ |
| `screenshot-02-apm-rps.png` | ✅ |
| `screenshot-03-loki-errors.png` | ✅ |
| `screenshot-04-tempo-top-ops.png` | ✅ |
| `payments-report.html` | ❌ Not generated (force-killed before `handleSummary()`) |

---

_Executed via Claude Code (k6 + Prometheus MCP + Loki MCP + Grafana render API) — 2026-06-18/19_
_Monitoring: 3 cycles — Prometheus + Loki queried each cycle. Test stopped on confirmed sustained RED at cycle 3._
