// PT-9 | products-service — products.test.js
// Service: products-service | Port: 3002
// Endpoints: GET /api/categories · GET /api/products · GET /api/products/:slug
// SLAs from PT-7: p(95) < 100ms | error rate < 0.5%

import http             from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray }  from 'k6/data';
import { htmlReport }   from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }  from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ─── Block 1 — Options ───────────────────────────────────────────────────────
// Default: Load Test (Black Friday peak — highest VU count in the project).
// Override for smoke/stress/spike via CLI:
//   k6 run --vus 2 --duration 30s --env TEST_TYPE=smoke tests/products/products.test.js

export const options = {
  stages: [
    { duration: '2m', target: 20  }, // ramp-up
    { duration: '5m', target: 200 }, // Black Friday peak
    { duration: '1m', target: 0   }, // ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<100'],  // PT-7: strictest SLA (catalog most-read)
    'http_req_failed':   ['rate<0.005'], // PT-7: max 0.5% errors
  },
};

// ─── Block 2 — Data ───────────────────────────────────────────────────────────
const slugs = new SharedArray('slugs', function () {
  return JSON.parse(open('../../data/products.json')).slugs;
});

// ─── Block 3 — Setup ─────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3002';

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'products-service: health ok': (r) => r.status === 200 });
}

// ─── Block 4 — Default (workload per VU) ─────────────────────────────────────
// Simulates realistic catalog browsing: categories → product list → product detail
export default function () {
  const slug = slugs[__VU % slugs.length];

  // Step 1: browse categories
  const catRes = http.get(`${BASE_URL}/api/categories`, {
    tags: { service: 'products', endpoint: 'categories' },
  });
  check(catRes, {
    'categories: status 200': (r) => r.status === 200,
    'categories: has data':   (r) => r.json('data') !== null,
  });
  sleep(Math.random() * 1 + 1); // think time: 1–2s

  // Step 2: browse product listing
  const listRes = http.get(`${BASE_URL}/api/products`, {
    tags: { service: 'products', endpoint: 'list' },
  });
  check(listRes, {
    'products: status 200': (r) => r.status === 200,
    'products: has data':   (r) => r.json('data') !== null,
  });
  sleep(Math.random() * 2 + 1); // think time: 1–3s

  // Step 3: open product detail page
  const detailRes = http.get(`${BASE_URL}/api/products/${slug}`, {
    tags: { service: 'products', endpoint: 'detail' },
  });
  check(detailRes, {
    'detail: status 200': (r) => r.status === 200,
    'detail: has slug':   (r) => r.json('data.slug') !== undefined,
  });
  sleep(Math.random() * 2 + 1); // think time: 1–3s
}

// ─── Block 5 — Summary (HTML report) ─────────────────────────────────────────
export function handleSummary(data) {
  const date     = new Date().toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = `results/${date}_${testType}_products`;

  return {
    [`${dir}/products-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
