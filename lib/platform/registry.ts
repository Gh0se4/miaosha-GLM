import type { IPlatformAdapter, IPlatformRegistry, PlatformId } from './types';

class PlatformRegistry implements IPlatformRegistry {
  private readonly adapters = new Map<PlatformId, IPlatformAdapter>();

  register(adapter: IPlatformAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: PlatformId): IPlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): readonly IPlatformAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const platformRegistry: IPlatformRegistry = new PlatformRegistry();

export function registerPlatform(adapter: IPlatformAdapter): void {
  platformRegistry.register(adapter);
}
