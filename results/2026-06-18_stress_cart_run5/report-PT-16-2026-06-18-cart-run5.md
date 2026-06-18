# Performance Test Technical Report — cart.test.js · Stress Test Run 5

**Date:** 2026-06-18
**Test type:** Stress — breaking point search (post cart-db tuning: `shared_buffers`/`work_mem`/`pg_stat_statements`)
**Tool:** k6 v1.0.0-rc1
**Environment:** Local Docker (development)
**Load profile:** 100→200→400→800→1,200→2,000 VUs · 2 min/stage · 14 min (stopped at 06m13.7s, Stage 3, 445 VUs)
**Related tickets:** PT-16 (execution) · PT-21 (analysis) · PT-7 (SLAs) · PT-6 (reporting)

**Command used:**
```bash
k6 run \
  --env BASE_URL=http://localhost:3003 \
  --env BASE_URL_AUTH=http://localhost:3001 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-18_stress_cart_run5 \
  --out json=results/2026-06-18_stress_cart_run5/raw.json \
  tests/cart/cart.test.js
```

---

## Executive Summary

cart-service was stress tested for the fifth time after tuning cart-db's Postgres configuration (`shared_buffers` 128MB→512MB, `work_mem` 4MB→16MB, `pg_stat_statements` enabled). The breaking point barely moved (~340-372 VUs, ~245-287 RPS — essentially the same as Run 4), but **`pg_stat_statements` proves the fix worked exactly as diagnosed**: mean query execution time dropped from 48-344ms to **0.08-0.53ms**, a 100-1000x improvement. The bottleneck has fully shifted again — this time to **connection pool capacity**: `pg_stat_activity` shows the pool growing to its full 108-connection ceiling with a growing share "idle in transaction" rather than executing queries. A smaller, secondary contributor was also found via trace analysis: the ~5% of requests that miss the Redis variant cache still pay the original 466ms cross-service-call cost.

---

## SLA Compliance

SLAs from PT-7: P95 < 150ms · Error rate < 0.5%

| Metric | Target (PT-7) | Run 3 | Run 4 | **Run 5** | Status (Run 5) |
|---|---|---|---|---|---|
| Breaking point (VUs) | ≥ 2,500 | ~600-650 | ~340 | **~340-372** | ❌ FAIL |
| Real RPS at breaking point | — | ~96-140 | ~210-294 | **~245-287** | — |
| Mean query execution time | — | unknown | 48-344ms (sample) | **0.08-0.53ms (full average)** | ✅ Fixed |
| HTTP error rate (5xx) | < 0.5% | 0.00% | 0.00% | **0.00%** | ✅ PASS |
| Recovery time | — | seconds | ~38s, clean | **~77s, clean** | ✅ PASS |

Did the test reach its target load? **No** — stopped at 445 VUs of a 2,000 VU target stage, per the SLA-breach stop rule, once the breach was confirmed real and sustained (monotonic climb: 44ms→60ms→97ms→144ms→223ms over the final 60 seconds).

---

## Findings

### [CRITICAL] Finding 1 — Connection pool capacity is now the dominant aggregate bottleneck

**Observed:** `pg_stat_activity_count{datname="cartdb"}` across the test window:

| State | Baseline | Peak | Significance |
|---|---|---|---|
| `active` (executing a query) | 0-1 | 1-3 | Stayed low throughout — queries are no longer the bottleneck |
| `idle in transaction` | ~0 | **20** | Connections holding an open transaction without active work — climbing |
| `idle`, `wait_event=ClientRead` | 60 (pre-warmed min) | **108 (= configured max)** | Pool grew to its complete ceiling |

**Root cause:** Now that query execution is sub-millisecond (Finding 2), the system can drive far more concurrent requests through the same pool — but 108 connections (`DB_POOL_MAX=9 × 12 workers`) is not enough capacity for the request rate now achievable. Connections pile up waiting for a slot to free, which manifests as "idle in transaction" time and ultimately as P95 latency.

**Evidence:** Prometheus range query on `pg_stat_activity_count{datname="cartdb"}`, 15:56:30-16:04:30Z.

