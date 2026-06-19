# Performance Report Analysis — payments.test.js (Run 1 — First-ever payments-service stress test)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18/19**
**Analysis target:** `tests/payments/payments.test.js` stress test results (PT-16 execution, Run 1)
**SLA reference (PT-7):** payments-service P95 < 1000ms, error rate < 0.1% (strictest SLA in the suite) · Black Friday target: 2,500 VUs

---

## Test Conditions

First-ever stress test of payments-service, completing the original PT-16 service matrix (users-api, products-service, cart-service, and orders-service had already been tested across 7 runs each). The test was stopped manually at ~452/2,000 VUs (early Stage 4) upon confirming a sustained, severe P95 breach. No baseline exists for payments-service prior to this run — this run establishes the baseline.

---

# Technical Report

## SLA Compliance

| Metric | Target | Actual | Result |
|---|---|---|---|
| P95 response time | < 1000ms | 931.6ms (baseline) → **9,470ms** (peak) | FAIL |
| Error rate (global) | n/a | 0% throughout | PASS — pure latency failure, not an error-rate failure |
| Error rate (payments-service scoped, excl. 402) | < 0.1% | 0% genuine 5xx observed | PASS (no app-level crashes observed in this VU range) |
| DB pool peak (payments-service) | n/a | **25/25 (100%) — fully exhausted** | Critical finding |

## Root Cause Analysis

### Finding 1 [CRITICAL] — payments-service has none of the fixes already proven necessary elsewhere in this stack

**Observed:** Source review of `payments-service/src/server.js` and `docker-compose.yml` confirms: no `cluster.js` (single Node process, no `NODE_CLUSTER_WORKERS`), no `UV_THREADPOOL_SIZE` override (default 4), no keep-alive `http.Agent` on outbound `fetch()` calls to orders-service, and a DB pool capped at only 25 connections (vs. cart-service's 216 and orders-service's 126).

**Root cause hypothesis:** payments-service was never brought up to the same hardening level as the other three services, each of which required multiple rounds of fixes (clustering, threadpool tuning, keep-alive, DB pool sizing) before reaching their current capacity. payments-service inherits none of that work.

**Evidence:** Direct source/config inspection; Tempo traces (below) showing the exact symptoms this class of fix addresses.

**Recommended action:** Apply the proven fix playbook (already successful, with measurable gains, on cart-service and orders-service): add clustering, `UV_THREADPOOL_SIZE=128`, keep-alive `http.Agent` + retry on outbound calls, and a proportionally larger DB pool.

**Retest required:** Yes, after the fix.

### Finding 2 [CRITICAL] — payments-service's own DB pool fully exhausted at only ~290 VUs

**Observed:** `db_connections_active{job="payments-service"}` reached 25/25 (100%) at the point the breach was confirmed. Tempo traces show two separate `pg-pool.connect` waits per request (993ms before the INSERT, 724ms before the UPDATE) — combined ~1.7s of pure pool-wait inside a single request.

**Root cause hypothesis:** A pool of only 25 connections is undersized for the concurrency this test reached, especially because each request holds the pool twice (once for the pending-payment INSERT, once for the post-gateway UPDATE), doubling the effective connection-demand per in-flight request relative to a single-acquisition pattern.

**Evidence:** Tempo traces `178a34fde213cf5e0b34e7f84bfc574`, `3079732c56a4f61ceb8f6111e62662b`; live `db_connections_active`/`db_pool_max` query.

**Recommended action:** Increase `DB_POOL_MAX` proportionally (matching the sizing pattern already validated for orders-service: workers × per-worker max).

**Retest required:** Yes.

### Finding 3 [HIGH] — Outbound calls to orders-service pay full connection-establishment cost on every request

**Observed:** The `GET /api/orders/:id` outbound call took 797ms (506ms tcp.connect + 112ms dns.lookup) while orders-service's own server-side handling was only 39ms. The `PATCH /api/orders/:id/status` outbound call took 1,742ms (1,015ms tcp.connect + 288ms dns.lookup) while orders-service's own handling was only 167ms. In both cases, **80-90% of the "outbound call" duration was connection overhead, not real work** — the exact signature already diagnosed and fixed in cart-service (Run 7) and orders-service (Run 3/4).

**Root cause hypothesis:** No keep-alive `http.Agent` is configured for these calls, so every request opens a brand-new TCP connection and performs a fresh DNS lookup, both of which compete for Node's default 4-thread `UV_THREADPOOL_SIZE`.

**Evidence:** Tempo span breakdown (above); source confirms plain `fetch()` calls with no custom agent.

