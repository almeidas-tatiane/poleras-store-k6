# Load Test Analysis — users-api (auth) — Run 2
**Ticket:** PT-15 | **Date:** 2026-06-10 | **Type:** Load Test (Re-run after fix)

## Configuration
| Parameter | Value |
|---|---|
| VUs | 100 |
| Duration | 10m (2m ramp-up → 6m steady → 2m ramp-down) |
| Script | `tests/auth/auth.test.js` |
| Endpoint | `POST /api/auth/login` |
| Stage flags | `--stage 2m:100 --stage 6m:100 --stage 2m:0` |
| Test window | 2026-06-10 22:43–22:53 UTC |
| Exit code | **0** (all thresholds passed) |
| HTML report | `results/2026-06-10_load_auth/auth-report.html` |

## Results Summary

| Metric | Value | SLA (PT-7) | Status |
|---|---|---|---|
| P95 latency | **87.78ms** | < 200ms | ✅ PASS |
| P90 latency | 76.15ms | — | — |
| Avg latency | 61.22ms | — | — |
| Max latency | 304.64ms | — | — |
| Error rate (http_req_failed) | **0.00%** | < 0.5% | ✅ PASS |
| Total requests | 23,372 | — | — |
| Throughput | 38.88 req/s | — | — |
| Iterations | 23,371 | — | — |

## Threshold Results
| Threshold | Value | Limit | Result |
|---|---|---|---|
| `http_req_duration{service:auth}` p(95) | 87.78ms | < 200ms | ✅ PASS |
| `http_req_failed{service:auth}` rate | 0.00% | < 0.5% | ✅ PASS |
| `http_req_failed` global (abortOnFail) | 0.00% | < 20% | ✅ PASS |

## Checks
| Check | Passed | Failed | Rate |
|---|---|---|---|
| users-api: health ok | 1 | 0 | 100% |
| login: status 200 | 23,371 | 0 | 100% |
| login: has token | 23,371 | 0 | 100% |
| **TOTAL** | **46,743** | **0** | **100%** |

## Fix Applied Before Re-run
- Registered users user101–user400 (300 users) via `POST /api/auth/register`
- Root cause: `users[__VU % users.length]` with 100 VUs accessed index 100 (user101@test.com), which was absent from the DB
- All 400 users in `data/users.json` are now seeded in the database

## PT-15 Success Criteria
| Criterion | Result |
|---|---|
| Sustain 100 VUs for 6 min steady state | ✅ Yes (100 VUs from 2m to 8m) |
| P95 < 200ms under load | ✅ 87.78ms (56.1% margin) |
| Error rate < 0.5% | ✅ 0.00% (all 23,371 logins succeeded) |
| No 5xx server errors | ✅ Confirmed (Prometheus + Loki) |
| HTML report generated | ✅ `results/2026-06-10_load_auth/auth-report.html` |

## Grafana Evidence (test window: 2026-06-10 22:43–22:53 UTC)
| Dashboard | Link |
|---|---|
| APM (RED Method) | http://localhost:3000/d/ecommerce-apm-v1?from=1781131260000&to=1781132040000 |
| SLO | http://localhost:3000/d/ecommerce-slo-v1?from=1781131260000&to=1781132040000 |
| Logs (Loki) | http://localhost:3000/d/ecommerce-logs-v1?from=1781131260000&to=1781132040000 |
| Traces (Tempo) | http://localhost:3000/d/ecommerce-traces-v1?from=1781131260000&to=1781132040000 |
