# Performance Test Technical Report

| Field | Value |
|---|---|
| Date | 2026-06-19 |
| Test type | Smoke, Load, Stress, e2e (consolidated, cross-service) — Spike/Endurance not executed |
| Tool | k6 (Grafana) |
| Environment | Local Docker — 5 microservices + nginx LB + Prometheus + Loki + Tempo |
| Tester | Performance Testing Team |
| Test duration | Smoke ~1-2min · Load ~10min · Stress ~14min (per run) |
| Peak load tested | 2,000 VUs (Stress); Black Friday target is 2,500 VUs |
| Baseline available | Yes — cart-service Run 7 (12-worker config) is the baseline for today's Run 10 regression check |

---

## Executive Summary

All 5 microservices (users-api, products-service, cart-service, orders-service, payments-service) plus the full end-to-end purchase flow were tested across Smoke, Load, and Stress profiles; Spike and Soak were not executed due to time constraints. Smoke and Load (steady ~100 VUs) pass cleanly on every service. **Stress testing (the test that matters for the 2,500-VU Black Friday target) shows every service's real breaking point sits 7-12x below target**, with two independent, unresolved root causes: cart-service's host-wide CPU oversubscription (which cascades into orders-service and payments-service) and products-service's separate cluster-master IPC saturation, which appears specifically at the 2,500-VU target itself.

---

## Load Profile

| Stage | Users | Duration | Notes |
|---|---|---|---|
| Smoke | 2-5 | 30-60s | Validates script correctness, not capacity |
| Load | 100 (e2e: 100) | 10min steady | Black-Friday-adjacent steady state |
| Stress | 100→2,000 | 14min (7×2min stages) | Breaking-point search, per PT-16 |
| Spike | — | — | **Not executed** (PT-17, closed without execution) |
| Soak | — | — | **Not executed** (PT-18, closed without execution) |

---

## SLA Compliance — per service × test type

| Service | Smoke | Load (~100 VU) | Stress (breaking point) |
|---|---|---|---|
| **users-api** (P95<200ms, err<0.5%) | P95 58.8ms — PASS | P95 79ms PASS / err 0.76% **FAIL*** | Breach onset ~200-250 VUs; 0% errors through full 2,000 VUs |
| **products-service** (P95<100ms, err<0.5%) | P95 12.1ms — PASS | P95 9.7ms / err 0% — PASS | PASS through 2,000 VUs (44ms) — **FAIL at 2,500 VUs** (P95 3.45-4.6s, err 0%) |
| **cart-service** (P95<150ms, err<0.5%) | P95 20.8ms — PASS | P95 43.9ms / err 0% — PASS | Breach onset ~317-380 VUs; 0% errors (graceful) |
| **orders-service** (P95<200ms, err<1%) | P95 44.9ms — PASS | P95 75.9ms / err 0% — PASS (post DB-pool fix) | Connection-reset onset ~237-325 VUs |
| **payments-service** (P95<1000ms**, err<0.1%) | P95 799ms vs revised SLA — PASS | P95 879.5ms / err 0% — PASS | Own bottleneck fixed; ceiling ~245-361 VUs (inherited cascade) |
| **e2e full flow** (P95<1000ms, err<1%) | P95 526ms — PASS | P95 674.7ms / err 0% — PASS (100 VUs) | **FAIL** — P95 14.59s (err 0.81% PASS) |
| Spike | — | — | **Not executed** |
| Soak | — | — | **Not executed** |

\* Root cause: a missing seeded test user (data defect), not a capacity/latency issue — does not affect the go/no-go verdict.
\** Original PT-7 SLA was 300ms; revised to 1000ms on 2026-06-11 since the payment gateway simulation has a designed 200-800ms delay.

---

## Findings

### CRITICAL — Finding 1: cart-service breaks at ~317-380 VUs due to host-wide CPU oversubscription

**Observed:** P95 breach onset at ~317-380 VUs (vs the 150ms SLA), with P95 climbing into the multi-second range well before the 2,500-VU target. 10 dedicated stress runs conducted.

**Root cause hypothesis:** Confirmed (not hypothesis) via direct V8 CPU profiling — cart-service's 12 worker processes were 91.7% idle at saturation, ruling out expensive application code. The host has only 16 logical cores but runs 50+ clustered Node worker processes across cart/orders/products/payments plus 4 Postgres instances, Redis, and the full observability stack — workers are scheduled-out waiting for a core, which is invisible to a CPU profiler but shows up directly as event-loop lag.

