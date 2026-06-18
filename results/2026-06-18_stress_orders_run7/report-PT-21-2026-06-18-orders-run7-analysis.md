# Performance Report Analysis — orders.test.js (Run 7 — First retest after cart-service's own fix)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18**
**Analysis target:** `tests/orders/orders.test.js` stress test results (PT-16 execution, Run 7)
**SLA reference (PT-7):** orders-service P95 < 200ms, error rate < 1% · Black Friday target: 2,500 VUs

---

## Test Conditions

This run was intended to stop at the first confirmed sustained breach (~475 VUs), but a delay in the kill command let the test continue to **1,437/2,000 VUs** before actually terminating. This is documented because it materially affects how to read the results: there are effectively **two distinct findings** in this run, at two different load levels.

---

# Technical Report

## SLA Compliance

| Metric | Target | Run 7 Actual | Result |
|---|---|---|---|
| P95 response time | < 200ms | 24-44ms baseline → **9,355ms** (at final stop) | FAIL |
| Server-side 5xx rate (fresh re-verify) | < 1% | ~0.015%-0.03%, rising slightly | Numerically PASS, but now includes genuine app-level 500s (new for this run) |
| DB pool peak (orders-service) | n/a | **124/126 (98.4%) — first time ever exhausted** | New, critical finding |
| DB pool peak (cart-service) | n/a | 205/216 (94.9%) | Consistent with cart-service's own established near-saturation pattern |

## Root Cause Analysis — Two distinct findings at two load levels

### Finding A (at ~237-475 VUs, the intended test range): cart-service's fix did not move the needle

The same cascading orders↔cart pattern recurs unchanged from every prior orders-service run: `EOF`/`socket hang up` on the outbound `GET /api/cart` call, onset at ~237-239 VUs — *earlier*, not later, than Run 6's ~309-325 VU best. cart-service's own ~10-15% RPS improvement (confirmed in its own isolated test) was not enough to shift where this cascade begins under orders-service's combined load profile.

### Finding B (at ~1,400+ VUs, reached only due to the kill delay): orders-service's own DB pool is now exhausted too

A fresh Tempo trace (`traceID 772b815ed03b9a42114b016cc9c5e811`, `POST /api/orders`, 500 response, 7,238ms total) shows:

```
POST /api/orders                     7,238ms
  ├─ GET /api/cart (outbound)         1,606ms
  │    └─ cart-service's own handling   757ms (4 SELECT queries, ~742ms combined — cart-service's own event-loop slowness)
  └─ ecommerce.create_order           7,222ms ← consumes nearly the entire request
       └─ pg-pool.connect             5,583ms ← orders-service's OWN DB pool wait
```

**This is a genuinely new finding.** In all 6 prior orders-service runs, orders-service's own DB pool was never the dominant constraint — it stayed comfortably under capacity while the bottleneck lived entirely in the outbound calls to cart-service. At the extreme concurrency this run incidentally reached (1,400+ VUs, far beyond any prior run's exposure), orders-service's own pool (126 connections = 14 workers × 9) finally became exhausted too, compounding with cart-service's lingering slowness.

### Findings

#### [HIGH] Finding 1 — cart-service's fix did not improve orders-service's breaking point
**Observed:** EOF onset ~237-239 VUs, earlier than Run 6's ~309-325 VU best.
**Root cause hypothesis:** cart-service's own event-loop lag still climbs under sufficient combined load (confirmed in cart-service's own Run 7); the connection-overhead fixes applied there don't address the underlying CPU cost of request processing, so the improvement margin isn't large enough to shift orders-service's cascade point.
**Recommended action:** as previously recommended for cart-service — profile actual CPU/event-loop work at saturation, or consider horizontal scaling, rather than further connection-handling tuning.
**Retest required:** Yes, after a more substantial cart-service fix.

