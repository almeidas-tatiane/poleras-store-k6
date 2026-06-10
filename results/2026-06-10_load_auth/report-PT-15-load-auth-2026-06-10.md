# Load Test Analysis — users-api (auth)
**Ticket:** PT-15 | **Date:** 2026-06-10 | **Type:** Load Test

## Configuration
| Parameter | Value |
|---|---|
| VUs | 100 |
| Duration | 10m (2m ramp-up → 6m steady → 2m ramp-down) |
| Script | `tests/auth/auth.test.js` |
| Endpoint | `POST /api/auth/login` |
| Stage flags | `--stage 2m:100 --stage 6m:100 --stage 2m:0` |
| Exit code | **99** (threshold breach) |
| HTML report | `results/2026-06-10_load_auth/auth-report.html` |

## Results Summary

| Metric | Value | SLA (PT-7) | Status |
|---|---|---|---|
| P95 latency | **79.13ms** | < 200ms | ✅ PASS |
| P90 latency | 70.05ms | — | — |
| Avg latency | 58.07ms | — | — |
| Max latency | 287.49ms | — | — |
| Error rate (http_req_failed) | **0.76%** | < 0.5% | ❌ BREACH |
| Total requests | 23,438 | — | — |
| Throughput | 38.93 req/s | — | — |
| Iterations | 23,437 | — | — |

## Threshold Results
| Threshold | Value | Limit | Result |
|---|---|---|---|
| `http_req_duration{service:auth}` p(95) | 79.13ms | < 200ms | ✅ PASS |
| `http_req_failed{service:auth}` rate | 0.76% | < 0.5% | ❌ FAIL |
| `http_req_failed` global (abortOnFail) | 0.76% | < 20% | ✅ PASS |

## Checks
| Check | Passed | Failed | Rate |
|---|---|---|---|
| users-api: health ok | 1 | 0 | 100% |
| login: status 200 | 23,257 | 180 | 99.23% |
| login: has token | 23,257 | 180 | 99.23% |
| **TOTAL** | **46,515** | **360** | **99.23%** |

## Failure Analysis
- **180 HTTP 401 (Unauthorized) responses** on `POST /api/auth/login`
- All failures are HTTP 4xx (client errors) — NOT server errors (5xx)
- No 5xx responses recorded (Prometheus global error rate = 0%)
- The 0.76% rate consistently exceeded the 0.5% PT-7 threshold throughout steady state

## Root Cause
The auth script selects users with `users[__VU % users.length]`. During the load test at 100 VUs, a subset of user credentials in `data/users.json` returned HTTP 401, indicating those users either:
1. Do not exist in the database, or
2. Have a different password in the dataset vs. what is seeded in the DB

At 2 VUs (smoke test), all checks passed 100% — suggesting only specific user indices in the dataset have invalid credentials.

## Loki Evidence
- All "error"-matching log entries were `level: warn` with `message: "HTTP request client error"` and `statusCode: 401`
- No `level: error` with `statusCode: 5xx` recorded
- Confirms authentication failures, not service failures

## Grafana Evidence (test window: 2026-06-10 21:57–22:09 UTC)
| Dashboard | Link |
|---|---|
| APM (RED Method) | http://localhost:3000/d/ecommerce-apm-v1?from=1781128620000&to=1781129340000 |
| SLO | http://localhost:3000/d/ecommerce-slo-v1?from=1781128620000&to=1781129340000 |
| Logs (Loki) | http://localhost:3000/d/ecommerce-logs-v1?from=1781128620000&to=1781129340000 |
| Traces (Tempo) | http://localhost:3000/d/ecommerce-traces-v1?from=1781128620000&to=1781129340000 |

## PT-15 Success Criteria — Auth
| Criterion | Result |
|---|---|
| Sustain 100 VUs for 6 min steady state | ✅ Yes (100 VUs from 2m to 8m) |
| P95 < 200ms under load | ✅ 79.13ms (60.4% margin) |
| Error rate < 0.5% | ❌ 0.76% (threshold breach) |
| No 5xx server errors | ✅ Confirmed (Prometheus + Loki) |
| HTML report generated | ✅ `results/2026-06-10_load_auth/auth-report.html` |

## Recommendation
**Fix before re-run:** Validate that all users in `data/users.json` exist in the database with the correct passwords. Steps:
1. Check how many users are in the dataset: `cat data/users.json | jq '.users | length'`
2. Verify the DB seed includes all users referenced by VUs 0–99
3. If missing users: re-seed the DB or update `data/users.json` to only include valid credentials
4. Re-run auth load test to confirm error rate drops below 0.5%

The latency profile is excellent — P95 at 79ms is well within the 200ms SLA with a 60% margin. Once the credential issue is fixed, this test should pass all thresholds.
