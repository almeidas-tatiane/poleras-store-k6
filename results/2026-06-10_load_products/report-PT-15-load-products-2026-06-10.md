# Load Test Analysis — products-service — PT-15
**Ticket:** PT-15 | **Date:** 2026-06-10 | **Type:** Load Test

## Configuration
| Parameter | Value |
|---|---|
| VUs | 100 |
| Duration | 10m (2m ramp-up → 6m steady → 2m ramp-down) |
| Script | `tests/products/products.test.js` |
| Endpoints | GET /api/categories · GET /api/products · GET /api/products/:slug |
| Stage flags | `--stage 2m:100 --stage 6m:100 --stage 2m:0` |
| Test window | 2026-06-10 23:34–23:44 UTC |
| Exit code | **0** (all thresholds passed) |
| HTML report | `results/2026-06-10_load_products/products-report.html` |

## Results Summary

| Metric | Value | SLA (PT-7) | Status |
|---|---|---|---|
| P95 latency | **9.73ms** | < 100ms | ✅ PASS |
| P90 latency | 8.13ms | — | — |
| Avg latency | 6.24ms | — | — |
| Max latency | 63.25ms | — | — |
| Error rate (http_req_failed) | **0.00%** | < 0.5% | ✅ PASS |
| Total requests | 26,314 | — | — |
| Throughput | 43.61 req/s | — | — |
| Iterations | 8,771 | — | — |

## Threshold Results
| Threshold | Value | Limit | Result |
|---|---|---|---|
| `http_req_duration{service:products}` p(95) | 9.73ms | < 100ms | ✅ PASS |
| `http_req_failed{service:products}` rate | 0.00% | < 0.5% | ✅ PASS |
| `http_req_failed` global (abortOnFail) | 0.00% | < 20% | ✅ PASS |

## Checks
| Check | Passed | Failed | Rate |
|---|---|---|---|
| products-service: health ok | 1 | 0 | 100% |
| categories: status 200 | 8,771 | 0 | 100% |
| categories: has data | 8,771 | 0 | 100% |
| products: status 200 | 8,771 | 0 | 100% |
| products: has data | 8,771 | 0 | 100% |
| detail: status 200 | 8,771 | 0 | 100% |
| detail: has slug | 8,771 | 0 | 100% |
| **TOTAL** | **52,627** | **0** | **100%** |

## PT-15 Success Criteria
| Criterion | Result |
|---|---|
| Sustain 100 VUs for 6 min steady state | ✅ Yes (100 VUs from 2m to 8m) |
| P95 < 100ms under load | ✅ 9.73ms (90.3% margin) |
| Error rate < 0.5% | ✅ 0.00% (all 26,314 requests succeeded) |
| No 5xx server errors | ✅ Confirmed (Prometheus + Loki) |
| HTML report generated | ✅ `results/2026-06-10_load_products/products-report.html` |

## Grafana Evidence (test window: 2026-06-10 23:34–23:44 UTC)
| Dashboard | Link |
|---|---|
| APM (RED Method) | http://localhost:3000/d/ecommerce-apm-v1?from=1781134467000&to=1781135071000 |
| SLO | http://localhost:3000/d/ecommerce-slo-v1?from=1781134467000&to=1781135071000 |
| Logs (Loki) | http://localhost:3000/d/ecommerce-logs-v1?from=1781134467000&to=1781135071000 |
| Traces (Tempo) | http://localhost:3000/d/ecommerce-traces-v1?from=1781134467000&to=1781135071000 |
