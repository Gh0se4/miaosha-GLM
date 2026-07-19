import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vm from 'vm';
import { IDBFactory } from 'fake-indexeddb';

const SOURCE_PATH = path.resolve(__dirname, '../../../entrypoints/bm-capture.content.ts');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createMainLogExportHarness() {
  const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
  const window: Record<string, unknown> = {
    addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
    postMessage: () => undefined,
  };
  const scope = vm.createContext({
    window,
    _NS: 'content-export-',
    MSG_OVL: '__overlay',
    indexedDB: new IDBFactory(),
    document: { visibilityState: 'visible', addEventListener: () => undefined },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    navigator: { userAgent: 'test-agent' },
    location: { href: 'https://example.test/glm-coding' },
    Intl,
    Date,
    Math,
    Promise,
    performance: { now: () => 1 },
    setTimeout: () => 0,
    postToOverlay: () => undefined,
  });
  for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
  }

  return {
    ingest(messages: Array<Record<string, unknown>>) {
      for (const message of messages) {
        if (!['FIRE_LOG_V2_RUN', 'FIRE_LOG_V2_EVENT', 'FIRE_SHOT_RESULT'].includes(String(message.type))) continue;
        for (const listener of listeners) {
          listener({ data: { __overlay: true, ...message } });
        }
      }
    },
    async exportLog() {
      await Promise.resolve();
      await Promise.resolve();
      return (window.__fireLogV2Store as { exportLog(sessionId: string): Promise<Record<string, unknown>> }).exportLog('');
    },
  };
}

