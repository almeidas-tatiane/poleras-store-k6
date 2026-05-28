# JIRA Setup Prompt — Poleras Store

## When to use this file

When your instructor tells you to connect the **Atlassian MCP (JIRA)**, copy the prompt
from the section below and paste it directly into Claude Code. Claude will use the MCP
to automatically create the Scrum board with all course tasks.

## Pre-requisites

1. Atlassian MCP configured and connected in Claude Code
2. Access to a JIRA workspace with project creation permissions
3. This project (`poleras-store-k6-course`) open in Claude Code

---

## Prompt — copy and paste

> Copy all text between the `---START---` and `---END---` lines
> and paste it directly into the Claude Code chat.

---START---

I am working on a Performance Testing course project called **Poleras Store**.
Please use the JIRA MCP to create a complete Scrum project with all course tasks.

### System under test context

**Poleras Store** is an online t-shirt store built with 5 independent microservices:

| Service | Port | Main endpoints |
|---|---|---|
| users-api | `:3001` | `POST /api/auth/register`, `POST /api/auth/login`, `GET /health` |
| products-service | `:3002` | `GET /api/products`, `GET /api/products/:slug`, `GET /api/categories` |
| cart-service | `:3003` | `POST /api/cart/items`, `GET /api/cart`, `DELETE /api/cart/items/:id` |
| orders-service | `:3004` | `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id` |
| payments-service | `:3005` | `POST /api/payments/process`, `GET /api/payments/:id/status` |

**Stack:** Node.js + Express + PostgreSQL + JWT
**Observability:** Prometheus (metrics), Loki (logs), Tempo (traces), Grafana (dashboards)
**Goal:** Validate whether the platform can handle the upcoming **Black Friday** traffic (estimated: 2,500 concurrent users, 5-minute peak). The event is approximately 1 month away.

**Target SLAs:**
- `users-api` POST login: P95 < 200ms, error rate < 0.5%
- `products-service` GET: P95 < 100ms, error rate < 0.5%
- `cart-service`: P95 < 150ms, error rate < 0.5%
- `orders-service`: P95 < 200ms, error rate < 1%
- `payments-service`: P95 < 300ms, error rate < 0.1%
- Overall availability: 99.9%

### Purchase flow (inter-service call sequence)

```
User → users-api (login / JWT)
     → products-service (browse catalog)
     → cart-service (add to cart)
     → orders-service (create order, validates cart)
     → payments-service (process payment, validates order)
```

### What I need created in JIRA

Please create the following following Scrum best practices:

**1. Scrum Project**
- Name: `Poleras Store - Performance Testing`
- Type: Scrum
- Description: Course project to validate Poleras Store's capacity for the Black Friday event through a progressive performance testing plan (Smoke → Load → Stress → Spike → Soak).

**2. One Epic**
- Title: `[EPIC] Performance Testing — Black Friday Ready`
- Description: Execute the full performance testing cycle across all 5 Poleras Store microservices to ensure acceptable response times and availability during Black Friday.

**3. Five User Stories** (one per phase of the performance testing cycle)

- **US-1:** `[PHASE 1] Performance Requirements Analysis`
  - As a QA team, I need to document SLAs, critical flows, and system risks to establish success criteria for the tests.
  - Acceptance criteria: SLAs defined per service, critical flows prioritized, technical risks identified.
  - Story Points: 8

- **US-2:** `[PHASE 2] Test Planning and Strategy`
  - As a QA team, I need to design the complete test strategy (types, thresholds, load model) before developing scripts.
  - Acceptance criteria: test types defined (Smoke/Load/Stress/Spike/Soak), k6 thresholds set, load model designed.
  - Story Points: 5

- **US-3:** `[PHASE 3] k6 Script Design and Development`
  - As a QA team, I need to develop 6 k6 scripts (one per service + e2e) following the 5-block pattern so tests can be executed.
  - Acceptance criteria: 6 scripts created (auth, products, cart, orders, payments, e2e), Smoke Test passed on all, thresholds aligned with US-1.
  - Story Points: 21

