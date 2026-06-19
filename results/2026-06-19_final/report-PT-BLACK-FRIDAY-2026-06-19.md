# Black Friday Readiness — Final Report & Go/No-Go Verdict

**Generated:** 2026-06-19 · **Ticket:** PT-23 · **SLA reference:** PT-7 · **Black Friday target:** 2,500 concurrent users, 5-minute peak

**Sources:** PT-19 (Smoke), PT-20 (Load), PT-21 (Stress — cart-service 10-run deep-dive + orders 7-run + payments 2-run + products/users-api/e2e), today's e2e Run 1. PT-17/PT-18/PT-22/PT-30 (Spike/Soak) were closed today without execution — **not factored into this verdict** (see Scope Note).

---

# VERDICT: ❌ NO-GO

**The platform cannot sustain the Black Friday target load (2,500 VUs) within PT-7's SLAs.** Every service's actual breaking point sits well below 2,500 VUs, and the root causes are understood but not yet fixed (one fix attempt — cart-service worker-count reduction — was tried today and proven to make things worse, then reverted).

---

# Technical Report

## SLA Compliance Table — per service × test type

| Service | Smoke (low VU) | Load (~100 VU steady) | Stress (breaking point) |
|---|---|---|---|
| **users-api** | ✅ PASS (P95 58.8ms) | ✅ PASS (P95 79ms, error 0.76% FAIL — data defect, not capacity¹) | Breach onset ~200-250 VUs; 0% errors even at full 2,000 VUs (graceful) |
| **products-service** | ✅ PASS (P95 12.1ms) | ✅ PASS (P95 9.7ms, 0% error) | ✅ PASS through 2,000 VUs (44ms) — **❌ FAILS at 2,500 VUs** (P95 3.45-4.6s, 0% error) — cluster-master IPC saturation |
| **cart-service** | ✅ PASS (P95 20.8ms) | ✅ PASS (P95 43.9ms, 0% error) | Breach onset ~317-380 VUs (current, reverted config); 0% errors (graceful degradation) |
| **orders-service** | ✅ PASS (P95 44.9ms) | ✅ PASS (P95 75.9ms, 0% error, post DB-pool fix) | EOF/connection-reset onset ~237-325 VUs (cascades from cart-service) |
| **payments-service** | ⚠️ P95 799ms vs original 300ms SLA — **SLA revised to 1000ms 2026-06-11** (gateway simulates 200-800ms by design); PASS vs revised SLA | ✅ PASS (P95 879.5ms vs revised 1000ms, 0% error) | Own bottleneck fully fixed (DB pool 100%→15%); ceiling now ~245-361 VUs, set by the cart↔orders cascade, not payments itself |
| **e2e (full flow)** | ✅ PASS (P95 526ms) | ✅ PASS (P95 674.7ms, 0% error, 100 VUs) | ❌ FAIL — P95 14.59s vs <1000ms (error rate 0.81% PASSED <1%); confirms payments breaks earliest, cart/orders together from ~250-300 VUs |
| **Spike (PT-17/22)** | — | — | **Not executed — closed due to lack of time** |
| **Soak (PT-18/30)** | — | — | **Not executed — closed due to lack of time** |

¹ The auth load-test error rate failure was traced to a missing seeded test user (data defect), not a capacity/latency issue — not counted against the go/no-go verdict.

## Bottlenecks Identified — Root Cause Summary

### 1. cart-service — CPU/event-loop ceiling at ~317-380 VUs (unresolved, highest priority)

10 stress runs (PT-21) progressively ruled out every other hypothesis: connection pooling (fixed, Run 4-6), DB query speed (fixed via `shared_buffers`/`work_mem`, Run 4), threadpool/keep-alive overhead (fixed, Run 7, ~10-15% RPS gain). Direct V8 CPU profiling (Run 8) showed workers **91.7% idle** — ruling out expensive application code. Root cause: **host-wide CPU oversubscription** — 16 logical cores shared by 50+ clustered Node worker processes across cart/orders/products/payments plus 4 Postgres instances, Redis, and the full observability stack.

**Today's fix attempt and result:** reduced `NODE_CLUSTER_WORKERS` 12→4 host-wide to relieve oversubscription. Run 8 was confounded by an un-rebalanced DB pool; **Run 10 (today, clean retest with DB pool rebalanced) proved the fix is a regression**: P95 2.7x worse, breach onset earlier (~317-321 vs ~365-380 VUs), DB pool saturates harder despite a matched total connection count. **Reverted today** to the last known-good config (12 workers, matching Run 7's validated baseline).

**Status: open.** No working fix exists yet. Next direction (not started): profile exactly what event-loop time is spent on at saturation under combined multi-service load (not single-service isolation), or evaluate horizontal scaling across multiple hosts.

### 2. orders-service — inherits cart-service's ceiling via a synchronous call (unresolved)

