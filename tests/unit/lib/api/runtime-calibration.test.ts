import { afterEach, describe, expect, it, vi } from 'vitest';

const { xhrRequest } = vi.hoisted(() => ({ xhrRequest: vi.fn() }));

vi.mock('../../../../lib/platform/adapters/bigmodel/request', () => ({ xhrRequest }));

import { calibrate } from '../../../../lib/api/runtime-calibration';

const auth = {
  authorization: 'token',
  bigmodelOrganization: 'org',
  bigmodelProject: 'project',
};

async function advanceToNextProbe() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1_500);
}

describe('calibrate', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    xhrRequest.mockReset();
  });

  it('does not start a probe when the quiet window has already begun', async () => {
    const events: string[] = [];

    const result = await calibrate(auth, undefined, {
      shouldContinue: () => false,
      onEvent: (event) => events.push(event.type),
    });

    expect(xhrRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rttCompensationMs: 0, clockOffsetMs: 0, probes: [] });
    expect(events).toEqual(['calibration_quiet_window_entered']);
  });

  it('awaits an async quiet-window guard before deciding not to probe', async () => {
    const events: string[] = [];

    const result = await calibrate(auth, undefined, {
      shouldContinue: async () => false,
      onEvent: (event) => events.push(event.type),
    });

    expect(xhrRequest).not.toHaveBeenCalled();
    expect(result.probes).toEqual([]);
    expect(events).toEqual(['calibration_quiet_window_entered']);
  });

  it('stops before the next probe when the quiet window begins during calibration', async () => {
    vi.useFakeTimers();
    xhrRequest.mockResolvedValue({ headers: {} });
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const events: string[] = [];

    const calibration = calibrate(auth, undefined, {
      shouldContinue,
      onEvent: (event) => events.push(event.type),
    });
    await advanceToNextProbe();
    const result = await calibration;

    expect(xhrRequest).toHaveBeenCalledTimes(1);
    expect(shouldContinue).toHaveBeenCalledTimes(2);
    expect(result.probes).toHaveLength(1);
    expect(events).toEqual([
      'calibration_probe_started',
      'calibration_probe_finished',
      'calibration_quiet_window_entered',
    ]);
  });

  it('returns successful RTT samples as rttCompensationMs', async () => {
    vi.useFakeTimers();
    xhrRequest.mockResolvedValue({ headers: {} });
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(42);

    const calibration = calibrate(auth, undefined, { shouldContinue });
    await advanceToNextProbe();
    const result = await calibration;

    expect(now).toHaveBeenCalledTimes(2);
    expect(result.rttCompensationMs).toBe(32);
    expect(result.probes).toHaveLength(1);
    expect(result).not.toHaveProperty('latencyMs');
  });

  it('emits probe lifecycle events in order', async () => {
    vi.useFakeTimers();
    xhrRequest.mockRejectedValue(new Error('network'));
    const events: Array<{ type: string; details?: Record<string, unknown> }> = [];
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    const calibration = calibrate(auth, undefined, {
      shouldContinue,
      onEvent: (event) => events.push(event),
    });
    await advanceToNextProbe();
    await calibration;

    expect(events.map(({ type }) => type)).toEqual([
      'calibration_probe_started',
      'calibration_probe_finished',
      'calibration_quiet_window_entered',
    ]);
    expect(events[1]?.details).toMatchObject({ probeIndex: 0, total: 8, success: false });
  });

  it('centers clock offset with the Date-header floor correction (no rtt/2 double-count)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T02:00:00.500Z'));
    // Server clock == local clock (true offset 0); the Date header floors to the second.
    xhrRequest.mockResolvedValue({ headers: { date: 'Sat, 31 May 2026 02:00:00 GMT' } });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(20); // rtt = 20ms
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    const calibration = calibrate(auth, undefined, { shouldContinue });
    await advanceToNextProbe();
    const result = await calibration;

    // (floored 02:00:00.000 + 500ms floor-bias) - local mid 02:00:00.500 = 0.
    // If the old `+ rtt/2` term were still present this would be ~10, not 0.
    expect(result.clockOffsetMs).toBe(0);
  });

  it('reports a positive offset when the server clock leads the local clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T02:00:00.500Z'));
    // Server ~1s ahead: it stamps the next whole second.
    xhrRequest.mockResolvedValue({ headers: { date: 'Sat, 31 May 2026 02:00:01 GMT' } });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(20);
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    const calibration = calibrate(auth, undefined, { shouldContinue });
    await advanceToNextProbe();
    const result = await calibration;

    // (02:00:01.000 + 500) - 02:00:00.500 = 1000.
    expect(result.clockOffsetMs).toBe(1000);
  });
});
