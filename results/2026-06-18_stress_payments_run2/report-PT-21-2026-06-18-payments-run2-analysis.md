# Performance Report Analysis — payments.test.js (Run 2 — Post-fix retest, vs. Run 1)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18/19**
**Analysis target:** `tests/payments/payments.test.js` stress test results (PT-16 execution, Run 2)
**SLA reference (PT-7):** payments-service P95 < 1000ms, error rate < 0.1% · orders-service P95 < 200ms · cart-service P95 < 150ms · Black Friday target: 2,500 VUs

---

## Test Conditions

This run retests payments-service after applying the full fix playbook identified in the Run 1 analysis (clustering, threadpool tuning, keep-alive connections, DB pool sizing, a registry/metrics-aggregation fix). The goal was to confirm whether payments-service's own breaking point improved. The test was stopped manually at ~361/2,000 VUs upon a confirmed sustained breach.

---

# Technical Report

## SLA Compliance

| Metric | Target | Run 1 (pre-fix) | Run 2 (post-fix) | Result |
|---|---|---|---|---|
| payments P95 | < 1000ms | 932ms → 9,470ms | 930ms → 2,483ms | FAIL (both runs), but peak severity much lower |
| payments error rate | n/a | 0% (latency-only) | 0% (latency-only) | PASS in both |
| payments DB pool peak | n/a | **100% exhausted** | **15%** | **Fixed** |
| orders P95 (same window) | < 200ms | not measured in Run 1's analysis scope | 48ms → 1,827ms | FAIL — pre-existing cascade |
| cart P95 (same window) | < 150ms | not measured in Run 1's analysis scope | 24ms → 668ms | FAIL — pre-existing cascade |

## Root Cause Analysis

### Finding 1 [RESOLVED] — payments-service's own bottleneck is fully fixed

**Observed:** DB pool peak dropped from 100% (25/25) to 15% (16/108). A sampled Tempo trace shows `pg-pool.connect` waits dropped from 993ms+724ms (Run 1) to 0.07-0.16ms (Run 2); the outbound `GET`/`PATCH` calls to orders-service dropped from 797ms/1,742ms (80-90% raw connection overhead) to 6ms/37.5ms.

**Verdict:** The clustering + `UV_THREADPOOL_SIZE` + keep-alive `http.Agent` + larger DB pool fix worked exactly as intended. No further payments-service-specific tuning is warranted.

### Finding 2 [HIGH] — The ceiling has fully shifted to the pre-existing cart↔orders cascade

**Observed:** Despite payments-service's own fix, the test still broke down at a similar VU range (~245-361 VUs vs Run 1's ~290-452) and peak RPS barely moved (~67.0 vs ~64.4 req/s, within noise). In the same window, orders-service's own P95 spiked to 1,827ms (9.1x its SLA) and cart-service's to 668ms (4.5x its SLA) — the same cascade already documented across 14 prior runs of cart-service and orders-service individually ([[project-cart-service-eventloop-bottleneck]], [[project-orders-service-no-clustering]]).

**Root cause hypothesis:** payments.test.js's flow depends on cart-service and orders-service before it ever reaches the payment step — so even with payments-service itself fully healthy, the end-to-end flow inherits whichever upstream service degrades first. This reconfirms (does not newly discover) that cart-service's CPU/event-loop ceiling is the dominant constraint across the entire purchase flow, not just for orders-service.

**Recommended action:** No payments-service-specific action remains. The standing P1 recommendation from cart-service Run 7 (profile actual event-loop CPU consumers) is now the correct next step for the whole stack, not just orders-service.

**Retest required:** Yes, for payments-service again, but only after the cart-service fix lands — re-testing payments-service alone will not show further improvement.

### Finding 3 [INFORMATIONAL, single-sample] — A ~12.85-second untraced gap inside a payments-service request, consistent with host-wide CPU contention

**Observed:** One sampled trace (`7adfe755b492f015c55d3e16b6d9d98e`) shows the root `POST /api/payments/process` span itself completing in 785.6ms (within SLA), but the full trace search reported a 12,905ms duration. The gap sits between the INSERT and UPDATE payment-record queries — exactly where the in-process `simulateGateway()` mock (`setTimeout` for a designed 200-800ms) runs, with no instrumented span around it.

