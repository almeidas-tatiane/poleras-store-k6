// PT-10 | cart-service — cart.test.js
// Service: cart-service | Port: 3003
// Endpoints: POST /api/cart/items · GET /api/cart · DELETE /api/cart/items/:id
// SLAs from PT-7: p(95) < 150ms | error rate < 0.5%
// Auth: requires JWT from users-api (POST /api/auth/login)

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
    // Scoped to cart-service only — login (users-api) excluded via tag
    'http_req_duration{service:cart}': ['p(95)<150'],
    'http_req_failed{service:cart}':   ['rate<0.005'],                               // PT-7: max 0.5% errors (scoped)
    'http_req_failed':                 [{ threshold: 'rate<0.20', abortOnFail: true }], // PT-26: global abort guard
  },
};

// ─── Block 2 — Data ───────────────────────────────────────────────────────────
const users = new SharedArray('users', function () {
  return JSON.parse(open('../../data/users.json')).users;
});

// ─── Block 3 — Setup ─────────────────────────────────────────────────────────
const BASE_URL      = __ENV.BASE_URL      || 'http://localhost:3003';
const BASE_URL_AUTH = __ENV.BASE_URL_AUTH || 'http://localhost:3001';

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'cart-service: health ok': (r) => r.status === 200 });
}

// ─── Block 4 — Default (workload per VU) ─────────────────────────────────────
// Flow: login → clear cart → add item → get cart → delete item
export default function () {
  const user      = users[(__VU - 1) % users.length];
  const variantId = ((__VU - 1) % 10) + 1; // rotate through variants 1–10

  // Step 1: login to get JWT
  const token = getAuthToken(BASE_URL_AUTH, user.email, user.password);
  if (!token) return;
  const authHeaders = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // Step 2: clear any existing cart items (idempotent — handles dirty state between runs)
  const existingCart = http.get(
    `${BASE_URL}/api/cart`,
    {
      headers: authHeaders,
      tags:    { service: 'cart', endpoint: 'get-cart' },
    }
  );
  const existingItems = existingCart.json('data.items') || [];
  for (const item of existingItems) {
    http.del(
      `${BASE_URL}/api/cart/items/${item.id}`,
      null,
      {
        headers: authHeaders,
        tags:    { service: 'cart', endpoint: 'delete-item', name: 'DELETE /api/cart/items/:id' },
      }
    );
  }

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s

  // Step 3: add item to cart
  const addRes = http.post(
    `${BASE_URL}/api/cart/items`,
    JSON.stringify({ variant_id: variantId, quantity: 1 }),
    {
      headers: authHeaders,
      tags:    { service: 'cart', endpoint: 'add-item' },
    }
  );

  check(addRes, {
    'add item: status 201': (r) => r.status === 201,
    'add item: has items':  (r) => Array.isArray(r.json('data.items')),
  });

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s

  // Step 4: retrieve cart
  const cartRes = http.get(
    `${BASE_URL}/api/cart`,
    {
      headers: authHeaders,
      tags:    { service: 'cart', endpoint: 'get-cart' },
    }
  );

  check(cartRes, {
    'get cart: status 200': (r) => r.status === 200,
    'get cart: has items':  (r) => Array.isArray(r.json('data.items')),
    'get cart: has total':  (r) => r.json('data.total') !== undefined,
  });

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s

  // Step 5: delete item from cart (cleanup for next iteration)
  const items    = addRes.json('data.items') || [];
  const cartItem = items.find((i) => i.variant_id === variantId);
  if (cartItem) {
    const delRes = http.del(
      `${BASE_URL}/api/cart/items/${cartItem.id}`,
      null,
      {
        headers: authHeaders,
        tags:    { service: 'cart', endpoint: 'delete-item', name: 'DELETE /api/cart/items/:id' },
      }
    );
    check(delRes, { 'delete item: status 200': (r) => r.status === 200 });
  }

  sleep(Math.random() * 1 + 0.5); // think time: 0.5–1.5s
}

// ─── Block 5 — Summary (HTML report) ─────────────────────────────────────────
export function handleSummary(data) {
  const now      = new Date();
  const date     = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('T')[0];
  const testType = __ENV.TEST_TYPE || 'load';
  const dir      = __ENV.RESULT_DIR || `results/${date}_${testType}_cart`;

  return {
    [`${dir}/cart-report.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
