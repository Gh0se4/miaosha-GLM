export type TicketState =
  | 'available'
  | 'reserved'
  | 'released'
  | 'fetch-started'
  | 'settled'
  | 'returned';

export interface FireShotState {
  shotId: string;
  productId: string;
  requestSeq: number;
  ticketKey: string;
  state: TicketState;
  fetchStartedAt?: number;
  plannedAt: number;
  scheduledAt?: number;
  releasedAt?: number;
}

export interface FireRunInput {
  runId: string;
  mode: 'manual' | 'burst' | 'auto';
  startMs: number;
  intervalMs: number;
  maxInFlight: number;
  slots: Array<{
    shotId: string;
    productId: string;
    productPriority: number;
    requestSeq: number;
    plannedAt: number;
  }>;
  onEvent(evt: { type: string; payload: Record<string, unknown> }): void;
  executeShot(ctx: {
    shotId: string;
    productId: string;
    requestSeq: number;
    requestId: string;
    onFetchStarted(meta?: { fetchStartedAt?: number; [key: string]: unknown }): void;
    setAbort(abort: () => void): void;
  }): Promise<{
    outcome: 'success' | 'busy' | 'soldout' | 'error' | 'neterr' | 'waf' | 'cancelled' | 'expired';
  }>;
  onStateChange?(snapshot: FireShotState[]): void;
}

export interface FireRunnerDependencies {
  now?: () => number;
  waitUntil?: (targetMs: number) => Promise<void>;
}

export interface FireRunResult {
  accepted: boolean;
  reason?: 'run_locked' | 'success' | 'waf' | 'cancelled' | 'complete';
}

let activeRunLock = false;

function toRunScopedShotId(runId: string, shotId: string): string {
  const runPrefix = `${runId}:`;
  return shotId.startsWith(runPrefix) ? shotId : `${runPrefix}${shotId}`;
}

function toRequestId(runId: string, shotId: string, requestSeq: number): string {
  return `${toRunScopedShotId(runId, shotId)}:${requestSeq}`;
}

export class FireRunner {
  private readonly now: () => number;
  private readonly waitUntil: (targetMs: number) => Promise<void>;
  private readonly shots: FireShotState[];
  private timer?: ReturnType<typeof setTimeout>;
  private cancelled = false;
  private cancelWake?: () => void;
  private readonly cancelSignal: Promise<void>;
  private readonly aborts = new Map<string, () => void>();

  constructor(
    private readonly input: FireRunInput,
    dependencies: FireRunnerDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.waitUntil = dependencies.waitUntil ?? ((targetMs) => this.defaultWaitUntil(targetMs));
    const ticketKeys = new Set<string>();
    const requestSeqs = new Set<number>();
    const requestIds = new Set<string>();
    this.shots = input.slots.map((slot) => {
      const ticketKey = toRunScopedShotId(input.runId, slot.shotId);
      const requestId = toRequestId(input.runId, slot.shotId, slot.requestSeq);
      if (requestIds.has(requestId)) throw new Error(`duplicate requestId "${requestId}"`);
      if (ticketKeys.has(ticketKey)) throw new Error(`colliding ticketKey "${ticketKey}"`);
      if (requestSeqs.has(slot.requestSeq)) throw new Error(`duplicate requestSeq ${slot.requestSeq}`);
      requestIds.add(requestId);
      ticketKeys.add(ticketKey);
      requestSeqs.add(slot.requestSeq);
      return {
        shotId: slot.shotId,
        productId: slot.productId,
        requestSeq: slot.requestSeq,
        ticketKey,
        state: 'available' as const,
        plannedAt: slot.plannedAt,
      };
    });
    this.cancelSignal = new Promise((resolve) => {
      this.cancelWake = resolve;
    });
  }

