# Performance Test Technical Report — products.test.js · Full Series (Runs 1–5 + BF Validation)

**Skill:** performance-report-analysis
**Scope:** products.test.js — all executions, comparative analysis
**Date:** 2026-06-17
**Test types:** Stress (Runs 1–5) · Load / BF Readiness Validation (BF Validation)
**Tool:** k6 v1.0.0-rc1
**Environment:** Local Docker (development)
**Load profiles:**
- Stress (Runs 1–5): 100→200→400→800→1,200→2,000 VUs · 2 min/stage · 14 min
- BF Validation: 3 min ramp → 5 min steady-state at 2,500 VUs → 2 min ramp-down · 10 min
**Related tickets:** PT-16 (execution) · PT-21 (analysis) · PT-7 (SLAs) · PT-6 (reporting)

---

## Executive Summary

products-service underwent six progressive test runs identifying and resolving a DB connection pool exhaustion bug (Run 4: 931 errors, 0.34% error rate), then certifying zero-error performance up to 2,000 VUs with server-side P95 of 44ms (Run 5). The Black Friday validation test at 2,500 VUs revealed a second, independent bottleneck: Node.js cluster master IPC saturation. The service holds the 100ms P95 SLA for approximately 2 minutes of sustained 2,500 VU load, then degrades progressively to 4,620ms P95 with no self-correction. **The service is NOT ready for the Black Friday target of 2,500 VUs without a cluster architecture change.**

---

## SLA Compliance — All Runs

SLAs from PT-7: P95 < 100ms · Error rate < 0.5%

| Run | Config | VU Peak | Error Rate | Server P95 at Peak | k6 Global P95 | Error SLA | Latency SLA |
|---|---|---|---|---|---|---|---|
| Run 1 | 1 worker · default pool · PG 100 | ~600 | N/A (not tracked) | N/A | ~4,850ms | — | ❌ |
| Run 2 | 1 worker · pool ~25 · PG 100 | ~1,200 | 0.00% | N/A | ~2,050ms | ✅ | ❌* |
| Run 3 | 4 workers · pool 25 · PG 100 | ~1,200 | **0.003%** (4 errors) | 72ms | 778ms | ✅ | ❌* |
| Run 4 | 8 workers · pool 13 · PG 100 | ~1,150 | **0.34%** (931 errors) | 72ms | 1,570ms | ❌ | ❌* |
| Run 5 | 12 workers · pool 9 · PG 150 | 2,000 | **0.00%** | **44ms** ✅ | 1,500ms | ✅ | ✅ (server) |
| **BF Validation** | 12 workers · pool 9 · PG 150 | **2,500** | **0.00%** | **4,620ms** | 3,450ms | ✅ | ❌ |

> *k6 global P95 in Runs 1–5 includes TCP connection overhead from localhost stress testing. Server-side Prometheus P95 is the authoritative SLA metric for those runs. Run 5 server P95 (44ms) was within SLA. BF Validation k6 P95 (3,450ms) equals server-side wait time — the breach is confirmed server-side.

---

## Findings

### [CRITICAL] Finding 1 — BF Validation: Cluster Master IPC Saturation Causes Progressive P95 Collapse at 2,500 VUs

**Observed:** During the BF validation steady-state at 2,500 VUs, server-side P95 held at 44–93ms for the first ~2 minutes then escalated progressively: 165ms → 1,701ms → 2,484ms → 4,620ms peak. The degradation never stabilized — it continued to worsen for the full 5-minute steady-state window with no self-correction. k6 final P95: 3,450ms (server-side wait time confirmed, not TCP overhead: `http_req_connecting` P95 = 0s, `http_req_waiting` P95 = 3,450ms).

**P95 escalation timeline (Prometheus):**

| Time UTC | VUs | /api/categories | /api/products | /api/products/:slug |
|---|---|---|---|---|
| 20:39:30Z | ~2,500 | 46ms ✅ | 60ms ✅ | 23ms ✅ |
| 20:41:00Z | 2,500 | 89ms ✅ | 70ms ✅ | 93ms ✅ |
| 20:41:30Z | 2,500 | 90ms ✅ | **165ms** ❌ | 93ms ✅ |
| 20:42:30Z | 2,500 | 89ms ✅ | **1,701ms** ❌ | 93ms ✅ |
| 20:43:30Z | 2,500 | **1,935ms** ❌ | **2,484ms** ❌ | **2,052ms** ❌ |
| 20:44:30Z | ~2,000↓ | **4,620ms** ❌ | **2,412ms** ❌ | **2,546ms** ❌ |