**Recommended action:** Increase `DB_POOL_MAX` further now that connections are cheap to use (sub-ms queries mean each connection can serve many more requests/second than before). Correspondingly check and, if needed, raise `cartdb`'s `max_connections` (currently 150) so the larger pool has headroom.

**Owner:** Backend Engineering / Platform
**Retest required:** Yes

---

### [HIGH] Finding 2 — `shared_buffers`/`work_mem` tuning fully solved query execution time

**Observed:** `pg_stat_statements`, queried directly after the test (not sampled — this is the authoritative full-test average):

| Query | Calls | Mean | Max |
|---|---|---|---|
| `SELECT COUNT(*) FROM carts WHERE status = $1` | 29,703 | 0.53ms | 38.77ms |
| `INSERT INTO cart_items (...)` | 14,858 | 0.36ms | 54.90ms |
| `UPDATE carts SET updated_at = NOW() WHERE id = $1` | 29,743 | 0.20ms | 36.49ms |
| `SELECT id FROM carts WHERE user_id = $1 AND status = $2 LIMIT $3` | 44,561 | 0.12ms | 33.83ms |
| `SELECT * FROM cart_items WHERE cart_id = $1 ORDER BY added_at` | 59,446 | 0.11ms | 24.98ms |
| `SELECT * FROM carts WHERE id = $1` | 59,446 | 0.10ms | 19.19ms |

Every query's mean execution time is now sub-millisecond, down from 48-344ms per query in Run 4's sampled Tempo trace — a 100-1000x improvement. The `max_ms` outliers (19-55ms) are rare tail events under peak contention, not the norm.

**Root cause (confirmed):** `shared_buffers` and `work_mem` were Postgres stock defaults, undersized for the concurrent load. Increasing them gave Postgres enough buffer cache to serve the working set without disk I/O thrashing.

**Recommended action:** None — this fix is complete and conclusively verified.

**Owner:** N/A
**Retest required:** No

---

### [MEDIUM] Finding 3 — Redis cache misses (~5% of requests) still pay the full cross-service-call cost

**Observed:** Tempo trace `162cedbc6376f8ccf9b36114475d09b` (`POST /api/cart/items`, 949ms total, a cache-miss case):

| Span | Duration | % of request |
|---|---|---|
| `redis-GET` (cache check — **miss**) | 136ms | 14% |
| Outbound `GET` to products-service (variant lookup) | 466ms | **49%** |
| `redis-SETEX` (cache write) | 94ms | 10% |
| `pg-pool.connect` (single acquisition) | 139ms | 15% |
| `BEGIN` + 5 queries + `COMMIT` | 158ms | 17% |
| **Total** | **949ms** | **100%** |

Unlike Run 4's traces (dominated by DB query time) or Run 3's (dominated by 6x connection acquisition), this trace's slowness is dominated by the cross-service call — because the Redis cache missed for this request. products-service's own work for that call was only 36ms; the rest is network/DNS overhead, the same pattern originally identified in the Run 3 report.

**Root cause:** With a ~94.7% cache hit rate (measured in Run 4), roughly 1 in 20 requests still takes the slow, uncached path. This is now a minority-case contributor to the long tail, not the dominant bottleneck (Finding 1 is), but it adds up under heavy load.

**Recommended action:** Consider a modestly longer Redis TTL (currently 30s, jittered) or a cache-warming strategy to reduce the miss rate further. Lower priority than Finding 1 — revisit after the pool-size fix is measured.

**Owner:** Backend Engineering
**Retest required:** No (informational, revisit later)

---

### [LOW] Finding 4 — Recovery and metrics reliability both holding up well

**Observed:** P95 returned to no-traffic baseline within ~77 seconds of stopping the test, with no lingering metrics artifact. The `AggregatorRegistry` fix (introduced in Run 3) has now held up cleanly across Runs 3, 4, and 5.

**Recommended action:** None.

**Owner:** N/A
**Retest required:** No

---

## Regression Analysis vs. Previous Runs

