import { describe, expect, it } from 'vitest';

import { buildFireSchedule } from '../../../../lib/api/fire-scheduler';

describe('buildFireSchedule', () => {
  it('computes deterministic absolute slots', () => {
    const plan = buildFireSchedule({
      runId: 'run-1',
      mode: 'auto',
      startMs: 1_000,
      intervalMs: 3_200,
      shots: [
        { shotId: 's1', productId: 'p1', productPriority: 10 },
        { shotId: 's2', productId: 'p2', productPriority: 20 },
      ],
    });

    expect(plan.slots).toHaveLength(2);
    expect(plan.slots[0].plannedAt).toBe(1000);
    expect(plan.slots[1].plannedAt).toBe(4200);
  });

  it('returns empty slots for empty shots', () => {
    const plan = buildFireSchedule({
      runId: 'run-2',
      mode: 'manual',
      startMs: 1_000,
      intervalMs: 1_000,
      shots: [],
    });

    expect(plan.slots).toEqual([]);
  });

  it('clips negative interval to positive integer minimum', () => {
    const plan = buildFireSchedule({
      runId: 'run-3',
      mode: 'burst',
      startMs: 1_000,
      intervalMs: -500,
      shots: [
        { shotId: 's1', productId: 'p1', productPriority: 1 },
        { shotId: 's2', productId: 'p2', productPriority: 2 },
      ],
    });

    expect(plan.intervalMs).toBe(1);
    expect(plan.slots[1].plannedAt).toBe(1001);
  });

  it('is reproducible across repeated calls', () => {
    const args = {
      runId: 'run-4',
      mode: 'manual' as const,
      startMs: 9_873,
      intervalMs: 2_345.9,
      shots: [
        { shotId: 's1', productId: 'p1', productPriority: 10 },
        { shotId: 's2', productId: 'p2', productPriority: 20 },
        { shotId: 's3', productId: 'p3', productPriority: 30 },
      ],
    };

    const first = buildFireSchedule(args);
    const second = buildFireSchedule(args);

    expect(second).toEqual(first);
  });

  it('does not introduce random jitter', () => {
    const baseArgs = {
      runId: 'run-5',
      mode: 'auto' as const,
      startMs: 2_000,
      intervalMs: 777,
      shots: Array.from({ length: 120 }, (_, index) => ({
        shotId: `s-${index}`,
        productId: `p-${index}`,
        productPriority: index,
      })),
    };

    const first = buildFireSchedule(baseArgs);
    const second = buildFireSchedule(baseArgs);

    expect(first.slots.map((slot) => slot.plannedAt)).toEqual(
      second.slots.map((slot) => slot.plannedAt),
    );
  });
});
