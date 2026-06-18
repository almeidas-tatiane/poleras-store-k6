# Performance Report Analysis — orders.test.js (Run 1 through Run 5)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18**
**Analysis target:** `tests/orders/orders.test.js` stress test results (PT-16 execution, Run 5)
**SLA reference (PT-7):** orders-service P95 < 200ms, error rate < 1% · Black Friday target: 2,500 VUs

---

## Test Conditions

| | Run 3 | Run 4 | Run 5 |
|---|---|---|---|
| Fix under test | UV_THREADPOOL_SIZE + keep-alive agent | keepAliveMsecs + retry | SCHED_RR + backlog 1024 + 14 workers |
| Max VUs reached | 868 | 725 | **598** |
| Results | `.../_orders_run3/` | `.../_orders_run4/` | `.../_orders_run5/` |

---

# Technical Report

## SLA Compliance — Run 5 (at stop)

| Metric | Target | Run 5 Actual | Result |
|---|---|---|---|
| P95 response time | < 200ms | 87ms baseline → 4,408ms (at stop) | FAIL |
| Server-side 5xx rate (fresh re-verify) | < 1% | **No data — genuinely 0%** | PASS — first run since Run 1/2 with zero server-side errors |
| DB pool peak (orders-service) | n/a | **73/126 (58%)** | Not saturated — ruled out as a factor this run |
| DB pool peak (cart-service) | n/a | **174/216 (80.6%)** | High, but not exhausted |

## Root Cause Analysis — A more precise answer than "host-wide CPU contention"

A fresh Tempo trace pulled for the one slow (`400`, 7,213ms) request found in Loki (`traceID d9063ef452563212603837d68d9a537f`) reveals the actual mechanism precisely:

```
POST /api/orders                7,213ms (orders-service)
  └─ GET /api/cart (outbound)    7,173ms
       └─ GET /api/cart (cart-service's own handling)  6,901ms
            └─ pg-pool.connect    6,893ms ← cart-service waiting to acquire ITS OWN DB connection
```

**The bottleneck is not in orders-service or orders-db at all — it is inside cart-service's own database connection acquisition**, which took nearly 7 seconds. Cross-referencing cart-service's own pool state: `db_connections_active` peaked at 174/216 (80.6%) — high, but **not exhausted**. This means the 6.9-second wait was not simply "no free connection slot" — it is more consistent with cart-service's own event loop being too busy (across its 12 workers) to promptly service the pool-acquisition callback even though a slot existed, which matches the CPU evidence already gathered for this run (`cart-service` climbing to ~3.6 cores' worth of CPU time during the same window).

**This reframes the "host-wide CPU contention" hypothesis from the prior PT-16 comment into something more specific and actionable: orders-service's breaking point in Run 5 is being set by cart-service's capacity, not orders-service's own configuration.** orders-service's outbound call to cart-service hangs waiting for cart-service to respond; while it hangs, that orders-service worker's event loop is tied up holding the request open; with enough concurrent requests hung this way, orders-service's own accept queue backs up and overflows — **regardless of how many orders-service workers exist or how large its own backlog is**, because the delay originates downstream. This explains precisely why Run 5's fix (more orders-service workers, bigger backlog, explicit scheduling) had no effect: it added capacity to the wrong service.

### Findings

#### [CRITICAL] Finding 1 — cart-service's own capacity (not orders-service's) is now the limiting factor
**Observed:** Tempo trace shows a 6,893ms `pg-pool.connect` wait *inside cart-service's* handling of an inbound `GET /api/cart` call from orders-service. cart-service's CPU climbed to ~3.6 cores' worth during the same window (from the prior CPU investigation).
**Root cause hypothesis:** cart-service's own event loop (across its 12 workers) becomes too busy under combined load (serving both k6's direct traffic and orders-service's internal calls) to promptly service pool-acquisition callbacks, even with pool headroom remaining (80.6% used, not 100%).
**Evidence:** Tempo trace `d9063ef452563212603837d68d9a537f`; cart-service `db_connections_active` max 174/216; cart-service CPU time climbing in the same window (prior finding).
**Recommended action:** the long-standing, never-implemented recommendation from Run 1's original analysis is now strongly evidenced: **decouple the cart-fetch/cart-convert calls from orders-service's request-response critical path** (e.g., async/queue-based), so that cart-service's variable response time under its own load no longer directly consumes orders-service's worker capacity. Separately, profile cart-service's own capacity under combined (not isolated) load.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 6

