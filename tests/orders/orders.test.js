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

// ─── Block 1 — Options ───────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '2m', target: 10  }, // ramp-up
    { duration: '5m', target: 50  }, // Black Friday peak
    { duration: '1m', target: 0   }, // ramp-down
  ],
  thresholds: {
    // Scoped to orders-service only — auth (users-api) and cart calls excluded via tag
    'http_req_duration{service:orders}': ['p(95)<200'],
    'http_req_failed': [
      'rate<0.01',                                     // PT-7: max 1% errors
      { threshold: 'rate<0.20', abortOnFail: true },   // PT-26: abort mid-test on pool exhaustion (>20%)
    ],
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
  const variantId = ((__VU * 17 + __ITER) % 104) + 1; // distribute across all 104 variants; prime 17 avoids repetition

  // Step 1: login to get JWT (per-VU — never shared across VUs)
  const loginRes = http.post(
    `${BASE_URL_AUTH}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags:    { service: 'auth' },
    }
  );

  const loginOk = check(loginRes, {
    'login: status 200': (r) => r.status === 200,
    'login: has token':  (r) => r.json('data.token') !== undefined,
  });

  if (!loginOk) return;

  const token = loginRes.json('data.token');
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
      tags:    { service: 'cart' },
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
        tags:    { service: 'orders', endpoint: 'get-order' },
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
  const date     = new Date().toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = `results/${date}_${testType}_orders`;

  return {
    [`${dir}/orders-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
