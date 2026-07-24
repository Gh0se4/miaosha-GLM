# Fire scheduler and Log V2 design

This design defines the first repair phase for the BigModel purchase flow. It replaces the accidental timing behavior with an explicit scheduler and produces durable records that can support later parameter tuning. The phase preserves the existing UI and manual JSON handoff.

## Status

- Design date: 2026-07-17
- Audience: maintainers of the Chrome MV3 extension
- Scope: BigModel purchase scheduling, MAIN-world transport telemetry, and diagnostic logging
- Persistence: local IndexedDB with manual JSON export
- Upload behavior: no automatic upload

## Goals

The implementation must:

- run one explicit scheduler per purchase run;
- prepare auth, products, tickets, and configuration before the first target time;
- control shot start times with absolute time slots;
- preserve intentional Burst concurrency with a documented limit;
- return every reserved ticket that never reaches `window.fetch()`;
- record the boundary between scheduling, cross-world messaging, and the browser fetch call;
- persist complete purchase records across page reloads and browser restarts;
- export a versioned JSON document for later analysis;
- stop calibration traffic during the five minutes before a sale;
- pass the full test suite, TypeScript checking, and the production build.

## Non-goals

This phase does not:

- choose an optimal request interval from the three existing sessions;
- implement automatic parameter tuning;
- add automatic WAF retries or cooldown recovery;
- redesign the overlay;
- upload logs to a server;
- migrate the existing Log V1 files into IndexedDB;
- claim that an application timestamp equals the server receive time.

## Confirmed problems

The current implementation starts `scheduleNext()` twice. It also ignores the configured interval and busy-backoff option in the active scheduling branch. A network-error path references an out-of-scope variable and can stop the chain.

The current log records an application timestamp before the order pipeline starts. It does not record the actual `window.fetch()` call, the HTTP status, or response headers. The exporter hardcodes the extension version and stores all entries in `sessionStorage`.

Runtime calibration sends active `/batch-preview` requests. The MAIN-world bridge drops response headers, so calibration cannot read the server `Date` header. These requests are absent from Log V1.

## Architecture

### Fire scheduler

Create `lib/api/fire-scheduler.ts` as a pure module. It accepts an immutable run configuration and produces absolute shot slots.

```typescript
export interface FireScheduleInput {
  startMs: number;
  intervalMs: number;
  maxInFlight: number;
  shots: Array<{ shotId: string; productId: string }>;
}

export interface FireScheduleSlot {
  shotId: string;
  productId: string;
  index: number;
  plannedAt: number;
}
```

The scheduler must not read storage, call the network, mutate tickets, or add random jitter. Each slot uses `startMs + index * intervalMs`.

### Strike runner

The content script remains the orchestration boundary for the first phase. It owns one `ActiveStrikeRun` and uses the pure scheduler to release shots.

The runner must acquire the run lock before it removes tickets from the pool. It must track each ticket through these states:

- `available`
- `reserved`
- `released`
- `fetch-started`
- `settled`
- `returned`

A ticket becomes consumed only when MAIN world reports `fetchCalledAt`. Cancellation must return all tickets that never reach that state.

### MAIN-world transport

Extend the existing DO_FETCH protocol instead of adding another request path. Every request gets a stable `requestId`, `runId`, and `shotId`.

The response must include:

```typescript
export interface MainWorldTransportTiming {
  bridgeReceivedAt: number;
  bridgeReceivedPerfMs: number;
  fetchCalledAt: number;
  fetchCalledPerfMs: number;
  responseHeadersAt: number;
  bodyCompletedAt: number;
}
```

The bridge must also return the real HTTP status, status text, accessible response headers, and complete response body. A DO_FETCH_CANCEL command must abort the matching MAIN-world `AbortController`.

### Diagnostic store

Create `src/bm-main/11-fire-log-store.js` as the persistence boundary. Use an IndexedDB database named `qianggouDiagnostics` with these object stores:

- `sessions`, keyed by `sessionId`;
- `runs`, keyed by `runId`;
- `events`, keyed by an auto-incremented sequence;
- `shots`, keyed by `shotId`.

`sessionStorage` may keep a small current-session summary. It must not be the source of truth for Log V2.

