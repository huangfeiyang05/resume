import { HttpError } from './errors.js';
import { wechatRecord } from './wechat-identity.js';

export interface WechatAppCredentials { appid: string; appSecret: string }

export function loadWechatAppCredentials(env: NodeJS.ProcessEnv = process.env): WechatAppCredentials | undefined {
  const explicit = Boolean(env.WECHAT_APP_ID || env.WECHAT_APP_SECRET);
  const appid = explicit ? env.WECHAT_APP_ID : env.WECHAT_PAY_APPID;
  const appSecret = explicit ? env.WECHAT_APP_SECRET : env.WECHAT_PAY_APP_SECRET;
  if (!appid && !appSecret) return undefined;
  if (!explicit && (!appid || !appSecret)) return undefined;
  if (!appid || !/^wx[a-f0-9]{16}$/i.test(appid) || !appSecret?.trim()) {
    throw new Error('WeChat mini-program login requires a valid AppID and AppSecret.');
  }
  if (explicit && env.WECHAT_PAY_APPID && env.WECHAT_PAY_APPID !== appid) {
    throw new Error('WeChat login and existing payment must use the same mini-program AppID.');
  }
  return { appid, appSecret };
}

export function wechatFlag(name: string, env: NodeJS.ProcessEnv) {
  const value = env[name] || 'false';
  if (value !== 'true' && value !== 'false') throw new Error(name + ' must be true or false.');
  return value === 'true';
}

/** One cached app token per process. Codes, tokens and provider response bodies stay out of logs. */
export class WechatApi {
  private token?: { value: string; expiresAt: number };
  private refresh?: Promise<string>;

  constructor(private readonly config: WechatAppCredentials, private readonly fetchImpl: typeof fetch = fetch) {}

  private async post(url: URL, body: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(6000), redirect: 'error' });
      if (!response.ok) throw new Error();
      const raw = await response.text();
      return raw.trim() ? wechatRecord(JSON.parse(raw)) : {};
    } catch {
      throw new HttpError(502, 'WECHAT_API_UNAVAILABLE', '暂时无法连接微信服务，请稍后重试。');
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    this.refresh ??= (async () => {
      const result = await this.post(new URL('https://api.weixin.qq.com/cgi-bin/stable_token'), JSON.stringify({
        grant_type: 'client_credential', appid: this.config.appid, secret: this.config.appSecret, force_refresh: false,
      }));
      if (typeof result.access_token !== 'string' || !result.access_token || typeof result.expires_in !== 'number'
        || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0) {
        throw new HttpError(502, 'WECHAT_API_UNAVAILABLE', '微信服务凭证暂不可用。');
      }
      this.token = { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 120) * 1000 };
      return this.token.value;
    })().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  async call(path: string, body: string, signature?: string) {
    const token = await this.accessToken();
    const url = new URL('https://api.weixin.qq.com' + path);
    url.searchParams.set('access_token', token);
    if (signature) url.searchParams.set('pay_sig', signature);
    const result = await this.post(url, body);
    // A failed response does not replay a one-time phone authorization or payment operation.
    if ([40001, 40014, 42001].includes(result.errcode as number) && this.token?.value === token) this.token = undefined;
    return result;
  }
}

export interface WechatPhoneProvider { redeem(code: string): Promise<string> }

export class WechatPhoneVerification implements WechatPhoneProvider {
  constructor(private readonly api: WechatApi, private readonly appid: string, private readonly now = Date.now) {}

  async redeem(code: string): Promise<string> {
    const result = await this.api.call('/wxa/business/getuserphonenumber', JSON.stringify({ code }));
    if (result.errcode === 40029 || result.errcode === 40163) {
      throw new HttpError(400, 'WECHAT_PHONE_CODE_INVALID', '微信手机号授权已过期或已使用，请重新授权。');
    }
    if (result.errcode !== 0) throw new HttpError(502, 'WECHAT_PHONE_UNAVAILABLE', '微信手机号验证暂不可用，请稍后重试。');
    const phone = wechatRecord(result.phone_info);
    const watermark = wechatRecord(phone.watermark);
    const age = typeof watermark.timestamp === 'number' ? this.now() - watermark.timestamp * 1000 : Infinity;
    if (watermark.appid !== this.appid || !Number.isSafeInteger(watermark.timestamp) || age < -30_000 || age > 300_000
      || typeof phone.purePhoneNumber !== 'string') {
      throw new HttpError(502, 'WECHAT_PHONE_RESPONSE_INVALID', '微信手机号授权信息无法核验，请重新授权。');
    }
    if (phone.countryCode !== '86') throw new HttpError(400, 'WECHAT_PHONE_REGION_UNSUPPORTED', '当前仅支持绑定中国大陆手机号。');
    return phone.purePhoneNumber;
  }
}
