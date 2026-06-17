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
// Modes (set via --env TEST_TYPE=<mode>):
//   stress (default) : 100→2,000 VUs — PT-16 breaking-point search
//   bf-validation    : ramp to 2,500 VUs + 5 min steady-state — P1 from Run 5 report (BF readiness Go/No-Go)

const _stressStages = [
  { duration: '2m', target: 100  }, // Stage 1 — PT-16 stress ramp
  { duration: '2m', target: 200  }, // Stage 2
  { duration: '2m', target: 400  }, // Stage 3
  { duration: '2m', target: 800  }, // Stage 4
  { duration: '2m', target: 1200 }, // Stage 5
  { duration: '2m', target: 2000 }, // Stage 6 — peak
  { duration: '2m', target: 0    }, // Stage 7 — ramp-down / recovery
];

const _bfValidationStages = [
  { duration: '3m', target: 2500 }, // ramp to Black Friday peak target
  { duration: '5m', target: 2500 }, // steady-state — BF readiness certification
  { duration: '2m', target: 0    }, // ramp-down
];

export const options = {
  stages: __ENV.TEST_TYPE === 'bf-validation' ? _bfValidationStages : _stressStages,
  thresholds: {
    'http_req_duration{service:products}': ['p(95)<100'],                                // PT-7: strictest SLA (catalog most-read)
    'http_req_failed{service:products}':   ['rate<0.005'],                               // PT-7: max 0.5% errors (scoped)
    'http_req_failed':                     [{ threshold: 'rate<0.20', abortOnFail: true }], // PT-26: global abort guard
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
  const now      = new Date();
  const date     = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = __ENV.RESULT_DIR || `results/${date}_${testType}_products`;

  return {
    [`${dir}/products-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
