export interface XhrRequestOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  withCredentials?: boolean;
}

export interface XhrResponse<T = unknown> {
  status: number;
  statusText: string;
  data: T;
  headers: Record<string, string>;
}

function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome.runtime &&
    !!chrome.runtime.id &&
    typeof chrome.runtime.sendMessage === 'function'
  );
}

function sendBackgroundRequest<T>(opts: XhrRequestOptions): Promise<XhrResponse<T>> {
  console.log('[volcengine-shared] background request', opts.method, opts.url);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'VOLCENGINE_REQUEST',
        payload: {
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || {},
          body: opts.body ?? null,
        },
      },
      (res) => {
        if (chrome.runtime.lastError) {
          console.error('[volcengine-shared] background lastError', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res || !res.ok) {
          console.error('[volcengine-shared] background response not ok', res);
          reject(new Error(res?.error || 'background request failed'));
          return;
        }
        console.log('[volcengine-shared] background response', res.status);
        let data: T;
        try {
          data = JSON.parse(res.body) as T;
        } catch {
          data = res.body as unknown as T;
        }
        resolve({
          status: res.status,
          statusText: res.statusText,
          data,
          headers: res.headers || {},
        });
      },
    );
  });
}

function xhrRequestImpl<T>(opts: XhrRequestOptions): Promise<XhrResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method || 'GET', opts.url, true);
    xhr.withCredentials = opts.withCredentials !== false;

    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        if (value != null) xhr.setRequestHeader(key, value);
      }
    }

    xhr.onload = () => {
      const headers: Record<string, string> = {};
      const headerText = xhr.getAllResponseHeaders();
      if (headerText) {
        headerText.split('\r\n').forEach((line) => {
          const [k, ...v] = line.split(':');
          if (k) headers[k.trim().toLowerCase()] = v.join(':').trim();
        });
      }

      let data: T;
      try {
        data = JSON.parse(xhr.responseText) as T;
      } catch {
        data = xhr.responseText as unknown as T;
      }

      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        data,
        headers,
      });
    };

    xhr.onerror = () => reject(new Error(`XHR network error: ${opts.url}`));
    xhr.ontimeout = () => reject(new Error(`XHR timeout: ${opts.url}`));
    xhr.onabort = () => reject(new Error(`XHR aborted: ${opts.url}`));

    xhr.send(opts.body ?? null);
  });
}

// ── MAIN world fetch override ───────────────────────────────────────────
type MainWorldFetcher = (opts: XhrRequestOptions) => Promise<XhrResponse>;

let _mwFetch: MainWorldFetcher | null = null;

export function setMainWorldFetcher(fn: MainWorldFetcher | null) {
  _mwFetch = fn;
}

/**
 * Perform an authenticated Volcengine platform API request.
 *
 * When a MAIN world fetcher is configured, requests are routed through the
 * page's native fetch to avoid extension-origin WAF blocks.
 */
export function xhrRequest<T = unknown>(opts: XhrRequestOptions): Promise<XhrResponse<T>> {
  if (_mwFetch) {
    return _mwFetch(opts) as Promise<XhrResponse<T>>;
  }
  if (isExtensionContext()) {
    return sendBackgroundRequest<T>(opts);
  }
  return xhrRequestImpl<T>(opts);
}
