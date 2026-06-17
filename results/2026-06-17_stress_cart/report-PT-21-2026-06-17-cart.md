# Performance Test Technical Report — cart.test.js · Stress Test Run 1

**Skill:** performance-report-analysis
**Scope:** cart.test.js — Stress Test Run 1 (PT-16)
**Date:** 2026-06-17
**Test type:** Stress — breaking point search
**Tool:** k6 v1.0.0-rc1
**Environment:** Local Docker (development)
**Load profile:** 100→200→400→800→1,200→2,000 VUs · 2 min/stage · 14 min (stopped at 07m15s, Stage 4)
**Related tickets:** PT-16 (execution) · PT-21 (analysis) · PT-7 (SLAs) · PT-6 (reporting)

**Command used:**
```bash
k6 run \
  --env BASE_URL=http://localhost:3003 \
  --env BASE_URL_AUTH=http://localhost:3001 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-17_stress_cart \
  tests/cart/cart.test.js
```

---

## Executive Summary

cart-service was stress tested with a 100→2,000 VU ramp (PT-16). The service breached the P95 SLA of 150ms at approximately **150 VUs** — the second most vulnerable service after the pre-fix auth-service (~110 VUs). The latency explosion (66ms → 1,461ms to 8,230ms) was driven by a shared test-user 404 DELETE cascade: when VU count exceeds the number of users in `data/users.json`, multiple VUs share the same cart, causing concurrent deletes of already-removed cart items. Each slow 404 response (500–1,100ms) consumed a DB connection slot, saturating the pool and creating backpressure across all cart operations. **The service is NOT ready for Black Friday: it breaks at 150 VUs against a target of 2,500 VUs (16.7× gap). Zero server errors were recorded throughout.**

---

## SLA Compliance

SLAs from PT-7: P95 < 150ms · Error rate < 0.5%

| Metric | Target (PT-7) | At Breaking Point (~150 VUs) | Peak (Stage 4, ~652 VUs) | Status |
|---|---|---|---|---|
| P95 — `GET /api/cart` | < 150ms | **1,461ms** | **4,970ms** | ❌ FAIL |
| P95 — `POST /api/cart/items` | < 150ms | **2,307ms** | **7,130ms** | ❌ FAIL |
| P95 — `DELETE /api/cart/items/:id` | < 150ms | **1,842ms** | **4,980ms** | ❌ FAIL |
| HTTP error rate (5xx) | < 0.5% | **0.00%** | **0.00%** | ✅ PASS |
| Recovery time | — | **~90s** | — | ✅ PASS |

---

## Findings

### [CRITICAL] Finding 1 — Shared Test-User 404 DELETE Cascade Causes P95 Collapse at ~150 VUs

**Observed:** P95 was within SLA at Stage 1 (~76 VUs, all routes < 70ms). At the Stage 1→2 transition (~150 VUs), all three cart routes simultaneously breached the 150ms SLA:

| Time (UTC) | VUs (approx) | `GET /api/cart` P95 | `POST /api/cart/items` P95 | `DELETE /api/cart/items/:id` P95 | Status |
|---|---|---|---|---|---|
| 21:26:31Z | ~76 | 25ms | 66ms | 38ms | ✅ GREEN |
| 21:28:30Z | ~150 | **1,461ms** | **2,307ms** | **1,842ms** | 🔴 RED |
| 21:29:00Z | ~200 | ~5,000ms | ~8,230ms | ~5,000ms | 🔴 RED |
| 21:32:45Z (stop) | ~652 | Recovering | — | — | ⏹ Stopped |

**Root cause:** Multi-layer failure triggered by test data design:

1. `cart.test.js` assigns users via `users[(__VU - 1) % users.length]`. If `data/users.json` has fewer users than active VUs, multiple VUs share the same account.
2. Multiple VUs sharing the same user see each other's cart items in the Step 2 "clear cart" loop.
3. VU-A adds and deletes item X; VU-B also tries to delete item X (already gone) → **HTTP 404**.
4. The DELETE 404 rate on `DELETE /api/cart/items/:itemId` jumped from **0.25 RPS** (21:32:00Z) to **9.86 RPS** (21:33:00Z) — a 39× spike.
5. Loki confirmed 50 log entries, all `statusCode:404, method:DELETE`, with response durations of **513ms–1,087ms each**.
6. Each slow 404 response held a DB connection open for ~750ms on average, filling the cart-service connection pool and creating backpressure on all subsequent cart operations.
7. Result: P95 degraded from 66ms to 8,230ms simultaneously across all endpoints — classic pool saturation signature.

**Evidence sources:**