#### [CRITICAL — but context-dependent] Finding 2 — orders-service's own DB pool exhausted at extreme concurrency (1,400+ VUs)
**Observed:** `db_connections_active{job="orders-service"}` peaked at 124/126 (98.4%); a sampled trace shows a 5.58-second wait to acquire a connection.
**Root cause hypothesis:** at sufficiently extreme concurrency — well beyond what any prior run intentionally tested — orders-service's own pool (126 connections) becomes a second, independent bottleneck on top of the cart-service cascade.
**Evidence:** Tempo trace `772b815ed03b9a42114b016cc9c5e811`; fresh `max_over_time(db_connections_active)` query.
**Recommended action:** not urgent given no prior run intentionally reached this range — but worth a note for capacity planning if sustained loads approaching 1,000+ VUs are ever expected in practice.
**Retest required:** No immediate action; monitor in future high-VU tests.

---

## Run 1 through Run 7 Comparison

| Metric | Run 3 (best max VUs) | Run 6 (best onset) | Run 7 |
|---|---|---|---|
| EOF onset | N/A | ~309-325 VUs | **~237-239 VUs (regression)** |
| Max VUs reached | 868 | 561 | 1,437 (not comparable — kill delay) |
| App-level failures | dozens | 2 (lowest) | 4 + 8 new DB-pool-timeout (at extreme load) |
| New finding | — | — | orders-service's own DB pool exhausted (first time, at 1,400+ VUs only) |

**Net assessment: cart-service's fix did not produce a measurable orders-service improvement at the load levels that matter for the current investigation (~200-500 VUs), and incidentally revealed that orders-service's own DB pool has a (so far untested) ceiling at much higher concurrency.**

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Apply a more substantial fix to cart-service (profile actual CPU work, not just connection overhead) before expecting visible improvement in dependent services | Before next orders-service retest |
| P2 | Fix the kill-delay issue in monitoring tooling so future stops take effect immediately | Ongoing |
| P3 | Note orders-service's own DB pool ceiling (126 connections) for future capacity planning if sustained high-concurrency testing is planned | Informational, not urgent |

---

# Business Report

## What Was Tested

The seventh test in this series, checking whether the improvement made to the shopping-cart service translated into a measurable gain for the order-placement service that depends on it.

## Key Question: Is It Ready?

**Overall verdict: Not ready — the cart-service improvement did not carry through to the order service.** The fix applied to the shopping-cart service produced a real, measured improvement in its own isolated test, but did not move the order-placement service's capacity ceiling at the traffic levels that matter for this investigation. A longer-than-intended test (due to a tooling delay) additionally surfaced a new, lower-priority observation about the order service's own database capacity at very extreme traffic levels — far beyond anything tested intentionally so far.

## Risk Summary

| Risk | Impact | Likelihood | Action |
|---|---|---|---|
| The order service's capacity is still limited by the shopping-cart service's responsiveness | High | High at meaningful traffic | A more substantial fix to the shopping-cart service is needed |
| The order service's own database capacity has an upper limit at extreme traffic (newly observed) | Low | Low — only seen at traffic levels far beyond any planned test | Note for future capacity planning, not an immediate concern |

## What Happens If We Deploy Now

Below a moderate traffic level, both services perform well. Above that level, the same pattern observed in every previous test recurs: order confirmations slow down and a small number fail, tied to the shopping-cart service's own responsiveness under load.

## What Needs to Happen Before Go-Live

- Apply a more substantial fix to the shopping-cart service — the recent improvement was real but not large enough to change the order service's capacity ceiling.
- Re-test the order-placement flow again after that deeper fix.

## What We Can Defer

- The order service's own database capacity at extreme traffic levels — only relevant far beyond any currently planned traffic scenario.

## Decision Required

**No-go for Black Friday today.** This round confirms the shopping-cart fix, while real, was not sufficient on its own — recommend a deeper investigation into the shopping-cart service's actual processing cost before further order-service testing.

---

## Evidence

Saved to `results/2026-06-18_stress_orders_run7/` (binary files referenced by path — not attachable via the current Jira MCP toolset):
- `screenshot-01-apm-p95-latency.png`, `screenshot-02-apm-rps.png` — Grafana RED-metrics panels
- `screenshot-03-loki-orders-logs.png` — Loki orders-service log stream
- `screenshot-04-tempo-top-ops.png` — Tempo top-operations panel
- Full Run 7 execution report: `report-PT-16-2026-06-18-orders-run7.md`

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18_
