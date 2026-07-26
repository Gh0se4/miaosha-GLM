import { storage } from '#imports';
import type { AuthHeaders } from './types';
import { AUTH_STORAGE_KEY } from './types';

// Exported for unit testing. This body is also serialized by value into the
// page's MAIN world via chrome.scripting.executeScript, so it must stay
// self-contained (no imports/closure references).
export function extractAuthFromPage(): AuthHeaders | null {
  const cookies = document.cookie.split(';').reduce((acc, c) => {
    const [k, ...vParts] = c.trim().split('=');
    acc[k] = vParts.join('=');
    return acc;
  }, {} as Record<string, string>);
  const jwt = cookies['bigmodel_token_production'];
  const org = localStorage.getItem('Bigmodel-Organization');
  const proj = localStorage.getItem('Bigmodel-Project');
  if (!jwt || !org || !proj) return null;
  return {
    authorization: jwt.startsWith('Bearer ') ? jwt : `Bearer ${jwt}`,
    bigmodelOrganization: org,
    bigmodelProject: proj,
  };
}

export const authStore = {
  async get(): Promise<AuthHeaders | null> {
    return await storage.getItem<AuthHeaders>(AUTH_STORAGE_KEY);
  },

  async set(headers: AuthHeaders): Promise<void> {
    await storage.setItem<AuthHeaders>(AUTH_STORAGE_KEY, headers);
  },

  async isReady(): Promise<boolean> {
    const h = await this.get();
    return !!(h?.authorization && h?.bigmodelOrganization && h?.bigmodelProject);
  },

  async captureFromTab(): Promise<AuthHeaders | null> {
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.bigmodel.cn/*' });
      const tab = tabs.find((t) => t.id != null);
      if (!tab?.id) return null;
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: extractAuthFromPage,
      });
      const auth = results?.[0]?.result;
      if (auth) {
        await this.set(auth);
        return auth;
      }
      return null;
    } catch {
      return null;
    }
  },
};
