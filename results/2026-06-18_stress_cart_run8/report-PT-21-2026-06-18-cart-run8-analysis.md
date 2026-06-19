# Performance Report Analysis — cart.test.js (Run 8 — Post worker-count-reduction retest)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18/19**
**Analysis target:** `tests/cart/cart.test.js` stress test results (PT-16 execution, Run 8)
**SLA reference (PT-7):** cart-service P95 < 150ms, error rate < 0.5% · Black Friday target: 2,500 VUs

---

## Test Conditions

This run validates the CPU-profiling-driven fix documented on PT-21 (comment 10168): cart-service's CPU/event-loop bottleneck — open and unresolved since Run 6/7 — was found via direct V8 profiling to be host-wide CPU oversubscription (54 Node worker processes across 4 services competing for 16 logical cores), not expensive application code. The fix reduced `NODE_CLUSTER_WORKERS` from 12/14/12/12 to 4 across all four services. The test was stopped at ~475-998 VUs (kill-delay) upon a confirmed sustained breach.

---

# Technical Report

## SLA Compliance

| Metric | Target | Run 7 | Run 8 | Result |
|---|---|---|---|---|
| P95 response time | < 150ms | 169.5ms→484.9ms | 150.4ms→994.0ms | FAIL both |
| Error rate | < 0.5% | 0% | 0% | PASS both |
| DB pool peak | n/a | 65% (141/216) | **100% (72/72)** | Newly exhausted |
| Event-loop lag peak | n/a | 172.8ms | **112.6ms** | Improved |

## Root Cause Analysis

### Finding 1 [CONFIRMED] — cart-service's own application code is not the bottleneck

**Observed:** A V8 CPU profile captured during sustained saturation (documented on PT-21 comment 10168) showed workers were 91.7% idle. No hot function exists to optimize.

**Verdict:** This finding stands independent of this retest's outcome — it was established via direct measurement, not inference from load-test behavior.

### Finding 2 [PARTIALLY SUPPORTED] — Reducing worker count lowered event-loop lag, consistent with reduced CPU contention

**Observed:** Event-loop lag peak dropped from 172.8ms (Run 7, 12 workers) to 112.6ms (Run 8, 4 workers) — a meaningful reduction, in the direction the CPU-oversubscription hypothesis predicts.

**Caveat:** This is the only metric that moved in the predicted direction. It is suggestive, not conclusive, on its own.

### Finding 3 [HIGH, NEW] — Reducing worker count introduced a confounding DB-pool bottleneck

**Observed:** `DB_POOL_MAX` (18 per worker) was not rebalanced when `NODE_CLUSTER_WORKERS` was reduced from 12 to 4, cutting total available DB connections from 216 to 72. DB pool hit 100% (72/72) at the same point the test broke — a brand new bottleneck that did not exist in Run 7 (which only reached 65%).

**Root cause hypothesis:** The breaking point in this run may be DB-pool-limited rather than CPU-limited, masking whatever true effect the worker-count reduction had on the underlying CPU contention.

**Recommended action:** Retest with `DB_POOL_MAX` raised to ~54 per worker (restoring ~216 total connections at 4 workers) to isolate the CPU-oversubscription variable cleanly, without a shrunken pool confounding the result.

**Retest required:** Yes — this is the critical next experiment before drawing a final conclusion.

### Finding 4 [INCONCLUSIVE] — Overall breaking point (VU count, RPS ceiling) did not measurably improve

**Observed:** P95 breach onset (~350-380 VUs) and peak RPS (~280-289 req/s) in Run 8 are statistically indistinguishable from Run 7's (~365-371 VUs, ~280-324 req/s).

**Interpretation:** Given Finding 3, this is most likely explained by the system hitting a *different* ceiling (DB pool) at roughly the same point the *old* ceiling (event-loop lag) used to bite — not by the CPU-oversubscription fix being ineffective. The confound must be removed before concluding either way.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Retest with `DB_POOL_MAX` rebalanced to ~54/worker (4 workers × 54 ≈ 216 total, matching Run 7's pool size) | Before drawing a final conclusion on the CPU-oversubscription fix |
| P2 | Fix the recurring kill-delay issue in monitoring tooling | Ongoing |
| P3 | If the rebalanced retest confirms improvement, propagate the same worker-count + DB-pool rebalance to orders-service and payments-service | After P1 |

---

# Business Report

## What Was Tested

A retest of the shopping-cart service after applying a fix based on direct technical profiling — rather than reacting to symptoms, we measured exactly where the system's processing time was going during a slowdown, and found the cause was different from what every prior fix attempt assumed.

## Key Question: Is It Ready?

**Overall verdict: Inconclusive — the fix shows a partial positive signal, but a side effect of the change introduced a new limiting factor that needs to be removed before we can draw a final conclusion.** One specific technical indicator (a measure of how backed-up the system gets internally) genuinely improved. However, the overall number of customers the system can handle before slowing down did not visibly change, because reducing the number of parallel worker processes also — without our intending it — reduced how many database connections were available at the same time. The system now hits that smaller limit at roughly the same point the old limit used to bite.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| The true effect of the CPU fix is currently hidden behind an unrelated, easily-fixed side effect | Medium | High | Rerun with the database connection limit restored to its previous size before judging the fix |
| If the CPU fix doesn't end up improving capacity once isolated, a different, more invasive approach (e.g., spreading services across more machines) may be needed | Medium | Unknown until retest | Defer until the cleaner retest result is in |

## What Happens If We Deploy Now

No change from the prior assessment — the shopping-cart service still slows down and the order-placement/payment services downstream still inherit that slowdown at a similar traffic level as before this fix.

## What Needs to Happen Before Go-Live

- Rerun the test with the database connection limit restored to verify whether the CPU fix genuinely improves capacity once the side effect is removed.
- Only after that clean result should a go/no-go decision account for this fix's real impact.

## What We Can Defer

- Propagating this fix to the other two affected services (order placement, payment processing) — hold until the cart-service retest gives a clean, unconfounded answer.

## Decision Required

**Still no-go for Black Friday today.** This round neither confirms nor rules out the deeper technical fix — recommend one more, carefully controlled retest before deciding whether this approach solves the capacity problem or whether a different approach is needed.

---

## Evidence

Saved to `results/2026-06-18_stress_cart_run8/`:
- `screenshot-01-apm-p95-latency.png`, `screenshot-02-apm-rps.png` — Grafana RED-metrics panels
- `screenshot-03-loki-cart-logs.png` — Loki cart-service log stream
- Full Run 8 execution report: `report-PT-16-2026-06-18-cart-run8.md`
- CPU profiling finding (prerequisite to this run): PT-21 comment 10168

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki) — 2026-06-18/19_