- **US-4:** `[PHASE 4 & 5] Environment Setup and Test Execution`
  - As a QA team, I need to verify the local environment and execute the full test cycle (Smoke → Load → Stress → Spike → Soak) to measure actual system capacity.
  - Acceptance criteria: all services healthy, Smoke Test (2 VUs × 1 min) error-free, Load Test (100 VUs × 10 min) with passing thresholds, Stress Test breakpoint identified.
  - Story Points: 13

- **US-5:** `[PHASE 6] Results Analysis and Reporting`
  - As a QA team, I need to analyze results from all runs and produce technical and executive reports to issue a go/no-go verdict for Black Friday.
  - Acceptance criteria: technical report with bottlenecks and recommendations, executive report with risk/impact for stakeholders, documented verdict.
  - Story Points: 8

**4. Detailed tasks inside US-3** (one per service + e2e)

Create the following tasks as children of US-3:

- `[Script] users-api — auth.test.js`: k6 script for `POST /api/auth/login`. SLA: P95 < 200ms, error rate < 0.5%. Dataset: `data/users.json`.
- `[Script] products-service — products.test.js`: k6 script for `GET /api/products`. SLA: P95 < 100ms, error rate < 0.5%. No authentication required.
- `[Script] cart-service — cart.test.js`: k6 script for `POST /api/cart/items` and `GET /api/cart`. SLA: P95 < 150ms, error rate < 0.5%. Requires JWT.
- `[Script] orders-service — orders.test.js`: k6 script for `POST /api/orders`. SLA: P95 < 200ms, error rate < 1%. Requires JWT and valid cart. Calls cart-service.
- `[Script] payments-service — payments.test.js`: k6 script for `POST /api/payments/process`. SLA: P95 < 300ms, error rate < 0.1%. Critical service — requires JWT and valid order.
- `[Script] e2e — e2e.test.js`: k6 script that executes the full purchase flow (login → browse → cart → order → payment). SLA: P95 < 1000ms total, error rate < 1%.

**5. Sprint Organization** (3 two-week sprints)

- **Sprint 1 — Analysis and Planning** (2 weeks): US-1, US-2
  - Sprint Goal: "Map all critical flows, define SLAs, and get the load strategy approved for all 5 Poleras Store microservices"

- **Sprint 2 — Development and Setup** (2 weeks): US-3, US-4 (partial — scripts + smoke tests)
  - Sprint Goal: "Develop all 6 k6 scripts using the 5-block pattern and validate the environment through error-free Smoke Tests"

- **Sprint 3 — Execution, Analysis and Reporting** (2 weeks): US-4 (Load/Stress/Spike/Soak runs), US-5
  - Sprint Goal: "Execute the full test cycle, identify the system's breaking point, and issue the go/no-go verdict for Black Friday"

**6. Project Versions** (Releases)

- `v1.0 - Sprint 1`: Analysis and Planning (Phase 1 + 2)
- `v2.0 - Sprint 2`: Script Development and Environment (Phase 3 + 4)
- `v3.0 - Sprint 3`: Execution, Analysis and Reporting (Phase 5 + 6)

Please create everything in JIRA using the Atlassian MCP. Follow Scrum best practices: Epic → Story → Task hierarchy, Story Points in Fibonacci scale, documented Sprint Goals.

---END---

---

## What Claude will create in JIRA

After running the prompt, Claude will automatically create:

- 1 Scrum project (`Poleras Store - Performance Testing`)
- 1 epic (`Black Friday Ready`)
- 5 user stories (US-1 to US-5) with Story Points and acceptance criteria
- 6 k6 script tasks with service-specific SLAs
- 3 sprints with documented Sprint Goals
- 3 project versions (v1.0, v2.0, v3.0)

## Notes for the instructor

- The JIRA project key can be adjusted based on the student's workspace
- The SLAs in each task are the thresholds students will use in their k6 scripts
- Once the board is created, students can start Sprint 1 and begin Phase 1
