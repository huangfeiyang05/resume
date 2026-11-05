import { createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from 'node:crypto';
import type { WechatPaymentParams } from '../shared/payment.js';
import type { PaymentConfig } from './payment-config.js';

export interface JsapiOrderInput {
  outTradeNo: string;
  description: string;
  amountCents: number;
  openid: string;
  notifyUrl: string;
  expiresAt: string;
}

export interface JsapiOrder {
  prepayId: string;
  payment: WechatPaymentParams;
}

export interface NativeOrderInput {
  outTradeNo: string;
  description: string;
  amountCents: number;
  notifyUrl: string;
  expiresAt: string;
}

export interface NativeOrder {
  codeUrl: string;
}

export interface DecryptedTransaction {
  mchid: string;
  appid: string;
  outTradeNo: string;
  transactionId: string;
  tradeState: string;
  successTime: string;
  amountCents: number;
  currency: string;
  openid?: string;
}

export interface NotifyPayload {
  id: string;
  eventType: string;
  resourceType?: string;
  transaction: DecryptedTransaction;
}

export interface WechatPayGateway {
  createJsapiOrder(input: JsapiOrderInput): Promise<JsapiOrder>;
  createNativeOrder(input: NativeOrderInput): Promise<NativeOrder>;
  /** Re-signs client payment parameters for an existing prepay_id. */
  paymentParams(prepayId: string): WechatPaymentParams;
  parseNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): NotifyPayload;
}

export class WechatPayError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); this.name = 'WechatPayError'; }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  if (typeof value !== 'string' || !value.trim()) throw new WechatPayError('WECHAT_HEADER_MISSING', `缺少微信支付响应头 ${name}。`);
  return value;
}

function nonce(): string { return randomBytes(16).toString('hex'); }

export class WechatPayClient implements WechatPayGateway {
  private readonly privateKey;
  private readonly publicKey;
  constructor(readonly config: PaymentConfig, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.privateKey = createPrivateKey(config.privateKeyPem);
    this.publicKey = createPublicKey(config.platformPublicKeyPem);
  }

  private authorization(method: string, path: string, body: string): string {
    const timestamp = Math.floor(this.now() / 1000).toString();
    const nonceStr = nonce();
    const message = `${method}\n${path}\n${timestamp}\n${nonceStr}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message).sign(this.privateKey, 'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchid}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${this.config.merchantSerialNo}",signature="${signature}"`;
  }

  private verifyResponse(headers: Record<string, string | string[] | undefined>, rawBody: string): void {
    const timestamp = header(headers, 'wechatpay-timestamp');
    const nonceStr = header(headers, 'wechatpay-nonce');
    const signature = header(headers, 'wechatpay-signature');
    const serial = header(headers, 'wechatpay-serial');
    if (!/^\d{10,13}$/.test(timestamp) || Math.abs(this.now() / 1000 - Number(timestamp)) > 300) throw new WechatPayError('WECHAT_TIMESTAMP_INVALID', '微信支付响应时间戳超出允许范围。');
    if (this.config.platformPublicKeyId && serial !== this.config.platformPublicKeyId) throw new WechatPayError('WECHAT_SERIAL_MISMATCH', '微信支付平台公钥标识不匹配。');
    const message = `${timestamp}\n${nonceStr}\n${rawBody}\n`;
    const valid = createVerify('RSA-SHA256').update(message).verify(this.publicKey, signature, 'base64');
    if (!valid) throw new WechatPayError('WECHAT_SIGNATURE_INVALID', '微信支付响应签名校验失败。');
  }

