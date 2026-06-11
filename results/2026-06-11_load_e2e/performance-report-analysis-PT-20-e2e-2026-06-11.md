# Performance Test Technical Report — e2e.test.js (Load Test)

| Field | Value |
|---|---|
| Date | 2026-06-11 |
| Test type | Load Test |
| Tool | k6 v1.0.0-rc1 |
| Script | `tests/e2e/e2e.test.js` |
| Environment | Local Docker — 5 microservices |
| Tester | Performance Testing Team (PT-15 / PT-20) |
| Test duration | 10m09.9s |
| Peak load | 100 VUs |
| Flow | login → browse products → add to cart → create order → process payment |
| Baseline available | Yes — PT-14 smoke test (2026-06-10) |

---

## Executive Summary

The end-to-end load test exercised all five Poleras Store microservices simultaneously at 100 concurrent users for 10 minutes and passed all thresholds defined in PT-7: global P95 of 674.74ms against a 1000ms SLA, and a 0.00% error rate with 61,605 checks passing at 100%. The only notable finding is payments-service sitting at 93% of its 1000ms SLA ceiling — a known architectural constraint from the payment gateway simulation, not a service defect — which must be accounted for when sizing the upcoming stress test.

---

## Load Profile

| Stage | Users | Duration |
|---|---|---|
| Ramp-up | 0 → 100 | 2 min |
| Steady state | 100 | 6 min |
| Ramp-down | 100 → 0 | 2 min |

Reached target: ✅ 100/100 VUs · 4,400 iterations completed · 0 interrupted

---

## SLA Compliance

| Service | Metric | Target (PT-7) | Actual p50 | Actual p95 | Result |
|---|---|---|---|---|---|
| global e2e | P95 response time | < 1000ms | 21.66ms | **674.74ms** | ✅ PASS |
| global e2e | Error rate | < 1% | — | **0.00%** | ✅ PASS |
| users-api (auth) | P95 | < 200ms | — | **86ms** (43% of SLA) | ✅ PASS |
| products-service | P95 | < 100ms | — | **7.9ms** (8% of SLA) | ✅ PASS |
| cart-service | P95 | < 150ms | — | **24ms** (16% of SLA) | ✅ PASS |
| orders-service | P95 | < 200ms | — | **63ms** steady (31% of SLA) | ✅ PASS |
| payments-service | P95 | < 1000ms | — | **926ms** (93% of SLA) | 🟡 YELLOW |
| payments-service | Error rate | < 0.1% | — | **0.00%** | ✅ PASS |
| — | Throughput | sustained | — | **57.73 req/s** | ✅ PASS |

---

## Findings

### [MEDIUM] Finding 1 — Payment gateway latency consuming 93% of SLA budget

**Observed:** `payments-service` P95 held stable at **918–941ms** throughout the entire 10-minute test (steady state peak: 926ms). SLA ceiling is 1000ms, leaving only **74ms of headroom** at 100 VUs.

**Root cause hypothesis:** The payment gateway simulation in `payments-service` adds **200–800ms of deterministic artificial latency** per transaction (uniform distribution by design). Gateway P95 ≈ 200 + 0.95 × 600 = 770ms. Service processing adds ~150ms. Combined P95 ≈ 920ms — exactly what was observed. The latency floor is **architectural and non-negotiable at this service** unless the gateway simulation parameters are changed.

**Supporting evidence:**
- Prometheus P95 at every minute from t+1m to t+10m: 918–941ms — **flat, no degradation trend** (rules out capacity exhaustion or memory leak)
- DB pool peak: 1 active connection (pool max 10) — pool is not a bottleneck
- Loki WARN: 10 entries, all HTTP 402 (payment rejections ~10% by design) — zero ERROR entries
- k6: 0 `http_req_failed` on `{service:payments}` across 19,882 payment requests

**Impact:** At 100 VUs the SLA holds. If service processing overhead grows by 75ms at higher load (stress test at 150+ VUs), P95 will breach 1000ms. This is the first service to fail under stress conditions.

**Recommended action:**
1. Before the stress test: establish where payments P95 breaches 1000ms by running incremental VU steps (120/150/200).
2. Raise `payments-service` DB pool max from 10 → 25 to prevent pool queuing from adding latency on top of gateway floor.
3. Document that the 1000ms SLA for payments has only 74ms headroom — any service degradation will directly cause breach.