**Root cause:** Node.js native cluster routes all TCP connections through a single master process via IPC messages. At 2,500 sustained VUs, the master's IPC queue grows faster than it drains. Workers remain healthy (0 errors, 100% correct responses when requests arrive) but requests queue at the master before routing. The event loop lag of the master process, sustained at 180–369ms throughout the steady-state phase, is the direct indicator of this saturation.

**Evidence chain:**
- `http_req_connecting` P95 = 0s → TCP connects fine, bottleneck is post-connection
- `http_req_waiting` P95 = 3,450ms → server queues the request after connection
- Event loop lag: 180ms at ~2,000 VUs (ramp) → sustained 210–292ms during SS → 369ms peak
- DB connections: 110/150 (73%) throughout — stable, not the bottleneck
- Error rate: 0.00% — workers process requests correctly when they get them
- Recovery: event loop returns to 21ms baseline within 90s of ramp-down, confirming no persistent damage

**Contrast with Run 5 (2,000 VUs):** Event loop lag peaked at 278ms transiently at the very 2,000 VU peak, then recovered immediately during ramp-down. At 2,500 VUs sustained, it is chronically elevated throughout the steady-state phase — the saturation threshold is between 2,000 and 2,500 VUs.

**Recommended action:** Replace Node.js native cluster (`cluster.fork()`) with PM2 cluster mode. PM2 runs each worker as an independent process with its own event loop and uses `SO_REUSEPORT` (or equivalent) for connection distribution without a shared master IPC bottleneck. Expected outcome: event loop lag drops to baseline (<25ms) at 2,500 VUs, P95 returns to ~55–65ms (extrapolated from Run 5 trend).

**Owner:** Backend Engineering
**Effort:** Medium (PM2 config change + container rebuild + retest)
**Retest required:** Yes — full BF validation at 2,500 VUs after fix

---

### [HIGH] Finding 2 — Run 4: DB Connection Pool Exhaustion — 931 Errors (0.34% Error Rate)

**Observed:** Run 4 (8 workers, DB_POOL_MAX=13, PG max_connections=100) produced 931 HTTP errors (0.34% error rate) at the ~1,150 VU peak. Error type: `"sorry, too many clients already"` — PostgreSQL rejecting new connections when the pool aggregate (8×13=104) exceeded `max_connections` (100).

**Root cause:** Pool math error. Each of the 8 workers maintained up to 13 connections independently, for an aggregate ceiling of 104 — 4 above the PostgreSQL hard limit of 100.

**Fix applied in Run 5:**
- `DB_POOL_MAX`: 13 → 9 per worker (12×9=108 aggregate)
- `products-db max_connections`: 100 → 150 (headroom above aggregate)
- `NODE_CLUSTER_WORKERS`: 8 → 12 (more processing capacity)
- Result: 931 errors → 0 errors. Confirmed stable across Run 5 (2,000 VUs) and BF Validation (2,500 VUs).

**Owner:** Backend Engineering / DevOps
**Effort:** Applied (config change, already in production state)
**Retest required:** Completed — Run 5 and BF Validation both confirm fix holds

---

### [MEDIUM] Finding 3 — Event Loop Lag Threshold (300ms) Crossed at 2,500 VUs

**Observed:** Event loop lag P95 exceeded the 300ms P2 threshold (identified in Run 5 report) during BF validation: peak 369ms at 20:43:30Z. Sustained at 210–292ms for the entire 5-minute steady-state phase.

| Run | Peak Event Loop Lag | Behavior | Status |
|---|---|---|---|
| Run 5 | 278ms (at 2,000 VU peak) | Transient spike, recovered during ramp-down | ⚠️ |
| BF Validation | 369ms (sustained throughout SS) | Chronic — never recovered during load | ❌ |

**Recommended action:** PM2 cluster mode (Finding 1) will resolve this — PM2 eliminates the shared master event loop entirely.

**Owner:** Backend Engineering
**Retest required:** Yes (implicit in Finding 1 retest)

---

### [MEDIUM] Finding 4 — 500 VU Gap Between Certified Capacity and BF Target

