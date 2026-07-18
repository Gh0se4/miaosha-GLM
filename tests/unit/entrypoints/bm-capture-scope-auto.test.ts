import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const AUTO_SOURCE = path.resolve(__dirname, '../../../src/bm-main/07-auto-fire.js');
const CONTENT_SOURCE = path.resolve(__dirname, '../../../entrypoints/bm-capture.content.ts');

function source(pathname: string) {
  return fs.readFileSync(pathname, 'utf-8');
}

describe('auto fire prepare-run lifecycle', () => {
  it('dispatches an explicit prepare payload without a hidden -500ms offset', () => {
    const auto = source(AUTO_SOURCE);

    expect(auto).toContain("type: 'PREFIRE_PREPARE'");
    expect(auto).toContain('preparationLeadMs: 3000');
    expect(auto).toContain('earlyOffsetMs: 3000');
    expect(auto).toContain('startMs: _rt.nextSaleTime - _rt.latencyMs - 3000 - _rt.clockOffsetMs');
    expect(auto).not.toContain('PREFIRE_FIRE');
    expect(auto).not.toMatch(/startMs\s*-\s*500/);
  });

  it('routes prepare, manual, and burst requests through the one FireRunner lifecycle', () => {
    const content = source(CONTENT_SOURCE);

    expect(content).toContain("from '../lib/api/fire-scheduler'");
    expect(content).toContain("from '../lib/api/fire-runner'");
    expect(content).toContain('async function prepareAndRun(');
    expect(content).toContain("event.data.type === 'PREFIRE_PREPARE'");
    expect(content).toContain('runId: `auto-${event.data.data?.targetMs}-${Date.now()}`');
    expect(content).toContain('new FireRunner(');
    expect(content).toContain('maxInFlight: options.mode === \'burst\' ? 2 : 1');
  });

  it('keeps configured manual interval and pins burst to 500ms', () => {
    const content = source(CONTENT_SOURCE);

    expect(content).toContain("const intervalMs = options.mode === 'burst' ? 500 : burstIntervalMs");
    expect(content).toContain("burstIntervalMs: mode === 'burst' ? 500 : undefined");
  });
});
