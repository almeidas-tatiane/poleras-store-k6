// PT-8 | users-api — auth.test.js
// Service: users-api | Port: 3001 | Endpoint: POST /api/auth/login
// SLAs from PT-7: p(95) < 200ms | error rate < 0.5%

import http            from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray }  from 'k6/data';
import { htmlReport }   from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }  from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ─── Block 1 — Options ───────────────────────────────────────────────────────
// Default: Load Test (Black Friday peak). Override for smoke/stress/spike via CLI:
//   k6 run --vus 2 --duration 30s --env TEST_TYPE=smoke tests/auth/auth.test.js

export const options = {
  stages: [
    { duration: '5m',  target: 100 }, // ramp-up — 5 min per PT-27
    { duration: '30m', target: 100 }, // sustain — 30 min steady state per PT-27
    { duration: '5m',  target: 0   }, // ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<200'], // PT-7: SLA auth
    'http_req_failed': [
      'rate<0.005',                                    // PT-7: max 0.5% errors
      { threshold: 'rate<0.20', abortOnFail: true },   // PT-26: abort mid-test on pool exhaustion (>20%)
    ],
  },
};

// ─── Block 2 — Data ───────────────────────────────────────────────────────────
const users = new SharedArray('users', function () {
  return JSON.parse(open('../../data/users.json')).users;
});

// ─── Block 3 — Setup ─────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'users-api: health ok': (r) => r.status === 200 });
}

// ─── Block 4 — Default (workload per VU) ─────────────────────────────────────
export default function () {
  const user = users[__VU % users.length];

  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags:    { service: 'auth' },
    }
  );

  check(res, {
    'login: status 200': (r) => r.status === 200,
    'login: has token':  (r) => r.json('data.token') !== undefined,
  });

  sleep(Math.random() * 2 + 1); // think time: 1–3s
}

// ─── Block 5 — Summary (HTML report) ─────────────────────────────────────────
export function handleSummary(data) {
  const date     = new Date().toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = `results/${date}_${testType}_auth`;

  return {
    [`${dir}/auth-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
