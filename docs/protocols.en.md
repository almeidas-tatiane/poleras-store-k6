# Protocols & k6 Commands

## Before running any test

Verify all services are responding:

```bash
curl -v http://localhost:3001/health
curl -v http://localhost:3002/health
curl -v http://localhost:3003/health
curl -v http://localhost:3004/health
curl -v http://localhost:3005/health
```

If any service does not respond → do not run k6. Check Docker first:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

---

## Most-used k6 commands

```bash
# Quick smoke test (2 VUs, 30 seconds — verifies the script works)
k6 run --vus 2 --duration 30s tests/auth/auth.test.js

# Official run (uses stages and thresholds defined in options)
k6 run tests/auth/auth.test.js

# With a different base URL
k6 run --env BASE_URL=http://localhost:3002 tests/products/products.test.js

# Real-time web dashboard (opens in browser)
K6_WEB_DASHBOARD=true k6 run tests/auth/auth.test.js

# Dashboard + export HTML on finish
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/dashboard.html \
  k6 run tests/auth/auth.test.js

# JSON output for later analysis
k6 run --out json=results/raw.json tests/auth/auth.test.js
```

---

## Protocol for errors on the first run

If within the first 60–90 seconds you see any of these signals → **STOP**:

- Error rate > 50% from the start
- `data_received: 0 B` or near zero
- Network errors on all VUs (connection reset, refused, timeout)
- Iterations completing in microseconds (loop with no throttle)

**What to do:**
1. Do not re-run
2. Diagnose the environment: `curl -v <BASE_URL>/health`
3. Read the HTML report already generated in `results/`
4. Re-run only after confirming the service is responding

---

## Results folder structure

```
results/
  YYYY-MM-DD_<test-type>_<service>/
    <service>-report.html       ← k6-reporter HTML
    <service>-dashboard.html    ← Web dashboard export
    report-<TICKET>-YYYY-MM-DD.md  ← Written analysis
```

**Test types:** `smoke` · `load` · `stress` · `spike` · `soak`

**Example:**
```
results/2026-06-01_smoke_auth/
  auth-report.html
  auth-dashboard.html
  report-<KEY-XX>-2026-06-01.md
```

---

## Project structure (the skill creates it)

```
tests/
  auth/auth.test.js          ← POST /api/auth/login
  products/products.test.js  ← GET /api/products
  cart/cart.test.js          ← POST/GET /api/cart
  orders/orders.test.js      ← POST /api/orders
  payments/payments.test.js  ← POST /api/payments/process
  e2e/e2e.test.js            ← full purchase flow

lib/
  helpers.js                 ← reusable functions

data/
  users.json                 ← user dataset (≥ VUs defined in script)

results/
  YYYY-MM-DD_<type>_<service>/
```

---

## k6 exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success, all thresholds passed | Report results |
| `99` | Thresholds failed (data is valid) | Read HTML, analyze, do NOT re-run |
| `101` | Setup error / script has errors | Fix the script |
| `107` | Connection timeout | Check environment |

**Exit code 99 = test completed but SLAs were not met.** Data is valid and must be analyzed.