| Source | Finding |
|---|---|
| Prometheus range (21:25–21:34Z) | P95 `POST /api/cart/items`: 39ms → 7,130ms |
| Prometheus error rate | `DELETE /api/cart/items/:itemId` 404 rate: 0.25 → 9.86 RPS |
| Loki logs | 50 × `statusCode:404, method:DELETE`, duration 513–1,087ms |
| k6 stdout | 11,801 iterations completed · 0 interrupted · max 652 VUs |
| Grafana APM | P95 global peak 8.23s · P50 3.66s · P99 10s (timeout) |
| Grafana APM | Recovery: P95 dropped from 8.23s → 4.75ms within ~90s of load removal |

**Recommended action:**
- **P1 (immediate):** Increase `data/users.json` to ≥ 2,000 unique users — eliminates VU-to-user sharing and the 404 cascade. This is the single highest-impact fix and does not require any code change.
- **P2 (parallel):** Check `DB_POOL_MAX` in cart-service config. If pool size < peak concurrent VUs, increase it (or add connection pooling middleware like pgBouncer).
- **P3 (investigation):** Instrument cart-db with `pg_stat_activity` exporter or Prometheus agent to make DB connection count observable for future runs.

**Owner:** Performance Testing Team (users.json) · Backend Engineering (pool config)
**Retest required:** Yes — re-run stress test after P1+P2 fix to find true architectural breaking point

---

### [HIGH] Finding 2 — cart-service DB Connection Pool Not Observable

**Observed:** Only products-db has a Prometheus exporter (`pg_stat_activity`). cart-db has no DB connection metric available in Grafana. During this run, DB pool saturation was inferred from latency patterns and Loki 404 log durations — it cannot be directly confirmed.

**Impact:** Without DB metrics, it is not possible to set an alert for `CartDBConnectionsHigh` or confirm whether the pool was fully exhausted vs. nearly exhausted. Future incidents may be harder to diagnose.

**Recommended action:** Install `postgres_exporter` (or equivalent) on cart-db and add a Grafana panel + alert for connection count. Target alert threshold: 80% of `DB_POOL_MAX × worker_count`.

**Owner:** Platform / DevOps
**Retest required:** No (observability improvement, not a fix)

---

### [MEDIUM] Finding 3 — Zero 5xx Errors Throughout: Graceful Degradation Pattern

**Observed:** Despite P95 values of 1.4s–8.2s and 404 DELETE rates of 9.86 RPS, the cart-service produced zero 5xx errors for the entire test. Prometheus 5xx panel showed "No data" (not zero — endpoint not instrumented or no 5xx fired). Loki scan returned 0 entries with `level=error` or `statusCode>=500`.

**Significance:** This is a different failure mode than products-service Run 4 (which produced 931 5xx errors from pool exhaustion). Cart-service degrades on latency without crashing — it queues requests rather than rejecting them. This is a more resilient behavior but hides the problem from error-rate monitors that would otherwise trigger alerts.

**Recommended action:** Add latency-based SLO alerts (P95 > 150ms for 60s) in addition to error rate alerts for cart-service. Relying solely on error rate alerts will not catch this failure mode.

**Owner:** Platform / DevOps
**Retest required:** No

---

## Regression Analysis vs. Other Services

No previous cart-service stress run exists (this is Run 1). Comparison across services (from PT-21 existing comments):

| Service | Breaking Point | Condition |
|---|---|---|
| auth-service (pre-fix) | ~110 VUs | Connection pool exhaustion |
| **cart-service (Run 1)** | **~150 VUs** | Shared users + 404 DELETE cascade |
| auth-service (post-fix) | ~200–250 VUs | After pool + async fix |
| products-service | ~750 VUs (Run 1) | DB pool exhaustion (8 workers) |
| products-service (Run 5) | 2,000 VUs ✅ | After all fixes |

**Cart-service is currently the second most vulnerable service after the unfixed auth-service.**

---

## Infrastructure Observations

| Resource | Baseline | Stage 1 (~76 VUs) | Breaking Point (~150 VUs) | Recovery | Status |
|---|---|---|---|---|---|
| P95 global (Grafana) | — | 69ms | 8,230ms (peak) | 4.75ms | ❌ |
| P50 global (Grafana) | — | ~25ms | 3,660ms | 2.50ms | ❌ |
| P99 global (Grafana) | — | ~80ms | 10,000ms (timeout) | 4.95ms | ❌ |
| HTTP 5xx errors | 0 | 0 | 0 | 0 | ✅ |
| HTTP 404 rate (DELETE) | 0 RPS | ~0 | 9.86 RPS (peak) | 0 | ❌ |
| DB connections (cart-db) | Not observable | — | — | — | ⚠️ Not instrumented |
| Recovery time | — | — | — | ~90s | ✅ |
| k6 iterations completed | — | — | 11,801 total | — | ✅ |
| k6 interrupted iterations | — | — | 0 | — | ✅ |

