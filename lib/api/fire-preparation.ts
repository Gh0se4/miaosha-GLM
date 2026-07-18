export interface FirePreparationCancellation {
  readonly cancelled: boolean;
  cancel(): void;
}

export function createFirePreparationCancellation(): FirePreparationCancellation {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
    },
  };
}

export async function runAfterFirePreparation<T>(input: {
  cancellation: FirePreparationCancellation;
  preflight: () => Promise<T>;
  onReady(value: T): Promise<void> | void;
}): Promise<'cancelled' | 'ready'> {
  const value = await input.preflight();
  if (input.cancellation.cancelled) return 'cancelled';
  await input.onReady(value);
  return 'ready';
}
