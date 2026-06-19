# Stress Test — cart-service Run 10 (DB-pool-rebalanced retest) — 2026-06-19

**Script:** `tests/cart/cart.test.js`
**Load profile:** 100→200→400→800→1,200→2,000 VUs (2 min/stage) + 2 min ramp-down — full 14m run, completed without being killed
**Config under test (unchanged from Run 8/9):** `NODE_CLUSTER_WORKERS=4`, **`DB_POOL_MAX=54`** (rebalanced from Run 8's confounded `18`; 4 workers × 54 = 216 total connections, matching Run 7's pool size exactly)

**Command used:**
```bash
k6 run --env TEST_TYPE=stress \
  --out json=results/2026-06-19_stress_cart_run10/raw.json \
  tests/cart/cart.test.js \
  > results/2026-06-19_stress_cart_run10/k6-stdout.log 2>&1
```
> Note: `RESULT_DIR` was not passed, so `handleSummary()` defaulted to `results/2026-06-19_stress_cart/cart-report.html` (a path that doesn't exist) and failed to write the HTML report — a tooling mistake on this run. No data was lost: full k6 text summary is in `k6-stdout.log`, raw per-request data in `raw.json`, and this report cross-checks both against live Prometheus queries for the test window.

**Prompt used:**
> "ok, proceed" (following an agreed priority list: rebalance DB_POOL_MAX to ~54/worker and retest cart-service in isolation before touching orders/payments) + "and update PT-16 and PT-21 accordingly"

---

## Test Outcome — Clean result, and it's negative: the worker-count-reduction fix does not improve capacity, and now shows a likely regression

All five services were health-checked before the run (`users-api`, `products-service`, `cart-service`, `orders-service`, `payments-service` — all 200 OK), avoiding the environment-outage problem that invalidated the prior attempt (Run 9, `users-api` down). The early-abort guard (first 90s, error rate threshold) was clear. The test ran the **full 14-minute profile to completion** — no kill-delay artifact this time, the first cart-service run to do so since the worker-count change.

**Both cart-scoped thresholds failed:**
- `http_req_duration{service:cart}` p95 = **5.74s** (target < 150ms)
- `http_req_failed{service:cart}` rate = **0.83%** (target < 0.5%)
- Global error guard held throughout (0.66% overall) — no abort, zero EOF/connection-reset errors. Cart-service's established graceful-degradation pattern continues across all 10 runs.

**SLA breach onset:** P95 crossed 150ms at **t+5m10.7s, ~317-321 VUs** (15s-step Prometheus range query: `90.5→71.8→143.3→189.1(BREACH)→245.6→487.8ms`). DB pool was only 75-91/216 (~35-42%) at this point — the initial breach is **not** DB-pool-driven, consistent with the event-loop/CPU hypothesis.

**Apples-to-apples comparison with Run 7 at the identical elapsed time and VU count (t+6m57.7s, 592 VUs — Run 7's own manual-stop point):**

| Metric | Run 7 (12 workers, DB pool 18/worker) | Run 10 (4 workers, DB pool 54/worker) | Read |
|---|---|---|---|
| P95 latency | 484.9ms | **1,323.8ms (2.7x worse)** | Regression |
| Event-loop lag p99 | 172.8ms | 183.3ms (comparable, slightly worse) | No improvement |
| DB pool usage | 65% (141/216) | **100% (216/216) — already pegged** | New, earlier saturation |
| RPS | ~280-324 | 299.5 | Comparable — throughput holds, it's pure latency/queueing |

**DB pool hit 100% (216/216) at ~t+6m55s (~585 VUs) and stayed pegged there for the remainder of the test, through the full ramp to 2,000 VUs and into ramp-down** — despite having the same total connection count as Run 7. With only 4 workers instead of 12, each worker's single-threaded event loop has to service more concurrent in-flight requests, holding its share of connections checked out longer before returning them — so the *same* total pool size saturates sooner and stays saturated harder under 4 workers than under 12.

**Conclusion: this is the clean, unconfounded result the team was waiting for since Run 8 — and it does not support the worker-count-reduction fix.** Breach onset is now earlier (~317-321 VUs vs Run 7/8's ~350-380), event-loop lag is not meaningfully better, and the rebalanced DB pool saturates faster and harder than it did at 12 workers. The fix should be considered for reversion on cart-service, not propagated to orders-service/payments-service.

---

## Cart-service Run 7 / Run 8 / Run 10 Comparison

| Metric | Run 7 (12 workers) | Run 8 (4 workers, pool=18 — confounded) | Run 10 (4 workers, pool=54 — clean) |
|---|---|---|---|
| Breaking point (P95 breach onset) | ~365-371 VUs | ~350-380 VUs | **~317-321 VUs (earlier)** |
| P95 at Run 7's own stop point (592 VUs / t+6m57.7s) | 484.9ms | n/a (different stop point) | **1,323.8ms** |
| Event-loop lag peak (full run, 2,000 VUs reached) | 172.8ms (at 592 VU stop) | 112.6ms (at 475 VU stop) | 358.9ms (at full 2,000 VUs — not a fair max-to-max comparison, but at Run 7's same VU/time: 183.3ms) |
| DB pool peak | 65% (141/216) | 100% (72/72) | **100% (216/216) — saturates despite matched total size** |
| Error rate | 0% | 0% | 0.83% (cart-scoped; still graceful, no crashes) |
| Completed full 14m profile? | No (manual stop) | No (kill-delay, stopped ~9m) | **Yes — first full completion** |

---

## Recovery

`curl http://localhost:3003/health` immediately after ramp-down completed → `200 OK`, 13ms. No container restarts. **Recovery: clean and fast, consistent with every prior run.**

---

## PT-16 Success Criteria Assessment

| Criteria | Status | Notes |
|---|---|---|
| Breaking point VU count documented | ✅ | ~317-321 VUs (P95 breach onset) — earlier than Run 7/8 |
| P95 latency and error rate at breaking point recorded | ✅ | P95 189ms at breach, climbing to 9.78s peak at 2,000 VUs; error rate 0.83% (cart-scoped) |
| Weakest service in the stack identified | ✅ (carried over) | Still cart-service, per Run 1-9 investigation |
| Recovery time after load drops documented | ✅ | Clean, fast (13ms health check) |
| Results saved to `results/YYYY-MM-DD_stress_{service}/` | ⚠️ Partial | `k6-stdout.log` ✅, `raw.json` ✅, this report ✅. `cart-report.html` missing — `RESULT_DIR` env var was not passed at launch, so `handleSummary()` wrote to a non-existent default path and failed. No data lost (cross-verified against live Prometheus); fix on next run is to always pass `--env RESULT_DIR=results/<run-folder>`. |

**4 of 5 PT-16 success criteria fully satisfied for this run; the HTML-report gap is a tooling miss, not a data gap.**
