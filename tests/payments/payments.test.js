// PT-12 | payments-service — payments.test.js
// Service: payments-service | Port: 3005
// Endpoints: POST /api/payments/process · GET /api/payments/:id
// SLAs from PT-7: p(95) < 300ms | error rate < 0.1% (STRICTEST)
// Note: ticket references GET /api/payments/:id/status — actual endpoint is GET /api/payments/:id
// Warning: gateway simulates 200–800ms latency; p(95) SLA of 300ms may be breached by design.

import http             from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray }  from 'k6/data';
import { htmlReport }   from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }  from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { getAuthToken } from '../../lib/auth.js';

// ─── Block 1 — Options ───────────────────────────────────────────────────────
// Default: Load Test (Black Friday peak). Override for smoke/stress/spike via CLI:
//   k6 run --vus 2 --duration 30s --env TEST_TYPE=smoke tests/payments/payments.test.js

export const options = {
  stages: [
    { duration: '5m',  target: 30 }, // ramp-up — 5 min per PT-27
    { duration: '30m', target: 30 }, // sustain — 30 min steady state per PT-27
    { duration: '5m',  target: 0  }, // ramp-down
  ],
  thresholds: {
    // Scoped to payments-service only — auth/cart/orders prep calls excluded via tag
    'http_req_duration{service:payments}': ['p(95)<300'],
    // 0.1% — strictest SLA; HTTP 402 (payment rejection) excluded via responseCallback
    'http_req_failed{service:payments}':   ['rate<0.001'],                           // PT-7: max 0.1% errors (scoped)
    'http_req_failed':                     [{ threshold: 'rate<0.20', abortOnFail: true }], // PT-26: global abort guard
  },
};

// ─── Block 2 — Data ───────────────────────────────────────────────────────────
const users = new SharedArray('users', function () {
  return JSON.parse(open('../../data/users.json')).users;
});

// ─── Block 3 — Setup ─────────────────────────────────────────────────────────
const BASE_URL        = __ENV.BASE_URL        || 'http://localhost:3005';
const BASE_URL_AUTH   = __ENV.BASE_URL_AUTH   || 'http://localhost:3001';
const BASE_URL_CART   = __ENV.BASE_URL_CART   || 'http://localhost:3003';
const BASE_URL_ORDERS = __ENV.BASE_URL_ORDERS || 'http://localhost:3004';

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'payments-service: health ok': (r) => r.status === 200 });
}

// ─── Block 4 — Default (workload per VU) ─────────────────────────────────────
// Flow: login → clear cart → add item → create order → process payment → get payment status
export default function () {
  const user      = users[(__VU - 1) % users.length];
  const variantId = ((__VU * 17 + __ITER) % 104) + 1; // 104 variants seeded in DB (smoke-verified 2026-06-09); prime 17 avoids clustering

  // Step 1: login (per-VU — never shared)
  const token = getAuthToken(BASE_URL_AUTH, user.email, user.password);
  if (!token) return;
  const authHeaders = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };

  sleep(Math.random() * 0.5 + 0.5);

  // Step 2: clear existing cart items (idempotent — prevents stale state)
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

  // Step 3: add item to cart (required for order creation)
  const addRes = http.post(
    `${BASE_URL_CART}/api/cart/items`,
    JSON.stringify({ variant_id: variantId, quantity: 1 }),
    { headers: authHeaders, tags: { service: 'cart' } }
  );
  const cartOk = check(addRes, { 'cart: item added 201': (r) => r.status === 201 });
  if (!cartOk) return;

  sleep(Math.random() * 0.5 + 0.5);

  // Step 4: create order (orders-service validates cart internally)
  const orderRes = http.post(
    `${BASE_URL_ORDERS}/api/orders`,
    JSON.stringify({}),
    { headers: authHeaders, tags: { service: 'orders' } }
  );
  const orderOk = check(orderRes, {
    'create order: status 201': (r) => r.status === 201,
    'create order: has id':     (r) => r.json('data.id') !== undefined,
  });
  if (!orderOk) return;

  const orderId = orderRes.json('data.id');

  sleep(Math.random() * 0.5 + 0.5);

  // Step 5: process payment
  // Gateway adds 200–800ms simulated latency and has a 90% approval rate.
  // HTTP 402 = payment rejected by gateway (business outcome, not a system error).
  // responseCallback prevents 402 from being counted in http_req_failed.
  const paymentRes = http.post(
    `${BASE_URL}/api/payments/process`,
    JSON.stringify({ order_id: orderId, payment_method: 'credit_card', card_number: '4111 1111 1111 1111' }),
    {
      headers:          authHeaders,
      tags:             { service: 'payments', endpoint: 'process' },
      responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 402),
    }
  );
  const paymentOk = check(paymentRes, {
    'process payment: 201 or 402':  (r) => r.status === 201 || r.status === 402,
    'process payment: has payment_id': (r) => r.json('data.payment_id') !== undefined,
  });

  sleep(Math.random() * 0.5 + 0.5);

  // Step 6: verify payment status persisted
  if (paymentOk) {
    const paymentId = paymentRes.json('data.payment_id');
    const statusRes = http.get(
      `${BASE_URL}/api/payments/${paymentId}`,
      {
        headers: authHeaders,
        tags:    { service: 'payments', endpoint: 'status', name: 'GET /api/payments/:id' },
      }
    );
    check(statusRes, {
      'get payment: status 200':  (r) => r.status === 200,
      'get payment: has status':  (r) => r.json('data.status') !== undefined,
    });
  }

  sleep(Math.random() * 1 + 0.5);
}

// ─── Block 5 — Summary (HTML report) ─────────────────────────────────────────
export function handleSummary(data) {
  const now      = new Date();
  const date     = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = `results/${date}_${testType}_payments`;
  return {
    [`${dir}/payments-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
