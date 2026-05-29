# Prompt de Setup JIRA — Poleras Store

## Cuándo usar este archivo

Cuando el instructor te indique conectar el **MCP de Atlassian (JIRA)**, copia el prompt
de la sección siguiente y pégalo en Claude Code. Claude usará el MCP para crear
automáticamente el tablero Scrum con todas las tareas del curso.

## Pre-requisitos

1. MCP de Atlassian configurado y conectado en Claude Code
2. Acceso a un workspace de JIRA con permisos para crear proyectos
3. Haber abierto este proyecto (`poleras-store-k6-course`) en Claude Code

---

## Prompt para copiar y pegar

> Copia todo el bloque de texto entre las líneas `---INICIO---` y `---FIN---`
> y pégalo directamente en el chat de Claude Code.

---INICIO---

Estoy trabajando en un proyecto de curso de Performance Testing llamado **Poleras Store**.
Necesito que uses el MCP de JIRA para crear un proyecto Scrum completo con todas las tareas del curso.

### Contexto del sistema bajo prueba

**Poleras Store** es una tienda online de poleras (camisetas) compuesta por 5 microservicios independientes:

| Servicio | Puerto | Endpoints principales |
|---|---|---|
| users-api | `:3001` | `POST /api/auth/register`, `POST /api/auth/login`, `GET /health` |
| products-service | `:3002` | `GET /api/products`, `GET /api/products/:slug`, `GET /api/categories` |
| cart-service | `:3003` | `POST /api/cart/items`, `GET /api/cart`, `DELETE /api/cart/items/:id` |
| orders-service | `:3004` | `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id` |
| payments-service | `:3005` | `POST /api/payments/process`, `GET /api/payments/:id/status` |

**Stack:** Node.js + Express + PostgreSQL + JWT
**Observabilidad:** Prometheus (métricas), Loki (logs), Tempo (trazas), Grafana (dashboards)
**Objetivo:** Validar si la plataforma resiste el tráfico del próximo evento **Black Friday** (estimado: 2500 usuarios concurrentes, pico de 5 minutos). El evento ocurre en aproximadamente 1 mes.

**SLAs objetivo:**
- `users-api` POST login: P95 < 200ms, error rate < 0.5%
- `products-service` GET: P95 < 100ms, error rate < 0.5%
- `cart-service`: P95 < 150ms, error rate < 0.5%
- `orders-service`: P95 < 200ms, error rate < 1%
- `payments-service`: P95 < 300ms, error rate < 0.1%
- Disponibilidad general: 99.9%

### Flujo de compra (secuencia de llamadas entre servicios)

```
Usuario → users-api (login/JWT)
       → products-service (ver catálogo)
       → cart-service (agregar al carrito)
       → orders-service (crear pedido, valida carrito)
       → payments-service (procesar pago, valida pedido)
```

### Lo que necesito crear en JIRA

Por favor crea lo siguiente siguiendo buenas prácticas de Scrum:

**1. Proyecto Scrum**
- Nombre: `Poleras Store - Performance Testing`
- Tipo: Scrum
- Descripción: Proyecto de curso para validar la capacidad de Poleras Store ante el evento Black Friday mediante un plan de pruebas de performance progresivo (Smoke → Load → Stress → Spike → Soak).

**2. Una Épica**
- Título: `[EPIC] Performance Testing — Black Friday Ready`
- Descripción: Ejecutar el ciclo completo de performance testing sobre los 5 microservicios de Poleras Store para garantizar disponibilidad y tiempos de respuesta aceptables durante el Black Friday.

**3. Cinco Historias de Usuario** (una por fase del ciclo de performance testing)

- **HU-1:** `[FASE 1] Análisis de Requisitos de Performance`
  - Como equipo de QA, necesito documentar los SLAs, flujos críticos y riesgos del sistema para establecer criterios de éxito de las pruebas.
  - Criterios de aceptación: SLAs definidos por servicio, flujos críticos priorizados, riesgos técnicos identificados.
  - Story Points: 8

- **HU-2:** `[FASE 2] Planificación y Estrategia de Pruebas`
  - Como equipo de QA, necesito diseñar la estrategia completa de pruebas (tipos, thresholds, modelo de carga) antes de desarrollar los scripts.
  - Criterios de aceptación: tipos de prueba definidos (Smoke/Load/Stress/Spike/Soak), thresholds k6 establecidos, modelo de carga diseñado.
  - Story Points: 5

- **HU-3:** `[FASE 3] Diseño y Desarrollo de Scripts k6`
  - Como equipo de QA, necesito desarrollar 6 scripts k6 (uno por servicio + e2e) siguiendo el patrón de 5 bloques para poder ejecutar las pruebas.
  - Criterios de aceptación: 6 scripts creados (auth, products, cart, orders, payments, e2e), Smoke Test pasado en todos, thresholds alineados con el ticket de definición de SLAs.
  - Story Points: 21