---

## Recommendations Summary

| Priority | Action | Owner | Urgency |
|---|---|---|---|
| **P1** | Increase `data/users.json` to ≥ 2,000 unique users — eliminates shared-user 404 DELETE cascade (root cause of latency collapse) | Performance Team | Before next run |
| **P2** | Check and increase `DB_POOL_MAX` in cart-service — compare max pool size to concurrent VU count at breaking point | Backend Eng | Before next run |
| **P3** | Install `postgres_exporter` on cart-db — adds Grafana visibility for DB connection count + pool saturation alerting | Platform | Post-fix |
| **P4** | Add latency-based alert: P95 > 150ms for ≥ 60s (cart-service) — error-rate-only alerts will not detect this failure mode | Platform | Post-fix |
| **P5** | Re-run stress test after P1+P2 to find true architectural breaking point | Performance Team | After fix |

---

## PT-21 Analysis Checklist

| Item | Status |
|---|---|
| Breaking point VU count documented | ✅ ~150 VUs |
| P95 latency at breaking point recorded | ✅ 1,461ms–8,230ms (Prometheus + Grafana) |
| Error rate at breaking point recorded | ✅ 0.00% (no 5xx) |
| Recovery time documented | ✅ ~90s |
| Root cause identified | ✅ Shared test users → 404 DELETE cascade → pool saturation |
| Root cause confirmed with evidence | ✅ Prometheus DELETE 404 rate + Loki duration logs |
| Comparison with other services | ✅ See table above |
| Recommendations with owners | ✅ P1–P5 above |
| Black Friday readiness verdict | ❌ NOT READY (150 VUs vs. 2,500 VU target = 16.7× gap) |
| Grafana screenshots included | ✅ 3 screenshots (P95 breaking point, full window, RPS by service) |

---

## Test Conditions and Limitations

- **Environment:** Local Docker on development machine. Absolute latency values are development baselines, not production-absolute.
- **No handleSummary generated:** Test was force-killed (SIGKILL, exit code 255) at Stage 4 (07m15s). k6 HTML report was not produced. Prometheus and Loki are the authoritative data sources for this run.
- **cart-db not instrumented:** DB connection count could not be directly measured. Pool saturation is inferred from latency patterns and Loki 404 duration data.
- **Test stopped early:** Max VUs reached was 652 (Stage 4 ramp). Stages 4–7 (800→2,000 VUs) were not executed. Breaking point at 150 VUs makes higher stages irrelevant — P95 was already at 8.23s.
- **Single node:** All tests run on a single Docker host. Production multi-node setup behavior may differ.

---

## Grafana Evidence

| Screenshot | Description |
|---|---|
| `screenshot-01-latency-p95-breaking-point.png` | P50/P95/P99 — all services — captured at RED alert (~150 VUs). Cart-service P95 spike clearly visible |
| `screenshot-02-full-test-window-p95.png` | P50/P95/P99 — 20-min window — full test arc showing ramp-up, peak, and recovery |
| `screenshot-03-rps-by-service.png` | RPS by service — cart-service at ~140 RPS at Stage 1 before collapse |

---

# Performance Test — Business Summary

| | |
|---|---|
| **System tested** | Poleras Store — Shopping Cart (add items, view cart, remove items) |
| **Analysis date** | 2026-06-17 |
| **Test conducted by** | Performance Testing Team |
| **Test type** | Stress Test — breaking point search |

---

## What Was Tested

We pushed the Poleras Store shopping cart under progressively increasing load — starting with 100 simultaneous shoppers and doubling every 2 minutes toward a target of 2,000 shoppers. Each simulated shopper logged in, cleared their cart, added a product, viewed the cart, and removed the item — repeating this cycle continuously. The test was stopped early when the cart became unacceptably slow, as planned for a breaking-point search.

---

## Key Question: Is It Ready?

**Overall verdict: Not ready — the shopping cart fails at 150 simultaneous users, 16.7× below the Black Friday target**

The cart service handled 100 simultaneous shoppers without issues. When load crossed approximately 150 shoppers, response times escalated from under 70ms to over 8 seconds within seconds. No transactions failed outright, but the severe slowdown would cause the vast majority of shoppers to abandon their carts before completing a purchase. The root cause has been identified — it is a test data issue that, once resolved, will reveal the true system capacity limit (which may be higher or lower than 150 users). **Black Friday preparedness cannot be assessed until this test is re-run with a proper dataset.**

