import type { BillingPeriod, IProductProbe, PlatformAuth, PlatformId, Product, ProductCatalog } from '../../types';
import { extractConfigsFromBundle } from './bundle-parser';
import type { VolcengineConfigItem } from './types';

export interface VolcengineProductProbeConfig {
  platform: PlatformId;
  /** window global exposing the activity bundle factory. */
  globalName: string;
  /** CommonBuy Product code to keep from the bundle. */
  productCode: string;
  /** ConfigurationCode -> display name. */
  displayNames: Record<string, string>;
}

export interface VolcengineProductProbeImpl {
  getIndexKey(configCode: string, duration: number): string | undefined;
  getConfigItem(productId: string): VolcengineConfigItem | undefined;
  seedCatalog(catalog: ProductCatalog): void;
  ProductProbe: new () => IProductProbe;
}

/**
 * Build a volcengine product probe + its catalog lookups. Agent Plan and Coding
 * Plan differ only in the window global, product code, and display names, so
 * both are produced here to keep one implementation of the bundle→catalog and
 * index-key lookup logic. Each call gets its own private lookup maps.
 */
export function createVolcengineProductProbe(config: VolcengineProductProbeConfig): VolcengineProductProbeImpl {
  const { platform, globalName, productCode, displayNames } = config;

  const indexKeyByConfig = new Map<string, string>();
  const configBodyByProductId = new Map<string, VolcengineConfigItem>();
  let seededCatalog: ProductCatalog | null = null;

  function productIdFor(configCode: string, duration: number): string {
    return `${configCode}|duration:${duration}`;
  }

  function durationToBillingPeriod(duration: number, unit: string): BillingPeriod {
    if (unit === 'monthly') {
      if (duration === 1) return 'monthly';
      if (duration === 3) return 'quarterly';
      if (duration === 12) return 'yearly';
    }
    if (duration >= 12) return 'yearly';
    if (duration >= 3) return 'quarterly';
    return 'monthly';
  }

  function billingLabel(duration: number): string {
    if (duration === 1) return '连续包月';
    if (duration === 3) return '连续包季';
    if (duration === 12) return '连续包年';
    return `${duration}个月`;
  }

  function buildCatalog(items: VolcengineConfigItem[]): ProductCatalog {
    const groups: ProductCatalog['groups'] = { monthly: [], quarterly: [], yearly: [] };

    for (const item of items) {
      const body = item.configBody;
      const configCode = body.ConfigurationCode;
      const duration = body.Duration || 1;
      const billing = durationToBillingPeriod(duration, body.DurationUnit);
      const id = productIdFor(configCode, duration);

      indexKeyByConfig.set(`${configCode}|${duration}`, item.indexKey);
      configBodyByProductId.set(id, item);

      // Prices come from the MAIN-world overlay via calculatePriceV5. When the
      // adapter builds a catalog itself (tests / fallback) we leave them at 0 so
      // consumers know they are not live prices.
      const product: Product = {
        id,
        name: displayNames[configCode] || configCode,
        billingPeriod: billing,
        price: 0,
        currentAmount: 0,
        renewAmount: 0,
        originalPrice: 0,
        soldOut: false,
        description: `${duration}个月 · ${billingLabel(duration)}`,
        raw: item,
      };

      groups[billing].push(product);
    }

    for (const billing of Object.keys(groups) as BillingPeriod[]) {
      groups[billing].sort((a, b) => a.currentAmount - b.currentAmount);
    }

    return { platform, updatedAt: Date.now(), groups };
  }

  function getIndexKey(configCode: string, duration: number): string | undefined {
    return indexKeyByConfig.get(`${configCode}|${duration}`);
  }

  function getConfigItem(productId: string): VolcengineConfigItem | undefined {
    return configBodyByProductId.get(productId);
  }

  /** Seed the in-memory lookup maps from a catalog produced by the MAIN world overlay. */
  function seedCatalog(catalog: ProductCatalog): void {
    seededCatalog = catalog;
    try {
      for (const group of Object.values(catalog.groups)) {
        for (const product of group) {
          const raw = (product as any).raw as VolcengineConfigItem | undefined;
          if (!raw?.indexKey || !raw?.configBody) continue;
          const body = raw.configBody;
          const id = productIdFor(body.ConfigurationCode, body.Duration || 1);
          indexKeyByConfig.set(`${body.ConfigurationCode}|${body.Duration || 1}`, raw.indexKey);
          configBodyByProductId.set(id, raw);
        }
      }
    } catch (e) {
      console.warn(`[${platform}] seed catalog failed`, e);
    }
  }

  class ProductProbe implements IProductProbe {
    readonly platform = platform;

    extractFromPage(): ProductCatalog | null {
      try {
        const items = extractConfigsFromBundle({ globalName, productCode });
        if (items.length === 0) return null;
        return buildCatalog(items);
      } catch {
        return null;
      }
    }

    async fetch(_auth: PlatformAuth): Promise<ProductCatalog> {
      if (seededCatalog) return seededCatalog;
      const catalog = this.extractFromPage();
      if (catalog) return catalog;
      throw new Error(`${platform}: product catalog not seeded`);
    }
  }

  return { getIndexKey, getConfigItem, seedCatalog, ProductProbe };
}