- **HU-4:** `[FASE 4 & 5] Configuración del Entorno y Ejecución de Pruebas`
  - Como equipo de QA, necesito verificar el entorno local y ejecutar el ciclo completo de pruebas (Smoke → Load → Stress → Spike → Soak) para medir la capacidad real del sistema.
  - Criterios de aceptación: todos los servicios en estado healthy, Smoke Test (2 VUs × 1 min) sin errores, Load Test (100 VUs × 10 min) con thresholds cumplidos, Stress Test hasta punto de quiebre identificado.
  - Story Points: 13

- **HU-5:** `[FASE 6] Análisis y Reporte de Resultados`
  - Como equipo de QA, necesito analizar los resultados de todas las ejecuciones y generar reportes técnico y ejecutivo para dar el veredicto go/no-go para Black Friday.
  - Criterios de aceptación: reporte técnico con bottlenecks y recomendaciones, reporte ejecutivo con riesgo/impacto para stakeholders, veredicto documentado.
  - Story Points: 8

**4. Tarea de SLAs** (crear primero — es la fuente de verdad de todo el proyecto)

Crea esta tarea como hija de la Historia de Análisis de Requisitos **antes que cualquier otra tarea de script, ejecución o análisis**:

- `[SLA] Definir SLAs y SLOs por microservicio`: Documentar los thresholds de performance aceptados para cada servicio. Estos valores son la fuente de verdad para todos los scripts k6, tickets de ejecución y tickets de análisis.
  - Descripción debe incluir la tabla de SLAs:
    | Servicio | Endpoint | P95 | Error rate |
    |---|---|---|---|
    | users-api | POST /api/auth/login | < 200ms | < 0.5% |
    | products-service | GET /api/products | < 100ms | < 0.5% |
    | cart-service | POST/GET /api/cart | < 150ms | < 0.5% |
    | orders-service | POST /api/orders | < 200ms | < 1% |
    | payments-service | POST /api/payments/process | < 300ms | < 0.1% |
    | e2e (flujo completo) | login→cart→order→payment | < 1000ms | < 1% |
  - Criterios de aceptación: tabla aprobada por el equipo, valores alineados con arquitectura del sistema.

**5. Tareas de scripts** (una por servicio + e2e, hijas de la Historia de Diseño de Scripts)

**Regla de trazabilidad:** la descripción de cada tarea debe comenzar con un bloque que referencie el ticket de SLAs recién creado, indicando los thresholds que aplican para ese servicio. Además, cada tarea debe tener un issue link formal tipo **"Relates"** hacia el ticket de SLAs.

Formato del bloque de referencia al inicio de cada descripción:
```
ℹ️ REFERENCIA TÉCNICA — Lee el ticket de definición de SLAs
Los thresholds para este servicio están definidos y aprobados en ese ticket: [indicar P95 y error rate del servicio].
Los valores deben usarse exactamente en el bloque de `thresholds` del script k6.
```

- `[Script] users-api — auth.test.js`: Script k6 para `POST /api/auth/login`. SLA: P95 < 200ms, error rate < 0.5%. Dataset: `data/users.json`. Guarda el JWT para uso en servicios posteriores. Issue link "Relates" → ticket de SLAs.
- `[Script] products-service — products.test.js`: Script k6 para `GET /api/products`. SLA: P95 < 100ms, error rate < 0.5%. No requiere autenticación. Issue link "Relates" → ticket de SLAs.
- `[Script] cart-service — cart.test.js`: Script k6 para `POST /api/cart/items` y `GET /api/cart`. SLA: P95 < 150ms, error rate < 0.5%. Requiere JWT. Issue link "Relates" → ticket de SLAs.
- `[Script] orders-service — orders.test.js`: Script k6 para `POST /api/orders`. SLA: P95 < 200ms, error rate < 1%. Requiere JWT y carrito válido. Llama a cart-service. Issue link "Relates" → ticket de SLAs.
- `[Script] payments-service — payments.test.js`: Script k6 para `POST /api/payments/process`. SLA: P95 < 300ms, error rate < 0.1%. Servicio crítico — requiere JWT y orden válida. Issue link "Relates" → ticket de SLAs.
- `[Script] e2e — e2e.test.js`: Script k6 para el flujo completo (login → browse → cart → order → payment). SLA: P95 < 1000ms total, error rate < 1%. Issue link "Relates" → ticket de SLAs.

**6. Tareas de ejecución** (una por tipo de prueba, hijas de la Historia de Ejecución)

Cada tarea debe tener issue links **"Relates"** hacia el ticket de SLAs y hacia el ticket de script correspondiente, y su descripción debe iniciar con:
```
ℹ️ REFERENCIA TÉCNICA
- SLAs de referencia: ver ticket de definición de SLAs
- Script a ejecutar: ver ticket del script correspondiente
Los thresholds que debe cumplir esta ejecución están definidos en el ticket de SLAs.
```

