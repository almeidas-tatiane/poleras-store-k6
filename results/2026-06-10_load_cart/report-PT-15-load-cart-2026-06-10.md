# Load Test Analysis — cart-service — PT-15
**Ticket:** PT-15 | **Date:** 2026-06-10 | **Type:** Load Test

## Configuration
| Parameter | Value |
|---|---|
| VUs | 100 |
| Duration | 10m (2m ramp-up → 6m steady → 2m ramp-down) |
| Script | `tests/cart/cart.test.js` |
| Endpoints | POST /api/auth/login · GET /api/cart · POST /api/cart/items · DELETE /api/cart/items/:id |
| Stage flags | `--stage 2m:100 --stage 6m:100 --stage 2m:0` |
| Test window | 2026-06-11 00:05:14 – 00:15:18 UTC |
| Exit code | **0** (all thresholds passed) |
| HTML report | ⚠️ Not saved — script used UTC date (`results/2026-06-11_load_cart/`), directory not found |

## Results Summary

| Metric | Value | SLA (PT-7) | Status |
|---|---|---|---|
| P95 latency `{service:cart}` | **43.92ms** | < 150ms | ✅ PASS |
| P90 latency `{service:cart}` | 32.65ms | — | — |
| Avg latency `{service:cart}` | 18.66ms | — | — |
| Max latency | 300.97ms | — | — |
| Error rate `{service:cart}` | **0.00%** | < 0.5% | ✅ PASS |
| Total requests | 58,327 | — | — |
| Cart-service requests | 46,660 | — | — |
| Throughput | 96.67 req/s | — | — |
| Iterations | 11,666 | — | — |

## Threshold Results
| Threshold | Value | Limit | Result |
|---|---|---|---|
| `http_req_duration{service:cart}` p(95) | 43.92ms | < 150ms | ✅ PASS |
| `http_req_failed{service:cart}` rate | 0.00% | < 0.5% | ✅ PASS |
| `http_req_failed` global (abortOnFail) | ~0.00% | < 20% | ✅ PASS |

## Checks
| Check | Passed | Failed | Rate |
|---|---|---|---|
| cart-service: health ok | 1 | 0 | 100% |
| auth: login ok | 11,665 | 1 | 99.99% |
| add item: status 201 | 11,666 | 0 | 100% |
| add item: has items | 11,666 | 0 | 100% |
| get cart: status 200 | 11,666 | 0 | 100% |
| get cart: has items | 11,666 | 0 | 100% |
| get cart: has total | 11,666 | 0 | 100% |
| delete item: status 200 | 11,666 | 0 | 100% |
| **TOTAL** | **81,656** | **1** | **99.99%** |

### Note on the 1 failed check
The single "auth: login ok" failure corresponds to a slow database query on the `users` table (5,325ms) observed in Loki at 00:12:20 UTC. This was an isolated outlier — all 46,660 cart-service requests succeeded (0.00% error rate on `{service:cart}`).

## Prometheus Monitoring (Steady State Cycles)
| Cycle | Time | GET /api/cart P95 | POST /api/cart/items P95 | DELETE /api/cart/items P95 | 5xx |
|---|---|---|---|---|---|
| Cycle 1 | t≈1:00 | ~30ms | ~65ms | ~40ms | 0 |
| Cycle 2 | t≈2:00 | ~27ms | ~60ms | ~35ms | 0 |
| Cycle 3 | t≈3:49 | 30.7ms | 67.3ms | 41.7ms | 0 |
| Cycle 4 | t≈6:51 | 22.6ms | 47.2ms | 28.4ms | 0 |
| Cycle 5 (ramp-down) | t≈9:09 | 23.3ms | 48.2ms | 30.7ms | 0 |

## Loki Findings
| Time (UTC) | Service | Level | Message |
|---|---|---|---|
| 00:10:04 | users-api | WARN | Slow database query — `users` table, 107ms |
| 00:12:20 | users-api | WARN | Slow database query — `users` table, 5,325ms |

0 errors in 47,881 log lines scanned across all 5 services.

## PT-15 Success Criteria
| Criterion | Result |
|---|---|
| Sustain 100 VUs for 6 min steady state | ✅ Yes (100 VUs from t=2:01 to t=8:02) |
| P95 < 150ms under load | ✅ 43.92ms (70.7% margin) |
| Error rate < 0.5% for cart-service | ✅ 0.00% (all 46,660 cart requests succeeded) |
| No 5xx server errors | ✅ Confirmed (Prometheus + Loki) |
| HTML report generated | ⚠️ Not saved (UTC/local date mismatch in handleSummary) |

## Grafana Evidence (test window: 2026-06-11 00:05–00:15 UTC)
| Dashboard | Link |
|---|---|
| APM (RED Method) | http://localhost:3000/d/ecommerce-apm-v1?from=1781136314000&to=1781136918000 |
| SLO | http://localhost:3000/d/ecommerce-slo-v1?from=1781136314000&to=1781136918000 |
| Logs (Loki) | http://localhost:3000/d/ecommerce-logs-v1?from=1781136314000&to=1781136918000 |
| Traces (Tempo) | http://localhost:3000/d/ecommerce-traces-v1?from=1781136314000&to=1781136918000 |
