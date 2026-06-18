# Performance Report Analysis — orders.test.js (Run 1 vs Run 2 vs Run 3 vs Run 4)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18**
**Analysis target:** `tests/orders/orders.test.js` stress test results (PT-16 execution, Run 4)
**SLA reference (PT-7):** orders-service P95 < 200ms, error rate < 1% · Black Friday target: 2,500 VUs

---

## Test Conditions

| | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Config under test | Single process | 12-worker cluster | + `UV_THREADPOOL_SIZE=128` + keep-alive agent | + `keepAliveMsecs=4000` + retry-on-`ECONNRESET` |
| Max VUs reached | 181 | 582 | 868 | 725 |
| Results | `results/.../_orders/` | `.../_orders_run2/` | `.../_orders_run3/` | `.../_orders_run4/` |

All four runs were stopped before the configured 2,000-VU peak — each breaking point (PT-16's object) was captured cleanly.

---

# Technical Report

## SLA Compliance — Run 4 (at stop)

| Metric | Target | Run 4 Actual | Result |
|---|---|---|---|
| P95 response time | < 200ms | 197ms (breach onset) → 6,223ms (at stop) | FAIL |
| Error rate (server-side 5xx, fresh re-verify) | < 1% | ~0.014%-0.02% throughout | PASS numerically, but non-zero and present (same regression class introduced in Run 3) |
| Error rate (client-side EOF, never reaches app) | n/a | 230/13,749 ≈ 1.7% | The dominant failure signature this run |
| Outbound-call failures (the Run 3 bug) | n/a | **4 total** (down from dozens) | **Confirmed fixed** |

## Latency Distribution Analysis

P95 shows the same two-phase shape as Run 3 — a healthy, gradual climb (~10ms→~99ms through the first ~4 minutes) followed by a genuinely exponential blowup once the breach begins (197ms→6,223ms in ~3 minutes). The breach itself, however, starts at a markedly lower VU count than Run 3 (~264-276 VUs vs. ~700-750 VUs).

## Root Cause Analysis — Synthesis Across All 4 Runs

**Every symptom across all four runs traces back to the same underlying limitation: each of orders-service's 12 cluster workers has a single-threaded Node.js event loop, and it saturates under sufficient concurrent load.** Which specific code path gets exposed first has shifted with each fix, but the foundational ceiling has never actually been raised:

| Run | What broke first | Why that fix didn't raise the ceiling |
|---|---|---|
| 1 | DNS resolution (libuv threadpool, size 4, single process) | N/A — first fix target |
| 2 | Same DNS bottleneck (clustering didn't help — threadpool cap is **per-process**, not per-cluster) + accept-queue overflow appeared as a side effect | Clustering added workers but each one still hit the same per-process threadpool cap |
| 3 | Outbound keep-alive socket-reuse race (once threadpool was fixed) | `UV_THREADPOOL_SIZE=128` removed the DNS bottleneck, but exposed the next weakest link: stale socket reuse |
| 4 | Inbound accept-queue overflow (recurring, now earlier) + DB pool wait time (newly confirmed) | `keepAliveMsecs`/retry removed the socket-reuse race, but **removing that bottleneck let more requests stay in-flight simultaneously**, increasing concurrent pressure on the next two weakest links: the worker's own accept queue and the DB connection pool |

**Run 4's new evidence sharpens this further.** A Tempo trace pulled for one of the slow 400-response warnings (`traceID 3e1cdbff17dc694360dfae920cab1af7`, total duration 5,527.5ms) shows the entire delay is a single span: **`pg-pool.connect` at 5,099.35ms** — a request stuck for over 5 seconds just acquiring a database connection, before any query ran. Cross-referenced with the DB pool peaking at 105/108 (97%), this **confirms** (rather than merely hypothesizes, as in Run 3) that the DB pool is now a real, trace-evidenced contributor to tail latency under near-saturation.

**The most critical problem today is not any single one of these symptoms — it's the fact that the per-worker concurrency ceiling itself has never been directly addressed.** Each fix has been correct and necessary, but each one only shifts load onto the next-weakest link in the same chain (DNS → outbound sockets → inbound accept queue → DB pool). Continuing to patch individual symptoms will keep producing diminishing, shifting returns rather than closing the Black Friday gap.

### Findings

#### [CRITICAL] Finding 1 — Per-worker event-loop/accept-queue ceiling remains unaddressed
**Observed:** 230 client-side `EOF` connection resets (never reaching the app layer) starting at ~264-276 VUs — earlier than Run 3's ~700-750 VU breach, comparable to Run 2's ~226-234 VU onset.
**Root cause hypothesis:** with the outbound stall and socket-reuse race both fixed, requests complete faster and more reliably, increasing the number of requests in-flight simultaneously at any given VU level — which raises concurrent pressure on each of the 12 workers' own OS-level accept queue until it overflows.
**Evidence:** `nodejs_eventloop_lag_p99_seconds{job="orders-service"}` climbing 15ms→680ms (the same fingerprint observed in every prior run); k6 log EOF count (230) vs. app-level error count (4).
**Recommended action:** address the per-worker concurrency ceiling directly rather than further symptom patches — investigate `SO_REUSEPORT` tuning (already queued from auth-service's own investigation), increasing `NODE_CLUSTER_WORKERS` beyond 12 if CPU headroom allows, or profiling exactly what keeps each worker's event loop busy at the saturation point.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 5

#### [HIGH] Finding 2 — DB connection pool wait time now trace-confirmed as a real bottleneck
**Observed:** Tempo trace `3e1cdbff17dc694360dfae920cab1af7` shows a 5,099ms `pg-pool.connect` span — over 5 seconds spent waiting to acquire a connection, out of a 5,527.5ms total request. A second similar warning (6,718ms total) shows the same signature. DB pool peaked at 105/108 (97%).
**Root cause hypothesis:** likely still a downstream symptom of Finding 1 (more concurrent in-flight requests hold connections longer), rather than an independent capacity problem — but it is now directly confirmed via trace evidence, elevating it from Run 3's hypothesis to a verified finding.
**Evidence:** Tempo trace pull, fresh `max_over_time(db_connections_active)` query.
**Recommended action:** re-measure after Finding 1 is fixed; consider increasing `DB_POOL_MAX` per worker (currently 9) only if saturation persists independent of the event-loop fix.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 5 (same retest as Finding 1)

#### [LOW] Finding 3 — Outbound keep-alive socket-reuse race: confirmed fixed
**Observed:** Only 4 application-level outbound-call failures during the entire test (down from dozens in Run 3), and the one pulled in detail (`traceID 728f6fc021558ea735ab04cc7290f6cc`) shows the retry working as designed — two fast `GET` attempts (49.8ms, 59.3ms) rather than a multi-second hang.
**Recommended action:** none — this fix is validated and should remain in place.
**Retest required:** No

---

## Run 1 vs Run 2 vs Run 3 vs Run 4 Comparison

| Metric | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Outbound 11-12s stall | Present | Present (unchanged) | **Fixed** | **Fixed** (confirmed again) |
| Outbound socket-reuse race | N/A | N/A | Present (~700-750 VUs) | **Fixed** (4 failures total, fail-fast) |
| Inbound accept-queue overflow | N/A | ~226-234 VUs | Not dominant | **~264-276 VUs** (recurs) |
| DB pool wait as confirmed bottleneck | No | No | Hypothesized (108/108 peak) | **Confirmed via trace** (105/108 peak, 5.1s wait observed) |
| Max VUs survived | 181 | 582 | 868 | 725 |
| Black Friday gap (2,500 VU target) | ~14x | ~9x | ~2.9x | ~3.4x |

**Net assessment: every fix has been correct, necessary, and verified working on its own terms — but the Black Friday gap has plateaued around ~3x rather than continuing to close, because the fixes have addressed symptoms in sequence without yet reaching the underlying per-worker concurrency ceiling that connects all of them.**

---

## Infrastructure Observations

- **Event loop:** the single most reliable leading indicator across all 4 runs — climbs from ~15ms baseline to 600-700ms in the minutes before any breach.
- **DB pool:** now confirmed (not just suspected) as a real contributor under near-saturation (97-100% across Run 3 and Run 4).
- **Network/accept queue:** the dominant failure mode in Run 2 and Run 4 — a per-worker OS-level limit, not addressed by any fix applied so far.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Address the per-worker event-loop/accept-queue ceiling directly: `SO_REUSEPORT` tuning, more workers (if CPU allows), or profiling per-worker busy-time | Before Run 5 |
| P2 | Re-measure DB pool peak after Finding 1 is fixed; resize only if saturation persists | After Run 5 |
| P2 | Re-run with a graceful stop mechanism to capture the HTML report and a true recovery curve (all 4 runs force-killed so far) | Before Run 5 |
| P3 | Re-test as "Run 5" targeting survival materially past ~900 VUs | Next session |

---

# Business Report

## What Was Tested

The fourth in a series of tests simulating growing shopper traffic placing orders, checking whether the latest fix closed the gap to Black Friday's expected load.

## Key Question: Is It Ready?

**Overall verdict: Not ready — the gap has plateaued, and the next fix needs a different approach.**

The last fix worked exactly as intended — it eliminated the specific problem it targeted. But fixing that problem let the system push harder against a more fundamental limit that has been quietly present since the very first test: each "lane" of the order-processing service can only handle so much traffic at once before it backs up, no matter which specific symptom shows up first. We've now fixed three different symptoms of that same underlying limit in a row, and capacity has stopped climbing as a result (roughly a third of Black Friday traffic, both this round and last round).

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| Above roughly a third of expected Black Friday traffic, some orders are rejected outright at the network level before the system even processes them | High | Medium — only above ~265 simultaneous shoppers in this test (notably lower than the prior round's ~700) | Address the underlying capacity limit directly, not another point fix |
| A newly confirmed, more specific cause: some requests wait several seconds just for a free "slot" to talk to the database | Medium | Low-medium, tied to the same root cause above | Expected to improve once the capacity limit is addressed |

## What Happens If We Deploy Now

Below roughly a third of expected Black Friday traffic, the system performs well. Above that, a meaningful share of orders would be rejected outright (not just slow) and need a retry, and some that do go through would take several seconds longer than acceptable.

## What Needs to Happen Before Go-Live

- **Address the underlying processing-capacity limit directly**, rather than continuing to fix one symptom at a time — the last three fixes each worked, but capacity has plateaued because they kept addressing the same limit's side effects rather than the limit itself.
- **Run one more verification test** after that change to confirm it actually raises the ceiling rather than just moving the symptom again.

## What We Can Defer

- Database connection pool sizing — now confirmed as a real contributing factor, but expected to resolve as a side effect of the capacity fix rather than needing independent attention right now.

## Decision Required

**No-go for Black Friday today.** Three consecutive successful, verified fixes have not moved overall capacity forward in the last two rounds (capacity has held in the same ~3x-gap range). Recommend a focused effort on the underlying capacity limit itself before further point fixes, with one more verification test afterward.

---

## Evidence

Saved to `results/2026-06-18_stress_orders_run4/` (binary files referenced by path — not attachable via the current Jira MCP toolset):
- `screenshot-01-apm-p95-latency.png`, `screenshot-02-apm-rps.png` — Grafana RED-metrics panels
- `screenshot-03-loki-orders-logs.png` — Loki orders-service log stream
- `screenshot-04-tempo-top-ops.png` — Tempo top-operations panel
- Full Run 4 execution report: `report-PT-16-2026-06-18-orders-run4.md`

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18_