7 stress runs exhausted every orders-service-side fix (DNS/threadpool starvation, outbound keep-alive+retry, accept-queue/backlog tuning, critical-path decoupling for background tasks). Each fix worked exactly as designed, but the EOF/connection-reset onset plateaued at ~237-325 VUs because the one remaining synchronous call (`GET /api/cart`) ties up an orders-service worker for however long cart-service takes to respond — confirmed via Tempo trace showing a 6.9s `pg-pool.connect` wait *inside cart-service's own handling* of that call, not in orders-service or orders-db.

**Status: open, blocked on item 1.** orders-service has no further local fix available.

### 3. payments-service — own bottleneck fixed; inherits the same cascade (unresolved, but lowest individual risk)

Run 1 found payments-service unhardened (no clustering, no threadpool tuning, no keep-alive, 25-connection DB pool) — the weakest service in the stack, breaking at ~290-452 VUs. Run 2 applied the full proven fix playbook: DB pool wait dropped from 993ms+724ms to <1ms, outbound call overhead dropped from 797-1,742ms to 6-37ms. **Payments-service's own bottleneck is fully resolved.** But the overall ceiling barely moved (~245-361 VUs) because its flow depends on cart+orders completing first, and those still degrade earlier.

**Status: closed as an independent risk; ceiling now fully owned by item 1.**

### 4. products-service — separate, unrelated ceiling exactly at the Black Friday target (unresolved)

Handles up to 2,000 VUs cleanly (44ms P95, 0% errors — best-in-class). At the actual 2,500-VU Black Friday target, a dedicated BF-validation load test found **sustained, progressive P95 escalation to 3.45-4.6s** (vs <100ms SLA) with 0% errors. Root cause (confirmed via Prometheus + Tempo): the Node.js **cluster master's IPC routing** saturates at sustained 2,500-VU connection rates — workers themselves stay healthy and fast (45-70ms server-side), but requests queue at the master before being routed to a worker. This is a **different root cause from cart-service's CPU oversubscription** — fixing item 1 will not fix this.

**Status: open, independent of items 1-3.** Recommended fix (not yet implemented): PM2 cluster mode or `SO_REUSEPORT` to remove the master from the request-routing path.

### 5. users-api — best-in-class, lowest risk

Post-fix (bcrypt optimization, threadpool scaling, login cache, nginx horizontal LB), reaches the full 2,000-VU profile with 0% server-side errors and graceful latency degradation. SLA breach onset (~200-250 VUs) is real but never escalates to failures.

## Recommendations Summary

| Priority | Action | Target | Status |
|---|---|---|---|
| P1 | Find a working fix for cart-service's CPU/event-loop ceiling — worker-count reduction is ruled out (made it worse); profile under combined multi-service load, or evaluate multi-host scaling | cart-service | Open |
| P1 | Implement PM2 cluster mode or `SO_REUSEPORT` to remove the cluster-master IPC bottleneck at 2,500 VUs | products-service | Open, independent of cart-service work |
| P2 | Retest orders-service and payments-service once a real cart-service fix lands — both are fully blocked on item 1, not on anything in their own code | orders-service, payments-service | Blocked |
| P3 | Re-seed/verify the missing test user that caused auth load-test's 0.76% error rate (data defect, not a capacity finding) | users-api test data | Open, low effort |
| P3 | Schedule the Soak test (PT-18, 50 VUs × 2h) before the real event — it's the only test type that can catch slow memory leaks or gradual degradation, and none of today's tests would surface that | All services | Deferred (not run today) |
| P3 | Schedule the Spike test (PT-17, 0→2,500 VUs instant) before the real event — today's gradual-ramp Stress test establishes the same breaking points more informatively, but doesn't validate instant-surge recovery behavior specifically | All services | Deferred (not run today) |

---

# Business Report

## What Was Tested

Smoke, Load (steady ~100 users), and Stress (gradual ramp to 2,000-2,500 users) testing across all 5 services individually and as a full purchase-flow chain (login → browse → cart → order → payment). Spike (instant 2,500-user surge) and Soak (2-hour sustained run) were not run today due to time constraints — see Scope Note.

## Key Question: Is It Ready?

**No.** Every service's real breaking point is well below the 2,500-user Black Friday target:

| Service | Breaks at (VUs) | Gap to 2,500-user target |
|---|---|---|
| products-service | ~2,000-2,500 (right at the target) | ~1x — closest to ready, but fails right at the target itself |
| users-api | ~200-250 (latency only, never errors) | ~10-12x, but degrades gracefully, never crashes |
| cart-service | ~317-380 | ~7x |
| orders-service | ~237-325 | ~8-10x |
| payments-service | ~245-361 | ~7-10x |