**Observed:** Run 5 formally certified zero-error operation with SLA compliance (44ms server P95) at 2,000 VUs. Black Friday target is 2,500 VUs — a 25% increase. This gap was validated in BF Validation, which confirmed the service fails SLA at 2,500 VUs.

**Quantified gap:**
- Certified: 2,000 VUs · server P95 44ms · error rate 0.00%
- Target: 2,500 VUs · required P95 <100ms · required error rate <0.5%
- Current status at 2,500 VUs: P95 4,620ms (held for 2 min at 89–93ms, then collapsed)

**Recommended action:** Fix Finding 1 (cluster architecture), then re-certify at 2,500 VUs.

**Owner:** Performance Testing Team + Backend Engineering
**Retest required:** Yes

---

### [LOW] Finding 5 — P3 Slug Endpoint Single-JOIN Optimization Verified

**Observed:** The `/api/products/:slug` endpoint was optimized (Run 5 recommendation P3) by replacing 2 sequential DB queries with a single JOIN + `json_agg`. During BF validation first 2 minutes of steady-state, slug P95 was 22–93ms — comparable to categories and products. In Run 5, slug was the slowest endpoint (44ms vs 8ms for others at peak). The optimization equalized endpoint performance.

**Impact:** Eliminated one DB round-trip per cache miss. Under high load, cache misses at 2,500 VUs are more frequent — the optimization is more impactful at BF scale. Slug degraded at the same time as all other endpoints during BF validation, confirming the root cause is cluster master saturation (shared bottleneck), not the query.

**Owner:** Backend Engineering
**Retest required:** No (verified working)

---

### [INFORMATIONAL] Finding 6 — k6 Global P95 vs Prometheus P95: Measurement Methodology

**Observed:** In Runs 1–5, k6 global P95 significantly exceeded Prometheus server-side P95 (e.g., Run 5: k6 1,500ms vs Prometheus 44ms at 2,000 VUs). In BF Validation, they converge (k6 3,450ms vs Prometheus 4,620ms peak) because the breach is server-side.

| Run | k6 Global P95 | Prometheus P95 | Gap | Cause |
|---|---|---|---|---|
| Run 5 | 1,500ms | 44ms | 1,456ms | TCP connection overhead at 2,000 concurrent VUs (localhost) |
| BF Validation | 3,450ms | 4,620ms (peak SS) | — | Both reflect server-side queuing; Prometheus peak is higher than k6 average |

**Impact:** None on findings. Important for documentation: k6 threshold breaches in Runs 1–5 are not indicative of server degradation. In BF Validation, the k6 P95 is entirely server-side.

---

## Comparative Analysis — Full Series

| Metric | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | BF Validation |
|---|---|---|---|---|---|---|
| Workers | 1 | 1 | 4 | 8 | 12 | 12 |
| DB_POOL_MAX/worker | default | ~25 | 25 | 13 | 9 | 9 |
| PG max_connections | 100 | 100 | 100 | 100 | **150** | 150 |
| Aggregate DB pool | ~10 | ~25 | 100 | **104 ❌** | 108 ✅ | 108 ✅ |
| HTTP errors | N/A | 0 | 4 | **931 ❌** | 0 ✅ | 0 ✅ |
| Error rate | N/A | 0% | 0.003% | **0.34% ❌** | 0.00% ✅ | 0.00% ✅ |
| Server P95 at peak | N/A | N/A | 72ms ✅ | 72ms ✅* | **44ms ✅** | **4,620ms ❌** |
| k6 global P95 | ~4,850ms | ~2,050ms | 778ms | 1,570ms | 1,500ms | 3,450ms |
| DB connections peak | N/A | N/A | ~100 | N/A | 110/150 ✅ | 110/150 ✅ |
| Event loop lag peak | N/A | N/A | N/A | N/A | 278ms ⚠️ transient | 369ms ❌ sustained |
| Recovery time | N/A | N/A | N/A | N/A | ~90s ✅ | ~90s ✅ |
| Throughput | N/A | N/A | N/A | 319 RPS | 325 RPS | **569 RPS** |
| VU peak reached | ~600 | ~1,200 | ~1,200 | ~1,150 | 2,000 ✅ | **2,500 ✅** |

> *Run 4 server P95 of 72ms is valid but the test was effectively broken by pool exhaustion — the 931 errors represent requests that never reached latency measurement.

---

## Regression Analysis — Run 5 → BF Validation

