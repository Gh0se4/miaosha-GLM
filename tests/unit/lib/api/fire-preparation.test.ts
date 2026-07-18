import { describe, expect, it } from 'vitest';

import { createFirePreparationCancellation, runAfterFirePreparation } from '../../../../lib/api/fire-preparation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('fire preparation cancellation', () => {
  it('does not create a runner or reserve tickets when cancelled during deferred preflight, and a later run proceeds', async () => {
    const preflight = deferred<{ ticket: string }>();
    const firstCancellation = createFirePreparationCancellation();
    let runners = 0;
    let fetches = 0;
    let ticketsReserved = 0;

    const firstRun = runAfterFirePreparation({
      cancellation: firstCancellation,
      preflight: () => preflight.promise,
      onReady: async () => {
        runners += 1;
        ticketsReserved += 1;
        fetches += 1;
      },
    });

    firstCancellation.cancel();
    preflight.resolve({ ticket: 'ticket-1' });

    await expect(firstRun).resolves.toBe('cancelled');
    expect({ runners, fetches, ticketsReserved }).toEqual({ runners: 0, fetches: 0, ticketsReserved: 0 });

    const secondCancellation = createFirePreparationCancellation();
    await expect(runAfterFirePreparation({
      cancellation: secondCancellation,
      preflight: async () => ({ ticket: 'ticket-2' }),
      onReady: async () => { runners += 1; },
    })).resolves.toBe('ready');
    expect(runners).toBe(1);
  });
});
