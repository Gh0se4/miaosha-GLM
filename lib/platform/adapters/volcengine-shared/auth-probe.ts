import type { IAuthProbe, AuthSignals, PlatformAuth } from '../../types';

export interface VolcengineAuthHeaders {
  'x-csrf-token': string;
  'monitor-huoshan-web-id': string;
  'x-language': string;
  'x-use-bff-version': string;
  'monitor-utm'?: string;
}

export function isVolcengineAuthValid(auth: PlatformAuth | null): auth is PlatformAuth & { headers: VolcengineAuthHeaders } {
  if (!auth) return false;
  const h = auth.headers;
  return !!h['x-csrf-token'] && !!h['monitor-huoshan-web-id'];
}

export class VolcengineAuthProbe implements IAuthProbe {
  readonly platform = 'volcengine';

  async isAuthenticated(auth?: PlatformAuth | null): Promise<boolean> {
    return isVolcengineAuthValid(auth ?? (await this.capture()));
  }

  async capture(): Promise<PlatformAuth | null> {
    try {
      const cookies = document.cookie.split(';').reduce((acc, c) => {
        const [k, ...vParts] = c.trim().split('=');
        acc[k] = vParts.join('=');
        return acc;
      }, {} as Record<string, string>);

      const csrf = cookies['csrfToken'];
      const webId = cookies['monitor_huoshan_web_id'];
      const accountId = cookies['AccountID'];
      if (!csrf || !webId) return null;

      const headers: VolcengineAuthHeaders = {
        'x-csrf-token': csrf,
        'monitor-huoshan-web-id': webId,
        'x-language': 'zh',
        'x-use-bff-version': '1',
      };
      if (cookies['monitor_utm']) {
        headers['monitor-utm'] = cookies['monitor_utm'];
      }

      return {
        platform: this.platform,
        capturedAt: Date.now(),
        headers: { ...headers },
        metadata: {
          source: 'live-page',
          accountId: accountId || undefined,
          csrfToken: csrf,
          webId,
        },
      };
    } catch {
      return null;
    }
  }

  getSignals(auth: PlatformAuth | null): AuthSignals {
    if (!isVolcengineAuthValid(auth)) {
      return { ok: false, source: 'none' };
    }
    const source = (auth.metadata?.source as 'live-page' | 'cache') ?? 'cache';
    const ageMs = typeof auth.capturedAt === 'number' ? Math.max(0, Date.now() - auth.capturedAt) : 0;
    const raw = auth.headers['x-csrf-token'];
    return {
      ok: true,
      source,
      ageMs,
      tokenSuffix: raw.length > 6 ? '…' + raw.slice(-6) : raw,
      userDisplay: auth.metadata?.accountId ? `账号 ${auth.metadata.accountId}` : undefined,
    };
  }
}