**Recommended action:** Apply the same shared keep-alive `http.Agent` + `fetchWithRetry()` pattern already proven in cart-service and orders-service.

**Retest required:** Yes, alongside Finding 1/2 fixes (same commit, same retest).

### Finding 4 [INFORMATIONAL] — Cross-service cascade reconfirmed cart↔orders bottleneck

**Observed:** During this same test window, orders-service's own P95 spiked to 2.86s and cart-service's to 1.32s (per the APM dashboard's 30-minute view) — consistent with the already-documented cart↔orders cascade from 14 prior runs across both services. This is not a new finding; it is included here because payments.test.js's flow exercises cart and orders directly, so this test reproduced the known cascade alongside the new payments-specific findings.

**Recommended action:** No new action — already tracked as an open item against cart-service's deeper CPU/event-loop fix (see cart-service Run 7 / orders-service Run 7 analyses).

**Retest required:** No (already covered by existing recommendations).

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Apply clustering + `UV_THREADPOOL_SIZE` + keep-alive `http.Agent` fix playbook to payments-service | Before next payments-service retest |
| P2 | Increase payments-service's DB pool size proportionally | Same commit as P1 |
| P3 | Re-test payments-service to establish a comparable breaking point | After P1/P2 |
| P4 | Note: payments-service's breakdown is independent of, and faster than, the known cart↔orders cascade — fixing cart-service's CPU ceiling will not by itself fix payments-service | Informational |

---

# Business Report

## What Was Tested

The fifth and final service in the original test plan: the payment-processing step that completes every purchase. We simulated shoppers logging in, adding an item to their cart, placing an order, and paying for it — gradually increasing the number of simultaneous shoppers to find the breaking point, the same approach used for the other four services already tested.

## Key Question: Is It Ready?

**Overall verdict: Not ready — payment processing is the weakest link in the entire system.** Of the five services tested so far, the payment service broke down at the lowest traffic level by a wide margin. Unlike the shopping-cart and order services — which needed substantial traffic before showing strain, and have already received several rounds of improvement — the payment service has never been hardened at all. It is, in effect, running in its original, unoptimized state while every other service around it has been strengthened.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| Customers experience multi-second delays — or outright failures — completing payment, even at modest traffic | High | High — confirmed at well below typical Black Friday traffic levels | Apply the same hardening already proven on the other services before any further testing |
| The payment service's database connection capacity runs out quickly, queueing payment requests behind each other | High | High at moderate traffic | Increase database connection capacity alongside the other fixes |
| Slow communication between the payment and order services compounds the delay | Medium | High | Fix connection reuse on the payment service's calls to the order service |

## What Happens If We Deploy Now

At low traffic, payments process normally and quickly. As soon as traffic increases even moderately — far below the expected Black Friday peak — payment confirmation times balloon from under a second to multiple seconds, and the system's capacity to handle payments in parallel runs out. This is the most customer-visible and revenue-critical point of failure identified across the entire test campaign so far, because it sits at the final, must-complete step of every purchase.

## What Needs to Happen Before Go-Live

- The payment service needs the same set of capacity improvements already successfully applied to the shopping-cart and order services (running multiple parallel workers, reusing network connections instead of opening new ones for every request, and increasing database connection capacity).
- After those fixes, the payment service needs to be re-tested to confirm it can handle traffic comparable to the other services before any Black Friday go/no-go decision is made.

## What We Can Defer

- The previously-known interaction between the shopping-cart and order services (already tracked separately) — it showed up again in this test but is not a new issue and does not block addressing the payment service's own, more urgent problem first.

## Decision Required

**No-go for Black Friday today.** The payment service — the step every single transaction must pass through — is currently the single greatest risk to a successful Black Friday launch. Recommend treating its hardening as the highest-priority remaining work before any further capacity testing or go-live planning.

---

## Evidence

Saved to `results/2026-06-18_stress_payments/` (binary files referenced by path — not attachable via the current Jira MCP toolset):
- `screenshot-01-apm-p95-latency.png` — Grafana RED-metrics P50/P95/P99 panel (30-min window), showing payments-service P95 peaking at 9.47s, with orders-service and cart-service spiking in the same window
- `screenshot-02-apm-rps.png` — RPS-by-service panel, showing payments-service plateauing at only ~64 req/s before breaking — the lowest throughput ceiling of any service tested
- `screenshot-03-loki-errors.png` — Loki recent-errors panel showing a 7,362ms `POST /api/payments/process` request (402 business outcome, but pathologically slow regardless of approval/rejection)
- `screenshot-04-tempo-top-ops.png` — Tempo top-operations panel
- Full Run 1 execution report: `report-PT-16-2026-06-18-payments-run1.md`

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18/19_