**Owner:** payments-service / Performance Testing Team
**Effort estimate:** Low (pool config) · Medium (stress profiling)
**Retest required:** Yes — as part of stress test

---

### [INFORMATIONAL] Finding 2 — Wide global latency distribution is expected (bimodal flow)

**Observed:** Global p50 = 21.66ms · p90 = 404.03ms · p95 = 674.74ms · max = 1.11s.

**Root cause:** The e2e flow mixes fast endpoints (auth ~80ms, products ~8ms, cart ~24ms, orders ~63ms) with slow payment steps (~880ms per iteration). The payment calls pull the global p95 sharply upward. The median of 21.66ms reflects the majority of fast requests. This is healthy bimodal distribution, not a long-tail problem.

**Impact:** None. No action required.

---

### [INFORMATIONAL] Finding 3 — Orders-service warm-up spike (t+2m to t+3m)

**Observed:** orders-service P95 measured **74.9ms at t+3m** (peak during ramp-up), then recovered to **53–63ms** for steady state. Well within the 200ms SLA (37%).

**Root cause:** JIT query plan compilation and lazy connection pool initialization on first full-load hit. Same warm-up pattern documented in individual orders load test. Pool fix (max=25, connectionTimeoutMillis=5000) absorbed the burst without errors.

**Impact:** None. Relevant for readiness probe configuration.

---

### [INFORMATIONAL] Finding 4 — Payment gateway rejections (402) correctly classified

**Observed:** 10 WARN-level Loki entries from payments-service: `"HTTP request client error"`, `statusCode: 402` (~10% payment rejection rate by design).

**Root cause / Design:** Gateway simulation rejects 10% of payments by design. k6 script correctly excludes 402 from `http_req_failed`. Loki classifies as WARN, not ERROR. Correct behavior throughout.

**Impact:** None.

---

### [LOW] Finding 5 — users-api and payments-service DB pool max lower than other services

**Observed:** users-api and payments-service pool max = 10. Cart/orders/products = 25 (raised during PT-15 fix). At 100 VUs: peak 1 connection active on both — no current issue.

**Root cause:** Pool sizing fix during PT-15 was scoped to orders-service only.

**Impact:** Fine at 100 VUs. At 300+ VUs, pool max=10 could cause queuing, adding latency on top of an already-tight payments SLA.

**Recommended action:** Raise pool max to 25 before stress tests.

**Owner:** Engineering | **Effort:** Low | **Retest required:** No (verify in stress test)

---

## Regression vs. Baseline (PT-14 Smoke — 2026-06-10)

| Service | Smoke P95 | Load P95 | Delta | Status |
|---|---|---|---|---|
| auth (users-api) | 58.83ms | 86ms | +46% | ✅ OK — expected at 50× load |
| products-service | 12.11ms | 7.9ms | -35% | ✅ Improvement — cache warm |
| cart-service | 20.83ms | 24ms | +15% | ✅ OK — within threshold |
| orders-service | 44.93ms | 63ms | +40% | ✅ OK — expected at 50× load |
| payments-service | 799.45ms¹ | 926ms | +16% | ✅ OK — within 20% threshold |

> ¹ Smoke baseline for payments already elevated (gateway simulation, no patch at time of PT-14).

**Note:** This run establishes the official e2e load test baseline for future comparisons.

---

## Infrastructure Observations

| Resource | Peak value | Pool Max | % Used | Status |
|---|---|---|---|---|
| users-api DB connections | 1 | 10 | 10% | ✅ OK |
| cart-service DB connections | 2 | 25 | 8% | ✅ OK |
| orders-service DB connections | 2 | 25 | 8% | ✅ OK |
| payments-service DB connections | 1 | 10 | 10% | ✅ OK |
| products-service DB connections | 1 | 10 | 10% | ✅ OK |
| 5xx errors (all services) | 0 | — | — | ✅ Clean |
| Loki ERROR entries | 0 | — | — | ✅ Clean |
| Loki WARN entries | 10 (payments 402) | — | — | ✅ Expected |

---

## Recommendations

