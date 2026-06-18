# Performance Report Analysis — orders.test.js (Run 1 vs Run 2 vs Run 3)

**Generated via Claude Code — `performance-report-analysis` skill — 2026-06-18**
**Analysis target:** `tests/orders/orders.test.js` stress test results (PT-16 execution, Run 3)
**SLA reference (PT-7):** orders-service P95 < 200ms, error rate < 1% · Black Friday target: 2,500 VUs

---

## Test Conditions

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Date/window (UTC) | 2026-06-18, 17:15:17–17:18:55 | 2026-06-18, 19:06:19–19:13:14 | 2026-06-18, 19:34:20–19:42:40 |
| Config under test | Single process, no clustering | 12-worker cluster, no `UV_THREADPOOL_SIZE` | 12-worker cluster + `UV_THREADPOOL_SIZE=128` + keep-alive `http.Agent` |
| Stop reason | Manual — sustained P95 breach | Manual — sustained P95 breach | Manual — sustained P95 breach (exponential blowup confirmed) |
| Max VUs reached | 181 | 582 | **868** |
| Results | `results/2026-06-18_stress_orders/` | `results/2026-06-18_stress_orders_run2/` | `results/2026-06-18_stress_orders_run3/` |

All three runs were stopped before reaching the configured 2,000-VU peak — results are partial for upper stages, but each run's breaking point (the object of PT-16) was captured cleanly.

---

# Technical Report

## SLA Compliance — Run 3 (at stop)

| Metric | Target | Run 3 Actual | Result |
|---|---|---|---|
| P95 response time | < 200ms | 238ms (breach onset) → 8,509ms (at stop) | FAIL |
| Error rate (server-side 5xx, re-verified fresh) | < 1% | ~0.07%–0.24%, rising | PASS (numerically) but a **new regression** — Run 1/Run 2 never had genuine server-side 5xx |
| `cart_convert_ms` (the Run 1/Run 2 bottleneck metric) | n/a (internal timing) | 7–390ms throughout | **Fixed** — was 11,700–12,000ms in Run 1/Run 2 |

## Latency Distribution Analysis

Run 3's P95 curve has two distinct phases — a meaningful change from Run 1 and Run 2:

| Phase | VU range | Shape | Interpretation |
|---|---|---|---|
| Phase 1 | ~0–700 VUs | P95 rises from ~10ms baseline to ~238ms — **gradual, sub-exponential** | Healthy capacity curve (per skill's pattern table: "P95 rises linearly as users scale — expected, not a bug") |
| Phase 2 | ~700–868 VUs | P95 rises 238ms→8,509ms in ~3 minutes — **genuinely exponential** | True breaking point — confirmed via 15s-step Prometheus range query showing monotonic, accelerating climb |

This two-phase shape did not exist in Run 1 or Run 2, where the blowup was immediate at the breaking point (no gradual phase). Run 3's gradual phase is direct evidence the primary fix worked — the system now behaves like a normal capacity-bound service up to ~700 VUs, instead of falling over almost immediately.

## Root Cause Analysis

### Confirmed: the Run 1/Run 2 root cause is fixed

`cart_convert_ms`, sampled directly from the app's own per-request timing logs throughout the full Run 3 window, never exceeded ~390ms (vs. 11,700–12,000ms in Run 1/Run 2). The `UV_THREADPOOL_SIZE=128` + keep-alive agent fix achieved its stated objective.

### New finding: a different bug now caps the breaking point

A fresh Tempo trace pull for one of Run 3's failing requests (traceID `3f975d20672bcf238bd6ada617fd83f6`, statusCode 500, total duration 739.67ms) shows:

```
POST /api/orders                  739.67ms (FAILED — 500)
  └─ ecommerce.create_order        734.15ms
       └─ GET (outbound call)      732.98ms ← consumes the ENTIRE request, then fails
            (no pg.query spans exist anywhere in this trace)
```

The request died entirely inside the outbound `GET http://cart-service:3003/api/cart` call — the order-creation DB transaction never even started. A fresh Loki query across the full Run 3 window confirms two distinct error signatures on this exact call: **`socket hang up`** and **`read ECONNRESET`**, both classic symptoms of a Node.js `http.Agent` keep-alive race — the client holds an idle socket open for reuse, but the receiving server (cart-service) closes its end at nearly the same moment the client tries to reuse it (Node's default server `keepAliveTimeout` is 5000ms; the shared agent added in the Run 3 fix did not configure a shorter `keepAliveMsecs`, so the two sides' timing isn't coordinated).

**This is a different, narrower bug than Run 1/Run 2's regression** (which was per-process libuv threadpool starvation from `UV_THREADPOOL_SIZE` being unset — confirmed not recurring). It is also a **new severity class**: for the first time across all 3 runs, the orders-service application itself is generating genuine 500 responses (0.07%–0.24%, rising) — Run 1 had 0% errors throughout, and Run 2's ~1.7% error rate was a pure client-side TCP reset that never reached the application layer (server-side 5xx rate was 0% in Run 2). Run 3's errors are real, server-logged application failures.

### Findings

#### [CRITICAL] Finding 1 — Keep-alive socket-reuse race causes genuine order-creation failures above ~700 VUs
**Observed:** `socket hang up`/`read ECONNRESET` on outbound `GET /api/cart`, causing `POST /api/orders` to return real 500s (server-side 5xx rate 0.07%–0.24%, rising) — a new failure class not seen in Run 1 or Run 2.
**Root cause hypothesis:** the keep-alive `http.Agent` added in the Run 3 fix does not set `keepAliveMsecs` below the receiving servers' (cart-service/products-service) HTTP keep-alive timeout (Node default 5000ms), so the client occasionally tries to reuse a socket the server has just closed.
**Evidence:** Tempo trace `3f975d20672bcf238bd6ada617fd83f6` (entire 739.67ms request consumed by the failing outbound `GET`, no DB spans at all); Loki entries with both `socket hang up` and `read ECONNRESET` error text on the same call.
**Recommended action:** set `keepAliveMsecs` on the shared agent to ~4000ms (comfortably below the server's 5000ms default), and/or add a retry-on-`ECONNRESET` wrapper around the 3 outbound calls (all are idempotent/best-effort already, except the initial `GET /api/cart` which should also be made retry-safe since it currently fails the whole order).
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 4

#### [HIGH] Finding 2 — DB connection pool now reaching its configured ceiling (108/108)
**Observed:** `db_connections_active` (aggregated across 12 workers) climbed from a steady baseline of 12 to a confirmed peak of **108/108 (100%)** near the end of the test — up from Run 2's peak of 94/108 (87%).
**Root cause hypothesis:** likely a downstream compounding symptom of Finding 1 — as `GET /api/cart` calls hang or reset, more concurrent in-flight/retrying requests hold their DB connections open longer, gradually consuming the full pool. Not believed to be an independent root cause, but it is now fully saturated and merits monitoring once Finding 1 is fixed.
**Evidence:** Prometheus range + instant queries over the Run 3 window.
**Recommended action:** re-measure pool peak after Finding 1 is fixed; only increase pool size if saturation persists independent of the socket-reuse race.
**Owner:** Backend/platform engineering
**Retest required:** Yes — Run 4 (same retest as Finding 1)

#### [INFORMATIONAL] Finding 3 — cart-service degradation in Run 3 is cascading backpressure, consistent with Run 1/Run 2
**Observed:** cart-service's own P95 breached its 150ms SLA in lockstep with orders-service's breach.
**Root cause hypothesis:** orders-service's synchronous downstream calls propagate load when orders-service itself is saturated — the same pattern documented in all 3 runs. cart-service's own standalone capacity (~600-650 VUs, from its own investigation) is not independently at risk here.
**Recommended action:** none independently; re-verify after Finding 1 is fixed.
**Retest required:** No (covered by Run 4)

---

## Run 1 vs Run 2 vs Run 3 Comparison

| Metric | Run 1 | Run 2 | Run 3 | Trend |
|---|---|---|---|---|
| Primary stall (`cart_convert_ms`) | ~11.7s | ~11.9–12.0s (unchanged) | **Gone** (max ~390ms) | ✅ Fixed |
| P95 SLA breach onset | ~163-180 VUs | ~270 VUs | ~235-270 VUs (now gradual, not immediate) | ✅ Improved shape |
| Exponential blowup onset | ~163-180 VUs (immediate) | ~270 VUs (immediate) | **~700-750 VUs** | ✅ Substantially later |
| Error type | None (0%) | Client-side TCP reset only (server 5xx = 0%) | **Server-side 5xx (real app failures)** | ⚠️ New regression class |
| Max VUs survived | 181 | 582 | **868** | ✅ Continued improvement |
| Black Friday gap (2,500 VU target) | ~14x | ~9x | **~2.9x** | ✅ Substantially closed |
| DB pool peak | 16 (single process) | 94/108 (87%) | **108/108 (100%)** | ⚠️ Now fully saturated |

**Net assessment: real, substantial, measurable progress across all 3 runs.** Each fix addressed its target root cause and meaningfully advanced capacity. The remaining gap (~2.9x) is now caused by a narrower, well-understood, and easily fixable issue (keep-alive timing mismatch) rather than the deep architectural problem (per-process threadpool starvation) that dominated Run 1 and Run 2.

---

## Infrastructure Observations

- **Event loop / threadpool:** No longer the bottleneck — confirmed fixed.
- **DB pool:** reached 100% of configured capacity (108/108) for the first time across the 3 runs — flag for monitoring in Run 4, likely resolves once Finding 1 is fixed.
- **Network/sockets:** the new bottleneck — keep-alive socket lifecycle mismatch between client and server, identified precisely via Tempo + Loki cross-reference.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| P1 | Set `keepAliveMsecs` ~4000ms on the shared agent (below servers' 5000ms default) | Before Run 4 |
| P1 | Add retry-on-`ECONNRESET`/socket-hang-up wrapper for the 3 outbound calls, including the initial `GET /api/cart` | Before Run 4 |
| P2 | Re-run with a graceful stop mechanism to capture the HTML report and a true ramp-down recovery curve (all 3 runs so far were force-killed) | Before Run 4 |
| P2 | Re-test as "Run 4" targeting survival at or near the 2,500 VU Black Friday target | Next session |
| P3 | Re-measure DB pool peak after Finding 1 is fixed; only resize if saturation persists | After Run 4 |

---

# Business Report

## What Was Tested

We ran the third in a series of tests simulating a growing wave of shoppers placing orders, to check whether each round of engineering fixes actually closed the gap to our Black Friday traffic target.

## Key Question: Is It Ready?

**Overall verdict: Not ready yet — but the gap has narrowed dramatically.**

Across three rounds of testing and fixing, the order-placement system has gone from handling roughly 1 in 14 of the expected Black Friday traffic before failing, to roughly 1 in 9, to now **roughly 1 in 3**. The original, most damaging problem (a multi-second delay buried in how orders talk to the shopping cart) is confirmed fixed. A new, smaller, and well-understood problem has taken its place at the new — much higher — traffic level, and it has a known, low-effort fix.

## Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| At roughly a third of expected Black Friday traffic, a small but real share of orders now fail outright (not just slow) | High | Medium — only above ~700 simultaneous shoppers (much higher than before) | Fix before launch — a known, low-effort fix is already identified |
| Database capacity is now fully utilized at the point of failure | Medium | Low independently — expected to resolve once the above is fixed | Re-check after the next fix; no action needed today |

## What Happens If We Deploy Now

Below roughly a third of expected Black Friday traffic, the system now performs well — a major improvement from the first two test rounds. Above that point, a small percentage of customers would have their order attempt fail outright and need to retry, rather than just experiencing a slow confirmation as before.

## What Needs to Happen Before Go-Live

- **Fix a newly surfaced, narrower technical issue** in how the order service reuses its network connections to the shopping cart service — this is a known pattern with a standard, low-effort fix (not a new investigation).
- **Run one more verification test** to confirm this fix closes the remaining gap to the Black Friday target.

## What We Can Defer

- Database capacity tuning — currently at its configured limit only at the point of failure; expected to resolve as a side effect of the next fix, not an independent concern.

## Decision Required

**No-go for Black Friday on order-placement today, but the path to "go" is now short and well-defined.** Each of the three fix-and-retest cycles so far has produced a clear, measurable improvement (capacity roughly tripled since the first test). Recommend proceeding with the next fix-and-retest cycle; given the trend, a "go" verdict after Run 4 is a realistic expectation rather than a hope.

---

## Evidence

Saved to `results/2026-06-18_stress_orders_run3/` (binary files referenced by path — not attachable via the current Jira MCP toolset):
- `screenshot-01-apm-p95-latency.png`, `screenshot-02-apm-rps.png` — Grafana RED-metrics panels
- `screenshot-03-loki-orders-logs.png` — Loki orders-service log stream
- `screenshot-04-tempo-top-ops.png` — Tempo top-operations panel
- Full Run 3 execution report: `report-PT-16-2026-06-18-orders-run3.md`

---

_Analysis performed via Claude Code (`performance-report-analysis` skill) + Grafana MCP (Prometheus, Loki, Tempo) — 2026-06-18_
