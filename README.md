# Poleras Store — Performance Testing Course

Proyecto base del curso de **Performance Testing** con k6.

---

## ¿Qué es Poleras Store?

**Poleras Store** es una tienda online que vende poleras (camisetas) de calidad, cómodas y a bajo precio. La empresa está próxima a lanzar su plataforma al mercado y necesita evaluar si su infraestructura puede resistir el tráfico de uno de los eventos comerciales más grandes del año: **Black Friday**.

El equipo de ingeniería ya tiene todos los servicios desplegados en local. Tu rol como **Performance Tester** es validar que la plataforma aguanta la carga esperada antes del lanzamiento.

---

## La Plataforma

Poleras Store está construida con **5 microservicios independientes**:

| Servicio | Puerto | Responsabilidad |
|---|---|---|
| `users-api` | `3001` | Registro, autenticación y JWT |
| `products-service` | `3002` | Catálogo de productos, variantes y stock |
| `cart-service` | `3003` | Carrito de compras por sesión |
| `orders-service` | `3004` | Creación y seguimiento de pedidos |
| `payments-service` | `3005` | Procesamiento de pagos y transacciones |

**Stack:** Node.js · Express · PostgreSQL · JWT  
**Observabilidad:** Prometheus · Loki · Tempo · Grafana

Para ver los diagramas de arquitectura abre en tu navegador:
- `docs/architecture.html` — Vista de alto nivel del sistema
- `docs/sequence.html` — Flujo completo de una compra

---

## Ciclo Pruebas

Ejecutar un ciclo completo de pruebas de performance en 6 fases:

```
FASE 1 — Análisis de Requisitos      Definir SLAs y flujos críticos
FASE 2 — Planificación y Estrategia  Diseñar tipos de prueba y modelo de carga
FASE 3 — Diseño de Scripts           Desarrollar scripts k6 por servicio
FASE 4 — Configuración del Entorno   Verificar servicios y preparar datos
FASE 5 — Ejecución de Pruebas        Smoke → Load → Stress → Spike → Soak
FASE 6 — Análisis y Reporte          Interpretar resultados y emitir veredicto
```

El veredicto final responde a una pregunta concreta: **¿puede Poleras Store sobrevivir el Black Friday?**

---

## Requisitos Previos

- [k6 v1.0.0+](https://k6.io/docs/get-started/installation/) instalado
- [Claude Code](https://claude.ai/code) instalado
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) corriendo
- Stack de Poleras Store (lo entrega el instructor)
- (Opcional) Cuenta en JIRA Cloud para integración con MCP

---

## Inicio Rápido

**1. Clonar este repositorio:**
```bash
git clone <URL-del-instructor>
cd poleras-store-k6-course
```

**2. Levantar los servicios de Poleras Store:**
```bash
# En el directorio del stack de Poleras Store (entregado por el instructor)
docker compose up -d
```

**3. Verificar que los 5 servicios responden:**
```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
curl http://localhost:3004/health
curl http://localhost:3005/health
```


**4. Cuando el instructor lo indique, conectar JIRA y crear el tablero:**
```
Ver: prompts/jira-setup.es.md
```

---

## Tu Primer Test

Una vez completadas las fases 1–3 del curso (análisis, planificación y scripts), Claude Code habrá generado los scripts. Ejecuta tu primer Smoke Test así:

```bash
k6 run --vus 2 --duration 30s tests/auth/auth.test.js
```

---

## Documentación

| Documento | Descripción |
|---|---|
| `docs/architecture.html` | Diagrama de arquitectura del sistema |
| `docs/sequence.html` | Flujo de compra entre microservicios |
| `docs/pattern-5-blocks.es.md` | Estructura obligatoria de los scripts k6 |
| `docs/protocols.es.md` | Comandos k6, exit codes y convenciones |
| `docs/bimodal-reporting.es.md` | Cómo generar reportes técnicos y ejecutivos |
| `prompts/jira-setup.es.md` | Prompt para crear el tablero JIRA del curso |


> Toda la documentación está disponible en español (`.es.md`) e inglés (`.en.md`).

---

## Herramientas del Curso

| Herramienta | Rol |
|---|---|
| **k6** | Motor de carga — ejecuta los scripts de prueba |
| **Claude Code** | Agente AI — guía el flujo y valida los scripts |
| **JIRA** | Gestión de tareas — fuente de verdad de SLAs y criterios |
| **Grafana** | Observabilidad — métricas, logs y trazas en tiempo real |
