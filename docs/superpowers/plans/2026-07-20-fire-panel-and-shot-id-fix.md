# Fire panel and log identity fixes

## Scope

Implement the approved small follow-up changes while preserving the existing
fire scheduling policy:

1. Make every shot identifier globally unique within a downloaded log by
   creating it once as `${runId}:shot-${index}`. Reuse that canonical value
   across scheduling, lifecycle state, request metadata, and log records; no
   downstream layer may prefix the run identifier again.
2. Open Fire Matrix when the page script loads with an `Idle` badge, without
   creating a fake wave. Change the badge to `Wave 1` only after the first real
   `FIRE_BATCH_START` event.
3. Add a manual stop action to Fire Matrix and rename the comprehensive log
   download action to `完整日志json`.

## Steps

1. Add a regression test that runs two manual fire batches through the content
   harness and verifies their exported shot records use distinct canonical IDs
   in the exact `${runId}:shot-${index}` format.
2. Change schedule, lifecycle bookkeeping, and request metadata to use the
   same run-scoped shot ID. Scope it exactly once and reject accidental
   `${runId}:${runId}:shot-${index}` values in regression coverage.
3. Add Fire Matrix UI tests for the initial `Idle` badge, the first real
   `FIRE_BATCH_START` transition to `Wave 1`, the stop command, and the new
   download label.
4. Implement the panel behavior, then run focused tests, the full test suite,
   typecheck, and production build.