function createContentHarness(options: {
  capture?: Promise<any>;
  paymentStateFails?: boolean;
  orderResult?: any;
  nextSaleTime?: number;
  runtimeCalibration?: any;
  shots?: Array<Record<string, unknown>>;
  orderResults?: any[];
  burstIntervalMs?: number;
  returnedTicketCounts?: number[];
  now?: () => number;
  onPreparationReady?: () => void;
} = {}) {
  const listeners: Array<(event: any) => unknown> = [];
  const posted: any[] = [];
  const runnerEvents: string[] = [];
  let pollCalls = 0;
  let runnerCount = 0;
  let calibrationCalls = 0;
  let orderResultIndex = 0;
  let nextSaleTime = options.nextSaleTime ?? Date.now() + 60 * 60 * 1000;
  const auth = {
    platform: 'bigmodel',
    capturedAt: Date.now(),
    headers: {
      authorization: 'token',
      'bigmodel-organization': 'org',
      'bigmodel-project': 'project',
    },
    metadata: { source: 'live-page' },
  };
  const storage = {
    getItem: async (key: string) => {
      if (key === 'local:paymentState' && options.paymentStateFails) {
        throw new Error('payment storage unavailable');
      }
      if (key === 'local:selectedProducts') {
        return { priorityList: [{ productId: 'product-1' }] };
      }
      if (key === 'local:runtimeCalibration') return options.runtimeCalibration ?? null;
      return null;
    },
    setItem: async () => undefined,
  };
  let contentScript: any;
  const window = {
    sessionStorage: { getItem: () => 'test' },
    addEventListener: (type: string, listener: (event: any) => unknown) => {
      if (type === 'message') listeners.push(listener);
    },
    removeEventListener: () => undefined,
    postMessage: (message: any) => {
      posted.push(message);
      if (message.type === 'PAYMENT_STATE' && options.paymentStateFails) {
        throw new Error('payment state delivery unavailable');
      }
      if (message.type === 'READ_TICKET_STORE') {
        queueMicrotask(() => {
          for (const listener of listeners) {
            void listener({
              source: window,
              data: {
                teste: true,
                type: 'TICKET_STORE_DATA',
                reqId: message.reqId,
                list: (options.shots ?? [{ ticket: 'ticket-1', randstr: 'rand-1', createdAt: Date.now(), productId: 'product-1', priority: 1 }]).map((shot) => ({
                  ticket: shot.ticket,
                  randstr: shot.randstr,
                  createdAt: shot.createdAt,
                })),
              },
            });
          }
        });
      }
    },
  };
  const require = (id: string) => {
    if (id === '#imports') return {
      storage,
      defineContentScript: (config: any) => {
        contentScript = config;
        return config;
      },
    };
    if (id.includes('fire-preparation')) return {
      createFirePreparationCancellation: () => {
        let cancelled = false;
        return { get cancelled() { return cancelled; }, cancel: () => { cancelled = true; } };
      },
      runAfterFirePreparation: async ({ cancellation, preflight, onReady }: any) => {
        const value = await preflight();
        if (cancellation.cancelled) return 'cancelled';
        options.onPreparationReady?.();
        await onReady(value);
        return 'ready';
      },
    };
    if (id.includes('payment-status-notifier')) return { reportPaymentStatus: () => undefined };
    if (id.includes('fire-runner')) return {
      FireRunner: class {
        input: any;
        constructor(input: any) { this.input = input; runnerCount++; }
        cancel() {}
        async run() {
          this.input.onEvent({ type: 'tickets_reserved', payload: {} });
          runnerEvents.push('tickets_reserved');
          let outcome = 'complete';
          for (const slot of this.input.slots) {
            this.input.onEvent({ type: 'shot_released', payload: { runId: this.input.runId, shotId: slot.shotId, requestSeq: slot.requestSeq, plannedAt: slot.plannedAt, scheduledAt: 123, releasedAt: 123 } });
            const result = await this.input.executeShot({
              shotId: slot.shotId,
              requestSeq: slot.requestSeq,
              requestId: `request-${slot.requestSeq + 1}`,
              onFetchStarted: () => undefined,
              setAbort: () => undefined,
            });
            runnerEvents.push(result.outcome);
            if (result.outcome === 'success') outcome = 'success';
          }
          let returnedOffset = 0;
          for (const count of options.returnedTicketCounts ?? []) {
            const returnedSlots = this.input.slots.slice(returnedOffset, returnedOffset + count);
            returnedOffset += count;
            this.input.onEvent({
              type: 'tickets_returned',
              payload: {
                runId: this.input.runId,
                count: returnedSlots.length,
                shotIds: returnedSlots.map((slot: any) => slot.shotId),
                shots: returnedSlots.map((slot: any) => ({
                  shotId: slot.shotId,
                  requestSeq: slot.requestSeq,
                  plannedAt: slot.plannedAt,
                  terminalUnsentReason: 'cancelled',
                })),
              },
            });
          }
          return { accepted: true, reason: outcome };
        }
      },
    };
    if (id.includes('fire-scheduler')) return {
      buildFireSchedule: (input: any) => ({ ...input, slots: input.shots.map((shot: any, index: number) => ({ ...shot, requestSeq: index, plannedAt: input.startMs + index * input.intervalMs })) }),
    };
    if (id.includes('strike-plan')) return {
      buildStrikeQueue: ({ tickets, targets }: any) => ({ shots: options.shots ?? [{ ...tickets[0], productId: targets[0].productId, priority: targets[0].priority }] }),
    };
    if (id.includes('settings/fire')) return { fireStore: { get: async () => ({ payType: 'ALI', burstIntervalMs: options.burstIntervalMs ?? 2100 }), set: async () => undefined }, FIRE_CONFIG_DEFAULT: { payType: 'ALI', burstIntervalMs: 2100 } };
    if (id.includes('settings/sale-time')) return { SALE_ALARM_MINUTES: [], SALE_TIME_DEFAULT: {}, getNextSaleTime: () => nextSaleTime, saleTimeStore: { get: async () => ({}) } };
    if (id.includes('settings/captcha')) return { captchaStore: { get: async () => ({ batchSessionLimit: 100 }) } };
    if (id.includes('platform/adapters/bigmodel/request')) return {
      setMainWorldFetcher: () => undefined,
      xhrRequest: async () => { pollCalls++; return { data: { code: 0, data: { status: 'SUCCESS' } } }; },
    };
    if (id.includes('platform/shared/stores')) return { createAuthStore: () => ({ get: () => null, set: async () => undefined }) };
    if (id.includes('platform')) return {
      bigmodelAdapter: {
        authProbe: { capture: () => options.capture ?? Promise.resolve(auth), isAuthenticated: async () => true },
        orderPipeline: { run: async (_ctx: any, _auth: any, fireRequest: any) => {
          const orderResult = options.orderResults?.[orderResultIndex++] ?? options.orderResult;
          const resultTiming = orderResult?.metadata?.transport?.timing;
          fireRequest?.onFetchStarted?.({
            requestId: fireRequest.requestId,
            timing: resultTiming ?? { bridgeReceivedAt: 1, bridgeReceivedPerfMs: 1, fetchCalledAt: 2, fetchCalledPerfMs: 2, responseHeadersAt: 3, bodyCompletedAt: 4 },
          });
          return await (orderResult ?? ({ success: true, data: { bizId: 'biz-1', amount: 1, productId: 'product-1' } }));
        } },
      },
    };
    if (id.includes('runtime-calibration')) return { calibrate: async () => { calibrationCalls++; return {}; } };
    throw new Error(`Unexpected import: ${id}`);
  };
  const document = {
    head: { appendChild: () => undefined },
    documentElement: { appendChild: () => undefined },
    createElement: () => ({ remove: () => undefined }),
    getElementById: () => null,
  };
  const chrome = {
    runtime: { id: 'test', getURL: () => '', onMessage: { addListener: () => undefined } },
    storage: { local: {}, onChanged: { addListener: () => undefined } },
  };
  const source = ts.transpileModule(fs.readFileSync(SOURCE_PATH, 'utf-8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    require,
    exports: {},
    defineContentScript: (config: any) => {
      contentScript = config;
      return config;
    },
    window,
    document,
    chrome,
    console,
    Date: options.now ? class extends Date { static now() { return options.now!(); } } : Date,
    Promise,
    Map,
    Set,
    Math,
    JSON,
    Error,
    queueMicrotask,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  });

  return {
    posted,
    runnerEvents,
    get pollCalls() { return pollCalls; },
    get runnerCount() { return runnerCount; },
    get calibrationCalls() { return calibrationCalls; },
    setNextSaleTime(value: number) { nextSaleTime = value; },
    async start() { await contentScript.main(); },
    async command(type: string, data?: any) {
      const pending = listeners.map((listener) => listener({ source: window, data: { testc: true, type, data } }));
      await Promise.all(pending);
    },
  };
}

