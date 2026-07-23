# Automatic ticket window

## Confirmed timing

- T−30 minutes: reload once for the target sale, then recover product data.
- T−4 minutes 58 seconds: start ticket acquisition.
- T−10 seconds: stop ticket acquisition.

## Final implementation decisions

- Persist `_autoToggle` at `_NS + 'auto-ticket-enabled'` in page `sessionStorage`. Missing or unreadable state defaults to `false`; a same-tab T−30 reload restores an enabled toggle under the reused namespace.
- Batch mode records an owner of `manual` or `auto-ticket`. START is idempotent when a batch is already active. An auto-ticket STOP can stop only an auto-owned batch and must leave a manual batch running.

## Implementation

1. Persist one refresh marker per target sale in page `sessionStorage` under
   the `_NS`-prefixed key `${_NS}auto-refresh-${targetMs}`. A same-tab reload
   reuses the namespace and marker, so it does not schedule another reload.
   Verify the marker after writing it; if persistence fails, log the failure
   and do not reload.
2. Persist the OCR auto preference in extension storage as
   `local:ocrAutoEnabled` through `safeGet` and `safeSet`, not through page
   `localStorage` or `sessionStorage`. Default it to enabled, send one
   `OCR_CHECK` on startup, and render an explicit healthy/unavailable state.
3. Add content-side ticket-window timers which request captcha acquisition only
   while the window is open, stop them at T−10, and log all transitions through
   `AUTO_TICKET_DIAGNOSTIC`.
4. Preserve ticket TTL safety: reject stale tickets rather than extending their
   lifetime; emit diagnostics for start/stop and refresh decisions.
5. Test scheduling boundaries, one-shot refresh guard, OCR status, and ticket
   window stop behavior; then verify full test/type/build gates.

## Structured diagnostics

Every `AUTO_TICKET_DIAGNOSTIC` payload has this shape:

```ts
{
  type: 'refresh_scheduled' | 'refresh_triggered' | 'refresh_skipped' | 'window_started' | 'window_stopped';
  nextSaleTime: number;
  timestamp: number;
  reason: string;
  details: Record<string, unknown>;
}
```

Refresh diagnostics use `timer_scheduled`, `timer_elapsed`,
`already_refreshed`, `window_elapsed`, or `marker_persist_failed` as the
reason. Window diagnostics use `window_opened`, `window_elapsed`,
`auto_disabled`, or `sale_rescheduled`; their details include the applicable
`startAt`, `stopAt`, `refreshAt`, `delayMs`, or `rescheduledTo` timestamps.

## Timing calibration

Keep HTTP `Date` clock offset observable and continue using the full measured
RTT for the current auto schedule and its log fields. Do not replace full RTT
with a one-way estimate in this implementation. Such a change requires
independent validation with real transport samples and explicit approval.
