import type {
  BillingPeriod,
  IProductProbe,
  PlatformAuth,
  Product,
  ProductCatalog,
} from '../../types';
import { isBigmodelAuthValid } from './auth-probe';
import { xhrRequest } from './request';

const PLAN_ORDER = ['Lite', 'Pro', 'Max'];

interface BigmodelPreview {
  productId?: string;
  monthlyPayAmount?: string | number;
  monthlyOriginalAmount?: string | number;
  payAmount?: string | number;
  renewAmount?: string | number;
  soldOut?: boolean;
  forbidden?: boolean;
  canPurchase?: boolean;
  campaignDiscountDetails?: Array<{ campaignName?: string; rewardDetail?: string }>;
}

function formatAmount(value: unknown): string {
  const num = Number(value);
  if (!isFinite(num)) return '';
  return String(Math.round(num * 100) / 100)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1');
}

function inferBillingFromPreview(item: BigmodelPreview | null | undefined): BillingPeriod {
  if (!item) return 'monthly';
  const monthly = Number(item.monthlyPayAmount);
  const total = Number(item.payAmount);
  if (isFinite(monthly) && monthly > 0 && isFinite(total) && total > 0) {
    const ratio = total / monthly;
    if (ratio > 6) return 'yearly';
    if (ratio > 1.5) return 'quarterly';
    return 'monthly';
  }
  const discounts = item.campaignDiscountDetails || [];
  for (const d of discounts) {
    const name = d?.campaignName || d?.rewardDetail || '';
    if (name.includes('年')) return 'yearly';
    if (name.includes('季')) return 'quarterly';
  }
  return 'monthly';
}

function getPromoTag(item: BigmodelPreview | null | undefined): string {
  const discounts = item?.campaignDiscountDetails;
  if (!discounts || !discounts.length) return '';
  return discounts[0].rewardDetail || discounts[0].campaignName || '';
}

function getRenewLabel(billing: BillingPeriod): string {
  if (billing === 'yearly') return '下个年度续费金额';
  if (billing === 'quarterly') return '下个季度续费金额';
  return '下个月续费金额';
}

export interface BigmodelBatchPreviewResponse {
  code: number;
  msg?: string;
  data?: {
    productList?: BigmodelPreview[];
  };
}

export class BigmodelProductProbe implements IProductProbe {
  readonly platform = 'bigmodel';

  async fetch(auth: PlatformAuth): Promise<ProductCatalog> {
    if (!isBigmodelAuthValid(auth)) {
      throw new Error('bigmodel auth invalid');
    }

    const authorization = auth.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    const res = await xhrRequest<BigmodelBatchPreviewResponse>({
      method: 'POST',
      url: 'https://bigmodel.cn/api/biz/pay/batch-preview',
      withCredentials: true,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: authorization,
        'Bigmodel-Organization': auth.headers['bigmodel-organization'],
        'Bigmodel-Project': auth.headers['bigmodel-project'],
      },
      body: JSON.stringify({ invitationCode: '' }),
    });

    const data = res.data;
    if (data.code !== 200 || !Array.isArray(data.data?.productList)) {
      throw new Error(`batch-preview failed: ${data.code} ${data.msg || ''}`);
    }

    return this.convert(data.data.productList);
  }

  extractFromPage(): ProductCatalog | null {
    try {
      // Try namespace-prefixed key
      const ns = (typeof window !== 'undefined' && window.sessionStorage.getItem('_st')) || '';
      const key = ns ? ns + 'bp' : '_cache_bp';
      const cached = JSON.parse(window.sessionStorage.getItem(key) || 'null');
      const list = cached?.data?.productList;
      if (Array.isArray(list)) return this.convert(list);
    } catch {
      // ignore
    }
    return null;
  }

  convert(productList: BigmodelPreview[]): ProductCatalog {
    const groups: Record<BillingPeriod, BigmodelPreview[]> = {
      monthly: [],
      quarterly: [],
      yearly: [],
    };

    for (const item of productList) {
      const billing = inferBillingFromPreview(item);
      if (!groups[billing]) groups[billing] = [];
      groups[billing].push(item);
    }

    const matrix: Record<BillingPeriod, Product[]> = {
      monthly: [],
      quarterly: [],
      yearly: [],
    };

    const billings: BillingPeriod[] = ['monthly', 'quarterly', 'yearly'];
    for (const billing of billings) {
      const rows = groups[billing] || [];
      rows.sort((a, b) => Number(a.monthlyPayAmount || a.payAmount || 0) - Number(b.monthlyPayAmount || b.payAmount || 0),
      );
      for (let i = 0; i < rows.length && i < PLAN_ORDER.length; i++) {
        const preview = rows[i];
        const renewAmount = preview.renewAmount != null ? preview.renewAmount : preview.payAmount;
        matrix[billing].push({
          id: preview.productId ?? '',
          name: PLAN_ORDER[i],
          billingPeriod: billing,
          price: Number(preview.monthlyPayAmount) || 0,
          originalPrice: Number(preview.monthlyOriginalAmount) || undefined,
          currentAmount: Number(preview.payAmount) || 0,
          renewAmount: Number(renewAmount) || 0,
          soldOut: !!(preview.soldOut || preview.forbidden || preview.canPurchase === false),
          tag: getPromoTag(preview),
          description: getRenewLabel(billing) + '：¥' + formatAmount(renewAmount),
          raw: preview,
        });
      }
    }

    return {
      platform: this.platform,
      updatedAt: Date.now(),
      groups: matrix,
    };
  }
}
