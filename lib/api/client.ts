import type { AuthHeaders, TestResult } from './types';

const BASE_URL = 'https://bigmodel.cn';
const BIGMODEL_TAB_URL = '*://*.bigmodel.cn/*';

type BigmodelTab = {
  active?: boolean;
  id?: number;
};

export function buildHeaders(auth: AuthHeaders): Record<string, string> {
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    Authorization: auth.authorization,
    'bigmodel-organization': auth.bigmodelOrganization,
    'bigmodel-project': auth.bigmodelProject,
  };
}

export function parseResponseBody(bodyText: string | null): unknown {
  if (bodyText === null) return null;

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

export async function findBigmodelTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: BIGMODEL_TAB_URL });
  const tab = tabs.find((candidate: BigmodelTab) => candidate.active && candidate.id != null)
    ?? tabs.find((candidate: BigmodelTab) => candidate.id != null);

  if (!tab?.id) {
    throw new Error('No active bigmodel.cn tab found for same-origin probe.');
  }

  return tab.id;
}

async function fetchFromBigmodelPage(
  url: string,
  method: 'GET' | 'POST',
  body: Record<string, unknown> | null,
  headers: Record<string, string>,
): Promise<{
  status: number;
  headers: Record<string, string>;
  bodyText: string | null;
  durationMs: number;
  error?: string;
}> {
  const tabId = await findBigmodelTabId();
  const requestBody = method === 'POST' && body ? JSON.stringify(body) : null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [url, method, headers, requestBody],
    func: async (
      requestUrl: string,
      requestMethod: 'GET' | 'POST',
      requestHeaders: Record<string, string>,
      serializedBody: string | null,
    ) => {
      const start = performance.now();

      try {
        const response = await fetch(requestUrl, {
          method: requestMethod,
          headers: requestHeaders,
          body: serializedBody ?? undefined,
          cache: 'no-store',
          credentials: 'include',
        });

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        return {
          status: response.status,
          headers: responseHeaders,
          bodyText: await response.text(),
          durationMs: Math.round(performance.now() - start),
        };
      } catch (error) {
        return {
          status: 0,
          headers: {},
          bodyText: null,
          durationMs: Math.round(performance.now() - start),
          error: String(error),
        };
      }
    },
  });

  const result = results?.[0]?.result;
  if (!result) {
    throw new Error('Same-origin probe returned no result.');
  }

  return result;
}

export async function testEndpoint(
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> | null,
  auth: AuthHeaders,
): Promise<TestResult> {
  const url = `${BASE_URL}${path}`;
  const start = performance.now();

  try {
    const result = await fetchFromBigmodelPage(url, method, body, buildHeaders(auth));

    return {
      status: result.status,
      headers: result.headers,
      body: parseResponseBody(result.bodyText),
      durationMs: result.durationMs,
      error: result.error,
    };
  } catch (err) {
    return {
      status: 0,
      headers: {},
      body: null,
      durationMs: Math.round(performance.now() - start),
      error: String(err),
    };
  }
}
