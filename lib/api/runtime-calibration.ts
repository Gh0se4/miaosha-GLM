import { xhrRequest } from '../platform/adapters/bigmodel/request';

const TARGET = 'https://bigmodel.cn/api/biz/pay/batch-preview';
const PROBE_COUNT = 8;
const PROBE_INTERVAL_MS = 1500;
const BEST_RATIO = 0.6;

interface ProbeResult {
  rttMs: number;
  serverTimeMs: number;   // Unix epoch from HTTP Date header
  localSendMs: number;    // Date.now() at send
  localRecvMs: number;    // Date.now() at recv
}

export interface CalibrationResult {
  rttCompensationMs: number; // median RTT retained for scheduler compensation
  clockOffsetMs: number;  // serverTime - localTime
  probes: ProbeResult[];
}

export interface CalibrationEvent {
  type: 'calibration_probe_started' | 'calibration_probe_finished' | 'calibration_quiet_window_entered';
  details?: Record<string, unknown>;
}

export interface CalibrationOptions {
  /** Checked before every probe so callers can enforce the T-5 quiet window. */
  shouldContinue?: () => boolean | Promise<boolean>;
  onEvent?: (event: CalibrationEvent) => void;
}

async function probeOnce(auth: {
  authorization: string;
  bigmodelOrganization: string;
  bigmodelProject: string;
}): Promise<ProbeResult> {
  // performance.now() for accurate RTT, Date.now() for clock offset (same base as server Date header)
  const perfSend = performance.now();
  const dateSend = Date.now();

  const res = await xhrRequest<unknown>({
    method: 'POST',
    url: TARGET,
    withCredentials: true,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=utf-8',
      Authorization: auth.authorization,
      'Bigmodel-Organization': auth.bigmodelOrganization,
      'Bigmodel-Project': auth.bigmodelProject,
    },
    body: JSON.stringify({ invitationCode: '' }),
  });

  // Consume response to ensure full round-trip
  const dateRecv = Date.now();
  const perfRecv = performance.now();

  const rttMs = perfRecv - perfSend;
  const serverTimeStr = res.headers['date'];
  const serverTimeMs = serverTimeStr ? new Date(serverTimeStr).getTime() : 0;

  return { rttMs, serverTimeMs, localSendMs: dateSend, localRecvMs: dateRecv };
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function calibrate(
  auth: {
    authorization: string;
    bigmodelOrganization: string;
    bigmodelProject: string;
  },
  onProgress?: (done: number, total: number) => void,
  options: CalibrationOptions = {},
): Promise<CalibrationResult> {
  const probes: ProbeResult[] = [];

  for (let i = 0; i < PROBE_COUNT; i++) {
    const shouldContinue = await options.shouldContinue?.();
    if (shouldContinue === false) {
      options.onEvent?.({
        type: 'calibration_quiet_window_entered',
        details: { probeIndex: i, total: PROBE_COUNT },
      });
      break;
    }

    let success = false;
    options.onEvent?.({
      type: 'calibration_probe_started',
      details: { probeIndex: i, total: PROBE_COUNT },
    });
    try {
      const result = await probeOnce(auth);
      probes.push(result);
      success = true;
    } catch {
      // Skip failed probes
    } finally {
      options.onEvent?.({
        type: 'calibration_probe_finished',
        details: { probeIndex: i, total: PROBE_COUNT, success },
      });
    }
    onProgress?.(i + 1, PROBE_COUNT);
    if (i < PROBE_COUNT - 1) {
      await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
    }
  }

  if (probes.length === 0) {
    return { rttCompensationMs: 0, clockOffsetMs: 0, probes: [] };
  }

  // Take best 60% by lowest RTT (NTP-style filtering)
  const sorted = [...probes].sort((a, b) => a.rttMs - b.rttMs);
  const keep = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * BEST_RATIO)));

  const latencies = keep.map(p => p.rttMs);
  const rttCompensationMs = Math.round(median(latencies));

  // Clock offset = serverTime - localTime, estimated at the round-trip midpoint.
  //
  // Two corrections vs. the naive estimate:
  //  1. The HTTP `Date` header has whole-second resolution, so serverTimeMs is
  //     floored and under-reads the true server time by a uniform 0–1000ms
  //     (~500ms mean). Left uncorrected this biases the offset low, which makes
  //     the auto-fire scheduler fire late. Add the mean floor error back.
  //  2. Use the symmetric single-timestamp estimate `serverTime - localMid`.
  //     localMidMs already sits at the round-trip midpoint, so adding another
  //     rtt/2 (as an earlier version did) double-counts the network path and
  //     biases the offset high.
  //
  // Residual sub-second uncertainty remains (the true floor fraction varies per
  // probe); the median across probes plus the scheduler's safety margin absorb
  // it. NOTE: this changes effective fire timing — re-validate any hand-tuned
  // scheduler margins against real sale-time measurements.
  const DATE_HEADER_FLOOR_BIAS_MS = 500;
  const offsets = keep
    .filter(p => p.serverTimeMs > 0)
    .map(p => {
      const localMidMs = (p.localSendMs + p.localRecvMs) / 2;
      return (p.serverTimeMs + DATE_HEADER_FLOOR_BIAS_MS) - localMidMs;
    });

  const clockOffsetMs = offsets.length > 0
    ? Math.round(median(offsets))
    : 0;

  return { rttCompensationMs, clockOffsetMs, probes: keep };
}
