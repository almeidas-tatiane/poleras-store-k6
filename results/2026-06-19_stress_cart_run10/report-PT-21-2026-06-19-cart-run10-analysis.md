# Performance Report Analysis — cart.test.js (Run 10 — DB-pool-rebalanced, unconfounded retest)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-19**
**Analysis target:** `tests/cart/cart.test.js` stress test results (PT-16 execution, Run 10)
**SLA reference (PT-7):** cart-service P95 < 150ms, error rate < 0.5% · Black Friday target: 2,500 VUs

---

## Test Conditions

This run was designed to resolve Run 8's open question: does reducing `NODE_CLUSTER_WORKERS` from 12 to 4 (the CPU-oversubscription fix, PT-21 commit `857912d`) actually improve cart-service's capacity ceiling, once the side-effect of a shrunken DB connection pool is removed? `DB_POOL_MAX` was raised from 18 to 54 per worker (4 × 54 = 216 total, matching Run 7's pool size exactly), and the test ran the full 14-minute profile to completion for the first time since the worker-count change.

---

# Technical Report

## SLA Compliance

| Metric | Target | Run 7 (12 workers) | Run 10 (4 workers, pool rebalanced) | Result |
|---|---|---|---|---|
| P95 response time | < 150ms | 169.5ms→484.9ms (stopped at 592 VUs) | 189.1ms→9,784ms (ran to 2,000 VUs) | FAIL both |
| Error rate | < 0.5% | 0% | 0.83% (cart-scoped) | FAIL (new, but still graceful — no crashes) |
| DB pool peak | n/a | 65% (141/216) | **100% (216/216)** | Saturates despite matched total size |
| Event-loop lag at matched VU/time (592 VUs, t+6m57.7s) | n/a | 172.8ms | 183.3ms | No improvement |

## Root Cause Analysis

### Finding 1 [CONFIRMED, carried over] — cart-service's own application code is not the bottleneck

Unchanged from Run 8: a V8 CPU profile during sustained saturation showed workers 91.7% idle. Still no hot function to optimize. This finding stands independent of this run's outcome.

### Finding 2 [RESOLVED — NEGATIVE] — Reducing worker count does not improve the capacity ceiling, once the DB-pool confound is removed

**Observed:** With `DB_POOL_MAX` rebalanced so total connections exactly match Run 7 (216), the comparison is now clean. At the identical elapsed time and VU count as Run 7's own stop point (t+6m57.7s, 592 VUs): P95 is 2.7x worse (1,323.8ms vs 484.9ms), and event-loop lag is not better (183.3ms vs 172.8ms) — it's marginally worse. The SLA-breach onset itself moved earlier, not later: ~317-321 VUs in Run 10 vs ~365-380 VUs in Run 7/8.

**This closes the question Run 8 left open.** Run 8's partial-positive signal (event-loop lag 112.6ms, lower than Run 7's 172.8ms) is now understood to have been an artifact of comparing different VU/time stopping points combined with the DB-pool confound — not a real effect of fewer workers. With the confound removed and a fair time-aligned comparison, fewer workers does not reduce event-loop contention; it most likely increases it, because the same total request load is now divided across fewer event loops, each handling more concurrent work.

**Verdict:** The CPU-oversubscription-via-worker-count-reduction fix is not supported by evidence. Recommend reverting `NODE_CLUSTER_WORKERS` to its prior value for cart-service (12) pending a different mitigation, rather than treating fewer workers as a capacity improvement.

### Finding 3 [NEW] — The DB pool now saturates earlier and harder under 4 workers than it did under 12, even with matched total connections

