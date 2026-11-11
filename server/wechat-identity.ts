import { HttpError, invalid } from './errors.js';

export interface WechatIdentity { openid: string; sessionKey?: string }

/** Exchanges a one-time mini-program login code on the server; the app secret never reaches clients. */
export interface WechatIdentityProvider {
  exchange(code: string): Promise<WechatIdentity>;
}

export function wechatLoginCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid('微信登录凭证无效。');
  return value;
}

export function wechatRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class WechatCodeExchange implements WechatIdentityProvider {
  constructor(readonly appid: string, readonly appSecret: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async exchange(code: string): Promise<WechatIdentity> {
    let response: Response;
    try {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.searchParams.set('appid', this.appid);
      url.searchParams.set('secret', this.appSecret);
      url.searchParams.set('js_code', code);
      url.searchParams.set('grant_type', 'authorization_code');
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(6000), redirect: 'error' });
    } catch {
      throw new HttpError(502, 'WECHAT_UNAVAILABLE', '暂时无法连接微信登录服务，请稍后重试。');
    }
    let payload: Record<string, unknown>;
    try { payload = wechatRecord(await response.json()); } catch { throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录服务返回异常。'); }
    if (!response.ok || typeof payload.openid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.openid)
      || (payload.errcode !== undefined && payload.errcode !== 0)) {
      const code = typeof payload.errcode === 'number' ? payload.errcode : undefined;
      if (code === 40029 || code === 40163) throw new HttpError(400, 'WECHAT_CODE_INVALID', '微信登录凭证无效或已使用，请重试。');
      throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录暂不可用，请稍后重试。');
    }
    return { openid: payload.openid, ...(typeof payload.session_key === 'string' ? { sessionKey: payload.session_key } : {}) };
  }
}