If IndexedDB is temporarily unavailable, the store must retain new records in memory. The UI must show a persistence warning. Manual export must merge persisted and in-memory records without dropping either source.

## Scheduling data flow

### Automatic run

1. MAIN world schedules preparation three seconds before the target fetch time.
2. ISOLATED world captures auth, selected products, valid tickets, fire configuration, and the latest calibration snapshot.
3. The runner acquires the run lock.
4. The runner reserves tickets and builds an immutable run plan.
5. The scheduler releases each shot at its absolute slot.
6. MAIN world reports the transport timing and response.
7. The runner classifies the response and finalizes or continues the run.
8. The runner returns every ticket that never reached `fetch-started`.

Preparation uses a default lead time of 3,000 ms. The run record must store the configured lead time and the actual preparation duration.

The first version preserves the existing target calculation from `scheduleAutoFire`. It removes the additional hidden `startMs - 500` adjustment. The log must record `nextSaleTime`, `rttCompensationMs`, `clockOffsetMs`, and `earlyOffsetMs` separately so later sessions can tune each component.

### Manual and Burst runs

Manual runs prepare immediately and use the configured interval. Auto and Manual runs set `maxInFlight` to `1`.

Burst runs use a 500 ms interval and set `maxInFlight` to `2` in the first version. This limit is explicit, logged, and testable. Later sessions may change it without changing the scheduler architecture.

### Minimum-gap rule

For Auto and Manual modes, a shot cannot start while another shot is in flight. It also cannot start before both conditions are true:

- the absolute slot has arrived;
- the previous actual `fetchCalledAt + intervalMs` has arrived.

This rule prevents response latency from shrinking the start-to-start gap. If a response delays the next shot, the log records `queueDelayMs` instead of silently shifting the plan.

## Calibration behavior

The bridge must preserve response headers so calibration can read the server `Date` header. Calibration records every probe as a diagnostic event, including failures.

The scheduler must not start a calibration run within five minutes of the next sale. A calibration run already in progress must stop before sending its next probe after entering the quiet window.

This phase keeps the current RTT compensation formula to avoid mixing scheduler repair with parameter tuning. The exported calibration snapshot must label the value `rttCompensationMs`; it must not describe it as measured one-way latency.

## Log V2 schema

The JSON export uses this root shape:

```json
{
  "schemaVersion": 2,
  "exportedAt": "2026-07-17T08:00:00.000Z",
  "extensionVersion": "1.5.0",
  "session": {},
  "runs": [],
  "events": [],
  "shots": []
}
```

### Session record

The session record contains:

- `sessionId`;
- runtime manifest version;
- user agent;
- page URL;
- timezone;
- session start and last-update timestamps;
- initial document visibility state.

### Run record

Each run record contains:

- `runId` and trigger source;
- mode and lifecycle state;
- target, preparation, start, and finish timestamps;
- interval, preparation lead time, and `maxInFlight`;
- complete selected-product snapshot;
- complete ticket and randstr snapshot;
- calibration snapshot;
- auth source and age without reusable credentials;
- stop reason and ticket return counts.

### Event record

Each event contains `eventId`, `sessionId`, optional `runId`, a wall-clock timestamp, a monotonic timestamp, an event type, and structured details.

Required event types include:

- `calibration_probe_started` and `calibration_probe_finished`;
- `calibration_quiet_window_entered`;
- `run_prepare_started` and `run_prepared`;
- `run_rejected`;
- `tickets_reserved` and `tickets_returned`;
- `shot_released` and `fetch_started`;
- `fetch_aborted` and `fetch_timed_out`;
- `visibility_changed`;
- `persistence_error`;
- `run_finished`.

### Shot record

Each shot contains:

- identifiers and local sequence numbers;
- product, priority, complete ticket, and complete randstr;
- the full request URL, method, allowed headers, and body;
- planned, release, bridge, fetch, response-header, and body-completion timestamps;
- HTTP status and status text;
- complete accessible response headers and body;
- application code, outcome, and raw server message;
- RTT, schedule error, queue delay, and transport durations;
- cancellation or abort metadata.

