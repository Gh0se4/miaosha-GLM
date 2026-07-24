export type FireMode = 'manual' | 'burst' | 'auto';

export interface FireShotSlot {
  shotId: string;
  productId: string;
  productPriority: number;
  requestSeq: number;
  plannedAt: number;
}

export interface FireScheduleInput {
  runId: string;
  mode: FireMode;
  startMs: number;
  intervalMs: number;
  shots: Array<{
    shotId: string;
    productId: string;
    productPriority: number;
  }>;
}

export interface FireSchedulePlan {
  runId: string;
  mode: FireMode;
  startMs: number;
  intervalMs: number;
  slots: FireShotSlot[];
}

export function buildFireSchedule(input: FireScheduleInput): FireSchedulePlan {
  const startMs = Math.max(0, Math.round(input.startMs));
  const intervalMs = Math.max(1, Math.round(input.intervalMs));

  return {
    runId: input.runId,
    mode: input.mode,
    startMs,
    intervalMs,
    slots: input.shots.map((shot, index) => ({
      shotId: shot.shotId,
      productId: shot.productId,
      productPriority: shot.productPriority,
      requestSeq: index,
      plannedAt: startMs + index * intervalMs,
    })),
  };
}
