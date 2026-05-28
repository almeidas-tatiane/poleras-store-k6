# 5-Block Pattern — k6 Scripts

All k6 scripts in this project must follow this mandatory structure.

```
Block 1 → Options     scenarios + thresholds (executor, VUs, duration, SLA gates)
Block 2 → Data        SharedArray for parameterized inputs — loaded once
Block 3 → Setup       one-time preparation (optional)
Block 4 → Default fn  workload per VU: requests, checks, groups, sleep
Block 5 → Summary     handleSummary() — generates HTML report in results/
```

## Mandatory rules

- `SharedArray` always for test data — never a plain variable (OOM risk)
- `thresholds` to fail the test — `check()` only records, never fails the test
- `sleep(Math.random() * 2 + 1)` between steps — realistic think time required
- Service tags on all requests: `tags: { service: 'auth' }`
- Base URL always from `__ENV.BASE_URL || 'http://localhost:3001'`

## Block 1 — Options: thresholds

SLAs (thresholds) come from the JIRA ticket for each service. Never invent them.

```javascript
export const options = {
  stages: [
    { duration: '1m', target: 10 },   // ramp-up
    { duration: '3m', target: 10 },   // peak
    { duration: '1m', target: 0 },    // ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<200'],    // SLA from ticket
    'http_req_failed': ['rate<0.005'],     // 0.5% max error rate
  }
};
```

**Reference SLAs for Poleras Store:**

| Service | P95 target | Error rate |
|---|---|---|
| users-api (GET) | < 100ms | < 0.5% |
| users-api (POST login) | < 200ms | < 0.5% |
| products-service | < 100ms | < 0.5% |
| cart-service | < 150ms | < 0.5% |
| orders-service | < 200ms | < 1% |
| payments-service | < 300ms | < 0.1% |

## Block 2 — Data: dataset

```javascript
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', function() {
  return JSON.parse(open('../../data/users.json')).users;
});
```

**Dataset rule:** `data/users.json` must have ≥ VUs defined in the scenario.

```json
{
  "users": [
    { "email": "user1@test.com", "password": "Test1234!" },
    { "email": "user2@test.com", "password": "Test1234!" }
  ]
}
```

## Block 3 — Setup (optional)

```javascript
export function setup() {
  // Runs ONCE before the test starts
  // Useful for: authenticating, preparing data, verifying environment
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'service is up': (r) => r.status === 200 });
}
```

## Block 4 — Default function (workload)

```javascript
export default function(data) {
  const user = users[__VU % users.length];
  const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { service: 'auth' } }
  );

  check(res, {
    'login successful': (r) => r.status === 200,
    'has token': (r) => r.json('token') !== undefined,
  });

  sleep(Math.random() * 2 + 1);  // think time: 1–3 seconds
}
```

## Block 5 — handleSummary (report)

```javascript
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

export function handleSummary(data) {
  const timestamp = new Date().toISOString().split('T')[0];
  return {
    [`results/${timestamp}_smoke_auth/auth-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
```