**Supporting evidence:** `nodejs_eventloop_lag_p99_seconds{job="cart-service"}` climbing in lockstep with P95 across every run; V8 `.cpuprofile` showing 91.7% `(idle)` time; today's Run 10 (DB-pool-rebalanced, unconfounded retest) showed P95 2.7x worse than the Run 7 baseline at the identical elapsed time/VU count, ruling out the leading fix candidate (see Regression section below).

**Impact:** Cart operations (add/view/remove items) become multi-second under load well below the Black Friday target; orders-service and payments-service both inherit this delay through their own dependency on cart-service.

**Recommended action:** Profile event-loop time under combined multi-service load (not single-service isolation, which this profiling so far has used); evaluate horizontal scaling across multiple hosts as an alternative to vertical worker-count tuning, which has been ruled out.

**Owner:** Backend Engineering
**Effort estimate:** High (open-ended investigation, not a config change)
**Retest required:** Yes, once a candidate fix is identified

---

### CRITICAL — Finding 2: orders-service inherits cart-service's ceiling via one synchronous call

**Observed:** Connection-reset (EOF) onset plateaued at ~237-325 VUs across 7 stress runs, despite every orders-service-side fix (DNS/threadpool starvation, outbound keep-alive+retry, accept-queue/backlog tuning, critical-path decoupling for background tasks) being applied and verified working exactly as designed.

**Root cause hypothesis:** Confirmed via Tempo trace — the one remaining synchronous call in the order-creation path, `GET /api/cart`, ties up an orders-service worker for however long cart-service takes to respond. A sampled trace showed a 6.9-second `pg-pool.connect` wait *inside cart-service's own handling* of that call, not in orders-service or its database.

**Supporting evidence:** Tempo trace `772b815ed03b9a42114b016cc9c5e811`; orders-service's own DB pool only reached 98.4% at extreme load (1,400+ VUs), ruling it out as the primary constraint at the breach point.

**Impact:** Order creation slows and eventually resets well below target load, independent of any further orders-service-side tuning.

**Recommended action:** No further orders-service-side action available — fully blocked on Finding 1 (cart-service). Retest orders-service only after a cart-service fix lands.

**Owner:** Backend Engineering (blocked)
**Effort estimate:** N/A — blocked
**Retest required:** Yes, after Finding 1 is resolved

---

### CRITICAL — Finding 3: payments-service's own bottleneck is fixed, but it now fully inherits the cart↔orders cascade

**Observed:** Run 1 (unhardened) broke at ~290-452 VUs — the weakest service in the entire stack. Run 2, after the full proven fix playbook (clustering, threadpool tuning, keep-alive, DB pool 25→108 connections), fully resolved payments-service's own bottleneck (DB pool wait dropped from 993ms+724ms to <1ms) — but the overall breaking point barely moved (~245-361 VUs).

**Root cause hypothesis:** Confirmed — payments-service's flow depends on cart-service and orders-service completing first; a fully healthy payments-service still inherits whichever upstream service degrades first.

**Supporting evidence:** Same-window APM data showed orders P95 at 9.1x its own SLA and cart P95 at 4.5x its own SLA during payments-service's Run 2 breach.

**Impact:** Payment processing slows in lockstep with cart/orders, even though payments-service's own code and configuration are no longer the limiting factor.

**Recommended action:** No further payments-service-side action available — fully blocked on Finding 1. Retest only after a cart-service fix lands.

**Owner:** Backend Engineering (blocked)
**Effort estimate:** N/A — blocked, own work complete
**Retest required:** Yes, after Finding 1 is resolved

---

### CRITICAL — Finding 4: products-service has a separate, independent ceiling exactly at the Black Friday target

**Observed:** Handles up to 2,000 VUs cleanly (44ms P95, 0% errors — best-in-class). A dedicated 2,500-VU Black Friday validation test found **sustained, progressive P95 escalation to 3.45-4.6s** (vs <100ms SLA), with 0% errors.

**Root cause hypothesis:** Confirmed via Prometheus + Tempo — the Node.js **cluster master's IPC routing** saturates at sustained 2,500-VU connection rates. Workers themselves stay healthy and fast (45-70ms server-side processing), but requests queue at the master before being routed to a worker. This is a **different mechanism from Finding 1** (cart-service's CPU oversubscription) — fixing one will not fix the other.