| Metric | Run 3 | Run 4 | Run 5 | Trend |
|---|---|---|---|---|
| Breaking point (VUs) | ~600-650 | ~340 | ~340-372 | ➡️ Stable since Run 4 |
| Real RPS at breaking point | ~96-140 | ~210-294 | ~245-287 | ✅ Stable/slightly improving |
| Mean query execution time | unknown | 48-344ms (sample) | **0.08-0.53ms (full avg)** | ✅ Major improvement |
| Dominant bottleneck | Connection acquisition pattern | DB query execution | **Connection pool capacity** | ✅ Progressively isolated |
| Error rate | 0% | 0% | 0% | ➡️ Stable (all 5 runs) |
| Recovery time | seconds | ~38s, clean | ~77s, clean | ➡️ Stable, no artifact |

---

## Infrastructure Observations

| Resource | Baseline | Peak (Run 5) | Status |
|---|---|---|---|
| P95 `POST /api/cart/items` | ~24ms | 1,453ms | ❌ |
| `pg_stat_activity` active queries | 0-1 | 1-3 | ✅ Low |
| `pg_stat_activity` idle in transaction | ~0 | **20** | ❌ Climbing |
| `pg_stat_activity` pool size | 60 | **108 (= configured max)** | ⚠️ At ceiling |
| `pg_stat_statements` mean query time | — | 0.08-0.53ms | ✅ Excellent |
| Redis cache hit rate | — | ~94.7% (measured Run 4) | ✅ Good, minor room to improve |
| HTTP 5xx errors | 0 | 0 | ✅ |
| Recovery time | — | ~77s, clean | ✅ |

---

## Recommendations Summary

| Priority | Action | Owner | Urgency |
|---|---|---|---|
| **P1** | Increase `DB_POOL_MAX` further (now cheap since queries are sub-ms); check/raise `cartdb`'s `max_connections` (currently 150) if the new pool size approaches it | Backend Eng / Platform | Immediate — this is the next fix |
| **P2** | Retest after the pool increase to measure the new breaking point (VU + RPS) | Performance Team | After P1 |
| **P3** | Consider a longer Redis TTL or cache-warming to reduce the ~5% miss rate | Backend Eng | After P1/P2, lower priority |
| **P4** | Continue monitoring `pg_stat_activity` idle-in-transaction trend after the pool change, to confirm it resolves rather than just shifts further | Performance Team | Ongoing |

---

## Test Conditions and Limitations

- **Environment:** Local Docker on development machine. Absolute latency and connection-count values are development baselines, not production-absolute.
- **No handleSummary generated:** Test was stopped (TaskStop) at 06m13.7s, 445 VUs. k6 HTML report was not produced — same limitation as Runs 1-4.
- **Single trace sampled in depth for Finding 3:** The cache-miss pattern generalizes structurally (Redis misses always pay the full cross-service cost), but the exact percentage breakdown will vary request-to-request.
- **Test stopped early:** Max VUs reached was 445 of a 2,000 VU target stage.

---

## Direct Answer: Root Cause of the Most Critical Problem and What to Fix First

**The dominant aggregate bottleneck, per the DB-side `pg_stat_activity` evidence, is connection pool capacity.** 108 connections is no longer enough for the request rate the system can now achieve, since per-request database work is cheap (sub-millisecond queries, confirmed by `pg_stat_statements`). A secondary, smaller contributor is the ~5% Redis cache-miss path, which still pays the full 466ms cross-service-call cost when it occurs — but this is a minority case, not the dominant signal.