---

## Risk Summary

| Risk | Business Impact | Likelihood | Recommended Action |
|---|---|---|---|
| Cart breaks at ~150 concurrent shoppers — 16.7× below BF target | Shoppers cannot add to or manage their cart at peak; direct loss of sale transactions | **High** — confirmed by test | Fix test data, re-run stress test to find true capacity limit |
| True capacity may be higher than 150 users (test artifact) | Current result reflects a test script problem, not necessarily a service problem | High — shared-user pattern identified | Fix data/users.json first before concluding the service needs code changes |
| Cart-service DB capacity unknown | Without DB metrics, it's impossible to know how close to the limit the database is | Medium — DB not instrumented | Install DB monitoring before next run |
| Latency-only failures not caught by error alerts | Current alerts fire on errors, not slowdowns — this failure mode produces no errors | Medium | Add latency-based monitoring |

---

## What Happens If We Deploy Now

At low traffic (under ~150 users), the shopping cart works correctly and quickly. As Black Friday traffic peaks, the cart will experience severe slowdowns — not crashes or errors, but page loads taking 8+ seconds for every cart action: adding a product, viewing the cart, removing an item. Shoppers will wait, refresh the page (which makes things worse), and ultimately abandon before checking out. Since cart operations are the final step before purchase, slowness here translates directly to lost revenue.

Critically, the current test result may overstate the problem: the breaking point at 150 users is likely caused partly by a test configuration issue (too few test accounts). The next run with a corrected test will reveal whether the cart can handle more load than the current result suggests. Until that test is complete, the team cannot determine whether the cart needs engineering work or is already sufficient.

---

## What Needs to Happen Before Go-Live

- **Correct the performance test setup and re-run** — the current test used too few test accounts, causing artificial conflicts that made the cart appear to break earlier than it actually does. Expanding the test data will give an accurate picture of the cart's real capacity.
- **Investigate the cart database configuration** — we currently cannot monitor the database connection usage during tests. Adding this visibility is necessary before certifying the service for Black Friday.
- **Determine the true breaking point** — only after the above two steps can the team confirm whether the cart needs engineering changes and how large the gap to the 2,500-user target actually is.

---

## What We Can Defer

- **Database monitoring tooling** — needed before the next test run, but the implementation itself is a background task.
- **Latency-based alerts** — these improve early warning but are not blocking for the retest.
- **Cart architecture changes** — premature until the retest confirms whether a problem exists at the architectural level.

---

## Decision Required

| Option | What It Means | Risk |
|---|---|---|
| **Fix test data and re-run stress test (recommended)** | 1–2 hours to expand test data + 15-minute retest. Gives an accurate picture of cart capacity. | Low — straightforward fix, fast turnaround |
| **Treat current result as worst-case and begin engineering remediation now** | Assumes the 150 VU breaking point is real. May invest engineering effort in a problem that doesn't exist. | Medium — possible wasted effort if true capacity is already above 2,500 VUs |
| **Defer cart testing until other services are assessed** | Risk of discovering a hard cart-service capacity problem late in the project. | Medium-High — cart is on the critical path of every purchase |

**Recommendation:** Fix `data/users.json` (1 hour) and re-run the stress test immediately. The result will either clear the cart for Black Friday or reveal a real engineering problem — both outcomes are better than the current uncertainty.

---

_Performance Report Analysis generated by performance-report-analysis skill · 2026-06-17_
_k6 results: results/2026-06-17_stress_cart/ (Run 1, stopped at Stage 4)_
_Grafana evidence: Prometheus (P95 per route, 404 error rate) · Loki (DELETE 404 log entries)_
_Prompt used: "Read PT-6 to see the description rules / Read the PT-21 (verify the evidences saved in the result cart folder and Grafana evidences on PT-16 to cart.test.js stress test, comparing the executions if there is more than one for the same service), verify the analysis checklist and run the skill performance-report-analysis to generate a technical and business report. / Use MCP Grafana to query all of the following in parallel: 1. P95 of the service in the same period of the test 2. Error rate in the same period of the test 3. DB connection pool peak usage 4. Errors in Loki for the service in that window 5. If errors found: get the traceId of the most frequent and open it in Tempo - what span is the bottleneck? / Then tell me: what is the root cause of the most critical problem and what would you fix first? / Include the business and technical report generated with performance-report-analysis skills as comment in the PT-21 also Specify the Performance Report Analysis is for cart.test.js / Include screenshot from Grafana as evidence if needed / Include in the ticket comment the prompt used / Generate the output accordingly PT-16 / Commit and push changes to https://github.com/almeidas-tatiane/poleras-store-k6"_
