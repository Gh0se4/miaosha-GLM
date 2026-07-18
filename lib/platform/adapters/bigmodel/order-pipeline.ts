import type {
  IOrderPipeline,
  OperationResult,
  OrderContext,
  PaymentSession,
  PlatformAuth,
} from '../../types';
import { isBigmodelAuthValid } from './auth-probe';
import { xhrRequest, type MainWorldTransportTiming } from './request';

export interface BigmodelFireRequestContext {
  requestId: string;
  runId: string;
  shotId: string;
  onFetchStarted(meta: { timing: MainWorldTransportTiming; requestId: string }): void;
  onAbortReady(abort: () => void): void;
}

export interface BigmodelPreviewResponse {
  code: number;
  msg?: string;
  data?: {
    bizId?: string;
    productId?: string;
    thirdPartyAmount?: number;
    payAmount?: number;
    qrCode?: string;
    soldOut?: boolean;
  };
}

export interface ClassifiedShotResult {
  outcome:
    | 'success'
    | 'soldout'
    | 'busy'
    | 'error'
    | 'neterr'
    | 'captchaService'
    | 'captchaInvalid'
    | 'captchaRisk';
  code: number;
  serverMsg: string;
  rawServerMsg: string;
}

export function classifyPreviewError(body: { code?: number; msg?: string }, rawBodyText?: string): ClassifiedShotResult {
  const code = body.code ?? 500;
  const raw = body.msg || '';

  if (code === 500 && raw.includes('验证码校验服务异常')) {
    return { outcome: 'captchaService', code, serverMsg: '【智谱 --> 腾讯验证码核销：QPS 超限】' + raw, rawServerMsg: raw };
  }
  if (code === 500 && raw.includes('验证码Ticket不合法')) {
    return { outcome: 'captchaInvalid', code, serverMsg: '【插件/用户 --> 腾讯验证码核销：ticket 无效或已过期】' + raw, rawServerMsg: raw };
  }
  if (code === 500 && raw.includes('验证存在安全风险')) {
    return { outcome: 'captchaRisk', code, serverMsg: '【腾讯验证码风控 --> 当前请求：环境存在安全风险】' + raw, rawServerMsg: raw };
  }
  if (code === 555 || raw.toLowerCase().includes('system busy')) {
    return { outcome: 'busy', code, serverMsg: '【智谱 --> 当前用户：2 秒滑动窗口限流】' + raw, rawServerMsg: raw };
  }
  const bodyText = rawBodyText || raw || '';
  if (bodyText.indexOf('<!doctypehtml>') !== -1 || bodyText.indexOf('<html') !== -1) {
    return { outcome: 'error', code: 500, serverMsg: '⚠️ WAF拦截：阿里云WAF返回HTML验证页面，当前会话可能已被风控', rawServerMsg: bodyText.substring(0, 300) };
  }
  const snippet = bodyText.substring(0, 300);
  return { outcome: 'error', code, serverMsg: '服务端返回 ' + code + (snippet ? ' [' + snippet + ']' : ''), rawServerMsg: snippet };
}

export class BigmodelOrderPipeline implements IOrderPipeline {
  readonly platform = 'bigmodel';

  async run(
    ctx: OrderContext,
    auth: PlatformAuth,
    fireRequest?: BigmodelFireRequestContext,
  ): Promise<OperationResult<PaymentSession>> {
    if (!isBigmodelAuthValid(auth)) {
      return { success: false, error: 'bigmodel auth invalid' };
    }
    if (!ctx.ticket?.ticket) {
      return { success: false, error: 'missing captcha ticket' };
    }

    try {
      const authorization = auth.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
      const res = await xhrRequest<BigmodelPreviewResponse>({
        method: 'POST',
        url: 'https://bigmodel.cn/api/biz/pay/preview',
        withCredentials: true,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=utf-8',
          Authorization: authorization,
          'Bigmodel-Organization': auth.headers['bigmodel-organization'],
          'Bigmodel-Project': auth.headers['bigmodel-project'],
        },
        body: JSON.stringify({
          productId: ctx.productId,
          ticket: ctx.ticket.ticket,
          randstr: ctx.ticket.randstr || '',
        }),
        requestId: fireRequest?.requestId,
        runId: fireRequest?.runId,
        shotId: fireRequest?.shotId,
        onFetchStarted: fireRequest?.onFetchStarted,
        onAbortReady: fireRequest?.onAbortReady,
      });
      const body = res.data;

      if (body.code === 200 && body.data && !body.data.soldOut && body.data.bizId) {
        const session: PaymentSession = {
          platform: this.platform,
          productId: body.data.productId || ctx.productId,
          amount: body.data.thirdPartyAmount ?? body.data.payAmount ?? 0,
          currency: 'CNY',
          bizId: body.data.bizId,
          qrCode: body.data.qrCode,
          raw: body.data,
        };
        return { success: true, data: session };
      }

      if (body.code === 200 && body.data?.soldOut) {
        return {
          success: false,
          error: 'sold out',
          metadata: { classified: { outcome: 'soldout', code: 200, serverMsg: 'sold out', rawServerMsg: body.msg || '' } },
        };
      }

      const rawBodyText = typeof body === 'string' ? body : JSON.stringify(body);
      const classified = classifyPreviewError(body, rawBodyText);
      return { success: false, error: classified.serverMsg, metadata: { classified, raw: body, rawBodyText } };
    } catch (e: any) {
      return {
        success: false,
        error: e?.message || 'network error',
        metadata: { classified: { outcome: 'neterr', code: 0, serverMsg: e?.message, rawServerMsg: e?.message } },
      };
    }
  }
}
