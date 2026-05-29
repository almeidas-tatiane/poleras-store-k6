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

Please create the following, following Scrum best practices:

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
  - Acceptance criteria: 6 scripts created (auth, products, cart, orders, payments, e2e), Smoke Test passed on all, thresholds aligned with the SLA definition ticket.
  - Story Points: 21

- **US-4:** `[PHASE 4 & 5] Environment Setup and Test Execution`
  - As a QA team, I need to verify the local environment and execute the full test cycle (Smoke → Load → Stress → Spike → Soak) to measure actual system capacity.
  - Acceptance criteria: all services healthy, Smoke Test (2 VUs × 1 min) error-free, Load Test (100 VUs × 10 min) with passing thresholds, Stress Test breakpoint identified.
  - Story Points: 13

- **US-5:** `[PHASE 6] Results Analysis and Reporting`
  - As a QA team, I need to analyze results from all runs and produce technical and executive reports to issue a go/no-go verdict for Black Friday.
  - Acceptance criteria: technical report with bottlenecks and recommendations, executive report with risk/impact for stakeholders, documented verdict.
  - Story Points: 8

**4. SLA task** (create first — this is the source of truth for the entire project)

Create this task as a child of the Requirements Analysis Story **before any script, execution, or analysis task**:

- `[SLA] Define SLAs and SLOs per microservice`: Document the accepted performance thresholds for each service. These values are the source of truth for all k6 scripts, execution tickets, and analysis tickets.
  - Description must include the SLA table:
    | Service | Endpoint | P95 | Error rate |
    |---|---|---|---|
    | users-api | POST /api/auth/login | < 200ms | < 0.5% |
    | products-service | GET /api/products | < 100ms | < 0.5% |
    | cart-service | POST/GET /api/cart | < 150ms | < 0.5% |
    | orders-service | POST /api/orders | < 200ms | < 1% |
    | payments-service | POST /api/payments/process | < 300ms | < 0.1% |
    | e2e (full flow) | login→cart→order→payment | < 1000ms | < 1% |
  - Acceptance criteria: table approved by the team, values aligned with system architecture.

**5. Script tasks** (one per service + e2e, children of the Script Design Story)

**Traceability rule:** each task description must begin with a reference block pointing to the SLA task just created, indicating the thresholds that apply for that service. Each task must also have a formal **"Relates"** issue link to the SLA task.

Reference block format at the top of each description:
```
ℹ️ TECHNICAL REFERENCE — Read the SLA definition ticket
The thresholds for this service are defined and approved in that ticket: [indicate P95 and error rate for the service].
These values must be used exactly in the k6 script's `thresholds` block.
```

- `[Script] users-api — auth.test.js`: k6 script for `POST /api/auth/login`. SLA: P95 < 200ms, error rate < 0.5%. Dataset: `data/users.json`. Store JWT for use in subsequent services. Issue link "Relates" → SLA task.
- `[Script] products-service — products.test.js`: k6 script for `GET /api/products`. SLA: P95 < 100ms, error rate < 0.5%. No authentication required. Issue link "Relates" → SLA task.
- `[Script] cart-service — cart.test.js`: k6 script for `POST /api/cart/items` and `GET /api/cart`. SLA: P95 < 150ms, error rate < 0.5%. Requires JWT. Issue link "Relates" → SLA task.
- `[Script] orders-service — orders.test.js`: k6 script for `POST /api/orders`. SLA: P95 < 200ms, error rate < 1%. Requires JWT and valid cart. Calls cart-service. Issue link "Relates" → SLA task.
- `[Script] payments-service — payments.test.js`: k6 script for `POST /api/payments/process`. SLA: P95 < 300ms, error rate < 0.1%. Critical service — requires JWT and valid order. Issue link "Relates" → SLA task.
- `[Script] e2e — e2e.test.js`: k6 script for the full purchase flow (login → browse → cart → order → payment). SLA: P95 < 1000ms total, error rate < 1%. Issue link "Relates" → SLA task.

**6. Execution tasks** (one per test type, children of the Execution Story)

