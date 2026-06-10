// PT-13 | e2e — e2e.test.js
// Flow: login → browse products → add to cart → create order → process payment
// SLAs from PT-7: p(95) < 1000ms | error rate < 1%
// Services: users-api:3001 · products-service:3002 · cart-service:3003 · orders-service:3004 · payments-service:3005

import http                      from 'k6/http';
import { check, sleep, group }   from 'k6';
import { SharedArray }           from 'k6/data';
import { htmlReport }            from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }           from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ─── Block 1 — Options ───────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '2m', target: 10 }, // ramp-up
    { duration: '5m', target: 30 }, // Black Friday peak
    { duration: '1m', target: 0  }, // ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<1000'], // PT-7: e2e SLA — all requests across all 5 services
    'http_req_failed': [
      'rate<0.01',                                     // PT-7: 1% max error rate
      { threshold: 'rate<0.20', abortOnFail: true },   // PT-26: abort mid-test on pool exhaustion (>20%)
    ],
  },
};

// ─── Block 2 — Data ───────────────────────────────────────────────────────────
const users = new SharedArray('users', function () {
  return JSON.parse(open('../../data/users.json')).users;
});

const slugs = new SharedArray('slugs', function () {
  return JSON.parse(open('../../data/products.json')).slugs;
});

// ─── Block 3 — Setup ─────────────────────────────────────────────────────────
const BASE_URL_AUTH     = __ENV.BASE_URL_AUTH     || 'http://localhost:3001';
const BASE_URL_PRODUCTS = __ENV.BASE_URL_PRODUCTS || 'http://localhost:3002';
const BASE_URL_CART     = __ENV.BASE_URL_CART     || 'http://localhost:3003';
const BASE_URL_ORDERS   = __ENV.BASE_URL_ORDERS   || 'http://localhost:3004';
const BASE_URL_PAYMENTS = __ENV.BASE_URL_PAYMENTS || 'http://localhost:3005';

export function setup() {
  const services = [
    { name: 'users-api',        url: `${BASE_URL_AUTH}/health` },
    { name: 'products-service', url: `${BASE_URL_PRODUCTS}/health` },
    { name: 'cart-service',     url: `${BASE_URL_CART}/health` },
    { name: 'orders-service',   url: `${BASE_URL_ORDERS}/health` },
    { name: 'payments-service', url: `${BASE_URL_PAYMENTS}/health` },
  ];
  for (const svc of services) {
    const res = http.get(svc.url);
    check(res, { [`${svc.name}: health ok`]: (r) => r.status === 200 });
  }
}

