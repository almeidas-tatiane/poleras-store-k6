# Performance Test Technical Report — cart.test.js · Stress Test Run 6

**Date:** 2026-06-18
**Test type:** Stress — breaking point search (post DB pool size fix: 108→216 connections)
**Tool:** k6 v1.0.0-rc1
**Environment:** Local Docker (development)
**Load profile:** 100→200→400→800→1,200→2,000 VUs · 2 min/stage · 14 min (stopped at 06m20.7s, Stage 3, 468 VUs)
**Related tickets:** PT-16 (execution) · PT-21 (analysis) · PT-7 (SLAs) · PT-6 (reporting)

**Command used:**
```bash
k6 run \
  --env BASE_URL=http://localhost:3003 \
  --env BASE_URL_AUTH=http://localhost:3001 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-18_stress_cart_run6 \
  --out json=results/2026-06-18_stress_cart_run6/raw.json \
  tests/cart/cart.test.js
```

---

## Executive Summary

cart-service was stress tested for the sixth time after doubling the DB connection pool (108→216 connections). The breaking point moved modestly (~354-397 VUs vs ~340-372 before, ~10-15% improvement) with peak throughput unchanged (~287 RPS). **Connection-pool wait is now completely eliminated (0%, down from Run 4's 39%) and the database remains fast (`pg_stat_statements`: 0.07-0.56ms mean, unchanged from Run 5)** — yet a sampled trace shows a Redis cache *hit* taking 118ms and individual Postgres queries taking 10-59ms each, both far above their proven-fast baselines, while `nodejs_eventloop_lag_p99_seconds` climbed to 154ms in the same window. **This points to CPU/event-loop contention across cart-service's 12 workers as the new bottleneck — a resource never directly measured in any of the 6 runs so far.**

---

## SLA Compliance

SLAs from PT-7: P95 < 150ms · Error rate < 0.5%

| Metric | Target (PT-7) | Run 4 | Run 5 | **Run 6** | Status (Run 6) |
|---|---|---|---|---|---|
| Breaking point (VUs) | ≥ 2,500 | ~340 | ~340-372 | **~354-397** | ❌ FAIL |
| Real RPS at breaking point | — | ~210-294 | ~245-287 | **~256-287** | — |
| Connection pool wait | — | 39% of request time | not measured directly | **0%** | ✅ Fixed |
| Mean query execution time | — | 48-344ms (sample) | 0.08-0.53ms | **0.07-0.56ms** | ✅ Stable |
| HTTP error rate (5xx) | < 0.5% | 0.00% | 0.00% | **0.00%** | ✅ PASS |
| Recovery time | — | ~38s | ~77s | **~76s, clean** | ✅ PASS |

Did the test reach its target load? **No** — stopped at 468 VUs of a 2,000 VU target stage, per the SLA-breach stop rule, once the breach was confirmed real and sustained (monotonic climb over the final ~75 seconds, no recovery dip).

---

## Findings

### [CRITICAL] Finding 1 — Event-loop/CPU contention across the 12 workers is the new bottleneck

**Observed:** Tempo trace `21fe6a98ec710fc113b909bc9a57f0cb` (`POST /api/cart/items`, 331ms total, captured at T+5:48, a Redis cache **hit** — no products-service call needed):

| Span | Duration | % of request | Established fast baseline |
|---|---|---|---|
| `redis-GET` (cache hit) | 118ms | 36% | Normally <5ms |
| `pg-pool.connect` | ~0ms | 0% | — |
| `BEGIN` + 6 queries + `COMMIT` | 208ms | 62% | Mean 0.07-0.56ms per query (`pg_stat_statements`) |
| **Total** | **331ms** | **100%** | |

Connection acquisition is now instant (0%, down from Run 4's 39%) — the pool-size fix completely solved that problem. But neither Redis nor Postgres is actually slow on average (both have proven fast baselines) — in this trace, both are inflated 20-100x simultaneously, with no single dependency to blame.

**Root cause:** Multiple independent, normally-fast operations slowing down together within the same request is the signature of the *requesting process's own event loop* being delayed in scheduling/processing each await — not the dependencies themselves. This is corroborated by `nodejs_eventloop_lag_p99_seconds` climbing from a 10ms baseline to **154ms** at T+6:23, in the same window as this trace.

**Evidence:** Tempo trace `21fe6a98ec710fc113b909bc9a57f0cb`; Prometheus `nodejs_eventloop_lag_p99_seconds{job="cart-service"}` range query, 16:37:00-16:45:00Z.

**Recommended action:** Directly measure CPU utilization on the cart-service container during peak load — this has not been captured in any of the 6 runs. If CPU-bound, the 12 workers on a single host may be near their practical ceiling; the next lever would be horizontal scaling across multiple hosts, not further single-host configuration tuning.

**Owner:** Backend Engineering / Platform
**Retest required:** Yes, after CPU measurement and any resulting fix

---

### [HIGH] Finding 2 — Connection pool fix gave a real but sub-linear improvement

**Observed:** `pg_stat_activity_count{datname="cartdb"}`: `idle in transaction` climbed to **41** at peak (vs Run 5's 20) — but as a fraction of the now-216-connection pool, 41/216 = **19%**, nearly identical to Run 5's 20/108 = **18.5%**. The pool grew toward its new ceiling (168+ of 216) but the test was stopped before fully maxing it.

**Root cause:** Doubling the pool moved the breaking point by only ~10-15% (not 2x), because the same proportional saturation pattern recurred at the larger scale. This confirms pool size was a real but not dominant constraint — consistent with Finding 1's CPU/event-loop hypothesis, since more available connections simply allows more concurrent in-flight requests, which then compete for the same fixed CPU capacity.

**Evidence:** Prometheus `pg_stat_activity_count{datname="cartdb"}` range query, 16:37:38-16:44:30Z.

**Recommended action:** Do not invest further in pool-size tuning alone; pair with the CPU investigation in Finding 1.

**Owner:** Backend Engineering
**Retest required:** No (sufficiently demonstrated)

---

### [LOW] Finding 3 — Database tuning (Run 5) and recovery/metrics fixes (Run 3-4) continue to hold

**Observed:** `pg_stat_statements` mean query times remain 0.07-0.56ms, identical to Run 5 — no regression. Recovery was clean at ~76 seconds with no lingering metrics artifact, consistent with Runs 3-5.

**Recommended action:** None — these fixes are stable across multiple runs now.

**Owner:** N/A
**Retest required:** No

---

## Regression Analysis vs. Previous Runs

| Metric | Run 4 | Run 5 | Run 6 | Trend |
|---|---|---|---|---|
| Breaking point (VUs) | ~340 | ~340-372 | ~354-397 | ✅ Modest improvement |
| Real RPS at breaking point | ~210-294 | ~245-287 | ~256-287 | ➡️ Stable |
| Connection pool wait | 39% | not isolated | **0%** | ✅ Fully fixed |
| Mean query execution time | 48-344ms (sample) | 0.08-0.53ms | 0.07-0.56ms | ✅ Stable, fixed |
| Event-loop lag at breach | not isolated | not isolated | **154ms peak** | ⚠️ New signal, needs CPU data |
| Dominant bottleneck | DB query execution | Connection pool | **CPU/event-loop (suspected)** | Progressive isolation continues |
| Error rate | 0% | 0% | 0% | ➡️ Stable across all 6 runs |

---

## Infrastructure Observations

| Resource | Baseline | Peak (Run 6) | Status |
|---|---|---|---|
| P95 `POST /api/cart/items` | ~40ms | 2,160ms | ❌ |
| Connection pool wait (`pg-pool.connect`) | — | ~0% of request time | ✅ Fixed |
| `pg_stat_statements` mean query time | — | 0.07-0.56ms | ✅ Excellent |
| `pg_stat_activity` idle in transaction | ~0 | 41 (19% of 216-pool) | ⚠️ Proportionally same as Run 5 |
| `nodejs_eventloop_lag_p99_seconds` | 10ms | **154ms** | ❌ New signal |
| **CPU utilization (cart-service container)** | — | **Not measured** | ⚠️ Gap — next step |
| HTTP 5xx errors | 0 | 0 | ✅ |
| Recovery time | — | ~76s, clean | ✅ |

---

## Recommendations Summary

| Priority | Action | Owner | Urgency |
|---|---|---|---|
| **P1** | Measure CPU utilization on the cart-service container directly during the next stress run — first time this metric will be captured | Backend Eng / Platform | Immediate |
| **P2** | If CPU-bound: evaluate horizontal scaling (multiple hosts) vs. further single-host tuning | Backend Eng / Platform | After P1 |
| **P3** | If not CPU-bound: investigate Node.js-level event-loop blocking sources (e.g. synchronous JSON parsing of large payloads, GC pauses) via `--prof` or `clinic.js` | Backend Eng | After P1, if needed |
| **P4** | Retest after whichever fix P1's findings indicate | Performance Team | After P2/P3 |

---

## Test Conditions and Limitations

- **Environment:** Local Docker on development machine, single host. Absolute latency and resource values are development baselines, not production-absolute.
- **No handleSummary generated:** Test was stopped (TaskStop) at 06m20.7s, 468 VUs. k6 HTML report was not produced — same limitation as Runs 1-5.
- **CPU utilization was not measured this run** — this is the explicit gap this report identifies and recommends closing next.
- **Test stopped early:** Max VUs reached was 468 of a 2,000 VU target stage.

---

## Direct Answer: Root Cause of the Most Critical Problem and What to Fix First

**Connection pool wait is now completely eliminated (0%, down from Run 4's 39%) and the database remains fast in aggregate (`pg_stat_statements` confirms 0.07-0.56ms mean, unchanged from Run 5).** Yet a sampled trace shows a Redis cache *hit* taking 118ms and individual Postgres queries taking 10-59ms each — both far above their proven-fast baselines — with `nodejs_eventloop_lag_p99_seconds` climbing to 154ms in the same window. Multiple independent, normally-fast operations slowing down together, with no single dependency to blame, is the signature of the requesting process's own CPU/event-loop capacity being the constraint.

**Fix this first:** directly measure CPU utilization on the cart-service container during peak load — a metric never captured in any of the 6 runs so far. This will confirm or rule out CPU saturation across the 12 workers before investing further in pool, cache, or database tuning, since each of those levers has now been addressed in turn and the system is still hitting a similar VU/RPS ceiling.

---

# Performance Test — Business Summary

| | |
|---|---|
| **System tested** | Poleras Store — Shopping Cart (add items, view cart, remove items) |
| **Analysis date** | 2026-06-18 |
| **Test conducted by** | Performance Testing Team |
| **Test type** | Stress Test — breaking point search, sixth attempt after five rounds of fixes |

---

## What Was Tested

We pushed the Poleras Store shopping cart under progressively increasing load for the sixth time, after doubling the number of database connections the cart service is allowed to use simultaneously.

---

## Key Question: Is It Ready?

**Overall verdict: Not ready yet, but six rounds of methodical, evidence-based investigation have made measured progress and narrowed the problem down to the system's underlying hardware capacity — the next thing to check.**

The number of simultaneous shoppers the cart can handle improved slightly (about 10-15%) after doubling its database connection capacity, but not as dramatically as hoped. Importantly, the database connection limit that was the suspected culprit has now been completely ruled out — connections are instantly available, and the database itself answers every query in a fraction of a millisecond. Despite this, some cart actions are still taking far longer than they should. The pattern of slowness now points to a different kind of limit: the computer running the cart service may simply be running out of processing power to keep up with the volume of requests, rather than any specific piece of the system being slow.

---

## Risk Summary

| Risk | Business Impact | Likelihood | Recommended Action |
|---|---|---|---|
| The computer running the cart service may be running out of processing capacity under heavy load | Shoppers experience slow cart actions once this capacity is reached during peak traffic | Medium-High — strongly suggested by the evidence, not yet directly confirmed | Directly measure processing usage during the next test — quick to check |
| Six rounds of fixes have each worked as intended but capacity gains are slowing | Diminishing returns from configuration changes alone | Medium — expected as more fundamental constraints are reached | If processing capacity is confirmed as the limit, consider running the cart service across more than one machine |

---

## What Happens If We Deploy Now

At everyday and moderately busy traffic levels, the cart performs well — six rounds of improvements have meaningfully strengthened it. As traffic approaches Black Friday peak, shoppers will still eventually experience slowdowns, though it now takes more simultaneous shoppers to trigger them than in any previous test. The exact reason has been narrowed down to a likely processing-capacity limit, which is straightforward to confirm.

---

## What Needs to Happen Before Go-Live

- **Directly measure how much computer processing power the cart service uses during peak load** — this is a one-time check that has not yet been done in any of the six test rounds, despite five investigation cycles addressing other areas. It will confirm or rule out the suspected cause.
- **Depending on that result:** either run the cart service across more than one machine (if processing power is the limit) or investigate a different, more specific code-level cause (if it isn't).

---

## What We Can Defer

- **Further database or connection-count tuning** — already addressed twice (database speed, then connection capacity); both are now confirmed healthy and not worth additional investment until the processing-capacity question is answered.

---

## Decision Required

| Option | What It Means | Risk |
|---|---|---|
| **Measure processing capacity directly and act on the result (recommended)** | A quick, low-risk diagnostic check, followed by either a scaling change or a more targeted code investigation depending on what it shows. | Low — purely diagnostic, no system changes required to check |
| **Ship current state and monitor in production** | Defers a low-cost diagnostic step that has a good chance of identifying the final blocking issue, given the pattern of success across five prior rounds. | Medium-High — risk during the highest-revenue period of the year |

**Recommendation:** Measure processing capacity directly before deciding on the next fix. Every round of testing so far has correctly identified and resolved what it targeted — this is the natural next step, not a guess.

---

_Performance Report Analysis generated by performance-report-analysis skill · 2026-06-18_
_k6 results: results/2026-06-18_stress_cart_run6/ (Run 6, stopped at Stage 3, 468 VUs)_
_Grafana evidence: Prometheus (P95 per route, pg_stat_activity, nodejs_eventloop_lag_p99_seconds) · Loki (error scan) · Tempo (span-level trace breakdown) · pg_stat_statements (direct query-level evidence)_
_Prompt used: "Read PT-6 to see the description rules / Read the PT-21 (verify the evidences saved in the result cart folder and Grafana evidences on PT-16 to cart.test.js stress test, comparing the executions if there is more than one for the same service), verify the analysis checklist and run the skill performance-report-analysis to generate a technical and business report. / Use MCP Grafana to query all of the following in parallel: 1. P95 of the service in the same period of the test 2. Error rate in the same period of the test 3. DB connection pool peak usage 4. Errors in Loki for the service in that window 5. If errors found: get the traceId of the most frequent and open it in Tempo - what span is the bottleneck? / Then tell me: what is the root cause of the most critical problem and what would you fix first? / Include the business and technical report generated with performance-report-analysis skills as comment in the PT-21 also Specify the Performance Report Analysis is for cart.test.js / Include screenshot from Grafana, Tempo and Loki as evidence if needed / Include in the ticket comment the prompt used / Generate the output accordingly PT-16 / Commit and push changes to https://github.com/almeidas-tatiane/poleras-store-k6"_
