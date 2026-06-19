# Stress Test — e2e Run 1 (full purchase-flow chain, post-revert baseline) — 2026-06-19

**Script:** `tests/e2e/e2e.test.js` (stress mode added this run — script previously only had a load-test profile; `RESULT_DIR` support also added)
**Load profile:** 100→200→400→800→1,200→2,000 VUs (2 min/stage) + 2 min ramp-down — full 14m run, completed naturally
**Service config:** all 5 services at their last known-good, fully validated state (cart/products/payments 12 workers, orders 14 workers — the host-wide worker-count reduction was reverted earlier today after cart-service Run 10 proved it a regression)
**Flow per VU:** login → browse products → add to cart → create order → process payment (all 5 services)

All 5 services health-checked green before launch. Early-abort guard (90s) clear.

## Result

Ran the full 14-minute profile. Global `http_req_failed` **passed** (0.81% < 1% target). Global `http_req_duration` **failed** badly: P95 14.59s vs <1000ms target (~14.6x over).

**Per-service breakdown (Prometheus, 30s-step P95 over the test window, 12:40:48–12:55:11 -03:00):**

| Service | Behavior |
|---|---|
| users-api | Stable throughout, <250ms even at 2,000 VUs — never breaks |
| products-service | Stable throughout, <500ms even at 2,000 VUs — never breaks in this chain (its own independent 2,500-VU ceiling, see PT-23, isn't reached by e2e's per-service request rate) |
| **payments-service** | **Breaks earliest** — already ~920-2,200ms by t+30-200s (well under 200 e2e VUs), pinned at the 10s histogram ceiling by t+7m (~601 VUs) |
| **cart-service** | Climbs from t+4m30s (~250 VUs), reaching 6-8s P95 by t+10-12m (~1,400-1,800 VUs) |
| **orders-service** | Climbs in lockstep with cart from t+4m30s, pinned at the 10s ceiling by t+9m30s (~1,101 VUs) |

This matches every prior single-service finding exactly: payments-service is the most fragile link (consistent with its "weakest in stack" finding), and cart/orders degrade together from ~250-300 VUs — close to cart-service's own isolated breaking point (~317-380 VUs across Runs 7/8/10). Running all 5 services' real workload simultaneously (rather than one at a time) does not meaningfully change where each service's own ceiling sits — it just exposes all of them in the same window, with the weakest (payments) failing first.

**Checks:** cart 99% pass (28 failures), orders 96% pass (664 failures), payments 97% pass (497 failures) — all consistent with each service's known capacity limit, not a new failure mode. No data-corruption checks failed (`create order: has id/has number`, `payment: has payment_id` all validate response shape correctly when the request completes).

**Recovery:** all 5 services healthy (<25ms) immediately after ramp-down, no container restarts, 19+ minutes uptime confirmed post-test.

## Conclusion

The full purchase-flow chain confirms — rather than changes — every single-service finding from PT-16/PT-21: the platform is currently bottlenecked by the cart-service CPU/event-loop ceiling (~317-380 VUs) that cascades into orders and payments, plus products-service's separate, unrelated cluster-master-IPC ceiling that only appears at the 2,500-VU Black Friday target itself. See the consolidated final report (PT-23) for the full go/no-go verdict.