// ─── Block 4 — Default (workload per VU) ─────────────────────────────────────
// Simulates a complete purchase journey across all 5 microservices.
export default function () {
  const user      = users[(__VU - 1) % users.length];
  const variantId = ((__VU * 17 + __ITER) % 104) + 1;
  const slug      = slugs[(__VU * 7  + __ITER) % slugs.length];

  let token, authHeaders;

  // ── Step 1: Authentication ───────────────────────────────────────────────
  group('1 - auth', function () {
    const loginRes = http.post(
      `${BASE_URL_AUTH}/api/auth/login`,
      JSON.stringify({ email: user.email, password: user.password }),
      { headers: { 'Content-Type': 'application/json' }, tags: { service: 'auth' } }
    );
    const ok = check(loginRes, {
      'login: status 200': (r) => r.status === 200,
      'login: has token':  (r) => r.json('data.token') !== undefined,
    });
    if (ok) {
      token = loginRes.json('data.token');
      authHeaders = {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      };
    }
    sleep(Math.random() * 1 + 1); // 1–2s think time
  });

  if (!token) return;

  // ── Step 2: Browse products ──────────────────────────────────────────────
  group('2 - products', function () {
    const listRes = http.get(`${BASE_URL_PRODUCTS}/api/products`, {
      tags: { service: 'products', endpoint: 'list' },
    });
    check(listRes, {
      'products list: status 200': (r) => r.status === 200,
      'products list: has data':   (r) => r.json('data') !== null,
    });
    sleep(Math.random() * 2 + 1); // 1–3s browsing

    const detailRes = http.get(`${BASE_URL_PRODUCTS}/api/products/${slug}`, {
      tags: { service: 'products', endpoint: 'detail' },
    });
    check(detailRes, {
      'product detail: status 200': (r) => r.status === 200,
      'product detail: has slug':   (r) => r.json('data.slug') !== undefined,
    });
    sleep(Math.random() * 2 + 1); // 1–3s reading detail
  });

  // ── Step 3: Cart ─────────────────────────────────────────────────────────
  let cartOk = false;
  group('3 - cart', function () {
    // Clear existing items (idempotent — prevents stale state)
    const existingCart  = http.get(`${BASE_URL_CART}/api/cart`, {
      headers: authHeaders,
      tags:    { service: 'cart', endpoint: 'get' },
    });
    const existingItems = existingCart.json('data.items') || [];
    for (const item of existingItems) {
      http.del(`${BASE_URL_CART}/api/cart/items/${item.id}`, null, {
        headers: authHeaders,
        tags:    { service: 'cart', endpoint: 'delete' },
      });
    }
    sleep(Math.random() * 0.5 + 0.5);

    const addRes = http.post(
      `${BASE_URL_CART}/api/cart/items`,
      JSON.stringify({ variant_id: variantId, quantity: 1 }),
      { headers: authHeaders, tags: { service: 'cart', endpoint: 'add' } }
    );
    cartOk = check(addRes, {
      'cart: item added 201': (r) => r.status === 201,
      'cart: has items':      (r) => Array.isArray(r.json('data.items')),
    });
    sleep(Math.random() * 1 + 0.5);
  });

  if (!cartOk) return;

  // ── Step 4: Create order ─────────────────────────────────────────────────
  let orderId;
  let orderOk = false;
  group('4 - orders', function () {
    const orderRes = http.post(
      `${BASE_URL_ORDERS}/api/orders`,
      JSON.stringify({}),
      { headers: authHeaders, tags: { service: 'orders', endpoint: 'create' } }
    );
    orderOk = check(orderRes, {
      'create order: status 201':   (r) => r.status === 201,
      'create order: has id':       (r) => r.json('data.id') !== undefined,
      'create order: has number':   (r) => r.json('data.order_number') !== undefined,
    });
    if (orderOk) orderId = orderRes.json('data.id');
    sleep(Math.random() * 1 + 0.5);
  });

  if (!orderOk) return;

  // ── Step 5: Process payment ──────────────────────────────────────────────
  group('5 - payments', function () {
    // Gateway has 90% approval rate. HTTP 402 = rejected by issuer (business outcome).
    // responseCallback prevents 402 from inflating http_req_failed.
    const paymentRes = http.post(
      `${BASE_URL_PAYMENTS}/api/payments/process`,
      JSON.stringify({ order_id: orderId, payment_method: 'credit_card', card_number: '4111 1111 1111 1111' }),
      {
        headers:          authHeaders,
        tags:             { service: 'payments', endpoint: 'process' },
        responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 402),
      }
    );
    const paymentOk = check(paymentRes, {
      'payment: 201 approved or 402 rejected': (r) => r.status === 201 || r.status === 402,
      'payment: has payment_id':               (r) => r.json('data.payment_id') !== undefined,
    });
    sleep(Math.random() * 1 + 0.5);

    if (paymentOk) {
      const paymentId = paymentRes.json('data.payment_id');
      const statusRes = http.get(
        `${BASE_URL_PAYMENTS}/api/payments/${paymentId}`,
        { headers: authHeaders, tags: { service: 'payments', endpoint: 'status' } }
      );
      check(statusRes, {
        'payment status: 200':              (r) => r.status === 200,
        'payment status: final state':      (r) => ['approved', 'rejected'].includes(r.json('data.status')),
      });
      sleep(Math.random() * 1 + 0.5);
    }
  });
}

// ─── Block 5 — Summary (HTML report) ─────────────────────────────────────────
export function handleSummary(data) {
  const date     = new Date().toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = `results/${date}_${testType}_e2e`;
  return {
    [`${dir}/e2e-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