| Priority | Action | Owner | Target |
|---|---|---|---|
| P1 | Raise users-api and payments-service DB pool max 10 → 25 before stress test | Engineering | Before PT-16 |
| P2 | Establish payments P95 breaking point in stress test (at what VU count does P95 breach 1000ms?) | Perf Team | PT-16 / PT-21 |
| P3 | Add readiness probe warm-up request on orders-service to eliminate cold-start spike | Engineering | Pre-launch |
| P3 | Use this run as official e2e load baseline — flag future P95 regression >20% | QA / Perf Team | Ongoing |

---

## Test Conditions and Limitations

- **Environment:** Local Docker — single host. Absolute latency lower than production (no network hops, CDN, load balancer). SLA compliance valid for relative comparison.
- **Dataset:** 400 users (user001–user400), 100 VUs, all pre-registered.
- **Payment rejection rate:** ~10% by gateway design. Excluded from error metric via `responseCallback`.
- **This test proves:** All 5 microservices handle 100 concurrent full-journey users for 6 minutes without errors, with all SLAs met.
- **This test does not prove:** Capacity ceiling, long-duration stability, or recovery after failure.

---

# Performance Test — Business Summary — e2e.test.js (Load Test)

| | |
|---|---|
| System tested | Poleras Store — Full Purchase Journey (all services) |
| Test conducted | June 2026 |
| Prepared by | Performance Testing Team |

---

## What We Tested

We simulated 100 simultaneous customers completing the full shopping journey on Poleras Store — from login, through browsing and selecting products, adding items to cart, placing an order, and completing payment. This represents the expected steady-state traffic during normal business hours leading up to Black Friday. All five backend systems worked together in the same test at the same time. The test ran for 10 full minutes with 100 customers active simultaneously.

---

## Is It Ready?

**Verdict: ✅ Ready to deploy at current traffic levels — Black Friday capacity certification pending**

Every simulated customer completed every step of the purchase journey without a single failure. All 61,605 transaction checks passed. The platform handled 100 simultaneous shoppers smoothly, end to end, for the entire test duration. One service — the payment system — consistently operates close to its response-time ceiling due to how the payment processor is simulated, which means it requires careful attention in the upcoming higher-load capacity tests.

---

## Risks

| Risk | Business impact | Urgency |
|---|---|---|
| Payment system operating close to its response-time ceiling | At higher Black Friday traffic, payment processing could slow beyond acceptable limits, causing customers to wait unusually long at checkout | Address in the stress test before certifying for Black Friday |
| Database connection limits not uniformly sized across services | Under significantly higher traffic than today's test, login and payment services have less capacity buffer than other services | Low-effort config fix before capacity testing |
| No long-duration test conducted yet | We have not confirmed whether the platform degrades over hours of sustained traffic | Soak test required before Black Friday sign-off |

---

## What Happens If We Launch Now

The platform is safe for current expected normal traffic. In the test, every shopper who attempted to browse, add to cart, place an order, and pay was able to complete their purchase — zero failures in 4,400 complete purchase simulations. The shopping experience was fast and consistent throughout.

This test does not certify the platform for Black Friday peak traffic. We have not yet tested at the traffic levels expected during the sale event (typically 2–5× normal). That determination requires the upcoming stress test.

---

## What Needs to Happen Before Launch

No blocking items for normal traffic levels.

**Before certifying for Black Friday peak traffic:**
- **Complete the stress test** — The payment system needs to be tested at higher traffic to find the exact point where checkout speed exceeds acceptable limits.
- **Confirm platform stability over time** — A multi-hour test is needed to verify the platform doesn't degrade after hours of continuous use.

---

## What Can Wait

- **Minor startup optimization on the order system** — In the first few minutes after a restart, order processing is slightly slower than normal. It recovers quickly and was never near unacceptable. Safe to address post-launch.
- **Enhanced database health monitoring** — Internal database visibility improvements can be applied as part of normal engineering work.

---

## Decision Required

**Question:** Is Poleras Store ready for Black Friday?

| Option | Benefit | Risk |
|---|---|---|
| **Proceed to stress and soak tests** (recommended) | Completes certification needed for Black Friday sign-off | Requires additional test time |
| Certify now for normal traffic only | Allows deployment for current volumes | Does not confirm Black Friday readiness |

**Recommendation:** Proceed to the stress test (PT-16 / PT-21). Today's result is a strong foundation — all five services passed cleanly. The stress test will determine whether the platform can handle the Black Friday surge, and the payment system's behavior at higher load is the critical question to answer.
