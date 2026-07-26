import type {
  IOrderPipeline,
  OperationResult,
  OrderContext,
  PaymentSession,
  PlatformAuth,
  PlatformId,
} from '../../types';
import { isVolcengineAuthValid } from './auth-probe';
import type { VolcengineCommonBuyRequest, VolcengineCommonBuyResponse, VolcengineConfigItem } from './types';
import { xhrRequest } from './request';

const ORDER_URL = 'https://www.volcengine.com/api/v2/top/activity/bill_volc_provider/CommonBuy/2020-01-01/cn-beijing';

export interface VolcengineOrderPipelineConfig {
  /** Platform id, e.g. 'volcengine-agentplan' / 'volcengine-codingplan'. */
  platform: PlatformId;
  /** CommonBuy Product code used by the fallback body, e.g. 'ark_bd' / 'ark_subscription'. */
  product: string;
  /** volcengine.com/activity/<payPath> segment used to build the pay URL. */
  payPath: string;
  getConfigItem: (productId: string) => VolcengineConfigItem | undefined;
  getIndexKey: (configCode: string, duration: number) => string | undefined;
}

/**
 * Build a volcengine CommonBuy order pipeline. The Agent Plan and Coding Plan
 * pipelines are identical apart from the product code, pay-URL segment,
 * platform id, and their catalog lookup helpers, so both are produced from this
 * factory to keep a single tested implementation of the real-money order flow.
 */
export function createVolcengineOrderPipeline(config: VolcengineOrderPipelineConfig): new () => IOrderPipeline {
  const { platform, product, payPath, getConfigItem, getIndexKey } = config;

  return class implements IOrderPipeline {
    readonly platform = platform;

    async run(ctx: OrderContext, auth: PlatformAuth): Promise<OperationResult<PaymentSession>> {
      if (!isVolcengineAuthValid(auth)) {
        return { success: false, error: 'volcengine auth invalid' };
      }

      const productId = ctx.productId;
      const item = getConfigItem(productId);
      if (!item) {
        // Fallback: reconstruct from productId
        const [configCode, durationPart] = productId.split('|');
        const duration = parseInt(durationPart?.replace('duration:', '') || '1', 10);
        if (!configCode || !Number.isFinite(duration)) {
          return { success: false, error: `unknown ${platform} product ${productId}` };
        }
        const indexKey = getIndexKey(configCode, duration);
        if (!indexKey) {
          return { success: false, error: `${platform} index key not found for ${productId}` };
        }
        const fallbackBody = {
          Product: product,
          ConfigurationCode: configCode,
          Quantity: 1,
          Duration: duration,
          DurationUnit: 'monthly',
          ChargeItemList: [{ ChargeItemCode: `${configCode}_cn-beijing`, Count: '1' }],
          RenewType: 2,
          PurchaseTimes: duration,
        };
        return this.placeOrder(indexKey, fallbackBody, productId, auth.headers);
      }

      return this.placeOrder(item.indexKey, item.configBody, productId, auth.headers, item.indexKeyCandidates);
    }

    private async placeOrder(
      indexKey: string,
      configBody: VolcengineCommonBuyRequest['ConfigList'][number],
      productId: string,
      authHeaders: Record<string, string>,
      indexKeyCandidates?: string[],
    ): Promise<OperationResult<PaymentSession>> {
      const candidates = indexKeyCandidates?.length ? indexKeyCandidates.slice() : [indexKey];

      for (let i = 0; i < candidates.length; i++) {
        const result = await this.tryOrder(candidates[i], configBody, productId, authHeaders);
        if (result.success) return result;
        const errCode = result.error?.match(/^\[([^\]]+)\]/)?.[1];
        if (errCode !== 'InvalidParameter.Configuration' || i === candidates.length - 1) {
          return result;
        }
      }
      return { success: false, error: `${platform} exhausted index key candidates` };
    }

    private async tryOrder(
      indexKey: string,
      configBody: VolcengineCommonBuyRequest['ConfigList'][number],
      productId: string,
      authHeaders: Record<string, string>,
    ): Promise<OperationResult<PaymentSession>> {
      const body: VolcengineCommonBuyRequest = {
        IndexKey: indexKey,
        ConfigList: [configBody],
        SignPay: true,
      };

      try {
        const res = await xhrRequest<VolcengineCommonBuyResponse>({
          method: 'POST',
          url: ORDER_URL,
          withCredentials: true,
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify(body),
        });

        const data = res.data;
        const error = data.ResponseMetadata?.Error;
        if (error) {
          return { success: false, error: `[${error.Code}] ${error.Message}`, metadata: { raw: data } };
        }

        const orderId = data.Result?.CustomerOrderID;
        if (!orderId) {
          return { success: false, error: `${platform} CommonBuy did not return CustomerOrderID`, metadata: { raw: data } };
        }

        const session: PaymentSession = {
          platform,
          productId,
          amount: 0,
          currency: 'CNY',
          orderId,
          bizId: orderId,
          payUrl: `https://www.volcengine.com/activity/${payPath}?i_f=1&o_n=${encodeURIComponent(orderId)}&tik=${encodeURIComponent(indexKey)}`,
          raw: { indexKey, configBody, response: data },
        };

        return { success: true, data: session };
      } catch (e: any) {
        return { success: false, error: e?.message || `${platform} CommonBuy network error` };
      }
    }
  };
}
