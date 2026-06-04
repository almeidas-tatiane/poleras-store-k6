# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- CLAUDE.md — Poleras Store · Performance Testing Course -->

Operation guide for the Claude Code agent in this course project.

---

## Project Context

**Application under test:** Poleras Store — t-shirt e-commerce
**Description:** Poleras Store is an online store that sells quality, comfortable, affordable t-shirts. All services run locally so the Performance Testing team can begin their activities. The engineering team needs an assessment to determine whether the platform can withstand the upcoming Black Friday event.
**System stack:** Node.js + Express + PostgreSQL · 5 independent microservices
**Observability:** Prometheus · Loki · Tempo · Grafana (available during test execution)

### Microservices and ports

| Service | Port | Function |
|---|---|---|
| users-api | `:3001` | Authentication, registration, JWT |
| products-service | `:3002` | Catalog, variants, stock |
| cart-service | `:3003` | Shopping cart, session |
| orders-service | `:3004` | Orders, status, history |
| payments-service | `:3005` | Payments, transactions |

**Architecture diagrams:** `docs/architecture.html` / `docs/architecture.en.html` · `docs/sequence.html` / `docs/sequence.en.html`

---

## Course Flow (6 Phases)

```
PHASE 1 — Requirements Analysis     → Read JIRA tickets, define SLAs
PHASE 2 — Planning and Strategy     → Choose test types, load model
PHASE 3 — Script Design             → Create k6 scripts (5-block pattern)
PHASE 4 — Environment Setup         → Verify services, prepare datasets
PHASE 5 — Test Execution            → Smoke → Load → Stress → Spike → Soak
PHASE 6 — Analysis and Reporting    → Interpret results, report findings
```

---

## Available Skills

Skills activate **automatically** during the normal flow. If the context was compacted, invoke them explicitly with `/skill-name`:

| Skill | When it activates | What it does |
|---|---|---|
| `/performance-testing-strategy` | After reading JIRA tickets¹ | Designs the test strategy |
| `/k6-best-practices` | After creating a script | Validates structure and best practices |
| `/performance-report-analysis` | After running k6 | Analyzes results and generates report |

> ¹ Requires Atlassian MCP connected and JIRA board created. See `prompts/jira-setup.en.md` before starting Phase 1.

---

## 5-Block Pattern (all k6 scripts)

Every k6 script you create **must** follow this structure:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

// Block 1 — Options: thresholds and scenario (VUs, duration, ramp-up)
export const options = {
  thresholds: {
    'http_req_duration': ['p(95)<200'],  // SLA from JIRA ticket
    'http_req_failed': ['rate<0.005']
  }
};

// Block 2 — Data: user dataset (SharedArray, never a plain variable)
const users = new SharedArray('users', () =>
  JSON.parse(open('../../data/users.json')).users
);

// Block 3 — Setup: one-time preparation (optional)
export function setup() { }

// Block 4 — Default: workload per VU
export default function() {
  // requests, checks, sleep
  sleep(Math.random() * 2 + 1);  // mandatory think time
}

// Block 5 — Summary: generates HTML report
export function handleSummary(data) {
  return { 'results/report.html': htmlReport(data) };
}
```

**Key rules:**
- `SharedArray` always for data — never a plain variable (OOM risk)
- `thresholds` to fail the test — `check()` only records, never fails
- `sleep()` between steps — simulates real user behavior
- Base URL from `__ENV.BASE_URL || 'http://localhost:3001'`

---

## Dataset and Structure (the skill creates it)

The `/k6-best-practices` skill generates the file structure, folders, and datasets. Do not manually create `lib/`, `data/`, `tests/`, or `results/` — the skill does it for you.

**Dataset rule:** the `data/users.json` file must have **≥ VUs** defined in the script.

```json
{
  "users": [
    { "email": "user1@test.com", "password": "Test1234!" },
    { "email": "user2@test.com", "password": "Test1234!" }
  ]
}
```

---

## Most Used k6 Commands

```bash
# Quick smoke test (validate the script works)
k6 run --vus 2 --duration 30s tests/auth/auth.test.js

# Official execution (uses script options)
k6 run tests/auth/auth.test.js

# With a different URL than default
k6 run --env BASE_URL=http://localhost:3002 tests/products/products.test.js

# With real-time web dashboard
K6_WEB_DASHBOARD=true k6 run tests/auth/auth.test.js

# Dashboard + export HTML when done
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/dashboard.html k6 run tests/auth/auth.test.js

# JSON output for later analysis
k6 run --out json=results/raw.json tests/auth/auth.test.js
```

---

## Critical Rules

### Test execution
1. **If error rate > 50% in the first 90s → STOP.** Do not re-run without diagnosing first.
2. **Before running:** verify the service responds → `curl http://localhost:3001/health`
   - If the service doesn't respond → check Docker: `docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`
3. **SLAs come from the JIRA ticket** — never invent them in the script.
4. **Results always in `results/`** — the script generates HTML automatically (Block 5).
   - Folder convention: `results/YYYY-MM-DD_<test-type>_<service>/` (e.g. `2026-06-01_smoke_auth/`)
5. **k6 exit codes:**

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success, all thresholds met | Report results |
| `99` | Failed thresholds (data is valid) | Read HTML, analyze, do NOT re-run |
| `101` | Setup error / script errors | Fix the script |
| `107` | Connection timeout | Check environment |

### Post-Compaction (summarized context)
> Applies when you see the `✻ Conversation compacted` message in the chat.

- ❌ **DO NOT** activate skills automatically — summarized context can produce incorrect analysis.
- ✅ **DO** invoke them explicitly when needed: `/k6-best-practices`, `/performance-testing-strategy`, `/performance-report-analysis`.
- ✅ **DO** re-read JIRA tickets via MCP before continuing (fresh data, not memory).
- ✅ **DO** verify the actual state of files with Read before assuming what exists.

### When reading JIRA tickets
- Extract explicit SLAs (P95, error rate, VUs) before creating any script.
- If the ticket has no defined SLAs → ask the instructor before continuing.
- Never assume thresholds — always take them from the ticket.

<!-- ADDITIONAL RULES — add here as the course progresses -->

---

## Project Documentation

All documentation is available in **Spanish** (`.es.md`) and **English** (`.en.md`):

| ES Document | EN Document | Content |
|---|---|---|
| `docs/architecture.html` | `docs/architecture.en.html` | Interactive diagram of the 5 microservices |
| `docs/sequence.html` | `docs/sequence.en.html` | Complete purchase flow (call sequence) |
| `docs/pattern-5-blocks.es.md` | `docs/pattern-5-blocks.en.md` | Mandatory pattern for k6 scripts |
| `docs/bimodal-reporting.es.md` | `docs/bimodal-reporting.en.md` | Technical and executive reports |
| `docs/protocols.es.md` | `docs/protocols.en.md` | k6 commands, common errors, conventions |
| `prompts/jira-setup.es.md` | `prompts/jira-setup.en.md` | Prompt to populate JIRA with MCP |

---
