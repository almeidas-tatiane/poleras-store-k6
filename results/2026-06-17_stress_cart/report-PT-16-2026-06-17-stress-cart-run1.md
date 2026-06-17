# Stress Test — cart-service · PT-16 Run 1

**Date:** 2026-06-17
**Test type:** Stress — breaking point search (PT-16)
**Script:** `tests/cart/cart.test.js`
**Test window (local):** 18:25:33 – ~18:32:45 (07m15s active, stopped at Stage 4)
**Related tickets:** PT-16 (execution) · PT-10 (script) · PT-7 (SLAs)

**Command used:**
```bash
k6 run \
  --env BASE_URL=http://localhost:3003 \
  --env BASE_URL_AUTH=http://localhost:3001 \
  --env TEST_TYPE=stress \
  --env RESULT_DIR=results/2026-06-17_stress_cart \
  tests/cart/cart.test.js
```

---

## k6 Run Statistics (at stop — no handleSummary due to forceful kill)

| Metric | Value |
|---|---|
| Total iterations completed | 11,801 |
| Interrupted iterations | 0 |
| Max VUs reached before stop | 652 (Stage 4: 400→800 ramp) |
| Test stopped at | 07m15s (out of 14m00s) |
| Reason stopped | RED alert: P95 breached SLA at ~100 VUs |
| k6 exit code | 255 (SIGKILL — forced stop) |
| HTML report generated | ❌ No (process killed before handleSummary) |

---

## SLA Breach Timeline — Prometheus P95 per Route

| Time (local) | Phase | VUs (approx) | `/api/cart` P95 | `/api/cart/items` P95 | `/api/cart/items/:itemId` P95 | Status |
|---|---|---|---|---|---|---|
| 18:25:33 | Test start | 0 | — | — | — | — |
| 18:26:31 | Stage 1 (~60s in) | ~76 | 25ms | 66ms | 38ms | ✅ GREEN |
| 18:28:00 | Stage 1→2 transition | ~120 | **1,461ms** | **2,307ms** | **1,842ms** | 🔴 RED |
| 18:28:30 | Stage 2 peak (Grafana) | ~200 | ~5s | ~8s | ~5s | 🔴 RED |
| 18:32:45 | Stopped | 652 | NaN (recovering) | NaN | NaN | ⏹ Stopped |

**Breaking point: ~100 VUs** — SLA (150ms) violated immediately at Stage 1→2 transition.

---

## Grafana P95 Peak Values (ecommerce-apm-v1 dashboard, 20-min window)

| Metric | Mean | Max (peak) | Last (post-stop) |
|---|---|---|---|
| P50 cart-service | 269ms | 3.66s | 2.50ms ✅ |
| **P95 cart-service** | **620ms** | **8.23s** | 4.75ms ✅ |
| P99 cart-service | 1.07s | **10s (k6 timeout)** | 4.95ms ✅ |
| P95 users-api | 9.52ms | 21.9ms | 9.50ms ✅ |
| P95 orders-service | 5.65ms | 17.5ms | 4.75ms ✅ |
| P95 payments-service | 5.18ms | 8.75ms | 4.75ms ✅ |

**Recovery:** P95 cart-service dropped from 8.23s peak → 4.75ms within ~90s of load removal. Fast recovery confirmed.

---

## Error Rate

| Source | Value | SLA | Status |
|---|---|---|---|
| k6 interrupted iterations | 0 / 11,801 | 0 | ✅ |
| Prometheus 5xx rate | 0.00% (no 5xx data returned) | <0.5% | ✅ |
| Loki application errors | 0 entries in test window | — | ✅ |

**Zero HTTP errors throughout.** The service degraded on latency but never produced errors.

---

## SLA Compliance

| Metric | Target (PT-7) | At Breaking Point (~100 VUs) | Status |
|---|---|---|---|
| P95 response time (cart) | < 150ms | **1,461ms – 8,230ms** | ❌ FAIL |
| Error rate | < 0.5% | **0.00%** | ✅ PASS |
| Recovery time | < 120s | **~90s** | ✅ PASS |

---

## Root Cause Hypothesis

The dramatic P95 jump (66ms → 1,461ms) at the 100 VU boundary suggests resource pool exhaustion rather than gradual saturation:

### Hypothesis 1: Cart-DB connection pool exhaustion (most likely)
- At 100 VUs with concurrent login + cart operations, the cart-service DB connection pool fills up
- New requests queue for a connection, compounding into the multi-second P95
- Similar pattern to Run 4 of products-service (pool exhaustion caused sudden latency collapse)

### Hypothesis 2: Shared user data causing cart contention
- Script uses `users[(__VU - 1) % users.length]` — if `users.length` < 100 VUs, multiple VUs share the same user account
- Multiple VUs sharing a user's cart cause concurrent DELETE/POST/GET operations on the same cart rows (DB lock contention)
- The "clear cart" loop in Step 2 could accumulate many DELETEs if carts have items from other VUs

### Hypothesis 3: Redis session/cache saturation
- If cart-service uses Redis for session storage, the connection pool to Redis could saturate at 100 VUs

**Recommended investigation:** Check `DB_POOL_MAX` in cart-service config and compare to concurrent VU count. Also check `data/users.json` user count — if < 100, multiple VUs share users causing lock contention.

---

## PT-16 Success Criteria Assessment

| Criteria | Status | Evidence |
|---|---|---|
| Breaking point VU count documented | ✅ | ~100 VUs (Stage 1→2 transition) |
| P95 latency at breaking point recorded | ✅ | 1,461ms–8,230ms (Prometheus + Grafana) |
| Error rate at breaking point recorded | ✅ | 0.00% |
| Recovery time documented | ✅ | ~90s |
| Results saved to results/YYYY-MM-DD_stress_cart/ | ✅ | `results/2026-06-17_stress_cart/` |

---

## Screenshots

| File | Description |
|---|---|
| screenshot-01-latency-p95-breaking-point.png | Grafana P50/P95/P99 — all services — captured at RED alert (~120 VUs) |
| screenshot-02-full-test-window-p95.png | Grafana P50/P95/P99 — 20-min window — full test arc showing peak and recovery |
| screenshot-03-rps-by-service.png | RPS by service — cart at 140 RPS at Stage 1 |

---

## Recommendations

| Priority | Action | Owner | Urgency |
|---|---|---|---|
| **P1** | Investigate cart-service DB_POOL_MAX — compare to concurrent VU count at breaking point | Backend Eng | Before next run |
| **P2** | Check `data/users.json` count — if < 100, increase to ≥ 2,000 to prevent VU-to-user sharing | Performance Team | Before next run |
| **P3** | Add cart-service DB connection metric to Prometheus alert (`CartDBConnectionsHigh`) | Platform | Post-fix |
| **P4** | Re-run stress test after P1+P2 fix to find true breaking point | Performance Team | After fix |
