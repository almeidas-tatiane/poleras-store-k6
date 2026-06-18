# Performance Test Technical Report — orders.test.js · Stress Test Run 1

**Date:** 2026-06-18
**Test type:** Stress — breaking point search (first-ever execution for orders-service)
**Tool:** k6 v1.0.0-rc1
**Environment:** Local Docker (development)
**Load profile:** 100→200→400→800→1,200→2,000 VUs · 2 min/stage · 14 min (stopped at 03m37.7s, Stage 1→2 transition, 181 VUs)
**Related tickets:** PT-16 (execution) · PT-21 (analysis) · PT-7 (SLAs) · PT-6 (reporting) · PT-11 (script)

**Command used:**
```bash
k6 run \
  --env BASE_URL=http://localhost:3004 \
  --env BASE_URL_AUTH=http://localhost:3001 \
  --env BASE_URL_CART=http://localhost:3003 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-18_stress_orders \
  --out json=results/2026-06-18_stress_orders/raw.json \
  tests/orders/orders.test.js
```

---

## Executive Summary

orders-service was stress tested for the first time, breaking at a low **~163-180 VUs** with 0% errors (pure latency failure). Trace analysis revealed a precise root cause: the order itself is created and returned to the client quickly (~250ms), but a background call to cart-service (to mark the cart as converted) gets queued for as long as **11.7 seconds** before it even leaves orders-service — entirely on orders-service's own side, since cart-service handles it in 6.8ms once it arrives. orders-service runs as a **single Node process with no clustering at all**, the identical root-cause class already diagnosed and fixed for cart-service in PT-21. **This is a known, low-risk, previously-validated fix waiting to be applied, not a new investigation.**

---

## SLA Compliance

SLAs from PT-7: P95 < 200ms · Error rate < 1%

| Metric | Target | Actual | Result |
|---|---|---|---|
| P95 `POST /api/orders` | < 200ms | 984ms (peak) | ❌ FAIL |
| P95 `GET /api/orders/:id` | < 200ms | 217ms (peak) | ❌ FAIL |
| Error rate | < 1% | 0.00% | ✅ PASS |
| Throughput at breaking point | — | not fully characterized (test stopped early) | — |

Did the test reach its target load? **No** — stopped at 181 VUs of a 2,000 VU target stage, per the SLA-breach stop rule, once the breach was confirmed real and sustained (monotonic climb: 212ms→246ms→322ms→745ms→842ms→965ms→984ms over ~80 seconds, no recovery dip).

---

## Findings

### [CRITICAL] Finding 1 — orders-service runs as a single process with no clustering; async work queues for up to 11.7 seconds under load

**Observed:** Tempo trace `16aeb6ce8a929f833193495b8e60ec6a` (`POST /api/orders`, search-reported total span 12,053ms) shows: the order-creation business logic (`ecommerce.create_order` span) completes in ~237.5ms, and the client receives its response promptly. But the trace also contains a later outbound call — `POST /api/cart/convert` to cart-service, used to mark the cart converted after the order is placed — that does not begin (its `dns.lookup`/`tcp.connect` spans) until **11.72 seconds** after the order response was already sent.

**Root cause:** Confirmed directly: orders-service has no `cluster.js` and no `NODE_CLUSTER_WORKERS` environment variable — it runs as a single Node.js process. Under concurrent load, its one event loop becomes saturated, and lower-priority queued async work (the cart-conversion call) gets pushed back by seconds. This is the exact same root-cause class diagnosed for cart-service in PT-21 Run 1-3, before clustering was added there.

**Evidence:** Tempo trace `16aeb6ce8a929f833193495b8e60ec6a`; cart-service's own receiving-side span for `/api/cart/convert` in the same trace took only 6.8ms — ruling out cart-service as the cause.

**Recommended action:** Add `NODE_CLUSTER_WORKERS` clustering to orders-service, mirroring the exact `cluster.js` + `AggregatorRegistry` pattern already implemented and proven for cart-service (PT-21, commits `186325e` and `0d847e8` in `Learning-Performance-Observability-Stack`). This single fix took cart-service's breaking point from ~150 VUs to ~600-650 VUs (4x) — a comparable gain is expected here.

**Owner:** Backend Engineering
**Retest required:** Yes

---

### [LOW] Finding 2 — orders-db has no query-pool observability (same gap cart-db had before its fix)

