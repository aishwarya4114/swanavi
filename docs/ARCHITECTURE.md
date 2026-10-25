# Swanavi — Architecture & File Map

Autonomous travel companion: a supervisor multi-agent system (Strands SDK + Amazon Bedrock)
that plans trips, books authorized travel services, coordinates Mastercard AP4M payments on
XRPL EVM testnet, monitors the trip, and recovers from disruptions — all within enforced budget
and authorization limits.

> Safety invariants live in **code, not prompts**. The LLM routes and decides; deterministic
> layers enforce payment rules, state transitions, deduplication, and locks.

## Design principle

Two layers, deliberately separated:

1. **Deterministic core** (`app/agent/swanavi/`) — pure Python, stdlib-only. Holds the domain
   models, durable state, payment client, booker, monitoring engine, recovery policies. Every
   safety invariant and state transition is here and is unit-tested without an LLM or network.
2. **Agent layer** (`app/agent/swanavi/agents/` + `main.py`) — Strands tools wrapping the core,
   plus the Master/Planner/Booking/Recovery agent definitions. Uses Bedrock when credentials are
   available; falls back to a deterministic scripted orchestrator for local, credential-free runs
   and reproducible scenario tests.

This split is what makes "Do not move safety checks into LLM prompts" provable.

## Agent topology (supervisor pattern)

```
                         ┌───────────────────────────┐
                         │      Master Trip Agent     │  orchestrator
                         │  (routes, authorizes,       │  (Strands + Bedrock)
                         │   explains to the UI)      │
                         └─────────────┬──────────────┘
            ┌──────────────┬───────────┴───────────┬───────────────┐
            ▼              ▼                       ▼               ▼
     Travel Planner    Booking Agent        Recovery Agent    Monitoring
     (itinerary,       (discover sellers,   (assess incident,  Engine
      timing,           lock/release/refund,  find alternatives, (deterministic
      feasibility)      reconcile)           verify)            ticks, not
                                                                   an LLM loop)
```

The Master Agent never signs payments, never touches key material, and never bypasses the
Booker's authorization scope. The monitoring engine is deterministic and only wakes the Master
Agent when a classified, deduplicated incident warrants it.

## Payment boundary

The agent talks to the Mastercard AP4M HTTP server (`X-Swanavi-Token`). Agent-accessible
operations: `createEscrow`, `release`, `refund`, `getStatus`, `getBudget`, plus read-only
merchant/store discovery and trip status. **Not** exposed autonomously: `fund`, `closeTrip`,
`kill-switch`, merchant-outcome switches, channel creation, wallet signing. Those are
human/operator-controlled. The payment server (code we never modify) enforces per-booking max,
spend ceiling, channel cap, kill switch, overcharge refusal, and duplicate-signature prevention.

## File map

```
app/agent/
  main.py                  Runtime entrypoint (Strands + Bedrock AgentCoreApp)
  parse.py                 payload parsing (unchanged)
  model/load.py            BedrockModel loader (unchanged)
  memory/session.py        AgentCore Memory session manager (unchanged)
  swanavi/                 ← core deterministic library
    config.py              config (payment URL/token, monitor intervals)
    domain/
      enums.py             BookingStatus, EscrowReason, IncidentType, RiskLevel,
                           AgentRole, ApprovalStatus, ActivityType
      models.py            typed dataclasses: Traveler, Trip, Itinerary, Activity,
                           BookingRecord, EscrowRef, PaymentEvidence, Observation,
                           Incident, RecoveryAttempt, ApprovalRequest,
                           ExecutionLock, AuditEvent
    storage/
      store.py             SwanaviStore: SQLite + in-memory; atomic conditional writes
    payment/
      errors.py            PaymentError (maps HTTP error→code)
      client.py            MastercardClient (injectable transport)
      budget.py            Budget snapshot + drift
    booking/
      booker.py            Booker: quote→lock→release/refund; idempotency; reconciliation
    monitoring/
      incidents.py        incident schema + state machine
      detectors.py         detector interfaces (weather/traffic/schedule/...)
      engine.py            MonitoringEngine: ticks, dedup, locks, configurable intervals
    recovery/
      policies.py          per-incident recovery policies; weather vertical slice
    agents/
      tools.py             Strands @tool definitions (payment/stores/weather/trip-state)
      boundaries.py        tool permission boundaries
      master.py            Master Agent
      planner.py           Planner Agent
      booking_agent.py     Booking Agent
      recovery.py          Recovery Agent
    observability/
      telemetry.py         correlation IDs, structured audit log
    orchestrator.py        deterministic orchestrator + Strands wrapper
    cli.py                 local CLI/REPL
agentcore/
  agentcore.json           runtime + memory config (extend for gateway/policy/identity)
  cdk/lib/cdk-stack.ts     CDK stack (extend with DynamoDB, EventBridge, etc.)
docs/                      architecture, demo script, security/devops checklists
tests/                     pytest suite (25 scenarios) — no LLM, no network, no keys
```

## Mock vs live vs simulated (honesty labels)

- `MOCK` — numbers in memory, no chain (payment server `mock` mode).
- `LOCAL` — ap4m mode, nothing on chain for this row (a lock, a refund).
- `LIVE` — confirmed on-chain transaction (`txHash`, `VoucherRedeemed`).
- `SIMULATED` — a recovery alternative we found but could not confirm as a real booking
  (merchant inventory unavailable). Always labeled as such; never presented as a reservation.

The demonstration distinguishes these at every surface.
