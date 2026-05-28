# Bimodal Reports — Technical & Executive

Every test run generates a report with **two sections for two different audiences**.

## Files per run

```
results/YYYY-MM-DD_<type>_<service>/
  ├── <service>-report.html          ← k6-reporter (automated data)
  ├── <service>-dashboard.html       ← k6 web dashboard export
  └── report-<TICKET>-YYYY-MM-DD.md ← Written analysis (both sections)
```

---

## Report template `.md`

```markdown
# Report — PERF-XX · Type: Smoke / Load / Stress

## EXECUTIVE SECTION (for Stakeholders / Business)

**Summary:**
- Date: YYYY-MM-DD HH:MM
- Test type: Smoke / Load / Stress / Spike / Soak
- Total duration: X minutes
- Virtual users: N VUs
- Global error rate: X%

**Key results:**
- ✅ Throughput: X req/s
- ✅ P95 latency: Xms (SLA: <Yms)
- ✅ Error rate: X% (SLA: <Y%)
- ✅ Availability: 99.X%

**Verdict:** Stable / Minor degradation / Critical degradation

**Black Friday impact:**
- [Can the service handle expected traffic?]
- [Is there a risk of failure under peak demand?]

---

## TECHNICAL SECTION (for QA / Performance Engineer)

### Test configuration
- Executor: ramping-vus / constant-arrival-rate
- Ramp-up: X min → peak: Y VUs × Z min → ramp-down: X min
- Base endpoint: http://localhost:300X
- Dataset: N records in data/users.json

### SLAs and Thresholds
| Metric | Target | Result | Status |
|---|---|---|---|
| p(95) latency | <Xms | Yms | ✅/❌ |
| p(99) latency | <Xms | Yms | ✅/❌ |
| error rate | <X% | Y% | ✅/❌ |

### Detected bottlenecks
- [Endpoint with highest latency]
- [Most frequent error type]
- [Behavior during ramp-up vs peak]

### Recommendations
- [Suggested optimizations]
- [Recommended next tests]
```

---

## Workflow: run → report → JIRA

1. Run k6 → the script auto-generates `results/` (Block 5)
2. Read the generated HTML to understand results
3. Create the `.md` analysis with both sections
4. If JIRA MCP is connected: comment on the ticket with the executive section
5. Commit to git:
   ```bash
   git add results/YYYY-MM-DD_<type>_<service>/
   git commit -m "perf: add <type> test results — PERF-XX"
   ```

---

## Quick k6 metrics reference

| Metric | Meaning |
|---|---|
| `http_req_duration p(95)` | 95% of requests completed in ≤ X ms |
| `http_req_failed rate` | % of requests with error (status ≥ 400 or network failure) |
| `http_reqs` | Total requests sent |
| `iterations` | Total times the `default` function executed |
| `vus_max` | Peak concurrent VUs reached |
| `data_received` | Total data received from the server |
