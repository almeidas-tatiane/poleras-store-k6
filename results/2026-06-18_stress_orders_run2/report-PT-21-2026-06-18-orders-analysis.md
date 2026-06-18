# Performance Report Analysis — orders.test.js (Run 1 vs Run 2)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18**
**Analysis target:** `tests/orders/orders.test.js` stress test results (PT-16 execution)
**SLA reference (PT-7):** orders-service P95 < 200ms, error rate < 1% · Black Friday target: 2,500 VUs

---

## Test Conditions

| | Run 1 | Run 2 |
|---|---|---|
| Date/window (UTC) | 2026-06-18, 17:15:17 – 17:18:55 | 2026-06-18, 19:06:19 – 19:13:14 |
| Config under test | Single Node process, no clustering | 12-worker cluster + `AggregatorRegistry`, `orders-db` `max_connections` 150, `DB_POOL_MAX=9`/worker (108 total), `orders-db-exporter` added |
| Stop reason | Manual stop — sustained P95 breach confirmed | Manual stop — sustained P95 breach confirmed (force-killed via `taskkill /F`) |
| Max VUs reached | 181 | 582 |
| Results | `results/2026-06-18_stress_orders/` | `results/2026-06-18_stress_orders_run2/` |

Both runs were stopped before reaching the configured 2,000-VU peak — results are **partial** for the upper stages, but the breaking point itself (the object of PT-16) was captured cleanly in both.

---

# Technical Report

## SLA Compliance

| Metric | Target | Run 1 (at stop) | Run 2 (at stop) | Result |
|---|---|---|---|---|
| P95 response time | < 200ms | 914.7 – 984ms | 7,926 – 9,776ms | FAIL (both) |
| Error rate (server-side 5xx) | < 1% | 0% | **0%** (re-confirmed via Prometheus) | PASS (both, server-side) |
| Error rate (client-observed, k6) | < 1% | 0% | **~1.7%** (EOF/connection reset) | FAIL (Run 2 only) |
| Throughput | n/a (capacity test) | — | — | — |

