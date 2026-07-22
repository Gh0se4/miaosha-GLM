import type {
  IOrderPipeline,
  OperationResult,
  OrderContext,
  PaymentSession,
  PlatformAuth,
} from '../../types';
import { isBigmodelAuthValid } from './auth-probe';
import { xhrRequest, type MainWorldFetchStartedTiming } from './request';

export interface BigmodelFireRequestContext {
  requestId: string;
  runId: string;
  shotId: string;
  onFetchStarted(meta: { timing: MainWorldFetchStartedTiming; requestId: string }): void;
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
    | 'waf'
    | 'error'
    | 'neterr'
    | 'captchaService'
    | 'captchaInvalid'
    | 'captchaRisk';
  code: number;
  serverMsg: string;
  rawServerMsg: string;
  responsibility: ErrorResponsibility;
}

export interface ErrorResponsibility {
  source: 'client-side-classification';
  subject: string;
  target: string;
  cause: string;
}

function responsibility(subject: string, target: string, cause: string): ErrorResponsibility {
  return { source: 'client-side-classification', subject, target, cause };
}

export function classifyPreviewError(body: { code?: number; msg?: string }, rawBodyText?: string): ClassifiedShotResult {
  const code = body.code ?? 500;
  const raw = body.msg || '';

  if (code === 500 && raw.includes('验证码校验服务异常')) {
    return {
      outcome: 'captchaService', code,
      serverMsg: '【客户端分类：验证码核销服务异常】' + raw,
      rawServerMsg: raw,
      responsibility: responsibility('智谱', '腾讯验证码核销', '响应文本指示验证码核销服务异常；客户端无法证实具体服务端原因'),
    };
  }
  if (code === 500 && raw.includes('验证码Ticket不合法')) {
    return {
      outcome: 'captchaInvalid', code,
      serverMsg: '【客户端分类：验证码 ticket 不合法】' + raw,
      rawServerMsg: raw,
      responsibility: responsibility('插件/用户', '腾讯验证码核销', '响应文本指示 ticket 不合法；客户端无法证实具体服务端原因'),
    };
  }
  if (code === 500 && raw.includes('验证存在安全风险')) {
    return {
      outcome: 'captchaRisk', code,
      serverMsg: '【客户端分类：验证码安全风险】' + raw,
      rawServerMsg: raw,
      responsibility: responsibility('腾讯验证码风控', '当前请求', '响应文本指示安全风险；客户端无法证实具体服务端原因'),
    };
  }
  if (code === 555 || raw.toLowerCase().includes('system busy')) {
    return {
      outcome: 'busy', code,
      serverMsg: '【客户端分类：服务繁忙/可能限流】' + raw,
      rawServerMsg: raw,
      responsibility: responsibility('智谱服务', '当前请求', '响应码或文本指示繁忙；客户端推断可能存在限流或服务繁忙，未证实具体原因'),
    };
  }
  const bodyText = rawBodyText || raw || '';
  if (/<\s*(?:!doctype\s+html|html)\b/i.test(bodyText)) {
    return {
      outcome: 'waf', code: 500,
      serverMsg: '⚠️ 客户端分类：响应包含 HTML 验证页，可能被 WAF 拦截；本轮已停止。',
      rawServerMsg: bodyText.substring(0, 300),
      responsibility: responsibility('WAF/边缘防护', '当前请求', '响应体包含 HTML 验证页特征；客户端推断可能被 WAF 拦截，未证实具体拦截原因'),
    };
  }
  const snippet = bodyText.substring(0, 300);
  return {
    outcome: 'error', code,
    serverMsg: '【客户端记录：服务端返回 ' + code + '】' + (snippet ? ' [' + snippet + ']' : ''),
    rawServerMsg: snippet,
    responsibility: responsibility('服务端/网络', '当前请求', '客户端仅记录响应码和正文片段，具体原因未知'),
  };
}

export function classifyPreviewNetworkError(error: unknown): ClassifiedShotResult {
  const message = typeof (error as { message?: unknown })?.message === 'string'
    ? (error as { message: string }).message
    : String(error || 'network error');
  return {
    outcome: 'neterr', code: 0,
    serverMsg: '【客户端分类：网络请求失败】' + message,
    rawServerMsg: message,
    responsibility: responsibility('客户端/网络', '智谱服务', '客户端捕获到传输错误；服务端是否收到请求未知'),
  };
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
      const requestBody = JSON.stringify({
        productId: ctx.productId,
        ticket: ctx.ticket.ticket,
        randstr: ctx.ticket.randstr || '',
      });
      const transport = {
        timing: res.timing,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: res.body ?? (typeof body === 'string' ? body : JSON.stringify(body)),
        request: {
          method: 'POST',
          url: 'https://bigmodel.cn/api/biz/pay/preview',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=utf-8',
            Authorization: authorization,
            'Bigmodel-Organization': auth.headers['bigmodel-organization'],
            'Bigmodel-Project': auth.headers['bigmodel-project'],
          },
          body: requestBody,
        },
      };

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
        return { success: true, data: session, metadata: { transport } };
      }

      if (body.code === 200 && body.data?.soldOut) {
        return {
          success: false,
          error: 'sold out',
          metadata: {
            transport,
            classified: {
              outcome: 'soldout', code: 200, serverMsg: 'sold out', rawServerMsg: body.msg || '',
              responsibility: responsibility('服务端商品状态', '当前商品', '响应字段 soldOut 为 true；客户端按该字段分类'),
            },
          },
        };
      }

      const rawBodyText = transport.body;
      const classified = classifyPreviewError(body, rawBodyText);
      return { success: false, error: classified.serverMsg, metadata: { classified, raw: body, rawBodyText, transport } };
    } catch (e: any) {
      const classified = classifyPreviewNetworkError(e);
      return {
        success: false,
        error: classified.rawServerMsg,
        metadata: {
          classified,
          transportFailure: e?.name === 'TimeoutError' ? 'timeout' : undefined,
          statusText: e?.statusText || e?.message || 'network error',
          message: classified.rawServerMsg,
        },
      };
    }
  }
}