  private async post(path: string, payload: unknown): Promise<string> {
    const raw = JSON.stringify(payload);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.mch.weixin.qq.com${path}`, {
        method: 'POST', headers: {
          Authorization: this.authorization('POST', path, raw),
          Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'resume-youfang/1.0',
        }, body: raw,
      });
    } catch { throw new WechatPayError('WECHAT_UNAVAILABLE', '暂时无法连接微信支付，请稍后重试。'); }
    const text = await response.text();
    if (!response.ok) {
      let message = '微信支付下单失败，请稍后重试。';
      try { const parsed = JSON.parse(text); if (typeof parsed.message === 'string' && parsed.message.length < 200) message = parsed.message; } catch { /* Keep the generic message. */ }
      throw new WechatPayError('WECHAT_ORDER_FAILED', message, response.status === 400 ? 400 : 502);
    }
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    this.verifyResponse(headers, text);
    return text;
  }

  async createJsapiOrder(input: JsapiOrderInput): Promise<JsapiOrder> {
    const text = await this.post('/v3/pay/transactions/jsapi', {
      appid: this.config.appid, mchid: this.config.mchid, description: input.description,
      out_trade_no: input.outTradeNo, time_expire: input.expiresAt, notify_url: input.notifyUrl,
      amount: { total: input.amountCents, currency: 'CNY' }, payer: { openid: input.openid },
    });
    let prepayId: unknown;
    try { prepayId = (JSON.parse(text) as Record<string, unknown>).prepay_id; } catch { throw new WechatPayError('WECHAT_RESPONSE_INVALID', '微信支付返回了无法解析的下单结果。'); }
    if (typeof prepayId !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(prepayId)) throw new WechatPayError('WECHAT_RESPONSE_INVALID', '微信支付未返回有效的预支付标识。');
    return { prepayId, payment: this.paymentParams(prepayId) };
  }

  async createNativeOrder(input: NativeOrderInput): Promise<NativeOrder> {
    const text = await this.post('/v3/pay/transactions/native', {
      appid: this.config.appid, mchid: this.config.mchid, description: input.description,
      out_trade_no: input.outTradeNo, time_expire: input.expiresAt, notify_url: input.notifyUrl,
      amount: { total: input.amountCents, currency: 'CNY' },
    });
    let codeUrl: unknown;
    try { codeUrl = (JSON.parse(text) as Record<string, unknown>).code_url; } catch { throw new WechatPayError('WECHAT_RESPONSE_INVALID', '微信支付返回了无法解析的下单结果。'); }
    if (typeof codeUrl !== 'string' || !/^weixin:\/\/[^\s]{10,512}$/.test(codeUrl)) throw new WechatPayError('WECHAT_RESPONSE_INVALID', '微信支付未返回有效的扫码链接。');
    return { codeUrl };
  }

  paymentParams(prepayId: string): WechatPaymentParams {
    const timeStamp = Math.floor(this.now() / 1000).toString();
    const nonceStr = nonce();
    const packageValue = `prepay_id=${prepayId}`;
    const message = `${this.config.appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
    const paySign = createSign('RSA-SHA256').update(message).sign(this.privateKey, 'base64');
    return { appId: this.config.appid, timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
  }

  parseNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): NotifyPayload {
    this.verifyResponse(headers, rawBody);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch { throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知不是有效 JSON。'); }
    const resource = parsed.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知缺少 resource。');
    const item = resource as Record<string, unknown>;
    if (item.algorithm !== 'AEAD_AES_256_GCM' || typeof item.ciphertext !== 'string' || typeof item.nonce !== 'string' || typeof item.associated_data !== 'string'
      || !/^[A-Za-z0-9+/=]{16,}$/.test(item.ciphertext) || Buffer.byteLength(item.nonce, 'utf8') !== 12) throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知加密字段无效。');
    const ciphertext = Buffer.from(item.ciphertext, 'base64');
    if (ciphertext.length <= 16) throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知密文无效。');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.apiV3Key, 'utf8'), Buffer.from(item.nonce, 'utf8'));
    decipher.setAAD(Buffer.from(item.associated_data, 'utf8'));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    let plain: string;
    try { plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]).toString('utf8'); }
    catch { throw new WechatPayError('WECHAT_NOTIFY_DECRYPT_FAILED', '微信支付通知解密失败。'); }
    let transaction: Record<string, unknown>;
    try { transaction = JSON.parse(plain) as Record<string, unknown>; } catch { throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知明文不是有效 JSON。'); }
    const amount = transaction.amount;
    const payer = transaction.payer;
    if (typeof transaction.mchid !== 'string' || typeof transaction.appid !== 'string' || typeof transaction.out_trade_no !== 'string'
      || typeof transaction.transaction_id !== 'string' || typeof transaction.trade_state !== 'string' || typeof transaction.success_time !== 'string'
      || !amount || typeof amount !== 'object' || !Number.isSafeInteger((amount as Record<string, unknown>).total) || typeof (amount as Record<string, unknown>).currency !== 'string') {
      throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知缺少交易字段。');
    }
    if (typeof parsed.id !== 'string' || typeof parsed.event_type !== 'string') throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知缺少事件标识。');
    return {
      id: parsed.id, eventType: parsed.event_type,
      ...(typeof item.original_type === 'string' ? { resourceType: item.original_type } : {}),
      transaction: {
        mchid: transaction.mchid, appid: transaction.appid, outTradeNo: transaction.out_trade_no,
        transactionId: transaction.transaction_id, tradeState: transaction.trade_state, successTime: transaction.success_time,
        amountCents: (amount as Record<string, number>).total, currency: (amount as Record<string, string>).currency,
        ...(payer && typeof payer === 'object' && typeof (payer as Record<string, unknown>).openid === 'string' ? { openid: (payer as Record<string, string>).openid } : {}),
      },
    };
  }
}