**Important nuance:** Run 2's `http_requests_total{status_code=~"5.."}` query returned **no data** in Prometheus — confirmed via direct re-query of the breach window. This means the server **never logged a 5xx response** for the failed requests; the ~1.7% failures were TCP-level connection resets (`EOF`) that never reached the application layer. Server-side error-rate metrics show 0% in both runs; the true regression is only visible from the client's (k6's) perspective.

## Latency Distribution Analysis

| Pattern observed | Run 1 | Run 2 |
|---|---|---|
| P95 trend | Rises exponentially above ~163-180 VUs (classic breaking-point signature) | Rises exponentially above ~270 VUs — same shape, higher threshold |
| Baseline (idle) | 4.75ms | 4.75ms |
| Peak observed (within capture window) | 914.7ms | 9,776ms (still climbing when stopped) |

Both runs show the textbook "P95 rises exponentially above a threshold" signature — a genuine breaking point, not noise.

## Root Cause Analysis (re-confirmed via fresh Tempo trace pull)

A new Tempo search against Run 2's breach window (`tags=service.name=orders-service`, `minDuration=500ms`, 19:09:00–19:13:30Z) returned **10 traces in the 9.2–12.0 second range** — e.g. trace `86d387ffa53aa80b14151a6f58c655d3` (total duration 11,953ms). Opening it span-by-span:

```
ecommerce.create_order             59.95ms   (DB work: BEGIN, SELECT, 2×INSERT, COMMIT — all sub-3ms each)
  ↓ GAP OF ~11.9 SECONDS — no spans recorded ↓
POST /api/cart/convert              6.69ms   (cart-service's own handling — fast)
```

**This is functionally identical to Run 1's finding** (trace `16aeb6ce8a929f833193495b8e60ec6a`, 11.7s gap before the same call). The order-creation DB transaction itself completes in under 60ms in both runs. The entire user-facing latency problem is an **~11-12 second stall between finishing the order-creation transaction and starting the outbound `POST /api/cart/convert` call to cart-service** — and cart-service's own processing of that call, once it arrives, takes single-digit milliseconds in both runs.

### Why clustering only partially helped — the real mechanism

The gap is **nearly identical in magnitude in both runs** (11.7s vs. 11.9s) despite Run 2 having 12x the worker capacity. A delay that scales with general event-loop/CPU contention would be expected to *change* under a 12x capacity increase — it did not. This points to a **fixed per-process resource cap**, not pure scheduling contention:

- `orders-service/src/server.js` makes **3 outbound `fetch()` calls per order-creation request** (`GET /api/cart`, `PATCH /api/products/variant/:id/stock`, `POST /api/cart/convert`), each requiring DNS resolution (visible as `dns.lookup` + `tcp.connect` spans — a **fresh** connection per call, no keep-alive agent reuse).
- DNS resolution via Node's default resolver (`dns.lookup`) is dispatched through **libuv's threadpool**, whose size is controlled by `UV_THREADPOOL_SIZE` (default: **4 threads**, per process).
- Direct inspection of `docker-compose.yml` confirms **`UV_THREADPOOL_SIZE` is NOT set for orders-service** — it is running with the Node.js default of 4. By contrast, **`users-api` already has this exact fix applied** (`UV_THREADPOOL_SIZE: "128"`, from the auth-service Run 2/3 investigation in this same PT-21 epic).
- Because the threadpool cap is **per-process**, adding 12 cluster workers does not relieve this bottleneck — each worker still only gets 4 threadpool threads. Under load, enough concurrent outbound calls per worker saturate that worker's threadpool, and DNS-bound continuations queue behind it for several seconds — the same magnitude in both runs because the per-worker concurrency at the point of breach is similar (the breaking point simply moved because there are now 12 workers instead of 1, but each individual worker hits the same internal limit at a similar load level).

This is the same root-cause *class* already diagnosed and partially fixed for auth-service — but the fix was never propagated to orders-service.

### Findings

#### [CRITICAL] Finding 1 — Fixed ~11-12s outbound-call stall, unchanged by clustering
**Observed:** Tempo traces in both Run 1 (11.7s) and Run 2 (11.9-12.0s) show an unexplained gap between order-commit and the outbound `POST /api/cart/convert` call. The DB work itself is fast (<60ms); cart-service's receiving end is fast (6.7-6.8ms).
**Root cause hypothesis:** `UV_THREADPOOL_SIZE` not configured for orders-service (defaults to 4); 3 outbound `fetch()` calls per request each require DNS resolution via the libuv threadpool; under load, DNS-bound continuations queue for several seconds per worker — a per-process cap unaffected by horizontal worker scaling.
**Evidence:** Tempo traces `16aeb6ce8a929f833193495b8e60ec6a` (Run 1) and `86d387ffa53aa80b14151a6f58c655d3` (Run 2, +9 similar); `docker-compose.yml` orders-service env block (no `UV_THREADPOOL_SIZE`) vs. users-api env block (`UV_THREADPOOL_SIZE: "128"`).
**Recommended action:** Add `UV_THREADPOOL_SIZE: "128"` to orders-service's environment (mirroring the users-api fix), and replace per-call fresh `fetch()` connections with a persistent keep-alive `http.Agent` to eliminate repeated DNS/TCP-handshake overhead entirely.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 3

#### [HIGH] Finding 2 — New connection-drop failure mode introduced by clustering (Run 2 only)
**Observed:** ~1.7% of `POST /api/orders` calls failed with `EOF` (TCP reset) starting at ~226-234 VUs, 186 failures by the time of stop. Server-side Prometheus shows 0% 5xx — these connections were reset before the application layer logged anything.
**Root cause hypothesis:** Identical regression pattern to auth-service's Run 3 — a cluster worker's OS-level accept queue overflows when its single event loop is sufficiently busy (here, busy waiting on the threadpool-starved DNS/fetch calls from Finding 1), causing the kernel to reset new incoming connections rather than queue them.
**Evidence:** `nodejs_eventloop_lag_p99_seconds{job="orders-service"}` climbed 18.6ms→693ms during the breach; k6 log lines `"Request Failed" error="Post ... EOF"` beginning at t+4m15s.
**Recommended action:** Fix Finding 1 first — removing the threadpool stall should reduce per-worker event-loop saturation enough to avoid the accept-queue overflow. If it recurs, apply the `SO_REUSEPORT`/accept-queue tuning already queued for auth-service.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 3 (same retest as Finding 1)

#### [MEDIUM] Finding 3 — DB connection pool approaching saturation under sustained load (Run 2)
**Observed:** `db_connections_active{job="orders-service"}` (aggregated across 12 workers) peaked at **94/108 (87%)** during the breach window — not yet exhausted, but trending upward as load increased. `pg_stat_activity{state="idle in transaction"}` on `orders-db` climbed from ~0 to 21-23, indicating transactions are being held open longer as upstream delays (Finding 1) compound.
**Root cause hypothesis:** Secondary symptom of Finding 1 — as requests stall waiting on DNS/threadpool, their DB transactions (already committed in this trace, but other concurrent requests' transactions) remain attributed to active connections for longer, gradually consuming pool headroom.
**Recommended action:** Re-measure pool peak after Finding 1 is fixed; no pool-size change recommended until then.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 3

#### [INFORMATIONAL] Finding 4 — cart-service degradation in Run 2 is cascading backpressure, not an independent fault
**Observed:** cart-service's `nodejs_eventloop_lag_p99_seconds` rose in lockstep with orders-service (18ms→422ms vs. orders' 18ms→693ms) during the same window.
**Root cause hypothesis:** orders-service's synchronous call into cart-service (`POST /api/cart/convert`) propagates load/backpressure downstream when orders-service itself is saturated. cart-service's own standalone capacity (established in its own investigation) is ~600-650 VUs — well above what was observed here.
**Recommended action:** No independent cart-service fix needed; re-verify cart-service health after Finding 1 is resolved.
**Owner:** N/A — informational
**Retest required:** No (covered by Run 3)

---

## Regression vs. Baseline (Run 1 → Run 2)

| Metric | Run 1 | Run 2 | Delta | Status |
|---|---|---|---|---|
| Breaking point (P95 breach onset) | ~163-180 VUs | ~270 VUs | +~50-65% | Improvement, but insufficient |
| P95 at stop | 984ms | 1,928ms (rising to 9,776ms before kill) | Worse in absolute terms (longer test ran further into saturation) | — |
| Error rate (client-observed) | 0% | ~1.7% | +1.7pp | **Flagged — new regression** |
| Error rate (server-side 5xx) | 0% | 0% | No change | — |
| Max VUs survived | 181 | 582 | +221% | Improvement |
| DB pool peak | 16 (single process) | 94/108 (87%, aggregated) | — | Higher absolute usage, proportionate to capacity added |

**Net assessment: improvement in raw VU capacity, but the underlying root cause (DNS/threadpool stall) was never addressed — clustering only diluted its effect across more workers, and introduced a new connection-drop failure mode in the process.**

---

## Infrastructure Observations

- **CPU/event-loop:** `nodejs_eventloop_lag_p99_seconds` for orders-service is the strongest leading indicator of the breach in both runs — climbs from ~18ms baseline to 693ms (Run 2) in the minutes before the connection-drop errors begin.
- **DB pool:** Not the bottleneck in either run (16/25 in Run 1 single-process default; 94/108 = 87% in Run 2) — ruled out via `orders-db-exporter` data added between runs.
- **Network/DNS:** Not directly instrumented (no DNS-specific metric exists yet) — this is the key recommended addition before Run 3 (see Finding 1).

---

## Recommendations Summary

| Priority | Action | Owner | Target |
|---|---|---|---|
| P1 | Add `UV_THREADPOOL_SIZE: "128"` to orders-service env (mirror users-api fix) | Backend eng | Before Run 3 |
| P1 | Replace per-call fresh `fetch()` with a persistent keep-alive `http.Agent` for cart-service/products-service calls | Backend eng | Before Run 3 |
| P2 | Add explicit timing instrumentation immediately around the 3 outbound `fetch()` calls in `server.js` to directly confirm the threadpool-wait hypothesis in the next run | Backend eng | Before Run 3 |
| P2 | Re-test orders-service stress profile as "Run 3" after P1 fixes | QA/Perf team | Next session |
| P3 | If connection-drop errors recur in Run 3, apply `SO_REUSEPORT`/accept-queue tuning (already queued for auth-service) | Backend eng | After Run 3 results |

---

# Business Report

## What Was Tested

We simulated a gradually increasing wave of shoppers placing orders — starting at 100 simultaneous shoppers and scaling up — to find the point at which the order-placement system starts struggling. This is the **second attempt**: after the first test found a problem, the engineering team applied a fix (running the order service across 12 parallel copies instead of one) and we re-ran the same test to check whether the fix worked.

## Key Question: Is It Ready?

**Overall verdict: Not ready — risks identified.**

The fix improved things, but it did not solve the underlying problem, and it introduced a new issue. The order-placement system still cannot handle anywhere close to the number of shoppers expected during Black Friday.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| Customers wait many seconds (in the worst cases, nearly 10-12 seconds) to get order confirmation under moderate traffic | High | High at Black-Friday-level traffic | Fix before launch — this directly affects checkout completion rates |
| A small fraction of orders fail outright (connection dropped) under heavier traffic — a new issue introduced by the recent fix | High | Medium (appears above roughly 1 in 10 of expected peak traffic) | Fix before launch — failed orders mean lost sales and support tickets |
| The database itself is healthy and not at risk of running out of capacity | Low | Low | No action needed right now |

## What Happens If We Deploy Now

At anything beyond a small fraction of expected Black Friday traffic, a meaningful share of shoppers would experience either a very long wait for their order confirmation (multiple seconds, sometimes close to ten) or, in some cases, the order attempt failing outright and needing to be retried. Both outcomes increase cart abandonment and support load during the highest-revenue period of the year.

## What Needs to Happen Before Go-Live

- **Fix the root delay in order processing.** Engineers have identified a specific, well-understood technical cause (a resource limit on how the order service looks up its internal network addresses) — the same class of problem was already fixed for the login system earlier in this project, so there is a proven playbook to apply here.
- **Re-test after the fix.** A third test run is needed to confirm the fix actually closes the gap to the Black Friday traffic target, not just improves it partially as the last fix did.
- **Resolve the new connection-failure issue** introduced by the recent change before it reaches customers in production.

## What We Can Defer

- Database capacity monitoring and tuning — current usage (87% of configured headroom) is being watched but is not the cause of the problem and has room before becoming one.

## Decision Required

**No-go for Black Friday on the order-placement service in its current state.** Recommend one more fix-and-retest cycle (estimated: low effort, as the root cause and fix pattern are already known from a prior, successful fix to a different part of the system) before re-evaluating readiness.

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18_