describe('bm-capture.content.ts scope regression', () => {
  it('safeGet and safeSet are declared at module scope', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf-8');
    const sourceFile = ts.createSourceFile(
      SOURCE_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const topLevelNames = new Set<string>();
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        topLevelNames.add(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name)) {
            topLevelNames.add(decl.name.text);
          }
        });
      }
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          clause.namedBindings.elements.forEach((el) => {
            topLevelNames.add(el.name.text);
          });
        }
        if (clause?.name) {
          topLevelNames.add(clause.name.text);
        }
      }
    });

    expect(topLevelNames.has('safeGet')).toBe(true);
    expect(topLevelNames.has('safeSet')).toBe(true);
  });

  it('module-scope loadReminderState only references available bindings', () => {
    // This is a lightweight guard against re-introducing the bug where a
    // module-scope function called a helper that was only defined inside
    // main(). If loadReminderState references an identifier that is not
    // available at module scope, the runtime ReferenceError will return.
    const source = fs.readFileSync(SOURCE_PATH, 'utf-8');
    const sourceFile = ts.createSourceFile(
      SOURCE_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const topLevelNames = new Set<string>();
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        topLevelNames.add(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name)) {
            topLevelNames.add(decl.name.text);
          }
        });
      }
      if (ts.isInterfaceDeclaration(node) && node.name) {
        topLevelNames.add(node.name.text);
      }
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          clause.namedBindings.elements.forEach((el) => {
            topLevelNames.add(el.name.text);
          });
        }
        if (clause?.name) {
          topLevelNames.add(clause.name.text);
        }
      }
    });

    // Known globals / built-ins used by module-scope code in this file.
    const allowedGlobals = new Set([
      'console',
      'document',
      'window',
      'globalThis',
      'Date',
      'Math',
      'Number',
      'Object',
      'Promise',
      'Set',
      'Map',
      'Array',
      'String',
      'Error',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'AudioContext',
      'localStorage',
      'performance',
      'fetch',
      'encodeURIComponent',
      'JSON',
      'chrome',
      'browser',
    ]);

    const loadReminderState = sourceFile.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'loadReminderState',
    );
    expect(loadReminderState).toBeDefined();

    const collectIdentifiers = (node: ts.Node, out: string[]) => {
      if (ts.isIdentifier(node)) {
        out.push(node.text);
        return;
      }
      // Avoid recursing into nested function declarations — their bodies have
      // their own scope and are checked by the compiler.
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return;
      }
      ts.forEachChild(node, (child) => collectIdentifiers(child, out));
    };

    const identifiers: string[] = [];
    collectIdentifiers(loadReminderState!, identifiers);

    const violations = identifiers.filter(
      (id) => !topLevelNames.has(id) && !allowedGlobals.has(id),
    );

    expect(violations).toEqual([]);
  });

  it('keeps success feedback and payment polling when payment persistence rejects', async () => {
    const harness = createContentHarness({ paymentStateFails: true });
    await harness.start();

    await harness.command('PREFIRE_PREPARE', { fireStartMs: Date.now() });
    await Promise.resolve();

    expect(harness.runnerEvents).toContain('success');
    expect(harness.posted.some((message) => message.type === 'BURST_FIRE_SUCCESS')).toBe(true);
    expect(harness.posted.some((message) => message.type === 'FIRE_SHOT_RESULT' && message.data?.outcome === 'success')).toBe(true);
    expect(harness.pollCalls).toBeGreaterThan(0);
  });

  it('loads when chrome.runtime does not expose getManifest', async () => {
    const harness = createContentHarness();
    await expect(harness.start()).resolves.toBeUndefined();
  });

  it('cancels an auth-preparing auto run before it reserves tickets or fetches', async () => {
    const capture = deferred<any>();
    const harness = createContentHarness({ capture: capture.promise });
    await harness.start();

    const preparing = harness.command('PREFIRE_PREPARE', { fireStartMs: Date.now() });
    await Promise.resolve();
    await harness.command('CANCEL_FIRE');
    capture.resolve({
      platform: 'bigmodel',
      capturedAt: Date.now(),
      headers: { authorization: 'token', 'bigmodel-organization': 'org', 'bigmodel-project': 'project' },
      metadata: { source: 'live-page' },
    });
    await preparing;

    expect(harness.runnerCount).toBe(0);
    expect(harness.runnerEvents).not.toContain('tickets_reserved');
    expect(harness.posted.some((message) => message.type === 'DO_FETCH')).toBe(false);
  });

  it('records a quiet-window entry once per sale and records again for the next sale', async () => {
    const now = Date.now();
    const harness = createContentHarness({ nextSaleTime: now + 60 * 60 * 1000 });
    await harness.start();
    const calibrationCallsBeforeQuietWindow = harness.calibrationCalls;
    harness.setNextSaleTime(now + 5 * 60 * 1000);

    await harness.command('GET_RUNTIME_CALIBRATION');
    await harness.command('GET_RUNTIME_CALIBRATION');
    harness.setNextSaleTime(now + 4 * 60 * 1000);
    await harness.command('GET_RUNTIME_CALIBRATION');

    const quietEntries = harness.posted.filter((message) => message.type === 'calibration_quiet_window_entered');
    expect(harness.calibrationCalls).toBe(calibrationCallsBeforeQuietWindow);
    expect(quietEntries.map((message) => message.data?.nextSaleTime)).toEqual([
      now + 5 * 60 * 1000,
      now + 4 * 60 * 1000,
    ]);
  });

  it('keeps legacy cached RTT compensation available while calibration is quiet', async () => {
    const harness = createContentHarness({
      nextSaleTime: Date.now() + 4 * 60 * 1000,
      runtimeCalibration: {
        latencyMs: 321,
        clockOffsetMs: -17,
        sampleCount: 6,
        calibratedAt: 123,
        reason: 'legacy-cache',
      },
    });

    await harness.start();
    await harness.command('GET_RUNTIME_CALIBRATION');

    expect(harness.calibrationCalls).toBe(0);
    expect(harness.posted.find((message) => message.type === 'RUNTIME_CALIBRATION')?.data).toMatchObject({
      rttCompensationMs: 321,
      latencyMs: 321,
      clockOffsetMs: -17,
      sampleCount: 6,
      reason: 'legacy-cache',
    });
  });

  it.each([
    ['busy', { outcome: 'busy', code: 555, serverMsg: 'busy', rawServerMsg: 'busy' }],
    ['soldout', { outcome: 'soldout', code: 200, serverMsg: 'sold out', rawServerMsg: 'sold out' }],
  ])('includes classified responsibility in the %s legacy shot payload', async (_outcome, classified) => {
    const responsibility = { source: 'client-side-classification', subject: 'client', target: 'request', cause: 'inference' };
    const harness = createContentHarness({
      orderResult: { success: false, error: classified.serverMsg, metadata: { classified: { ...classified, responsibility } } },
    });
    await harness.start();

    await harness.command('PREFIRE_PREPARE', { fireStartMs: Date.now() });
    await Promise.resolve();

    expect(harness.posted.find((message) => message.type === 'FIRE_SHOT_RESULT')?.data).toMatchObject({
      outcome: classified.outcome,
      responsibility,
    });
  });

  it('records scheduler and transport metrics from MAIN-world timestamps', async () => {
    const harness = createContentHarness({
      orderResult: {
        success: false,
        error: 'busy',
        metadata: {
          classified: { outcome: 'busy', code: 555, serverMsg: 'busy', rawServerMsg: 'busy' },
          transport: {
            status: 555,
            timing: {
              bridgeReceivedAt: 1_001,
              bridgeReceivedPerfMs: 1,
              fetchCalledAt: 1_005,
              fetchCalledPerfMs: 5,
              responseHeadersAt: 1_015,
              bodyCompletedAt: 1_020,
            },
          },
        },
      },
    });
    await harness.start();
    await harness.command('PREFIRE_PREPARE', { fireStartMs: 1_000 });

    expect(harness.posted.find((message) => message.type === 'FIRE_SHOT_RESULT')?.data).toMatchObject({
      plannedAt: 1_000,
      scheduleErrorMs: 5,
      queueDelayMs: 5,
      bridgeWaitMs: 4,
      fetchToHeadersMs: 10,
      responseBodyMs: 5,
      transportTotalMs: 19,
    });
  });

  it.each([
    ['manual', 'PREFIRE_FIRE', { startMs: 960, reason: 'manual' }],
    ['auto', 'PREFIRE_PREPARE', { fireStartMs: 960 }],
  ])('exports %s second-shot queue delay from the previous actual fetch anchor', async (_mode, command, data) => {
    const busyAt = (fetchCalledAt: number) => ({
      success: false,
      error: 'busy',
      metadata: {
        classified: { outcome: 'busy', code: 555, serverMsg: 'busy', rawServerMsg: 'busy' },
        transport: {
          status: 555,
          timing: {
            bridgeReceivedAt: fetchCalledAt - 1,
            fetchCalledAt,
            responseHeadersAt: fetchCalledAt + 1,
            bodyCompletedAt: fetchCalledAt + 2,
          },
        },
      },
    });
    const content = createContentHarness({
      burstIntervalMs: 50,
      shots: [
        { ticket: 'ticket-1', randstr: 'rand-1', createdAt: Date.now(), productId: 'product-1', priority: 1 },
        { ticket: 'ticket-2', randstr: 'rand-2', createdAt: Date.now(), productId: 'product-2', priority: 2 },
      ],
      orderResults: [busyAt(1_005), busyAt(1_060)],
    });
    const main = createMainLogExportHarness();
    await content.start();
    await content.command(command, data);
    await new Promise((resolve) => setTimeout(resolve, 0));
    main.ingest(content.posted);

    const report = await main.exportLog() as { shots: Array<Record<string, unknown>> };
    const second = report.shots.find((shot) => shot.shotId === 'shot-1');
    expect(second).toMatchObject({
      plannedAt: 1_010,
      timing: { fetchCalledAt: 1_060 },
      queueDelayMs: 5,
    });
  });

  it('exports delayed burst shots without a queue-delay metric', async () => {
    const content = createContentHarness({
      burstIntervalMs: 50,
      shots: [
        { ticket: 'ticket-1', randstr: 'rand-1', createdAt: Date.now(), productId: 'product-1', priority: 1 },
        { ticket: 'ticket-2', randstr: 'rand-2', createdAt: Date.now(), productId: 'product-2', priority: 2 },
      ],
      orderResults: [
        { success: false, error: 'busy', metadata: { classified: { outcome: 'busy', code: 555 }, transport: { status: 555, timing: { bridgeReceivedAt: 1_004, fetchCalledAt: 1_005 } } } },
        { success: false, error: 'busy', metadata: { classified: { outcome: 'busy', code: 555 }, transport: { status: 555, timing: { bridgeReceivedAt: 1_059, fetchCalledAt: 1_060 } } } },
      ],
    });
    const main = createMainLogExportHarness();
    await content.start();
    await content.command('PREFIRE_FIRE', { startMs: 1_000, reason: 'burst' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    main.ingest(content.posted);

    const report = await main.exportLog() as { shots: Array<Record<string, unknown>> };
    const delayedSecond = report.shots.find((shot) => shot.shotId === 'shot-1');
    expect(delayedSecond).toMatchObject({ mode: 'burst', plannedAt: 1_500, timing: { fetchCalledAt: 1_060 } });
    expect(delayedSecond).not.toHaveProperty('queueDelayMs');
  });

  it('exports the content run trigger source and cumulative returned-ticket count', async () => {
    const content = createContentHarness({
      returnedTicketCounts: [1, 2],
      shots: [
        { ticket: 'ticket-1', randstr: 'rand-1', createdAt: Date.now(), productId: 'product-1', priority: 1 },
        { ticket: 'ticket-2', randstr: 'rand-2', createdAt: Date.now(), productId: 'product-2', priority: 2 },
        { ticket: 'ticket-3', randstr: 'rand-3', createdAt: Date.now(), productId: 'product-3', priority: 3 },
      ],
    });
    const main = createMainLogExportHarness();
    await content.start();
    await content.command('PREFIRE_FIRE', { startMs: 1_000, reason: 'manual' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(content.posted).toContainEqual(expect.objectContaining({ type: 'FIRE_LOG_V2_RUN' }));
    main.ingest(content.posted);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const report = await main.exportLog() as { runs: Array<Record<string, unknown>> };
    expect(report.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'manual',
        triggerSource: 'manual',
        ticketReturnCount: 3,
        ticketsReturned: 3,
      }),
    ]));
  });

  it.each([
    ['manual', 'PREFIRE_FIRE', { startMs: 1_000, reason: 'manual' }],
    ['burst', 'PREFIRE_FIRE', { startMs: 1_000, reason: 'burst' }],
    ['auto', 'PREFIRE_PREPARE', { fireStartMs: 1_000 }],
  ])('exports %s as its unambiguous trigger source', async (triggerSource, command, data) => {
    const content = createContentHarness();
    const main = createMainLogExportHarness();
    await content.start();
    await content.command(command, data);
    await new Promise((resolve) => setTimeout(resolve, 0));
    main.ingest(content.posted);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const report = await main.exportLog() as { runs: Array<Record<string, unknown>> };
    expect(report.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: triggerSource, triggerSource }),
    ]));
  });

  it('persists a cancelled result after the MAIN fetch has already started', async () => {
    const pending = deferred<any>();
    const harness = createContentHarness({ orderResult: pending.promise });
    await harness.start();

    const firing = harness.command('PREFIRE_PREPARE', { fireStartMs: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.command('CANCEL_FIRE');
    pending.resolve({
      success: false,
      metadata: {
        transport: {
          status: 499,
          statusText: 'Client Closed Request',
          headers: { 'x-trace': 'trace-1' },
          body: '{"cancelled":true}',
          timing: { bridgeReceivedAt: 1, fetchCalledAt: 2, responseHeadersAt: 3, bodyCompletedAt: 4 },
          request: { method: 'POST', url: 'https://bigmodel.cn/api/biz/pay/preview', headers: { Authorization: 'secret' }, body: '{"ticket":"ticket-1"}' },
        },
      },
    });
    await firing;

    expect(harness.posted).toContainEqual(expect.objectContaining({
      type: 'FIRE_LOG_V2_EVENT',
      data: expect.objectContaining({
        type: 'fetch_aborted', runId: expect.any(String), shotId: 'shot-0',
        shot: expect.objectContaining({ outcome: 'cancelled', shotId: 'shot-0', releasedAt: 123, timing: expect.objectContaining({ fetchCalledAt: 2 }) }),
      }),
    }));
  });

  it('records prepare start and all auto target timing components in the V2 run', async () => {
    const harness = createContentHarness();
    await harness.start();
    await harness.command('PREFIRE_PREPARE', {
      targetMs: 10_000, fireStartMs: 9_100, preparationLeadMs: 3_000,
      rttCompensationMs: 700, clockOffsetMs: 200, earlyOffsetMs: 10,
    });

    const prepare = harness.posted.find((message) => message.type === 'FIRE_LOG_V2_EVENT' && message.data?.type === 'run_prepare_started');
    const run = harness.posted.find((message) => message.type === 'FIRE_LOG_V2_RUN' && message.data?.mode === 'auto');
    expect(prepare?.data).toMatchObject({ runId: expect.any(String), wallClockMs: expect.any(Number), monotonicMs: expect.any(Number) });
    expect(run?.data).toMatchObject({
      nextSaleTime: 10_000, targetMs: 10_000, startMs: 9_100, preparationLeadMs: 3_000,
      rttCompensationMs: 700, clockOffsetMs: 200, earlyOffsetMs: 10,
    });
  });

  it.each([
    ['auto', 'PREFIRE_PREPARE', { targetMs: 10_000, fireStartMs: 9_100, preparationLeadMs: 3_000 }, 3_000],
    ['manual', 'PREFIRE_FIRE', { startMs: 9_100, reason: 'manual' }, 0],
    ['burst', 'PREFIRE_FIRE', { startMs: 9_100, reason: 'burst' }, 0],
  ])('exports configured preparation timing for a %s run', async (_mode, command, data, preparationLeadMs) => {
    let now = 1_000;
    const harness = createContentHarness({
      now: () => now,
      onPreparationReady: () => { now = 1_250; },
    });
    await harness.start();
    await harness.command(command, data);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const exporter = createMainLogExportHarness();
    exporter.ingest(harness.posted);
    const report = await exporter.exportLog();
    const run = (report.runs as Array<Record<string, unknown>>).find((record) => record.mode === _mode);
    expect(run).toMatchObject({
      preparationLeadMs,
      preparationDurationMs: 250,
    });
  });

  it('records a timed-out started request as a V2 timeout shot', async () => {
    const harness = createContentHarness({ orderResult: Promise.resolve({
      success: false,
      metadata: { transportFailure: 'timeout', classified: { outcome: 'neterr', code: 0, serverMsg: 'timeout', rawServerMsg: 'timeout' } },
    }) });
    await harness.start();
    await harness.command('PREFIRE_PREPARE', { fireStartMs: Date.now() });

    expect(harness.posted).toContainEqual(expect.objectContaining({
      type: 'FIRE_LOG_V2_EVENT',
      data: expect.objectContaining({ type: 'fetch_timed_out', shotId: 'shot-0', shot: expect.objectContaining({ outcome: 'timed_out' }) }),
    }));
  });

  it.each([
    ['manual', 'PREFIRE_FIRE', { startMs: 1_000, reason: 'manual' }],
    ['burst', 'PREFIRE_FIRE', { startMs: 1_000, reason: 'burst' }],
    ['auto', 'PREFIRE_PREPARE', { targetMs: 2_000, fireStartMs: 1_000, preparationLeadMs: 3_000, rttCompensationMs: 7, clockOffsetMs: 2, earlyOffsetMs: 10 }],
  ])('records exactly one preparation-start event for an active %s run', async (_mode, command, data) => {
    const harness = createContentHarness();
    await harness.start();
    await harness.command(command, data);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const preparations = harness.posted.filter((message) => message.type === 'FIRE_LOG_V2_EVENT' && message.data?.type === 'run_prepare_started');
    expect(preparations).toHaveLength(1);
    expect(preparations[0].data).toMatchObject({ runId: expect.any(String), wallClockMs: expect.any(Number), monotonicMs: expect.any(Number) });
    if (_mode === 'auto') expect(preparations[0].data?.details).toMatchObject({ targetMs: 2_000, earlyOffsetMs: 10 });
  });
});