`scheduleErrorMs` is `actualStartAt - plannedAt`, where `actualStartAt` is
`fetchCalledAt` (or `releasedAt` only when no fetch was called).
For Auto and Manual shots that reached `window.fetch()`, `queueDelayMs` is
`max(0, fetchCalledAt - max(plannedAt, previousFetchCalledAt + intervalMs))`.
Burst omits this field because it intentionally permits overlap. Transport
durations are emitted only from ordered real timestamps:
`bridgeWaitMs` (`fetchCalledAt - bridgeReceivedAt`),
`fetchToHeadersMs` (`responseHeadersAt - fetchCalledAt`),
`responseBodyMs` (`bodyCompletedAt - responseHeadersAt`), and
`transportTotalMs` (`bodyCompletedAt - bridgeReceivedAt`). Unsent cancelled
shots omit delay and transport metrics rather than fabricating them.

### Credential boundary

Header filtering is case-insensitive. Log V2 must remove these headers before persistence and export:

- `Authorization`;
- `Cookie`;
- `Proxy-Authorization`;
- `Bigmodel-Organization`;
- `Bigmodel-Project`;
- `Set-Cookie`.

The logger must not replace these values with masks. It omits the fields entirely. Request bodies, ticket values, randstr values, product IDs, and response bodies remain complete.

## Result policy

The first version uses deterministic result handling:

| Result | Action |
|---|---|
| `success` | Stop the run, cancel future slots, and return unused tickets. |
| WAF HTML | Stop the run and record `waf-blocked`. Do not retry automatically. |
| `busy` / 555 | Continue according to the immutable run plan. |
| `soldout` | Continue to the next planned shot. |
| Network timeout | Abort the matching MAIN-world fetch and continue. |
| Other network error | Record the error and continue. |
| User cancellation | Abort in-flight requests, stop future slots, and return unused tickets. |

The code must describe responsibility labels as client-side classifications. It must not present the 555 cause or WAF cause as a proven server fact.

## Compatibility

The existing Fire, Burst, and JSON buttons remain available. The JSON button exports Log V2 when the IndexedDB store is available.

Log V1 files remain readable as standalone historical evidence. This phase does not import or rewrite them.

The export filename uses `qianggou-fire-log-v2-<sessionId>.json` so later analysis can route by schema without inspecting every entry.

## Testing strategy

### Scheduler tests

Use fake timers and real scheduler code to verify:

- exact absolute slots;
- no random jitter;
- a single scheduling chain;
- minimum start-to-start gaps;
- a Burst concurrency limit of two;
- delayed slots and queue-delay reporting;
- cancellation before and after `fetch-started`.

### Runner tests

Verify:

- the run lock precedes ticket reservation;
- duplicate commands do not change the ticket pool;
- success returns every unused ticket;
- network exceptions do not stop the chain;
- WAF stops the run without retrying;
- 555 responses do not mutate the active plan.

### Transport tests

Verify:

- all six transport timestamps are present and ordered;
- HTTP status and response headers survive the postMessage bridge;
- timeout sends DO_FETCH_CANCEL;
- cancellation aborts the matching MAIN-world request;
- late responses cannot settle a cancelled request twice.

### Persistence and export tests

Use a test IndexedDB implementation to verify:

- records survive store reinitialization;
- export joins sessions, runs, events, and shots correctly;
- memory fallback does not lose records;
- credential headers are omitted;
- request bodies and response bodies remain complete;
- runtime extension version replaces the hardcoded value.

### Existing quality baseline

Before completion, repair the current stale test expectations and harness setup. Add a valid TypeScript environment for Chrome extension globals. Verification must run:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

All three commands must exit with code `0`.

## Acceptance criteria

The first phase is complete only when:

- one trigger creates at most one active run;
- Auto and Manual never exceed their configured minimum start gap;
- Burst never exceeds two simultaneous fetches;
- every shot has a `plannedAt` and either a `fetchCalledAt` or a terminal unsent reason;
- every consumed ticket maps to exactly one `fetchCalledAt`;
- cancellation leaves no orphaned reserved tickets;
- no calibration probe starts inside the five-minute quiet window;
- a browser restart does not delete saved Log V2 records;
- manual export produces schema version 2 without reusable credentials;
- tests, type checking, and the production build pass.

## Next step

After written approval, create the implementation plan in `docs/superpowers/plans/`. Execute the plan in an isolated worktree with test-first changes and verification checkpoints.