Each task must have **"Relates"** issue links to the SLA task and to the relevant script task, and its description must begin with:
```
ℹ️ TECHNICAL REFERENCE
- SLA reference: see SLA definition ticket
- Script to execute: see corresponding script task
The thresholds this execution must meet are defined in the SLA task.
```

- `[Execution] Smoke Test — all services`: 2 VUs × 1 min per service. Verify all scripts run without errors. Success criterion: error rate = 0%.
- `[Execution] Load Test — all services`: 100 VUs × 10 min. Validate behavior under normal load. Success criterion: all SLA task thresholds met.
- `[Execution] Stress Test — find breaking point`: Increase VUs until degradation. Document the system's capacity limit.
- `[Execution] Spike Test — simulate Black Friday peak`: 2,500 VUs in 2 minutes. Evaluate behavior under extreme peak.
- `[Execution] Soak Test — validate long-term stability`: 50 VUs × 2 hours. Detect memory leaks or progressive degradation.

**7. Analysis tasks** (one per test type, children of the Analysis and Reporting Story)

Each task must have **"Relates"** issue links to the SLA task and to the corresponding execution task, and its description must begin with:
```
ℹ️ TECHNICAL REFERENCE
- SLA reference: see SLA definition ticket
- Results to analyze: see corresponding execution task
The analysis must compare the obtained results against the thresholds defined in the SLA task.
```

- `[Analysis] Smoke Test Results`: Verify all scripts ran without errors. Confirm environment is ready for load tests.
- `[Analysis] Load Test Results`: Compare P95 and error rate against SLAs. Identify services that fail to meet thresholds.
- `[Analysis] Stress Test Results`: Document breaking point, recovery behavior, and most vulnerable services.
- `[Analysis] Spike Test Results`: Evaluate Black Friday peak impact. Issue estimated risk for the real event.
- `[Analysis] Final Report — Go/No-Go Verdict`: Consolidate findings from all executions. Generate executive and technical reports. Issue Black Friday verdict.

**8. Sprint Organization** (3 two-week sprints)

- **Sprint 1 — Analysis and Planning** (2 weeks): Requirements Analysis and Planning Stories
  - Sprint Goal: "Map all critical flows, define SLAs, and get the load strategy approved for all 5 Poleras Store microservices"

- **Sprint 2 — Development and Setup** (2 weeks): Script Design Story + start of Execution (Smoke Test)
  - Sprint Goal: "Develop all 6 k6 scripts using the 5-block pattern and validate the environment through error-free Smoke Tests"

- **Sprint 3 — Execution, Analysis and Reporting** (2 weeks): Load/Stress/Spike/Soak executions + Analysis Story
  - Sprint Goal: "Execute the full test cycle, identify the system's breaking point, and issue the go/no-go verdict for Black Friday"

**9. Project Versions** (Releases)

- `v1.0 - Sprint 1`: Analysis and Planning (Phase 1 + 2)
- `v2.0 - Sprint 2`: Script Development and Environment (Phase 3 + 4)
- `v3.0 - Sprint 3`: Execution, Analysis and Reporting (Phase 5 + 6)

Please create everything in JIRA using the Atlassian MCP. Follow Scrum best practices: Epic → Story → Task hierarchy, Story Points in Fibonacci scale, documented Sprint Goals.

**Recommended creation order:** Project → Epic → Stories → SLA task (first) → script tasks (with links to SLA) → execution tasks (with links to SLA + scripts) → analysis tasks (with links to SLA + executions) → Sprints → Versions.

---END---

---

## What Claude will create in JIRA

After running the prompt, Claude will automatically create:

- 1 Scrum project (`Poleras Store - Performance Testing`)
- 1 epic (`Black Friday Ready`)
- 5 user stories with Story Points and acceptance criteria
- 1 SLA task (source of truth for all thresholds)
- 6 k6 script tasks with reference and link to the SLA task
- 5 execution tasks with reference and link to the SLA task + scripts
- 5 analysis tasks with reference and link to the SLA task + executions
- 3 sprints with documented Sprint Goals
- 3 project versions (v1.0, v2.0, v3.0)

## Notes for the instructor

- The JIRA project key can be adjusted based on the student's workspace
- The SLAs in each task are the thresholds students will use in their k6 scripts
- Once the board is created, students can start Sprint 1 and begin Phase 1