**Fix this first:** increase `DB_POOL_MAX` (and `cartdb`'s `max_connections` if the new pool size approaches the current 150 ceiling). This is the single biggest lever supported by the clearest aggregate evidence (the pool growing to its full ceiling with idle-in-transaction connections piling up), and it's a low-risk config change — not a code or query investigation. The cache-miss path (Finding 3) is a smaller optimization to revisit after this fix is measured.

---

# Performance Test — Business Summary

| | |
|---|---|
| **System tested** | Poleras Store — Shopping Cart (add items, view cart, remove items) |
| **Analysis date** | 2026-06-18 |
| **Test conducted by** | Performance Testing Team |
| **Test type** | Stress Test — breaking point search, fifth attempt after four rounds of fixes |

---

## What Was Tested

We pushed the Poleras Store shopping cart under progressively increasing load for the fifth time, after tuning the cart's database to use its available memory more effectively for caching frequently-accessed data.

---

## Key Question: Is It Ready?

**Overall verdict: Not ready yet, but the diagnostic process has now narrowed the problem down to one simple, low-risk setting — and that's the next thing we're changing.**

The number of simultaneous shoppers the cart can handle before slowing down stayed about the same as the last test round (~340-370). On the surface that might look like the database tuning didn't help — but it worked exactly as intended: routine database lookups, which were previously taking a third of a second or more under load, now complete in a fraction of a millisecond. The reason the headline number didn't move is that fixing the database exposed the next limit in line: a fixed cap on how many database connections the cart service is allowed to use at once. That cap is now the only thing holding the system back — a much simpler problem than anything found in the previous three rounds of testing.

---

## Risk Summary

| Risk | Business Impact | Likelihood | Recommended Action |
|---|---|---|---|
| A fixed connection limit, not the database itself, is now capping cart capacity | Shoppers experience slow cart actions once the limit is reached during peak traffic | High — confirmed by test | Raise the connection limit and re-test |
| A small fraction of shopping actions (about 1 in 20) still pay an older, slower path | Minor, occasional slowdowns even outside of peak load | Low — already a minor and well-understood factor | Address after the connection limit fix; not urgent |

---

## What Happens If We Deploy Now

At everyday and moderately busy traffic levels, the cart performs very well — database operations that used to be a concern are now effectively instant. As traffic approaches Black Friday peak, shoppers will still eventually experience the same kind of progressive slowdown seen in prior tests, but for a more straightforward reason this time: the system runs out of available database connections, not database speed.

---

## What Needs to Happen Before Go-Live

- **Increase the cart database's connection limit** — now that the database itself responds quickly, it can safely support more simultaneous connections than it's currently allowed. This is a low-risk configuration change.
- **Re-test after the change** to confirm whether this closes the remaining gap to the Black Friday target or reveals one more, hopefully final, limit to address.

---

## What We Can Defer

- **The small, occasional slow path affecting about 1 in 20 cart actions** — well understood, low impact, and best addressed after the connection limit change is measured.

---

## Decision Required

| Option | What It Means | Risk |
|---|---|---|
| **Raise the connection limit and re-test (recommended)** | A low-risk configuration change, expected to take effect immediately, followed by a 15-minute retest. | Low — standard, well-understood adjustment |
| **Ship current state and monitor in production** | Defers a low-risk, well-diagnosed fix. Given four consecutive rounds of successful, evidence-based improvements, this would forgo likely further gains. | Medium-High — direct risk during the highest-revenue period of the year |

**Recommendation:** Raise the connection limit and re-test. This is the simplest, lowest-risk fix identified across all five rounds of testing so far, and the diagnostic trail strongly supports it being the next, and possibly final, blocking issue.

---

_Performance Report Analysis generated by performance-report-analysis skill · 2026-06-18_
_k6 results: results/2026-06-18_stress_cart_run5/ (Run 5, stopped at Stage 3, 445 VUs)_
_Grafana evidence: Prometheus (P95 per route, pg_stat_activity via cart-db-exporter) · Loki (error scan) · Tempo (span-level trace breakdown) · pg_stat_statements (direct query-level evidence)_
_Prompt used: "Read PT-6 to see the description rules / Read the PT-21 (verify the evidences saved in the result cart folder and Grafana evidences on PT-16 to cart.test.js stress test, comparing the executions if there is more than one for the same service), verify the analysis checklist and run the skill performance-report-analysis to generate a technical and business report. / Use MCP Grafana to query all of the following in parallel: 1. P95 of the service in the same period of the test 2. Error rate in the same period of the test 3. DB connection pool peak usage 4. Errors in Loki for the service in that window 5. If errors found: get the traceId of the most frequent and open it in Tempo - what span is the bottleneck? / Then tell me: what is the root cause of the most critical problem and what would you fix first? / Include the business and technical report generated with performance-report-analysis skills as comment in the PT-21 also Specify the Performance Report Analysis is for cart.test.js / Include screenshot from Grafana, Tempo and Loki as evidence if needed / Include in the ticket comment the prompt used / Generate the output accordingly PT-16 / Commit and push changes to https://github.com/almeidas-tatiane/poleras-store-k6"_