**Observed:** `pg_stat_activity_count{datname="ordersdb"}` returned no data — orders-db has no `postgres_exporter`. As a proxy, the app-side `db_connections_active{job="orders-service"}` gauge peaked at only **15** connections during the test — low enough that DB connection exhaustion is not indicated as a factor here, but this can't be confirmed directly.

**Recommended action:** Add a `postgres_exporter` for orders-db, mirroring the `cart-db-exporter` already added for cart-db in PT-21.

**Owner:** Platform / DevOps
**Retest required:** No (observability improvement)

---

### [INFORMATIONAL] Finding 3 — cart-service ruled out as a contributing factor

**Observed:** cart-service (orders-service's internal dependency) was monitored throughout the same test window and stayed completely healthy — its own P95 never exceeded 31ms, well within its 150ms SLA, even as orders-service's P95 climbed past 980ms.

**Significance:** This confirms orders-service has its own, independent bottleneck — it is not being dragged down by cart-service's separately-documented capacity limitations (PT-21). The fix for orders-service does not depend on any further cart-service work.

**Recommended action:** None — informational confirmation only.

**Owner:** N/A
**Retest required:** No

---

## Regression vs. Baseline

Not applicable — this is the first-ever stress test execution for orders-service. No prior run exists for comparison. This report establishes the baseline for future regression tracking.

---

## Infrastructure Observations

| Resource | Baseline | Peak | Status |
|---|---|---|---|
| P95 `POST /api/orders` | ~90-100ms | 984ms | ❌ |
| P95 `GET /api/orders/:id` | ~9.5ms | 217ms | ❌ |
| `db_connections_active` (orders-service) | 1 | 15 | ✅ Low, not the constraint |
| cart-service P95 (dependency) | — | 31ms (max observed) | ✅ Healthy throughout |
| HTTP 5xx errors | 0 | 0 | ✅ |
| Recovery time | — | ~80s, clean | ✅ |

---

## Recommendations Summary

| Priority | Action | Owner | Target date |
|---|---|---|---|
| **P1** | Add `NODE_CLUSTER_WORKERS` clustering to orders-service (mirror cart-service's `cluster.js` + `AggregatorRegistry` pattern) | Backend Eng | Before next run |
| **P2** | Add `postgres_exporter` for orders-db | Platform / DevOps | Before next run, low priority |
| **P3** | Retest after P1 to measure the new breaking point | Performance Team | After P1 |

---

## Test Conditions

- **Environment:** Local Docker on development machine. Absolute latency values are development baselines, not production-absolute.
- **First-ever run for this service:** `orders.test.js` needed a stress-mode addition before this test could run (commit `c01516d`) — it previously only had load-test stages defined.
- **No handleSummary generated:** Test was stopped (TaskStop) at 03m37.7s, 181 VUs. k6 HTML report was not produced.
- **Test stopped early:** Max VUs reached was 181 of a 2,000 VU target stage; the true ceiling/RPS at breaking point was not fully characterized before the stop rule triggered.

---

## Direct Answer: Root Cause of the Most Critical Problem and What to Fix First

**orders-service runs as a single Node process with no clustering at all.** Under concurrent load, its single event loop becomes saturated, and asynchronous background work — specifically the post-order call to cart-service to mark the cart as converted — gets queued and delayed by as much as 11.7 seconds in the observed trace, even though the order itself is created and returned to the client quickly, and even though cart-service responds in milliseconds once the delayed call actually reaches it.

**This is the exact same root-cause class already solved for cart-service.** Fix first: add `NODE_CLUSTER_WORKERS` clustering to orders-service using the identical, already-proven `cluster.js` + `AggregatorRegistry` pattern from the cart-service fix (PT-21) — a known, low-risk, previously-validated change, not a new investigation. This took cart-service's breaking point from ~150 VUs to ~600-650 VUs in one step.

---

# Performance Test — Business Summary

| | |
|---|---|
| **System tested** | Poleras Store — Order Placement (create order, view order, list orders) |
| **Analysis date** | 2026-06-18 |
| **Test conducted by** | Performance Testing Team |
| **Test type** | Stress Test — breaking point search, first attempt for this system |

---

## What Was Tested

We pushed the Poleras Store's order-placement flow under progressively increasing load for the first time — simulating shoppers logging in, adding an item to their cart, placing an order, and checking their order's status and history.

---

## Key Question: Is It Ready?

**Overall verdict: Not ready — and the gap is large, but the cause has already been precisely identified and a proven fix exists.**

The order-placement system handled only about 165-180 simultaneous shoppers before response times climbed sharply — far below the 2,500-shopper Black Friday target, roughly a 14-15x gap. This is a similar starting point to where the shopping cart system was before its own round of fixes.

The good news: investigation found the exact cause, and it is the same issue that was already successfully fixed in the shopping cart system. The order-placement service is currently running as a single instance with no ability to spread work across multiple processes — meaning it can only do one thing at a time under the hood. When too many shoppers place orders simultaneously, some background work (confirming the cart was used) gets stuck waiting, sometimes for over 10 seconds, even though the shopper's own order confirmation comes back quickly.

---

## Risk Summary

| Risk | Business Impact | Likelihood | Recommended Action |
|---|---|---|---|
| Order placement breaks at ~165-180 simultaneous shoppers — far below Black Friday target | Shoppers experience severe delays placing orders during peak traffic; direct risk to completed sales | High — confirmed by test | Apply the same fix already proven for the shopping cart, then re-test |
| The fix needed is well understood and low-risk | Minimal — this is a repeat of a successful pattern, not new territory | Low | Proceed with confidence |

---

## What Happens If We Deploy Now

At low traffic, order placement works correctly and quickly. As traffic approaches even a fraction of the Black Friday target, shoppers will experience escalating delays when placing orders — the final, most critical step of a purchase. Unlike some other issues found in this project, this one does not produce error messages; it simply gets slower and slower, which can be just as damaging to completed sales, since shoppers may give up waiting.

---

## What Needs to Happen Before Go-Live

- **Apply the same scaling fix already used for the shopping cart system** — allow the order-placement service to use multiple processes instead of just one. This is a well-tested, low-risk change since it already solved an identical problem elsewhere in this project.
- **Re-test after the fix** to confirm the new capacity ceiling and determine how much further work, if any, is needed to reach the Black Friday target.

---

## What We Can Defer

- **Adding direct database visibility for the order-placement database** — useful for future investigations, but not blocking, since current evidence suggests the database itself is not the limiting factor.

---

## Decision Required

| Option | What It Means | Risk |
|---|---|---|
| **Apply the proven fix and re-test (recommended)** | A low-risk, already-validated configuration change (the same one that worked for the shopping cart), followed by a retest. | Low — repeat of a successful, well-understood fix |
| **Ship current state and monitor in production** | Leaves a known, large capacity gap (14-15x) unaddressed going into the highest-traffic period of the year. | High — direct risk to completed purchases during peak demand |

**Recommendation:** Apply the clustering fix immediately and re-test. This is the most confidently-recommended fix of any service tested so far in this project, since it is a direct repeat of a change already proven to work.

---

_Performance Report Analysis generated by performance-report-analysis skill · 2026-06-18_
_k6 results: results/2026-06-18_stress_orders/ (Run 1, stopped at Stage 1→2 transition, 181 VUs)_
_Grafana evidence: Prometheus (P95 per route, db_connections_active) · Loki (error scan) · Tempo (span-level trace breakdown)_
_Prompt used: "Read PT-6 to see the description rules / Read the PT-21 (verify the evidences saved in the result orders folder and Grafana evidences on PT-16 to orders.test.js stress test, comparing the executions if there is more than one for the same service), verify the analysis checklist and run the skill performance-report-analysis to generate a technical and business report. / Use MCP Grafana to query all of the following in parallel: 1. P95 of the service in the same period of the test 2. Error rate in the same period of the test 3. DB connection pool peak usage 4. Errors in Loki for the service in that window 5. If errors found: get the traceId of the most frequent and open it in Tempo - what span is the bottleneck? / Then tell me: what is the root cause of the most critical problem and what would you fix first? / Include the business and technical report generated with performance-report-analysis skills as comment in the PT-21 also Specify the Performance Report Analysis is for orders.test.js / Include screenshot from Grafana, Tempo and Loki as evidence if needed / Include in the ticket comment the prompt used / Generate the output accordingly PT-16 / Commit and push changes to https://github.com/almeidas-tatiane/poleras-store-k6"_
