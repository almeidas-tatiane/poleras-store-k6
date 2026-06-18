// PT-11 | orders-service — orders.test.js
// Service: orders-service | Port: 3004
// Endpoints: POST /api/orders · GET /api/orders · GET /api/orders/:id
// SLAs from PT-7: p(95) < 200ms | error rate < 1%
// Dependency: orders-service validates cart-service internally before creating order

import http             from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray }  from 'k6/data';
import { htmlReport }   from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }  from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { getAuthToken } from '../../lib/auth.js';

// ─── Block 1 — Options ───────────────────────────────────────────────────────
// Modes (set via --env TEST_TYPE=<mode>):
//   load   (default) : 50 VUs × 30 min — PT-27 Black Friday steady-state
//   stress           : 100→2,000 VUs   — PT-16 breaking-point search

const _loadStages = [
  { duration: '5m',  target: 50 }, // ramp-up — 5 min per PT-27
  { duration: '30m', target: 50 }, // sustain — 30 min steady state per PT-27
  { duration: '5m',  target: 0  }, // ramp-down
];

const _stressStages = [
  { duration: '2m', target: 100  }, // Stage 1 — PT-16 stress ramp
  { duration: '2m', target: 200  }, // Stage 2
  { duration: '2m', target: 400  }, // Stage 3
  { duration: '2m', target: 800  }, // Stage 4
  { duration: '2m', target: 1200 }, // Stage 5
  { duration: '2m', target: 2000 }, // Stage 6 — peak
  { duration: '2m', target: 0    }, // Stage 7 — ramp-down / recovery
];

export const options = {
  stages: __ENV.TEST_TYPE === 'stress' ? _stressStages : _loadStages,
  thresholds: {
    // Scoped to orders-service only — auth (users-api) and cart calls excluded via tag
    'http_req_duration{service:orders}': ['p(95)<200'],
    'http_req_failed{service:orders}':   ['rate<0.01'],                              // PT-7: max 1% errors (scoped)
    'http_req_failed':                   [{ threshold: 'rate<0.20', abortOnFail: true }], // PT-26: global abort guard
  },
};

// ─── Block 2 — Data ───────────────────────────────────────────────────────────
const users = new SharedArray('users', function () {
  return JSON.parse(open('../../data/users.json')).users;
});

// ─── Block 3 — Setup ─────────────────────────────────────────────────────────
const BASE_URL      = __ENV.BASE_URL      || 'http://localhost:3004';
const BASE_URL_AUTH = __ENV.BASE_URL_AUTH || 'http://localhost:3001';
const BASE_URL_CART = __ENV.BASE_URL_CART || 'http://localhost:3003';

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'orders-service: health ok': (r) => r.status === 200 });
}

// ─── Block 4 — Default (workload per VU) ─────────────────────────────────────
// Flow: login → clear cart → add item → create order → get order by id → list orders
export default function () {
  const user      = users[(__VU - 1) % users.length];
  const variantId = ((__VU * 17 + __ITER) % 104) + 1; // 104 variants seeded in DB (smoke-verified 2026-06-09); prime 17 avoids clustering

  // Step 1: login to get JWT (per-VU — never shared across VUs)
  const token = getAuthToken(BASE_URL_AUTH, user.email, user.password);
  if (!token) return;
  const authHeaders = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };

  sleep(Math.random() * 0.5 + 0.5); // think time: 0.5–1s

  // Step 2: clear existing cart items (idempotent — prevents stale state between iterations)
  const existingCart  = http.get(`${BASE_URL_CART}/api/cart`, {
    headers: authHeaders,
    tags:    { service: 'cart' },
  });
  const existingItems = existingCart.json('data.items') || [];
  for (const item of existingItems) {
    http.del(`${BASE_URL_CART}/api/cart/items/${item.id}`, null, {
      headers: authHeaders,
      tags:    { service: 'cart', name: 'DELETE /api/cart/items/:id' },
    });
  }

  // Step 3: add item to cart (orders-service validates cart before creating order)
  const addRes = http.post(
    `${BASE_URL_CART}/api/cart/items`,
    JSON.stringify({ variant_id: variantId, quantity: 1 }),
    {
      headers: authHeaders,
      tags:    { service: 'cart' },
    }
  );

  const cartOk = check(addRes, {
    'cart: item added 201': (r) => r.status === 201,
  });

  if (!cartOk) return;

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s

  // Step 4: create order (orders-service calls cart-service internally)
  const orderRes = http.post(
    `${BASE_URL}/api/orders`,
    JSON.stringify({}),
    {
      headers: authHeaders,
      tags:    { service: 'orders', endpoint: 'create-order' },
    }
  );

  const orderOk = check(orderRes, {
    'create order: status 201':   (r) => r.status === 201,
    'create order: has id':       (r) => r.json('data.id') !== undefined,
    'create order: has number':   (r) => r.json('data.order_number') !== undefined,
    'create order: has items':    (r) => Array.isArray(r.json('data.items')) && r.json('data.items').length > 0,
  });

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s

  // Step 5: get order by ID — verify persistence (acceptance criterion)
  if (orderOk) {
    const orderId   = orderRes.json('data.id');
    const detailRes = http.get(
      `${BASE_URL}/api/orders/${orderId}`,
      {
        headers: authHeaders,
        tags:    { service: 'orders', endpoint: 'get-order', name: 'GET /api/orders/:id' },
      }
    );

    check(detailRes, {
      'get order: status 200':     (r) => r.status === 200,
      'get order: id matches':     (r) => r.json('data.id') === orderId,
      'get order: status pending': (r) => r.json('data.status') === 'pending',
    });
  }

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s

  // Step 6: list orders
  const listRes = http.get(
    `${BASE_URL}/api/orders`,
    {
      headers: authHeaders,
      tags:    { service: 'orders', endpoint: 'list-orders' },
    }
  );

  check(listRes, {
    'list orders: status 200':  (r) => r.status === 200,
    'list orders: is array':    (r) => Array.isArray(r.json('data')),
  });

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s
}

// ─── Block 5 — Summary (HTML report) ─────────────────────────────────────────
export function handleSummary(data) {
  const now      = new Date();
  const date     = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = __ENV.RESULT_DIR || `results/${date}_${testType}_orders`;

  return {
    [`${dir}/orders-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
