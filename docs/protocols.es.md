# Protocolos y Comandos k6

## Antes de ejecutar cualquier test

Verificar que el servicio responde:

```bash
curl -v http://localhost:3001/health
curl -v http://localhost:3002/health
curl -v http://localhost:3003/health
curl -v http://localhost:3004/health
curl -v http://localhost:3005/health
```

Si algún servicio no responde → no ejecutar k6. Revisar Docker primero:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

---

## Comandos k6 más usados

```bash
# Smoke test rápido (2 VUs, 30 segundos — verifica que el script funciona)
k6 run --vus 2 --duration 30s tests/auth/auth.test.js

# Ejecución oficial (usa stages y thresholds definidos en options)
k6 run tests/auth/auth.test.js

# Con URL diferente al default
k6 run --env BASE_URL=http://localhost:3002 tests/products/products.test.js

# Dashboard web en tiempo real (se abre en navegador)
K6_WEB_DASHBOARD=true k6 run tests/auth/auth.test.js

# Dashboard + exportar HTML al terminar
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/dashboard.html \
  k6 run tests/auth/auth.test.js

# Salida JSON para análisis posterior
k6 run --out json=results/raw.json tests/auth/auth.test.js
```

---

## Protocolo ante errores en la primera ejecución

Si en los primeros 60–90 segundos ves cualquiera de estas señales → **PARAR**:

- Error rate > 50% desde el inicio
- `data_received: 0 B` o cercano a cero
- Errores de red en todos los VUs (connection reset, refused, timeout)
- Iteraciones completándose en microsegundos (loop sin throttle)

**Qué hacer:**
1. No re-ejecutar
2. Diagnosticar el entorno: `curl -v <BASE_URL>/health`
3. Leer el reporte HTML ya generado en `results/`
4. Solo re-ejecutar después de confirmar que el servicio responde

---

## Estructura de resultados

```
results/
  YYYY-MM-DD_<tipo-prueba>_<servicio>/
    <servicio>-report.html      ← HTML de k6-reporter
    <servicio>-dashboard.html   ← Web dashboard export
    report-<TICKET>-YYYY-MM-DD.md  ← Análisis escrito
```

**Tipos de prueba:** `smoke` · `load` · `stress` · `spike` · `soak`

**Ejemplo:**
```
results/2026-06-01_smoke_auth/
  auth-report.html
  auth-dashboard.html
  report-<KEY-XX>-2026-06-01.md
```

---

## Estructura del proyecto (el skill la crea)

```
tests/
  auth/auth.test.js          ← POST /api/auth/login
  products/products.test.js  ← GET /api/products
  cart/cart.test.js          ← POST/GET /api/cart
  orders/orders.test.js      ← POST /api/orders
  payments/payments.test.js  ← POST /api/payments/process
  e2e/e2e.test.js            ← flujo completo de compra

lib/
  helpers.js                 ← funciones reutilizables

data/
  users.json                 ← dataset de usuarios (≥ VUs del script)

results/
  YYYY-MM-DD_<tipo>_<servicio>/
```

---

## Exit codes de k6

| Código | Significado | Qué hacer |
|---|---|---|
| `0` | Éxito, todos los thresholds cumplidos | Reportar resultados |
| `99` | Thresholds fallidos (datos válidos) | Leer HTML, analizar, NO re-ejecutar |
| `101` | Error de setup / script con errores | Corregir el script |
| `107` | Timeout de conexión | Verificar entorno |

**Exit code 99 = test completó pero SLAs no se cumplieron.** Los datos son válidos y deben analizarse.
