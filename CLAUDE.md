# CLAUDE.md — Poleras Store · Performance Testing Course

Guía de operación para el agente Claude Code en este proyecto de curso.

---

## Contexto del Proyecto

**Aplicación bajo prueba:** Poleras Store — e-commerce de poleras (camisetas)
**Stack del sistema:** Node.js + Express + PostgreSQL · 5 microservicios independientes

### Microservicios y puertos

| Servicio | Puerto | Función |
|---|---|---|
| users-api | `:3001` | Autenticación, registro, JWT |
| products-service | `:3002` | Catálogo, variantes, stock |
| cart-service | `:3003` | Carrito de compras, sesión |
| orders-service | `:3004` | Pedidos, estado, historial |
| payments-service | `:3005` | Pagos, transacciones |

**Diagramas de arquitectura:** `docs/architecture.html` y `docs/sequence.html`

---

## Flujo del Curso (6 Fases)

```
FASE 1 — Análisis de Requisitos      → Leer tickets JIRA, definir SLAs
FASE 2 — Planificación y Estrategia  → Elegir tipos de prueba, modelo de carga
FASE 3 — Diseño de Scripts           → Crear scripts k6 (patrón de 5 bloques)
FASE 4 — Configuración del Entorno   → Verificar servicios, preparar datasets
FASE 5 — Ejecución de Pruebas        → Smoke → Load → Stress → Spike → Soak
FASE 6 — Análisis y Reporte          → Interpretar resultados, reportar hallazgos
```

---

## Skills Disponibles

Los skills se activan **automáticamente** durante el flujo normal. Si el contexto fue compactado, invócalos explícitamente con `/skill-name`:

| Skill | Cuándo se activa | Qué hace |
|---|---|---|
| `/performance-testing-strategy` | Después de leer los tickets JIRA | Diseña la estrategia de pruebas |
| `/k6-best-practices` | Después de crear un script | Valida estructura y buenas prácticas |
| `/performance-report-analysis` | Después de ejecutar k6 | Analiza resultados y genera reporte |

---

## Patrón de 5 Bloques (todos los scripts k6)

Cada script k6 que crees **debe** seguir esta estructura:

```javascript
// Block 1 — Options: thresholds y escenario (VUs, duración, ramp-up)
export const options = {
  thresholds: {
    'http_req_duration': ['p(95)<200'],  // SLA del ticket JIRA
    'http_req_failed': ['rate<0.005']
  }
};

// Block 2 — Data: dataset de usuarios (SharedArray, nunca variable plana)
const users = new SharedArray('users', () =>
  JSON.parse(open('../../data/users.json')).users
);

// Block 3 — Setup: preparación one-time (opcional)
export function setup() { }

// Block 4 — Default: workload por VU
export default function() {
  // requests, checks, sleep
  sleep(Math.random() * 2 + 1);  // think time obligatorio
}

// Block 5 — Summary: genera HTML report
export function handleSummary(data) {
  return { 'results/report.html': htmlReport(data) };
}
```

**Reglas clave:**
- `SharedArray` siempre para datos — nunca variable plana (riesgo OOM)
- `thresholds` para fallar el test — `check()` solo registra, nunca falla
- `sleep()` entre pasos — simula comportamiento real del usuario
- Base URL desde `__ENV.BASE_URL || 'http://localhost:3001'`

---

## Dataset y Estructura (el skill lo crea)

El skill `/k6-best-practices` genera la estructura de archivos, carpetas y datasets. No crees manualmente `lib/`, `data/`, `tests/` ni `results/` — el skill lo hace por ti.

**Regla de dataset:** el archivo `data/users.json` debe tener **≥ VUs** definidos en el script.

```json
{
  "users": [
    { "email": "user1@test.com", "password": "Test1234!" },
    { "email": "user2@test.com", "password": "Test1234!" }
  ]
}
```

---

## Comandos k6 más usados

```bash
# Smoke test rápido (validar que el script funciona)
k6 run --vus 2 --duration 30s tests/auth/auth.test.js

# Ejecución oficial (usa options del script)
k6 run tests/auth/auth.test.js

# Con URL diferente al default
k6 run --env BASE_URL=http://localhost:3002 tests/products/products.test.js

# Con dashboard web en tiempo real
K6_WEB_DASHBOARD=true k6 run tests/auth/auth.test.js
```

---

## Reglas Críticas

### Ejecución de pruebas
1. **Si error rate > 50% en los primeros 90s → PARAR.** No re-ejecutar sin diagnosticar primero.
2. **Antes de ejecutar:** verificar que el servicio responde → `curl http://localhost:3001/health`
3. **Los SLAs vienen del ticket JIRA** — no se inventan en el script.
4. **Resultado siempre en `results/`** — el script genera HTML automáticamente (Block 5).
5. **Exit code 99 = datos válidos.** Threshold fallido no significa test roto — analizar el HTML.

### Post-Compactación (contexto resumido)
> Aplica cuando ves el mensaje `✻ Conversation compacted` en el chat.

- ❌ **NO** activar skills automáticamente — el contexto resumido puede producir análisis incorrectos.
- ✅ **SÍ** invocarlos explícitamente cuando los necesites: `/k6-best-practices`, `/performance-testing-strategy`, `/performance-report-analysis`.
- ✅ **SÍ** re-leer los tickets JIRA via MCP antes de continuar (datos frescos, no memoria).
- ✅ **SÍ** verificar el estado real de los archivos con Read antes de asumir qué existe.

### Al leer tickets JIRA
- Extraer SLAs explícitos (P95, error rate, VUs) antes de crear cualquier script.
- Si el ticket no tiene SLAs definidos → preguntar al instructor antes de continuar.
- Nunca asumir thresholds — siempre desde el ticket.

<!-- REGLAS ADICIONALES — agregar aquí según avance el curso -->

---

## Documentación del Proyecto

Toda la documentación está disponible en **español** (`.es.md`) e **inglés** (`.en.md`):

| Documento ES | Documento EN | Contenido |
|---|---|---|
| `docs/architecture.html` | `docs/architecture.en.html` | Diagrama interactivo de los 5 microservicios |
| `docs/sequence.html` | `docs/sequence.en.html` | Flujo de compra completo (secuencia de llamadas) |
| `docs/pattern-5-blocks.es.md` | `docs/pattern-5-blocks.en.md` | Patrón obligatorio para scripts k6 |
| `docs/bimodal-reporting.es.md` | `docs/bimodal-reporting.en.md` | Reportes técnicos y ejecutivos |
| `docs/protocols.es.md` | `docs/protocols.en.md` | Comandos k6, errores comunes, convenciones |
| `prompts/jira-setup.es.md` | `prompts/jira-setup.en.md` | Prompt para poblar JIRA con el MCP |

---

## Conectar JIRA (cuando el instructor lo indique)

Cuando conectes el MCP de Atlassian, usa el prompt en `prompts/jira-setup.md` para crear automáticamente el tablero Scrum con todas las tareas del curso.

---

**Project Stack:** k6 · JavaScript ES Modules · Node 18+
**Base URL default:** `http://localhost:3001` (override con `--env BASE_URL=<url>`)