Today's investigation traced every service's slowdown to root cause. One fix was attempted today (reducing the number of parallel worker processes to relieve competition for the server's processing power) — it was tested cleanly and made things **worse**, not better, so it was reverted. No working fix currently exists for the platform's main bottleneck.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| Cart, order, and payment processing all slow down dramatically well below the expected Black Friday traffic level | Critical — customers would experience multi-second to several-second waits at checkout | Confirmed at ~300-400 concurrent users, a small fraction of the 2,500-user target | Do not launch at full target traffic without a working fix; see timeline below |
| Even if the cart/order/payment issue were fixed, the product-catalog browsing service has its own, completely separate problem that appears exactly at the target traffic level | High — customers couldn't browse the catalog smoothly even with checkout fixed | Confirmed via a dedicated 2,500-user validation test | Needs its own independent fix; not solved by fixing the other three services |
| Long-running memory leaks or slow degradation over hours were not tested today | Unknown | Untested (Soak test deferred) | Schedule a 2-hour sustained test before the real event, even though it's out of scope for today's verdict |
| Sudden instant traffic surges (vs. today's gradual ramp) were not tested today | Unknown, likely similar to gradual-ramp findings | Untested (Spike test deferred) | Lower priority than the Soak test — today's gradual ramp already characterizes each service's ceiling |

## Which Services Are Ready vs At Risk

- **Ready (with caveats):** users-api — slows down under heavy load but never crashes or errors, and its slowdown point, while below target, is the least severe.
- **At risk — cascading failure:** cart-service, orders-service, payments-service — these three are tied together. Cart-service is the root cause; orders and payments inherit its slowdown even though payments' own house is otherwise in order.
- **At risk — independent issue:** products-service — handles everything fine until the exact moment it hits the real Black Friday traffic level, where a different, unrelated technical limit kicks in.

## Timeline for Fixes (since verdict is NO-GO)

1. **Before any further testing:** assign engineering time to find a genuine fix for cart-service's processing-power ceiling (today's attempted fix made it worse and was rolled back) and to implement the proposed fix for the product-catalog service's separate issue. Both are real engineering investigations, not quick config changes — no fixed estimate available from today's work alone.
2. **After a cart-service fix is found:** retest cart-service in isolation to confirm it genuinely helps (today's experience shows a plausible-sounding fix can still make things worse — verify before trusting it).
3. **Once cart-service is confirmed fixed:** retest order-processing and payment-processing, since both are currently blocked on cart-service alone, not on anything in their own code.
4. **In parallel, independently:** implement and retest the product-catalog service's separate fix — this does not need to wait for cart-service.
5. **Before the real event, regardless of the above:** run the deferred 2-hour sustained test and the instant-surge test, since neither was covered today and both could surface additional issues.
6. **Final go/no-go:** re-run this same consolidated assessment once items 1-4 are confirmed fixed and retested, and ideally after item 5 as well.

## Decision Required

**NO-GO for Black Friday as the platform stands today.** Recommend communicating this gap to stakeholders now, with the understanding that the root causes are well understood (not a mystery requiring more diagnosis) but the actual fixes are still open engineering work, not configuration tweaks that can be applied today.

---

## Scope Note — Spike and Soak

PT-17 (Spike execution), PT-18 (Soak execution), PT-22 (Spike analysis), and PT-30 (Soak analysis) were closed today without execution, due to time constraints on completing the full testing program in a single day. This verdict is based entirely on Smoke, Load, Stress, and e2e results. Per PT-23's own instructions, the verdict should be based on whether all PT-7 SLAs were met across all test types — since two of the five test types were not run, this NO-GO verdict should be treated as a **lower bound on risk**, not a complete picture: the Soak test in particular could surface additional issues (memory leaks, gradual degradation) that none of today's tests would catch, and would need to be cleared before a future GO verdict, even after the Stress-test findings above are resolved.

---

## Evidence

- cart-service: `results/2026-06-1[7-9]_stress_cart_run{1-10}/` (10 runs) — `project_cart_service_eventloop_bottleneck` investigation
- orders-service: `results/2026-06-18_stress_orders_run{1-7}/` (7 runs) — `project_orders_service_no_clustering` investigation
- payments-service: `results/2026-06-1[8-9]_stress_payments_run{1-2}/` (2 runs) — `project_payments_service_unhardened` investigation
- products-service: `results/2026-06-1[6-7]_stress_products_run{1-5}/`, `results/2026-06-17_bf-validation_products/`
- users-api: `results/2026-06-16_stress_auth/`
- e2e: `results/2026-06-19_stress_e2e_run1/` (today)
- Smoke/Load (all services): `results/2026-06-09_smoke_*/`, `results/2026-06-10_smoke_*/`, `results/2026-06-10_load_*/`, `results/2026-06-11_load_*/`
- Spike/Soak: not executed — see PT-17, PT-18, PT-22, PT-30 (closed)

---

_Consolidated via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus) + Jira MCP — 2026-06-19_