**Supporting evidence:** `nodejs_eventloop_lag` for the cluster master sustained at 180-369ms throughout the 2,500-VU steady state (vs a transient spike at 2,000 VUs in the prior run); `http_req_connecting` P95 = 0s (ruling out TCP/network); DB connections stable at 110/150 (ruling out the database).

**Impact:** Product browsing — the very first step of every purchase — degrades severely at the exact traffic level Black Friday is expected to reach, independent of whether the cart/orders/payments cascade is ever fixed.

**Recommended action:** Investigate PM2 cluster mode (separate master/worker event loops, no IPC routing) or `SO_REUSEPORT` + independent processes (no shared master) to remove the master from the request path.

**Owner:** Backend Engineering
**Effort estimate:** Medium
**Retest required:** Yes, a 10-minute 2,500-VU validation re-run after the fix

---

### HIGH — Finding 5: users-api degrades gracefully below target but never crashes — lowest risk in the stack

**Observed:** SLA breach onset ~200-250 VUs, but the service completes the full 2,000-VU stress profile with 0% server-side errors throughout — pure latency degradation, no crashes, no connection drops.

**Root cause hypothesis:** Resolved in an earlier engagement (bcrypt event-loop saturation, fixed via bcrypt cost-factor tuning, threadpool scaling, an in-memory login cache, and horizontal scaling via nginx load balancing) — a 4.3x throughput improvement from a ~110-VU baseline.

**Supporting evidence:** Run 2 (post-fix) report shows 0 interrupted iterations and 0 server-side errors across the full 2,000-VU profile.

**Impact:** Login slows under heavy load but customers are never outright rejected — the least severe finding in this report.

**Recommended action:** No further action required for today's verdict; monitor in production once other services are fixed and a full 2,500-VU run becomes meaningful.

**Owner:** Backend Engineering
**Effort estimate:** Low (already mitigated)
**Retest required:** No — re-validate opportunistically once other blockers clear

---

### CRITICAL — Finding 6: the full purchase-flow chain (e2e) confirms every finding above in combination

**Observed:** The e2e stress test ran its full 14-minute profile to completion (100→2,000 VUs across all 5 services simultaneously). Global error rate passed (0.81% < 1%); global P95 failed badly (14.59s vs <1000ms, ~14.6x over).