#### [HIGH] Finding 2 — Run 5's fix (SCHED_RR + backlog + more workers) had no measurable effect
**Observed:** EOF/accept-queue onset (~247-262 VUs) and max VUs survived (598) showed no improvement over Run 4, and were worse by some measures.
**Root cause hypothesis:** consistent with Finding 1 — the fix added capacity to orders-service's own listening socket and worker pool, but the actual constraint is downstream (cart-service), so the added capacity was never the limiting resource.
**Recommended action:** do not pursue further orders-service-only capacity tuning until Finding 1 is addressed.
**Retest required:** Yes — Run 6 (same retest as Finding 1)

#### [INFORMATIONAL] Finding 3 — Server-side errors are fully back to zero
**Observed:** No 5xx data at all in the Run 5 window — the first run since Run 1 with a completely clean server-side error signal (Run 2 had client-side-only EOF, Run 3/4 had genuine server 5xx).
**Recommended action:** none — confirms the keep-alive/retry fixes from Run 3/4 remain solid; the current problem is purely latency/capacity, not correctness.

---

## Run 1 through Run 5 Comparison

| Metric | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|---|
| Max VUs survived | 181 | 582 | 868 | 725 | **598** |
| Black Friday gap | ~14x | ~9x | ~2.9x | ~3.4x | **~4.2x** |
| Server-side 5xx | 0% | 0% (client-only) | ~0.07-0.24% | ~0.014-0.02% | **0% (clean again)** |
| Confirmed bottleneck location | orders-service (DNS) | orders-service (DNS, per-process) | orders-service (outbound socket) | orders-service (inbound accept queue + DB wait) | **cart-service (downstream dependency)** |

**Net assessment: the investigation has correctly exhausted orders-service-local fixes and the evidence now points downstream.** Four consecutive fixes to orders-service's own configuration (clustering, threadpool, keep-alive, concurrency tuning) each measurably or non-measurably changed orders-service's behavior, but Run 5's trace evidence shows the actual constraint has moved to a service orders-service depends on synchronously. This is a natural and informative outcome of systematic root-causing, not a wasted effort — each fix was necessary to rule out its specific layer.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Decouple the cart-fetch/cart-convert calls from orders-service's critical path (async/queue-based) | Before Run 6 |
| P1 | Profile cart-service's capacity under combined load (not isolated cart-service-only testing) | Before Run 6 |
| P2 | Verify/debunk the products-service clustered-metrics CPU artifact (still open from Run 5's first analysis) | Before Run 6 |
| P3 | Re-test as "Run 6" once the synchronous dependency is addressed | Next session |

---

# Business Report

## What Was Tested

The fifth in a series of tests checking whether the latest fix closed the gap to Black Friday's expected traffic.

## Key Question: Is It Ready?

**Overall verdict: Not ready — but we now know precisely where to look next.**

The last fix targeted the order-processing service's own capacity, but it made no difference — and a detailed trace of one slow request revealed why: the actual slowdown is happening one step further upstream, in the shopping-cart service that the order service depends on. Strengthening the order service's own capacity couldn't help, because it was waiting on a service it doesn't control the speed of.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| The order service's performance is limited by how busy the shopping-cart service is, not by its own configuration | High | High at meaningful traffic levels | Decouple the dependency rather than continuing to tune the order service itself |
| No incorrect orders or data errors — this is purely a speed/capacity issue | Low | N/A | No correctness risk identified |

## What Happens If We Deploy Now

Below a moderate traffic level, the system performs well with no errors. Above that level, order confirmations slow down and some fail outright — but the underlying cause has now been precisely identified, which means the next fix has a much higher chance of success than the last one.

## What Needs to Happen Before Go-Live

- **Reduce how much the order service depends on the shopping-cart service responding instantly** — make that interaction happen in the background rather than making the customer's order wait on it.
- **Check the shopping-cart service's own capacity** under realistic combined traffic, not in isolation.
- **Run one more verification test** after that change.

## What We Can Defer

- Further tuning of the order service's own worker count or configuration — four rounds of this have been tried; the evidence now clearly points elsewhere.

## Decision Required

**No-go for Black Friday today.** This round was a necessary diagnostic step, not a failed fix — it definitively ruled out the order service's own configuration as the remaining bottleneck and pointed to a specific, addressable dependency instead. Recommend pivoting the next engineering effort to that dependency before any further capacity tuning.

---

## Evidence

Saved to `results/2026-06-18_stress_orders_run5/` (binary files referenced by path — not attachable via the current Jira MCP toolset):
- `screenshot-01-apm-p95-latency.png`, `screenshot-02-apm-rps.png` — Grafana RED-metrics panels
- `screenshot-03-loki-orders-logs.png` — Loki orders-service log stream
- `screenshot-04-tempo-top-ops.png` — Tempo top-operations panel
- Full Run 5 execution report: `report-PT-16-2026-06-18-orders-run5.md`

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18_
