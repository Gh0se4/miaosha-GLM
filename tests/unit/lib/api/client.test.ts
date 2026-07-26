import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHeaders,
  parseResponseBody,
  findBigmodelTabId,
  testEndpoint,
} from '../../../../lib/api/client';

const auth = {
  authorization: 'Bearer tok',
  bigmodelOrganization: 'org-1',
  bigmodelProject: 'proj-1',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseResponseBody', () => {
  it('parses JSON bodies', () => {
    expect(parseResponseBody('{"a":1}')).toEqual({ a: 1 });
  });
  it('returns the raw string for non-JSON bodies', () => {
    expect(parseResponseBody('<html>nope')).toBe('<html>nope');
  });
  it('returns null for a null body', () => {
    expect(parseResponseBody(null)).toBeNull();
  });
});

describe('buildHeaders', () => {
  it('maps auth into request headers', () => {
    expect(buildHeaders(auth)).toEqual({
      'Content-Type': 'application/json;charset=UTF-8',
      Authorization: 'Bearer tok',
      'bigmodel-organization': 'org-1',
      'bigmodel-project': 'proj-1',
    });
  });
});

describe('findBigmodelTabId', () => {
  it('prefers the active bigmodel tab', async () => {
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      { id: 7, active: false },
      { id: 9, active: true },
    ] as any);
    await expect(findBigmodelTabId()).resolves.toBe(9);
  });

  it('falls back to any bigmodel tab when none is active', async () => {
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([{ id: 11, active: false }] as any);
    await expect(findBigmodelTabId()).resolves.toBe(11);
  });

  it('throws when no bigmodel tab exists', async () => {
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([] as any);
    await expect(findBigmodelTabId()).rejects.toThrow(/No active bigmodel\.cn tab/);
  });
});

describe('testEndpoint', () => {
  it('returns an error result (not a throw) when no bigmodel tab is available', async () => {
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([] as any);

    const result = await testEndpoint('GET', '/api/x', null, auth);

    expect(result.status).toBe(0);
    expect(result.body).toBeNull();
    expect(result.error).toMatch(/No active bigmodel\.cn tab/);
  });
});
