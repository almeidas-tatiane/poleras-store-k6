# Patrón de 5 Bloques — Scripts k6

Todos los scripts k6 en este proyecto deben seguir esta estructura obligatoria.

```
Block 1 → Options     scenarios + thresholds (executor, VUs, duration, SLA gates)
Block 2 → Data        SharedArray para inputs parametrizados — cargado una vez
Block 3 → Setup       preparación one-time (opcional)
Block 4 → Default fn  workload por VU: requests, checks, groups, sleep
Block 5 → Summary     handleSummary() — genera HTML report en results/
```

## Reglas obligatorias

- `SharedArray` siempre para datos de prueba — nunca variable plana (OOM risk)
- `thresholds` para fallar la prueba — `check()` solo registra, nunca falla el test
- `sleep(Math.random() * 2 + 1)` entre pasos — think time realista obligatorio
- Tags por servicio en todos los requests: `tags: { service: 'auth' }`
- Base URL siempre desde `__ENV.BASE_URL || 'http://localhost:3001'`

## Block 1 — Options: thresholds

Los SLAs (thresholds) vienen del ticket JIRA del servicio. No se inventan.

```javascript
export const options = {
  stages: [
    { duration: '1m', target: 10 },   // ramp-up
    { duration: '3m', target: 10 },   // peak
    { duration: '1m', target: 0 },    // ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<200'],    // SLA del ticket
    'http_req_failed': ['rate<0.005'],     // 0.5% error máximo
  }
};
```

**SLAs de referencia para Poleras Store:**

| Servicio | P95 target | Error rate |
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

**Regla de dataset:** `data/users.json` debe tener ≥ VUs del escenario.

```json
{
  "users": [
    { "email": "user1@test.com", "password": "Test1234!" },
    { "email": "user2@test.com", "password": "Test1234!" }
  ]
}
```

## Block 3 — Setup (opcional)

```javascript
export function setup() {
  // Ejecuta UNA VEZ antes del test
  // Útil para: autenticar, preparar datos, verificar entorno
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

  sleep(Math.random() * 2 + 1);  // think time: 1–3 segundos
}
```

## Block 5 — handleSummary (reporte)

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