- `[Ejecución] Smoke Test — todos los servicios`: 2 VUs × 1 min por servicio. Validar que todos los scripts corren sin errores. Criterio de éxito: error rate = 0%.
- `[Ejecución] Load Test — todos los servicios`: 100 VUs × 10 min. Validar comportamiento bajo carga normal. Criterio de éxito: todos los thresholds del ticket de SLAs cumplidos.
- `[Ejecución] Stress Test — identificar punto de quiebre`: Incrementar VUs hasta degradación. Documentar el límite del sistema.
- `[Ejecución] Spike Test — simular pico Black Friday`: 2500 VUs en 2 minutos. Evaluar comportamiento bajo pico extremo.
- `[Ejecución] Soak Test — validar estabilidad prolongada`: 50 VUs × 2 horas. Detectar memory leaks o degradación progresiva.

**7. Tareas de análisis** (una por tipo de prueba, hijas de la Historia de Análisis y Reporte)

Cada tarea debe tener issue links **"Relates"** hacia el ticket de SLAs y hacia la tarea de ejecución correspondiente, y su descripción debe iniciar con:
```
ℹ️ REFERENCIA TÉCNICA
- SLAs de referencia: ver ticket de definición de SLAs
- Resultados a analizar: ver ticket de ejecución correspondiente
El análisis debe contrastar los resultados obtenidos contra los thresholds definidos en el ticket de SLAs.
```

- `[Análisis] Resultados Smoke Test`: Verificar que todos los scripts ejecutaron sin errores. Confirmar entorno listo para pruebas de carga.
- `[Análisis] Resultados Load Test`: Comparar P95 y error rate contra SLAs. Identificar servicios que no cumplen thresholds.
- `[Análisis] Resultados Stress Test`: Documentar punto de quiebre, comportamiento de recuperación y servicios más vulnerables.
- `[Análisis] Resultados Spike Test`: Evaluar impacto del pico Black Friday. Emitir riesgo estimado para el evento real.
- `[Análisis] Reporte Final — Veredicto Go/No-Go`: Consolidar hallazgos de todas las ejecuciones. Generar reporte ejecutivo y técnico. Emitir veredicto para Black Friday.

**8. Organización en Sprints** (3 sprints de 2 semanas)

- **Sprint 1 — Análisis y Planificación** (2 semanas): Historias de Análisis de Requisitos y Planificación
  - Sprint Goal: "Tener mapeados flujos críticos, SLAs definidos y estrategia de carga aprobada para los 5 microservicios de Poleras Store"

- **Sprint 2 — Desarrollo y Configuración** (2 semanas): Historia de Diseño de Scripts + inicio de Ejecución (Smoke Test)
  - Sprint Goal: "Desarrollar los 6 scripts k6 con patrón de 5 bloques y validar entorno mediante Smoke Tests sin errores"

- **Sprint 3 — Ejecución, Análisis y Reporte** (2 semanas): Ejecuciones Load/Stress/Spike/Soak + Historia de Análisis
  - Sprint Goal: "Ejecutar ciclo completo de pruebas, identificar punto de quiebre y emitir veredicto go/no-go para Black Friday"

**9. Versiones del proyecto** (Releases)

- `v1.0 - Sprint 1`: Análisis y Planificación (Fase 1 + 2)
- `v2.0 - Sprint 2`: Desarrollo de Scripts y Ambiente (Fase 3 + 4)
- `v3.0 - Sprint 3`: Ejecución, Análisis y Reporte (Fase 5 + 6)

Por favor crea todo esto en JIRA usando el MCP de Atlassian. Sigue las buenas prácticas de Scrum: jerarquía Epic → Story → Task, Story Points en escala Fibonacci, Sprint Goals documentados.

**Orden de creación recomendado:** Proyecto → Épica → Historias → tarea de SLAs (primero) → tareas de scripts (con links a SLAs) → tareas de ejecución (con links a SLAs y scripts) → tareas de análisis (con links a SLAs y ejecuciones) → Sprints → Versiones.

---FIN---

---

## Qué creará Claude en JIRA

Al ejecutar el prompt, Claude creará automáticamente:

- 1 proyecto Scrum (`Poleras Store - Performance Testing`)
- 1 épica (`Black Friday Ready`)
- 5 historias de usuario con Story Points y criterios de aceptación
- 1 tarea de SLAs (fuente de verdad para todos los thresholds)
- 6 tareas de scripts k6 con referencia y link al ticket de SLAs
- 5 tareas de ejecución con referencia y link al ticket de SLAs + scripts
- 5 tareas de análisis con referencia y link al ticket de SLAs + ejecuciones
- 3 sprints con Sprint Goals documentados
- 3 versiones del proyecto (v1.0, v2.0, v3.0)

## Notas para el instructor

- El key del proyecto JIRA puede ajustarse según el workspace del estudiante
- Los SLAs en las tareas son los que el estudiante usará para sus thresholds k6
- Una vez creado el tablero, el estudiante puede iniciar Sprint 1 y comenzar la Fase 1
