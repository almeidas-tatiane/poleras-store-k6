# Poleras Store — Performance Testing Course

> **[ EN ]** English (this file) &nbsp;|&nbsp; **[ ES ]** [Español](./README.md)

Base project for the **Performance Testing** course with k6.

---

## What is Poleras Store?

**Poleras Store** is an online store that sells quality, comfortable, and affordable t-shirts. The company is about to launch its platform to market and needs to evaluate whether its infrastructure can handle the traffic of one of the biggest commercial events of the year: **Black Friday**.

The engineering team already has all services deployed locally. Your role as a **Performance Tester** is to validate that the platform holds up under expected load before launch.

---

## The Platform

Poleras Store is built with **5 independent microservices**:

| Service | Port | Responsibility |
|---|---|---|
| `users-api` | `3001` | Registration, authentication and JWT |
| `products-service` | `3002` | Product catalog, variants and stock |
| `cart-service` | `3003` | Shopping cart per session |
| `orders-service` | `3004` | Order creation and tracking |
| `payments-service` | `3005` | Payment processing and transactions |

**Stack:** Node.js · Express · PostgreSQL · JWT  
**Observability:** Prometheus · Loki · Tempo · Grafana

To view the architecture diagrams, open in your browser:
- `docs/architecture.en.html` — High-level system overview
- `docs/sequence.en.html` — Complete purchase flow

---

## Testing Cycle

Execute a complete performance testing cycle in 6 phases:

```
PHASE 1 — Requirements Analysis    Define SLAs and critical flows
PHASE 2 — Planning and Strategy    Design test types and load model
PHASE 3 — Script Design            Develop k6 scripts per service
PHASE 4 — Environment Setup        Verify services and prepare data
PHASE 5 — Test Execution           Smoke → Load → Stress → Spike → Soak
PHASE 6 — Analysis and Reporting   Interpret results and issue verdict
```

The final verdict answers one concrete question: **can Poleras Store survive Black Friday?**

---

## Prerequisites

- [k6 v1.0.0+](https://k6.io/docs/get-started/installation/) installed
- [Claude Code](https://claude.ai/code) installed
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running
- Poleras Store stack (provided by the instructor)
- (Optional) JIRA Cloud account for MCP integration

---

## Quick Start

**1. Clone this repository:**
```bash
git clone <instructor-URL>
cd poleras-store-k6-course
```

**2. Start the Poleras Store services:**
```bash
# Inside the Poleras Store stack directory (provided by the instructor)
docker compose up -d
```

**3. Verify all 5 services are responding:**
```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
curl http://localhost:3004/health
curl http://localhost:3005/health
```

**4. When the instructor says so, connect JIRA and create the board:**
```
See: prompts/jira-setup.en.md
```

---

## Your First Test

Once you have completed course phases 1–3 (analysis, planning and scripts), Claude Code will have generated your scripts. Run your first Smoke Test like this:

```bash
k6 run --vus 2 --duration 30s tests/auth/auth.test.js
```

---

## Documentation

| Document | Description |
|---|---|
| `docs/architecture.en.html` | System architecture diagram |
| `docs/sequence.en.html` | Purchase flow between microservices |
| `docs/pattern-5-blocks.en.md` | Mandatory k6 script structure |
| `docs/protocols.en.md` | k6 commands, exit codes and conventions |
| `docs/bimodal-reporting.en.md` | How to generate technical and executive reports |
| `prompts/jira-setup.en.md` | Prompt to create the course JIRA board |

> All documentation is available in Spanish (`.es.md`) and English (`.en.md`).

---

## Course Tools

| Tool | Role |
|---|---|
| **k6** | Load engine — executes test scripts |
| **Claude Code** | AI agent — guides the flow and validates scripts |
| **JIRA** | Task management — source of truth for SLAs and criteria |
| **Grafana** | Observability — metrics, logs and traces in real time |
