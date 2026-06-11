# Performance Report Analysis — products-service (Load Test)
**Ticket:** PT-20 | **Date:** 2026-06-10 | **Script:** products.test.js | **Ref:** PT-15

---

## Performance Test Technical Report — products-service (Load Test)

**Date:** 2026-06-10
**Test type:** Load Test
**Tool:** k6 v1.0.0-rc1
**Script:** `tests/products/products.test.js` (PT-9)
**Environment:** Local Docker — all 5 microservices running locally
**Load profile:** 100 VUs × 10 min · 2m ramp-up → 6m steady → 2m ramp-down
**Test window:** 2026-06-10 23:34:27 – 23:44:31 UTC
**Exit code:** 0

---

### Executive Summary

The products-service load test ran to completion with 100 VUs for 10 minutes and met all SLA thresholds defined in PT-7. Global P95 latency was 9.73ms against a 100ms SLA (90.3% headroom) with a 0.00% error rate. The only notable observation is a warm-up spike on `/api/products` during ramp-up that resolved within 60 seconds and poses no risk at current load levels.

---

### SLA Compliance (PT-7)

| Metric | Target | Actual | Result |
|---|---|---|---|
| P95 response time `{service:products}` | < 100ms | **9.73ms** | ✅ PASS |
| P90 response time | — | 8.13ms | — |
| Error rate `{service:products}` | < 0.5% | **0.00%** | ✅ PASS |
| Global error rate (abortOnFail) | < 20% | **0.00%** | ✅ PASS |
| Throughput | ≥ sustained load | 43.61 req/s | ✅ PASS |
| Total checks | 100% pass | **52,627/52,627** | ✅ PASS |

---

### Per-Endpoint Breakdown (Prometheus — steady state)

| Endpoint | P95 Steady State | P95 SLA | Status |
|---|---|---|---|
| GET /api/categories | ~4.81ms | < 100ms | ✅ PASS |
| GET /api/products | ~5.0ms (warm-up: 13.75ms) | < 100ms | ✅ PASS |
| GET /api/products/:slug | ~4.87ms | < 100ms | ✅ PASS |

---

### Findings

#### [INFORMATIONAL] Finding 1 — /api/products Warm-Up Latency Spike
**Observed:** Prometheus P95 for `/api/products` measured **13.75ms** at t+1min (first scrape during ramp-up), compared to a stable **~5.0ms** throughout the remaining 8 minutes. All other endpoints were flat from first measurement.

**Root cause hypothesis:** Cold PostgreSQL query plan compilation and result-set materialization on first burst. The `/api/products` endpoint fetches the full product catalog, making the first DB round-trip measurably slower. Standard cold-start pattern.

**Evidence:** Prometheus timestamp 1781134500: `/api/products` P95 = 13.75ms → 1781134560: 5.66ms → stable ~5ms from t+3min.

**Recommended action:** Add a startup cache-warm request in the readiness probe (`GET /api/products` once before pod is marked Ready).

**Owner:** products-service engineering team
**Retest required:** No

---

#### [INFORMATIONAL] Finding 2 — No DB Connection Pool Observability
**Observed:** `pg_stat_database_numbackends` not available in Prometheus for products-service. `nodejs_active_handles_total` peaked at 108 (100 VUs + ~8 internal handles) — clean scaling pattern.

**Recommended action:** Add `pg.Pool` metrics to `/metrics` endpoint via `prom-client`. Required before stress/soak tests.

**Owner:** products-service engineering team
**Retest required:** No

---

#### [INFORMATIONAL] Finding 3 — No Baseline for Regression Detection
**Observed:** First load test of products-service. No prior baseline.

**Recommended action:** Store P95=9.73ms, error_rate=0.00%, throughput=43.61 req/s as regression baseline. Flag future regressions > 20%.

**Owner:** Performance testing team
**Retest required:** No

---

### Infrastructure Observations

| Metric | Observed | Status |
|---|---|---|
| `nodejs_active_handles_total` peak | 108 (mirrors VU count) | ✅ Normal |
| TPS peak (Prometheus) | 55.2 req/s | ✅ Linear scaling |
| 5xx errors (Prometheus) | 0 | ✅ |
| Loki errors/warnings (all 5 services) | 0 (26,816 lines scanned) | ✅ |
| DB connection pool | Not observable | ⚠️ No pg_exporter |

---

### Grafana Evidence (test window: 2026-06-10 23:34–23:44 UTC)

| Dashboard | Link |
|---|---|
| APM (RED Method) | http://localhost:3000/d/ecommerce-apm-v1?from=1781134467000&to=1781135071000 |
| SLO | http://localhost:3000/d/ecommerce-slo-v1?from=1781134467000&to=1781135071000 |
| Logs (Loki) | http://localhost:3000/d/ecommerce-logs-v1?from=1781134467000&to=1781135071000 |
| Traces (Tempo) | http://localhost:3000/d/ecommerce-traces-v1?from=1781134467000&to=1781135071000 |

---

### Recommendations Summary

| Priority | Action | Owner |
|---|---|---|
| P1 | Add DB connection pool metrics to `/metrics` | Engineering |
| P2 | Add readiness probe warmup call to `/api/products` | Engineering |
| P3 | Store this run as regression baseline | QA / Perf team |

---

### Test Conditions

- Environment: Local Docker. Not production-equivalent for absolute latency but valid for relative SLA comparison.
- Dataset: 12 product slugs, 100 VUs — all slugs valid (0 404s).
- Limitation: DB connection pool health not observable — pool exhaustion risk cannot be assessed for stress-level loads.

---

## Performance Test — Business Summary — products-service (Load Test)

**Date:** 2026-06-10
**System:** Poleras Store — Product Catalog Service
**Test conducted by:** Performance Testing Team (PT-15 / PT-20)

---

### What Was Tested

We simulated 100 simultaneous shoppers browsing the product catalog of Poleras Store, representing the expected steady-state traffic during normal business hours ahead of Black Friday. Each simulated shopper browsed categories, viewed the full product list, and opened a product detail page. The simulation ran for 10 minutes at full load.

---

### Key Question: Is It Ready?

**Overall verdict: ✅ Ready to deploy**

The product catalog service handled 100 concurrent shoppers without a single failure and responded well within the acceptable speed targets throughout the entire test. No issues were found that would pose a risk to customers or revenue during a normal shopping session.

---

### Risk Summary

| Risk | Impact | Likelihood | Recommended action |
|---|---|---|---|
| Service slows down on restart/redeploy | Low | Medium | One-time engineering fix before Black Friday |
| Performance degradation not detectable in monitoring | Medium | Low | Add database health monitoring (engineering task) |
| No historical data to detect future slowdowns | Medium | Low | Use this test as the reference point going forward |

---

### What Happens If We Deploy Now

The product catalog is safe to deploy. Every single one of the 26,314 simulated page views succeeded. Customers browsing products on Black Friday would experience fast, reliable responses at this traffic level.

---

### What Needs to Happen Before Go-Live

- **Add database health monitoring** — We currently cannot see how hard the database is working during peak traffic. Engineering can add this in a few hours.

---

### What We Can Defer

- **Startup performance optimization** — The product list page loads slightly slower for the very first visitor after a service restart (a few milliseconds, still well within targets). Minor polish item.

---

### Decision Required

No go/no-go decision required for the product catalog at this time. The service is certified for normal load. The next decision point will be after the **stress test** (PT-16), which will determine the maximum traffic level before performance degrades — critical data for Black Friday capacity planning.