| Metric | Run 5 (baseline) | BF Validation | Delta | Flag? |
|---|---|---|---|---|
| Error rate | 0.00% | 0.00% | = | ✅ No regression |
| Server P95 at peak | 44ms | 4,620ms | +10,400% | ❌ CRITICAL |
| k6 global P95 | 1,500ms (TCP overhead) | 3,450ms (server-side) | +130% | ❌ (methodology change) |
| Event loop lag peak | 278ms transient | 369ms sustained | +33% peak / qualitative change | ❌ |
| Throughput | 325.6 RPS | 569.3 RPS | +75% | ✅ (more VUs) |
| DB connections peak | 110/150 | 110/150 | = | ✅ No regression |
| Recovery time | ~90s | ~90s | = | ✅ |

---

## Infrastructure Observations (BF Validation)

| Resource | Baseline | 2,500 VU Steady-State | Recovery | Status |
|---|---|---|---|---|
| DB connections | 62 | **110/150 (73%)** | 62 in <30s | ✅ Never hit 120 alert |
| Event loop lag P95 | 20ms | **180–369ms sustained** | 21ms in ~90s | ❌ Chronic saturation |
| HTTP 5xx errors | 0 | 0 | — | ✅ |
| k6 interrupted iterations | 0 | 0 | — | ✅ |
| Throughput | — | **569 RPS peak** | — | ✅ |

---

## Recommendations Summary

| Priority | Action | Owner | Effort | Urgency |
|---|---|---|---|---|
| **P1-BF** | Migrate `products-service` from Node.js native `cluster` to **PM2 cluster mode** — eliminates shared master event loop, each worker handles its own connections via `SO_REUSEPORT` | Backend Eng | Medium | Before BF |
| **P2-BF** | Alternative: run N independent Node.js processes (no master) behind a load balancer — same outcome, more operational complexity | Backend Eng | Medium-High | Before BF |
| **P3-BF** | Re-run BF validation at 2,500 VUs for 5+ minutes steady-state after cluster fix — need confirmed P95 <100ms sustained | Performance Team | 10-min test | After fix |
| **P4** | Add Grafana alert: `nodejs_event_loop_lag_p95_seconds{job="products-service"} > 0.2` for 2+ minutes — early warning before the 300ms saturation threshold | DevOps | Low | Post-BF |
| **P5** | Consider adding covering index on `products(slug, is_active)` — eliminates seq scan on slug lookup (low impact now, but reduces DB load at 2,500+ VUs) | Backend Eng | Low | Post-BF |

---

## Test Conditions and Limitations

- **Environment:** Local Docker on development machine. Absolute latency values are development baselines, not production-absolute. Production latency will differ due to network, TLS, load balancer.
- **k6 P95 methodology:** Runs 1–5 k6 P95 includes TCP connection overhead; Prometheus server-side P95 is used for SLA evaluation. BF Validation k6 P95 = server-side wait time (same root cause as Prometheus).
- **Single node:** All tests run on a single Docker host. Production multi-node setup will behave differently — each node runs its own cluster, so master IPC overhead may scale differently.
- **No other services under load:** Only products-service was loaded. Full e2e stress test may reveal additional constraints.

---

# Performance Test — Business Summary

| | |
|---|---|
| **System tested** | Poleras Store — Product Catalog (categories, product listing, product detail pages) |
| **Analysis date** | 2026-06-17 |
| **Test series** | Stress Tests Runs 1–5 + Black Friday Readiness Validation |
| **Prepared by** | Performance Testing Team |

---

## What Was Tested

Over six progressive tests, we pushed the Poleras Store product catalog from its initial state to the Black Friday target load. Each test built on the previous, identifying and resolving problems as they appeared. The final test — the Black Friday validation — simulated exactly 2,500 simultaneous shoppers continuously browsing product categories, listings, and product detail pages for 10 minutes, mirroring the expected Black Friday traffic pattern.

---

## Key Question: Is It Ready?

**Overall verdict: Not ready — one architectural change required before Black Friday**

The product catalog successfully handled 2,000 simultaneous shoppers with zero failures and fast response times (confirmed in Run 5). When we pushed to the Black Friday target of 2,500 shoppers, product pages were initially fast for about 2 minutes, then slowed progressively until response times exceeded acceptable limits by 46 times. The slowdown accelerates over time under sustained load and does not recover on its own. This is a known, diagnosable problem with a specific technical solution. With one architectural change — estimated as a medium-effort engineering task — the service should pass the 2,500-shopper validation.

