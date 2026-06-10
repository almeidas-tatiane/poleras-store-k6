# Performance Test Technical Report
**Date:** 2026-06-10
**Test type:** Load Test
**Tool:** k6 v1.0.0-rc1
**Ticket:** PT-15 (execution) / PT-20 (analysis)
**Environment:** Local — 5 microservices via Docker, Prometheus + Loki + Tempo observability
**Load profile:** 100 VUs · 10 min · 2m ramp-up → 6m steady → 2m ramp-down · 38.93 req/s peak

---

## Executive Summary

The auth load test on users-api completed the full 10-minute run at 100 VUs. The P95 latency of 79ms is well within the 200ms SLA (60% headroom), confirming excellent service responsiveness. However, a single user credential — `user101@test.com` — is absent from the database, causing VU 100 to produce 401 Unauthorized on every iteration and pushing the error rate to 0.76% — above the 0.5% PT-7 threshold. This is a test-data defect, not a service performance issue.

---

## SLA Compliance

| Metric | Target (PT-7) | Actual | Result |
|---|---|---|---|
| P95 response time | < 200ms | **79.13ms** | ✅ PASS |
| P90 response time | — | 70.05ms | — |
| Avg response time | — | 58.07ms | — |
| Error rate (`http_req_failed`) | < 0.5% | **0.76%** | ❌ FAIL |
| Throughput | — | 38.93 req/s | — |
| Total iterations | — | 23,437 | — |
| Check pass rate | — | 99.23% | — |

---

## Findings

### [HIGH] Finding 1 — Missing user in database causes consistent 401s

**Observed:**
- 180 HTTP 401 (Unauthorized) responses out of 23,438 total → 0.76% error rate
- Exceeds PT-7 threshold of 0.5% → k6 exit code 99
- Error rate during steady state (Prometheus): 0.94–1.08% (consistent throughout all 6 minutes at 100 VUs)
- Error rate = 0 during ramp-up (< 100 VUs) and 0 during ramp-down (< 100 VUs)

**Root cause — confirmed by Tempo trace `a4d67da727adc42e0ec3d71b4c9724cb`:**

The auth script selects users via `users[__VU % users.length]`. With `users.length = 400` and 100 VUs (numbered 1–100):
- VU 100 → `users[100 % 400]` = `users[100]` = **user101@test.com**

The Tempo trace shows:
```
Span: pg.query:SELECT usersdb  (0.63ms)
  db.statement: SELECT id, firstname, lastname, email, password_hash, role FROM users WHERE email = $1
  db.postgresql.values: ["user101@test.com"]
  db.pg.rows: 0   ← USER NOT FOUND
```

The database was seeded with users `user001`–`user100` (100 users, dataset indices 0–99). The dataset contains 400 users but only the first 100 are in the database. VU 100 accesses index 100 (`user101@test.com`, the 101st user), which was never seeded.

**Evidence:**
- Tempo: `db.pg.rows = 0` for `user101@test.com` (trace `a4d67da727adc42e0ec3d71b4c9724cb`)
- Loki: 180 `level:warn` entries `statusCode:401` on `POST /api/auth/login`; all with `duration: 1–4ms` (fast DB miss, not a timeout)
- Prometheus error rate: exactly ~1% (= 1/100 VUs) during steady state, drops to 0% during ramp-down
- k6: `login: status 200` check failed exactly 180/23437 times
- No 5xx errors anywhere (Prometheus + Loki confirm 0 server errors)

**Recommended action:**
Register `user101@test.com` (password: `Test1234!`) in the users-api database via the registration endpoint before re-running the test. To future-proof for higher-VU tests (products: 200 VUs, e2e: 30 VUs), seed all 400 users from the dataset.

**Owner:** QA / test data management
**Retest required:** Yes

---

### [LOW] Finding 2 — DB connection pool metric reports 0 throughout test

**Observed:**
- `db_connections_active{job="users-api"}` = 0 for the entire test window
- Expected: active connections while 100 VUs are sending DB queries

**Root cause hypothesis:**
The metric may be tracked differently (e.g., using connection pool library internals not exposed to the gauge). With Tempo confirming `pg-pool.connect` completes in ~32µs, connections are being reused from a healthy pool — the 0 value is likely a labelling or metric export issue, not a real pool depletion.

**Evidence:** Tempo trace shows `pg-pool.connect` duration ~32µs — confirms connections are available, not exhausted.

**Recommended action:** Verify the Prometheus exporter in users-api correctly exposes `db_connections_active`. Non-blocking.

**Owner:** Platform / observability
**Retest required:** No

---

## Regression vs. Baseline

| Metric | Smoke (2026-06-10) | Load (2026-06-10) | Delta | Status |
|---|---|---|---|---|
| P95 | 58.83ms (2 VUs) | 79.13ms (100 VUs) | +34% | Expected (50× VU increase) |
| Error rate | 0% | 0.76% | +0.76pp | ❌ Regression (data defect) |
| Max latency | ~80ms | 287.49ms | +~200ms | Expected under load |

The P95 increase from 58.83ms to 79.13ms at 50× the load is entirely expected. The latency profile is healthy. The error rate increase is a test-data defect.

---

## Infrastructure Observations

| Resource | Observation | Status |
|---|---|---|
| P95 latency profile | 49ms (ramp-up) → 90ms (steady peak at 22:01:30) → 49ms (ramp-down) | ✅ Stable, no degradation |
| Error rate pattern | 0 → 0.94–1.08% at steady state → 0 | Consistent with 1 bad VU |
| 5xx errors | 0 throughout | ✅ No server errors |
| DB connection pool | Metric = 0 (likely instrumentation gap) | ⚠️ Investigate metric |
| DB query performance | `pg.query:SELECT` = 0.63ms | ✅ Excellent |
| All other services | No load applied (auth test only) | — |

---

## Recommendations Summary

| Priority | Action | Owner | Target |
|---|---|---|---|
| **P1** | Seed `user101@test.com` (and all 400 users) into usersdb | QA / Test Data | Before re-run |
| **P1** | Re-run auth load test to validate error rate < 0.5% | QA | After seeding |
| P2 | Validate DB seeding covers all VU-count scenarios (max 200 VUs for products test) | QA | Before products load test |
| P3 | Investigate `db_connections_active` metric not exporting correctly | Platform | Next sprint |

---

## Test Conditions

| Item | Value |
|---|---|
| Environment | Local Docker (single host) |
| Dataset | `data/users.json` — 400 users (user001–user400@test.com, password: Test1234!) |
| DB seeded users | user001–user100 (100 users — **101st user missing**) |
| Script | `tests/auth/auth.test.js` |
| Stage override | `--stage 2m:100 --stage 6m:100 --stage 2m:0` (PT-15: 10-min config) |
| HTML report | `results/2026-06-10_load_auth/auth-report.html` |
| Grafana dashboards | APM · SLO · Logs · Traces (see PT-15 comment for deeplinks) |
| Tempo trace | `a4d67da727adc42e0ec3d71b4c9724cb` — confirms root cause |

---

## Analysis Checklist (PT-20)

- [x] P95 latency vs SLA per service documented in table
- [x] Error rate vs SLA per service documented in table
- [x] Services that passed vs failed thresholds identified
- [x] Root cause investigated for any threshold breach — confirmed via Tempo trace
- [x] Recommendations documented for failing services