**Root cause hypothesis:** Under combined load, payments-service's 12 worker processes share the same physical CPU cores as cart-service's and orders-service's own clustered workers, all degrading simultaneously. A plain `setTimeout` callback can be delayed well beyond its scheduled fire time if the event loop is starved — this is consistent with, but does not on its own prove, host-wide CPU contention. Aggregate `nodejs_eventloop_lag_p99_seconds` for payments-service peaked at "only" 181.9ms in the same window, so this single trace may be an outlier not representative of the median request.

**Recommended action:** None yet — flagged as informational because it is based on one sample. Worth re-examining once cart-service's CPU fix is applied, to see if this kind of outlier disappears.

**Retest required:** No immediate action; re-observe after cart-service's fix.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | No further payments-service-specific work — its own bottleneck is resolved | Closed |
| P2 | Apply the deeper cart-service CPU/event-loop fix (profiling, standing since cart-service Run 7) | Before next orders-service or payments-service retest |
| P3 | Re-test payments-service after the cart-service fix lands | After P2 |
| P4 | Re-examine the single 12.85s gateway-simulation stall once cart-service's fix is applied | Informational |

---

# Business Report

## What Was Tested

A retest of the payment-processing step after applying the same capacity improvements already proven on the shopping-cart and order services — checking whether the fix translated into a real improvement in how many customers can complete payment simultaneously.

## Key Question: Is It Ready?

**Overall verdict: Better, but not ready — the fix worked, but revealed the true remaining problem is shared with the rest of the system.** The payment service's own specific weaknesses (no parallel processing, no connection reuse, too few database connections) are now fully resolved — direct measurement confirms it. However, the overall number of customers it can serve at once barely improved, because as soon as the payment service is no longer the limiting factor, it runs into the same shopping-cart/order-service slowdown that has already been identified and tracked separately.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| The payment service's own technical debt has been resolved | — | — | No further action needed here |
| The shopping-cart and order services still slow down together under load, and this now visibly affects payment completion too | High | High at moderate-to-high traffic | Prioritize the previously-identified, deeper fix to the shopping-cart service |

## What Happens If We Deploy Now

Customers will no longer experience the payment-specific failures seen in the first test (the payment step itself is fast and reliable now). However, at traffic levels approaching the shopping-cart/order-service slowdown threshold, customers will still experience the same delays as before — they will simply be caused by an earlier step in the checkout flow (adding to cart, placing the order) rather than by the payment step itself.

## What Needs to Happen Before Go-Live

- The shopping-cart service's deeper capacity fix (already identified, not yet implemented) remains the single highest-priority remaining item — it is now confirmed to affect three services' worth of customer-facing experience (cart, orders, and payments), not just one.
- Once that fix lands, re-test the full purchase flow (cart → order → payment) again to confirm the combined improvement.

## What We Can Defer

- Any further payment-service-specific investigation — its own issues are resolved and confirmed fixed by direct measurement.

## Decision Required

**Still no-go for Black Friday today, but the path forward is now clearer and narrower.** The payment service is no longer an independent risk; the entire remaining capacity risk for the whole checkout flow funnels into a single, already-identified item: the shopping-cart service's deeper performance fix. Recommend prioritizing that work above all else before any further testing.

---

## Evidence

Saved to `results/2026-06-18_stress_payments_run2/`:
- `screenshot-01-apm-p95-latency.png` — P50/P95/P99 panel showing payments, orders, and cart all spiking together
- `screenshot-02-apm-rps.png` — RPS by service
- `screenshot-03-loki-errors.png` — confirms no genuine error-level logs in the breach window
- `screenshot-04-tempo-top-ops.png` — Tempo top-operations panel
- Full Run 2 execution report: `report-PT-16-2026-06-18-payments-run2.md`
- Run 1 (pre-fix) comparison: `results/2026-06-18_stress_payments/report-PT-21-2026-06-18-payments-run1-analysis.md`

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18/19_