---

## Risk Summary

| Risk | Business Impact | Likelihood | Recommended Action |
|---|---|---|---|
| Product pages slow to 46× acceptable speed at Black Friday peak, after 2 minutes | Shoppers abandon carts; direct revenue loss during the highest-traffic window of the year | **High** — confirmed by test at exact BF load | Implement the architectural fix before BF and retest |
| Fix cannot be completed before Black Friday | Forced to launch with degraded performance at peak | Low-Medium — depends on engineering schedule | Begin fix immediately; if not completed, consider traffic throttling or load shedding |
| Fix introduces regressions | New architecture may cause different unexpected issues | Low — PM2 is a mature, widely-adopted solution | Rerun full validation after fix; maintain rollback plan |
| Database connection issues return | Recurrence of the Run 4 error scenario | Very Low — fix confirmed in two subsequent tests (2,000 and 2,500 VUs) | No action required; monitoring alert is in place |

---

## What Happens If We Deploy Now

If Black Friday begins with the current catalog, the first 2 minutes will appear normal — product pages will load quickly and no transactions will fail. After that 2-minute window at peak traffic, page response times will begin to climb. Within 5–7 minutes, product pages will take more than 4 seconds to load for many users. Shoppers will experience visible slowdowns, likely leading to page refreshes that worsen the situation, and a significant portion will abandon before adding items to their cart.

The key risk is revenue during the peak window: Black Friday traffic does not gradually build and sustain — it peaks hard and sustains. The current system fails precisely in the scenario that matters most.

Importantly, no transactions will actually fail (there are no crashes or errors), but the slowdown alone will drive abandonment. Based on industry benchmarks, a 4-second page load results in conversion rates 3–4× lower than a sub-1-second load.

---

## What Needs to Happen Before Go-Live

- **One engineering change to the server startup configuration** — the product catalog server needs to be updated from its current process management model to a more scalable one that eliminates the shared scheduling bottleneck. This is a known, well-documented solution used by other Node.js services at high traffic. Once deployed, it needs a 10-minute validation test to confirm the 2,500-shopper target is met.

---

## What We Can Defer

- **A query efficiency improvement for product detail pages** — the fix applied before the BF validation test already improved this significantly. A further database index improvement would marginally reduce server load at extreme traffic but is not blocking.
- **An automated alert for database connection pressure** — the database monitoring alert implemented before the BF validation test is already in place. Formal tuning of alert thresholds can be done post-launch.
- **A separate event loop health alert** — useful for ongoing monitoring, does not need to block launch.

---

## Decision Required

| Option | What It Means | Risk |
|---|---|---|
| **Apply the fix and retest before Black Friday** | 1–2 days engineering + 10-minute retest. If it passes, launch with full confidence. | Low — fix is well-understood, retest provides certainty |
| **Launch as-is and monitor closely** | Rely on the 2-minute window before degradation. Have engineering on standby. | High — degradation will likely occur at peak; response time under incident pressure is slower than a planned fix |
| **Reduce Black Friday traffic target** | Limit promotions to stay under 2,000 concurrent shoppers. | Medium — reduced revenue upside, but avoids the known failure mode |

**Recommendation:** Apply the fix and retest. The engineering effort is bounded, the solution is well-understood, and the test is fast. Launching with a known, confirmed failure mode at the target peak load is not a defensible position when a fix is available.

---

## Grafana Evidence

| Screenshot | Description |
|---|---|
| `screenshot-01-full-window-apm.png` | APM dashboard — full BF validation test window. P95 global 2.35s (RED), P50 936ms (RED), 0 5xx errors (GREEN), products-service peak 1.44K RPS |
| `screenshot-02-event-loop-lag.png` | Event Loop Lag P99 panel — APM dashboard, BF validation window |
| Run 5 `screenshot-04-t13m-peak-apm.png` | APM at 2,000 VU peak (Run 5) — all within SLA |
| Run 5 `screenshot-06-final-slo.png` | SLO error budget dashboard post-Run 5 |

---

_Performance Report Analysis generated by performance-report-analysis skill · 2026-06-17_
_k6 results: results/2026-06-17_bf-validation_products/ · results/2026-06-17_stress_products_run5/_
_Grafana evidence: Prometheus (P95, event loop lag, DB connections) · Loki (error scan)_
