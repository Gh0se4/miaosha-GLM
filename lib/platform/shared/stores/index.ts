import type {
  IAuthStore,
  IProductCatalogStore,
  PlatformAuth,
  PlatformId,
  ProductCatalog,
} from '../../types';
import { MemoryStore } from './base';
import { ChromeStorageStore } from './storage-base';

// Only the Auth and Product-Catalog stores are wired up (the *-capture content
// scripts construct them). The earlier SelectedProducts / TicketPool /
// RuntimeCalibration / SaleTime / PaymentBridge store factories had no callers
// and duplicated the authoritative implementations in lib/settings/* and
// lib/api/*, so they were removed to avoid a misleading parallel abstraction.

// =============================================================================
// Auth
// =============================================================================

export class MemoryAuthStore extends MemoryStore<PlatformAuth> implements IAuthStore {
  isReady(): boolean {
    const a = this.get();
    // Platform-aware: bigmodel auth carries `authorization`; volcengine auth
    // carries `x-csrf-token` (+ monitor-huoshan-web-id). Accept either so this
    // does not return false for a valid volcengine session.
    return !!a && !!a.headers && (!!a.headers.authorization || !!a.headers['x-csrf-token']);
  }
}

export class ChromeAuthStore extends ChromeStorageStore<PlatformAuth> implements IAuthStore {
  isReady(): boolean {
    const a = this.get();
    // Platform-aware: bigmodel auth carries `authorization`; volcengine auth
    // carries `x-csrf-token` (+ monitor-huoshan-web-id). Accept either so this
    // does not return false for a valid volcengine session.
    return !!a && !!a.headers && (!!a.headers.authorization || !!a.headers['x-csrf-token']);
  }
}

export function createAuthStore(useChrome = true): IAuthStore {
  return useChrome ? new ChromeAuthStore('local:platformAuth') : new MemoryAuthStore();
}

// =============================================================================
// Product Catalog
// =============================================================================

export class MemoryProductCatalogStore
  extends MemoryStore<Record<PlatformId, ProductCatalog>>
  implements IProductCatalogStore
{
  getPlatform(platform: PlatformId): ProductCatalog | null {
    const all = this.get();
    return all?.[platform] ?? null;
  }
}

export class ChromeProductCatalogStore
  extends ChromeStorageStore<Record<PlatformId, ProductCatalog>>
  implements IProductCatalogStore
{
  getPlatform(platform: PlatformId): ProductCatalog | null {
    const all = this.get();
    return all?.[platform] ?? null;
  }
}

export function createProductCatalogStore(useChrome = true): IProductCatalogStore {
  return useChrome
    ? new ChromeProductCatalogStore('local:platformCatalog')
    : new MemoryProductCatalogStore();
}