**Root cause hypothesis:** Not a new mechanism — a combination of Findings 1-4. Per-service Prometheus breakdown shows payments-service breaking earliest (elevated from as few as ~150-200 e2e VUs), cart-service and orders-service degrading together from ~250-300 e2e VUs (closely matching cart-service's own isolated ~317-380 VU ceiling), while products-service and users-api stay fast throughout (their own ceilings aren't reached by e2e's per-service request rate in this VU range).

**Supporting evidence:** 30-second-step Prometheus P95 series per service over the test window (12:40:48-12:55:11 -03:00); zero data-integrity check failures (`create order: has id/has number`, `payment: has payment_id` all validate correctly when a request completes).

**Impact:** Confirms that the cascade is real under genuine combined load, not an artifact of testing services one at a time.

**Recommended action:** No new action beyond Findings 1-4; re-run this e2e test as the final validation step once those are fixed.

**Owner:** Performance Testing Team
**Effort estimate:** Low (test already built and automated)
**Retest required:** Yes, after Findings 1 and 4 are both resolved

---

## Regression vs. Baseline

| Metric | Baseline (cart-service Run 7, 12 workers) | Current (Run 10, 4 workers, DB pool rebalanced) | Delta | Status |
|---|---|---|---|---|
| P95 at matched VU/time (592 VUs, t+6m57.7s) | 484.9ms | 1,323.8ms | **+173%** | **REGRESSION** |
| Event-loop lag p99 (same point) | 172.8ms | 183.3ms | +6% | REGRESSION (marginal) |
| DB pool usage (same point) | 65% (141/216) | 100% (216/216) | +54% | **REGRESSION** |
| Breach onset (VUs) | ~365-371 | ~317-321 | -13% (earlier) | **REGRESSION** |

**Regression thresholds used:** p95/p99 > 20% increase = regression; any onset-VU decrease = regression. All four metrics regressed. **The `NODE_CLUSTER_WORKERS` 12→4 fix was reverted today** back to the Run 7 baseline configuration across all four backend services (cart/orders/payments/products), since it made cart-service's capacity measurably worse, not better.

---

## Infrastructure Observations

| Resource | Peak value | Threshold | Status |
|---|---|---|---|
| Host logical cores | 16 | — | Fixed constraint |
| Total clustered Node worker processes (current config) | 50 (12+14+12+12) | ~16 (1:1 with cores) | **HIGH — ~3.1x oversubscribed** |
| cart-service DB pool | 100% (216/216) at ≥585 VUs | 80% | **HIGH — saturates well before the 2,500-VU target** |
| cart-service event-loop lag p99 | 358.9ms at full 2,000 VUs | 100ms (informal) | **HIGH** |
| products-service cluster-master event-loop lag | 369ms sustained at 2,500 VUs | 300ms (project-internal trigger) | **HIGH** |
| orders-service DB pool | 98.4% (124/126) at 1,400+ VUs | 80% | HIGH, but only at extreme load (informational) |
| payments-service DB pool (post-fix) | 15% (16/108) | 80% | OK — own bottleneck genuinely resolved |

**Notes:** The host-wide worker-process oversubscription (50 processes / 16 cores) is the single underlying constraint behind Findings 1-3. It was not relieved by reducing worker counts (Finding 1's regression) — the next investigation must address it differently (see Recommendations).

---

## Recommendations

| Priority | Action | Owner | Status |
|---|---|---|---|
| P1 (block release) | Find a working fix for cart-service's CPU/event-loop ceiling — worker-count reduction is ruled out; profile under combined multi-service load or evaluate multi-host scaling | Backend Engineering | Open |
| P1 (block release) | Implement PM2 cluster mode or `SO_REUSEPORT` for products-service to remove the cluster-master IPC bottleneck at 2,500 VUs | Backend Engineering | Open, independent of cart-service work |
| P2 (fix before next cycle) | Retest orders-service and payments-service once a cart-service fix lands — both are fully blocked, not on anything in their own code | Performance Testing Team | Blocked on P1 |
| P3 (monitor in production) | Re-seed/verify the missing test user that caused the auth load test's 0.76% error rate (data defect) | QA / Test Data | Open, low effort |
| P3 (monitor in production) | Schedule the Soak test (50 VUs × 2h) before the real event — the only test type that can catch slow memory leaks or gradual degradation | Performance Testing Team | Deferred today |
| P3 (monitor in production) | Schedule the Spike test (0→2,500 VUs instant) before the real event, to validate instant-surge recovery behavior specifically | Performance Testing Team | Deferred today |

---

## Test Conditions and Limitations

- **Environment:** local Docker Compose, not a production-sized environment — absolute VU numbers may not transfer 1:1 to production hardware, but the *relative* findings (cart-service's CPU ceiling, products-service's IPC ceiling, the cart→orders→payments cascade) are architectural and expected to reproduce.
- **Spike and Soak were not executed today** (PT-17/18/22/30, closed without execution due to time constraints) — this report's findings come from Smoke, Load, Stress, and e2e only. Treat the NO-GO verdict as a lower bound on risk: Soak in particular could surface additional issues (memory leaks, gradual degradation) that none of today's tests would catch.
- **e2e VU counts are not directly comparable to single-service stress VU counts** — an e2e VU drives one request to all 5 services per iteration, while a single-service VU drives repeated requests to just one service. The qualitative finding (payments breaks first, cart/orders together) is the reliable takeaway, not a precise apples-to-apples VU mapping.
- **This test does prove:** the relative ranking of service fragility, the specific root-cause mechanisms for 4 of 5 services, and that today's attempted fix (worker-count reduction) does not work. **This test does not prove:** exact production capacity numbers, long-duration stability, or behavior under instantaneous (rather than gradual) traffic surges.

---

# Performance Test — Business Summary

| | |
|---|---|
| System tested | Poleras Store — online t-shirt store (login, browsing, cart, checkout, payment) |
| Test conducted | June 2026 |
| Prepared by | Performance Testing Team |

---

## What We Tested

We simulated customers logging in, browsing products, adding items to their cart, placing orders, and paying — gradually increasing the number of simultaneous customers from a small handful up to 2,000, to find the point where the system starts struggling. We did this for each part of the store separately and then for the entire shopping journey at once. The goal was to check whether the platform can handle the expected Black Friday peak of 2,500 simultaneous customers.

---

## Is It Ready?

**Verdict: Not ready — action required.**

Every part of the store we tested starts struggling at a small fraction of the expected Black Friday traffic — between about 8% and 15% of the target level for checkout-related steps, and right at the target level itself for product browsing. We understand exactly why each part struggles, but the actual fixes are still open engineering work, not something that can be turned on today.

---

## Risks

| Risk | Business impact | Urgency |
|---|---|---|
| Adding items to cart, placing orders, and paying all slow down dramatically at a small fraction of expected Black Friday traffic | Customers would face multi-second to several-second waits at checkout — a major source of abandoned carts and lost sales during the event's busiest hours | Must fix before launch |
| Product browsing has a completely separate, unrelated problem that appears exactly at the expected Black Friday traffic level | Customers couldn't browse the catalog smoothly even if checkout were fixed | Must fix before launch |
| Login slows under heavy load but never fails outright | Some customers would experience a slower-than-ideal login, but would still get in | Fix within a few weeks — lowest priority of the issues found |
| We did not test what happens over several continuous hours of traffic, or an instant surge of customers all arriving at once | Unknown — could reveal additional issues such as the system needing a restart partway through the event | Should be tested before the real event, even though it's not blocking today's assessment |

---

## What Happens If We Launch Now

During Black Friday's expected traffic level, customers would experience severe slowdowns from the moment they try to browse products, and even worse delays at checkout — likely several seconds to tens of seconds per step. This would almost certainly drive cart abandonment and lost sales during the event's peak hours. The system does not crash outright in our tests — it slows down rather than going offline — but a multi-second checkout experience is, in practice, just as damaging to the business as an outage.

---

## What Needs to Happen Before Launch

- **Fix the checkout-path slowdown (cart, orders, payment)** — these three are tied together by a shared, underlying processing-power limitation. One fix attempt was tried and tested today; it made things worse, not better, and was rolled back. A different approach is needed before this can be resolved.
- **Fix the product-browsing slowdown** — this is a completely separate technical issue from the checkout problem above, and needs its own independent fix; solving the checkout issue will not solve this one.
- **Re-run today's tests once both fixes are in place** — to confirm the fixes actually work before committing to a launch date, since a plausible-looking fix can still make things worse, as we saw today.

---

## What Can Wait

- A 2-hour continuous-traffic test, to check for slow degradation over time (e.g., a service needing a restart partway through the event) — should happen before the real event, but isn't blocking today's assessment.
- A test simulating an instant flood of customers arriving all at once (rather than today's gradual ramp-up) — lower priority, since today's gradual test already tells us where each part of the system struggles.
- A minor data-setup issue in one of our test scripts (unrelated to system capacity) — already understood, low effort to fix, not a customer-facing risk.

---

## Decision Required

**Question:** Should we proceed with the Black Friday launch as scheduled, delay it, or launch with reduced traffic expectations?

| Option | Benefit | Risk |
|---|---|---|
| Launch as scheduled, full traffic | No schedule change | High likelihood of severe checkout and browsing slowdowns during peak hours, likely costing more in lost sales than the delay would |
| Delay launch until both fixes are confirmed working | Avoids a damaging peak-traffic experience | Requires open-ended engineering time — no fixed completion date yet |
| Launch as scheduled, but plan for reduced/throttled traffic | Avoids the worst-case slowdown for some customers | Still turns away or rations demand during the platform's most valuable sales window |

**Recommendation:** Delay full-scale launch until the checkout and browsing fixes are confirmed working through a clean re-test. Both root causes are well understood — this is not a guessing game — but neither fix exists yet today, and launching at full expected traffic without them carries a high risk of a damaging customer experience during the platform's most important sales event.

---

## Evidence

- cart-service: `results/2026-06-1[7-9]_stress_cart_run{1-10}/` (10 runs)
- orders-service: `results/2026-06-18_stress_orders_run{1-7}/` (7 runs)
- payments-service: `results/2026-06-1[8-9]_stress_payments_run{1-2}/` (2 runs)
- products-service: `results/2026-06-1[6-7]_stress_products_run{1-5}/`, `results/2026-06-17_bf-validation_products/`
- users-api: `results/2026-06-16_stress_auth/`
- e2e: `results/2026-06-19_stress_e2e_run1/`
- Smoke/Load (all services): `results/2026-06-09_smoke_*/`, `results/2026-06-10_smoke_*/`, `results/2026-06-10_load_*/`, `results/2026-06-11_load_*/`
- Spike/Soak: not executed — PT-17, PT-18, PT-22, PT-30 (closed)

---

_Generated via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus) + Jira MCP — 2026-06-19_