  snapshot(): FireShotState[] {
    return this.shots.map((shot) => ({ ...shot }));
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const abort of this.aborts.values()) {
      try {
        abort();
      } catch {
        // Cancellation must still return tickets when a transport abort observer fails.
      }
    }
    this.cancelWake?.();
  }

  async run(): Promise<FireRunResult> {
    if (activeRunLock) {
      this.event('run_rejected', { runId: this.input.runId, reason: 'run_locked' });
      return { accepted: false, reason: 'run_locked' };
    }

    activeRunLock = true;
    let stopReason: Exclude<FireRunResult['reason'], 'run_locked'> = 'complete';
    const inFlight = new Set<Promise<void>>();
    let lastFetchStartedAt = Number.NEGATIVE_INFINITY;

    try {
      this.transitionAll('available', 'reserved');
      this.event('tickets_reserved', { runId: this.input.runId, count: this.shots.length });

      while (true) {
        if (this.cancelled) {
          if (stopReason === 'complete') stopReason = 'cancelled';
          break;
        }
        if (stopReason !== 'complete') break;

        let launched = false;
        const configuredMaxInFlight = Math.max(1, Math.floor(this.input.maxInFlight));
        const maxInFlight = this.input.mode === 'burst'
          ? Math.min(2, configuredMaxInFlight)
          : 1;
        while (!this.cancelled && inFlight.size < maxInFlight) {
          const next = this.shots.find((shot) => shot.state === 'reserved');
          if (!next) break;

          const earliestAt = this.input.mode === 'burst'
            ? next.plannedAt
            : Math.max(next.plannedAt, lastFetchStartedAt + Math.max(0, this.input.intervalMs));
          if (this.now() < earliestAt) {
            let slotReady = false;
            const slotReadySignal = this.waitUntil(earliestAt).then(() => { slotReady = true; });
            while (!slotReady && !this.cancelled && stopReason === 'complete') {
              await Promise.race([slotReadySignal, this.cancelSignal, ...inFlight]);
            }
            if (this.cancelled || stopReason !== 'complete') break;
          }

          this.release(next);
          if (this.cancelled) break;
          const work = this.execute(next)
            .then(({ outcome, fetchStartedAt }) => {
              if (fetchStartedAt !== undefined) lastFetchStartedAt = fetchStartedAt;
              if (stopReason !== 'complete') return;
              if (this.cancelled) {
                stopReason = 'cancelled';
                return;
              }
              if (outcome === 'success' || outcome === 'waf') {
                stopReason = outcome;
              } else if (outcome === 'cancelled') {
                stopReason = 'cancelled';
              }
            })
            .finally(() => inFlight.delete(work));
          inFlight.add(work);
          launched = true;

          if (this.input.mode !== 'burst') break;
        }

        if (stopReason !== 'complete') break;
        if (inFlight.size === 0) {
          if (this.shots.some((shot) => shot.state === 'reserved')) continue;
          break;
        }
        if (!launched || inFlight.size >= maxInFlight) {
          await Promise.race([...inFlight, this.cancelSignal]);
        }
      }

      if (this.cancelled && stopReason === 'complete') stopReason = 'cancelled';
      await Promise.all([...inFlight]);
      this.returnUnstarted(stopReason);
      this.event('run_finished', { runId: this.input.runId, reason: stopReason });
      return { accepted: true, reason: stopReason };
    } finally {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      activeRunLock = false;
    }
  }

  private async execute(shot: FireShotState): Promise<{
    outcome: 'success' | 'busy' | 'soldout' | 'error' | 'neterr' | 'waf' | 'cancelled' | 'expired';
    fetchStartedAt?: number;
  }> {
    const requestId = toRequestId(this.input.runId, shot.shotId, shot.requestSeq);
    let fetchStartedAt: number | undefined;
    const onFetchStarted = (meta: { fetchStartedAt?: number; [key: string]: unknown } = {}) => {
      if (shot.state !== 'released') return;
      fetchStartedAt = meta.fetchStartedAt ?? this.now();
      shot.fetchStartedAt = fetchStartedAt;
      this.transition(shot, 'fetch-started');
      this.event('fetch_started', {
        runId: this.input.runId,
        shotId: shot.shotId,
        requestSeq: shot.requestSeq,
        requestId,
        fetchStartedAt,
        plannedAt: shot.plannedAt,
        ...meta,
      });
    };
    try {
      const result = await this.input.executeShot({
        shotId: shot.shotId,
        productId: shot.productId,
        requestSeq: shot.requestSeq,
        requestId,
        onFetchStarted,
        setAbort: (abort) => {
          if (typeof abort !== 'function') return;
          if (this.cancelled) {
            try {
              abort();
            } catch {
              // Cancellation must still settle when a late transport abort observer fails.
            }
            return;
          }
          this.aborts.set(requestId, abort);
        },
      });
      if (shot.state === 'fetch-started') this.transition(shot, 'settled');
      if (shot.state === 'released' && result.outcome === 'expired') this.transition(shot, 'settled');
      return { outcome: result.outcome, fetchStartedAt };
    } catch {
      if (shot.state === 'fetch-started') this.transition(shot, 'settled');
      return { outcome: 'neterr', fetchStartedAt };
    } finally {
      this.aborts.delete(requestId);
    }
  }

  private release(shot: FireShotState): void {
    shot.scheduledAt = this.now();
    shot.releasedAt = shot.scheduledAt;
    this.transition(shot, 'released');
    this.event('shot_released', {
      runId: this.input.runId,
      shotId: shot.shotId,
      requestSeq: shot.requestSeq,
      plannedAt: shot.plannedAt,
      scheduledAt: shot.scheduledAt,
      releasedAt: shot.releasedAt,
    });
  }

  private returnUnstarted(reason: Exclude<FireRunResult['reason'], 'run_locked'>): void {
    const returned = this.shots.filter((shot) => shot.state === 'reserved' || shot.state === 'released');
    for (const shot of returned) this.transition(shot, 'returned');
    if (returned.length > 0) {
      this.event('tickets_returned', {
        runId: this.input.runId,
        count: returned.length,
        shotIds: returned.map((shot) => shot.shotId),
        shots: returned.map((shot) => ({
          shotId: shot.shotId,
          requestSeq: shot.requestSeq,
          plannedAt: shot.plannedAt,
          terminalUnsentReason: reason === 'complete' ? 'rejected' : reason,
        })),
      });
    }
  }

  private transitionAll(from: TicketState, to: TicketState): void {
    for (const shot of this.shots) {
      if (shot.state === from) shot.state = to;
    }
    this.stateChanged();
  }

  private transition(shot: FireShotState, to: TicketState): void {
    shot.state = to;
    this.stateChanged();
  }

  private stateChanged(): void {
    try {
      this.input.onStateChange?.(this.snapshot());
    } catch {
      // Observers must not affect the fire lifecycle.
    }
  }

  private event(type: string, payload: Record<string, unknown>): void {
    try {
      this.input.onEvent({ type, payload });
    } catch {
      // Observers must not affect the fire lifecycle.
    }
  }

  private defaultWaitUntil(targetMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        resolve();
      }, Math.max(0, targetMs - this.now()));
    });
  }
}