**Observed:** DB pool hit 100% (216/216) at ~585 VUs and stayed pegged there through the full ramp to 2,000 VUs. Run 7, at 12 workers with the same 216 total connections, only reached 65% before being manually stopped (it's untested whether Run 7 would also have saturated further out — it was never run to completion).

**Root cause hypothesis:** With fewer workers, each worker's single-threaded event loop services more concurrent in-flight requests, holding its share of checked-out connections longer before returning them to the pool — so the same total pool size empties faster and refills slower under 4 workers than under 12. This is a second, independent symptom of the same underlying problem as Finding 2: fewer workers concentrates contention rather than relieving it.

### Finding 4 [CONFIRMED, carried over] — Throughput (RPS) holds up; this is a pure latency/queueing failure, not a throughput collapse

**Observed:** RPS at the matched comparison point (592 VUs) was 299.5 req/s in Run 10 vs ~280-324 req/s in Run 7 — comparable, even slightly favorable. Zero EOF/connection-reset errors throughout. The system keeps processing requests at a similar rate; they just queue for much longer before completing. Consistent with cart-service's graceful-degradation pattern across all 10 runs.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Revert `NODE_CLUSTER_WORKERS` to 12 for cart-service (the rebalanced-pool retest shows 4 workers is a regression, not an improvement) — or investigate an intermediate worker count (e.g. 6-8) as a follow-up experiment | cart-service |
| P1 | Do **not** propagate the worker-count reduction + DB-pool rebalance to orders-service or payments-service — the premise it was based on (fewer workers relieves CPU oversubscription) did not hold up under a clean test | orders-service, payments-service |
| P2 | orders-service and payments-service are still running with the unverified 12→4 / 14→4 worker reduction from the same commit, with their own un-rebalanced DB pools (orders 126→36, payments 108→36 total). Given Finding 2/3, these are now suspect for the same regression, not just "unconfounded" — recommend reverting their worker counts too, or at minimum retesting before reporting their Run 7/Run 2 numbers as current | orders-service, payments-service |
| P3 | Fix the recurring kill-delay issue in monitoring tooling (now moot for this run, since it completed naturally, but still unresolved generally) | Tooling |
| P3 | Always pass `--env RESULT_DIR=results/<run-folder>` explicitly — this run's HTML report failed to generate because it wasn't passed and `handleSummary()` defaulted to a path outside the run folder | Tooling / script usage |

---

# Business Report

## What Was Tested

A controlled retest of the shopping-cart service's most recent fix attempt — reducing the number of parallel worker processes to relieve competition for the computer's processing cores. Last time we tested this, a second, unrelated side effect (a shrunken database connection limit) muddied the result. This time we corrected that side effect and ran a clean, complete test.

## Key Question: Is It Ready?

**Overall verdict: No — and we now have a clear, clean answer to a question that's been open for two rounds of testing. The fix does not work, and the evidence suggests it makes things slightly worse, not better.** With the side effect removed, the system breaks down at a *lower* number of concurrent customers than before the fix (roughly 320 vs 350-380), and at a matched point in the test, response times were nearly three times worse than before the fix was applied. The number of requests being processed per second stayed about the same — this isn't a crash or a capacity collapse, it's customers waiting much longer for the same work to get done.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| The current fix, if left in place, makes cart-service slightly worse than before, not better | Medium | Confirmed | Revert the worker-count change on cart-service |
| Order-placement and payment-processing services received the identical change in the same update and have not been retested since | High | Confirmed (same commit, same change) | Treat their last-validated numbers as stale; revert or retest before relying on them |
| The original goal — relieving competition for processing power across all four services — is still unsolved | High | Confirmed | A different approach is needed; reducing worker counts uniformly was not it |

## What Happens If We Deploy Now

The shopping-cart service would start slowing down for customers at a lower number of concurrent shoppers than it did before this round of changes — a step backward, not forward, relative to the prior validated state.

## What Needs to Happen Before Go-Live

- Revert the worker-count reduction on cart-service (and likely orders-service and payments-service, which received the same change and have not been retested).
- Identify a different way to relieve processing-power competition across the four services — this attempt is now ruled out by clean evidence, not just inconclusive.
- Only after a genuinely improving fix is found and verified should the full end-to-end test and final go/no-go decision proceed.

## What We Can Defer

- The full end-to-end (e2e) stress test — still correctly deferred; there's no value in testing the full purchase flow while the cart-service capacity question just got a worse answer than before.
- Any further investment in tuning the database-connection-pool size — this round shows the pool isn't the real constraint; it saturates as a downstream symptom, not the root cause.

## Decision Required

**Still no-go for Black Friday.** This round closes a two-test-long open question with a definitive negative: the worker-count fix should be reverted, not propagated. Recommend treating this as a "back to the drawing board" moment for the cart-service capacity ceiling, rather than continuing to iterate on the current approach.

---

## Evidence

Saved to `results/2026-06-19_stress_cart_run10/`:
- `k6-stdout.log` — full k6 text summary and run log
- `raw.json` — per-request JSON output
- This report and the companion execution report (`report-PT-16-2026-06-19-cart-run10.md`)
- Cross-verified against live Prometheus queries (`http_request_duration_seconds_bucket`, `db_connections_total`, `nodejs_eventloop_lag_p99_seconds`, `http_requests_total`) for `job="cart-service"` over the test window (2026-06-19 12:05:20-12:19:26 -03:00)
- `cart-report.html` was not generated this run (see PT-16 report's note on `RESULT_DIR`)

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus) — 2026-06-19_
