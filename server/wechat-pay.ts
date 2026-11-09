import { createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from 'node:crypto';
import type { WechatPaymentParams } from '../shared/payment.js';
import type { PaymentConfig } from './payment-config.js';
import type { GatewayRefundStatus, RefundGateway, RefundTarget, WechatRefundNotification } from './refund-gateway.js';

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

export interface WechatPayGateway extends Partial<RefundGateway> {
  createJsapiOrder(input: JsapiOrderInput): Promise<JsapiOrder>;
  createNativeOrder(input: NativeOrderInput): Promise<NativeOrder>;
  /** Re-signs client payment parameters for an existing prepay_id. */
  paymentParams(prepayId: string): WechatPaymentParams;
  parseNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): NotifyPayload;
  parseRefundNotification?(headers: Record<string, string | string[] | undefined>, rawBody: string): WechatRefundNotification;
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

const refundStates: Record<string, GatewayRefundStatus> = { SUCCESS: 'succeeded', CLOSED: 'closed', ABNORMAL: 'abnormal', PROCESSING: 'processing' };
function refundResult(row: Record<string, unknown>, state: unknown): WechatRefundNotification {
  const amount = row.amount as Record<string, unknown> | undefined;
  const status = typeof state === 'string' && Object.hasOwn(refundStates, state) ? refundStates[state] : undefined;
  if (!status || typeof row.out_refund_no !== 'string' || typeof row.out_trade_no !== 'string' || typeof row.transaction_id !== 'string'
    || !amount || typeof amount.total !== 'number' || !Number.isSafeInteger(amount.total) || amount.total <= 0
    || amount.refund !== amount.total || (amount.currency !== undefined && amount.currency !== 'CNY')) {
    throw new WechatPayError('WECHAT_REFUND_INVALID', '微信退款结果的订单、状态或金额无效。');
  }
  return { id: row.out_refund_no, outTradeNo: row.out_trade_no, transactionId: row.transaction_id, amountCents: amount.total, status };
}

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

  private async request(method: 'GET' | 'POST', path: string, payload?: unknown) {
    const raw = payload === undefined ? '' : JSON.stringify(payload);
    try {
      const response = await this.fetchImpl(`https://api.mch.weixin.qq.com${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(8_000), headers: {
          Authorization: this.authorization(method, path, raw),
          Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'resume-youfang/1.0',
        }, ...(method === 'POST' ? { body: raw } : {}),
      });
      return { response, text: await response.text() };
    } catch { throw new WechatPayError('WECHAT_UNAVAILABLE', '暂时无法连接微信支付，请稍后重试。'); }
  }

  private verifyHttpResponse(response: Response, text: string) {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    this.verifyResponse(headers, text);
  }

  private async post(path: string, payload: unknown): Promise<string> {
    const { response, text } = await this.request('POST', path, payload);
    if (!response.ok) {
      let message = '微信支付下单失败，请稍后重试。';
      try { const parsed = JSON.parse(text); if (typeof parsed.message === 'string' && parsed.message.length < 200) message = parsed.message; } catch { /* Keep the generic message. */ }
      throw new WechatPayError('WECHAT_ORDER_FAILED', message, response.status === 400 ? 400 : 502);
    }
    this.verifyHttpResponse(response, text);
    return text;
  }

  private async refundRequest(method: 'GET' | 'POST', path: string, payload?: unknown) {
    const { response, text } = await this.request(method, path, payload);
    this.verifyHttpResponse(response, text);
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(text);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
    } catch { throw new WechatPayError('WECHAT_REFUND_INVALID', '微信退款服务返回了无效数据。'); }
    if (response.ok) return row;
    if (response.status === 404 && row.code === 'RESOURCE_NOT_EXISTS') return null;
    throw new WechatPayError('WECHAT_REFUND_UNCONFIRMED', '微信退款结果暂未确认，请核对后重试。');
  }

  private refundStatus(target: RefundTarget, row: Record<string, unknown>) {
    const result = refundResult(row, row.status);
    if (result.id !== target.id || result.outTradeNo !== target.outTradeNo || result.transactionId !== target.transactionId
      || result.amountCents !== target.amountCents) throw new WechatPayError('WECHAT_REFUND_MISMATCH', '微信退款结果与原订单不匹配。');
    return result.status;
  }

  async submitRefund(target: RefundTarget, notifyUrl?: string): Promise<GatewayRefundStatus> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(target.outTradeNo)}?mchid=${encodeURIComponent(this.config.mchid)}`;
    const payment = await this.refundRequest('GET', path);
    const amount = payment?.amount as Record<string, unknown> | undefined;
    if (!payment || payment.trade_state !== 'SUCCESS' || payment.appid !== this.config.appid || payment.mchid !== this.config.mchid
      || payment.out_trade_no !== target.outTradeNo || payment.transaction_id !== target.transactionId
      || amount?.total !== target.amountCents || amount.currency !== 'CNY') {
      throw new WechatPayError('WECHAT_REFUND_PAYMENT_MISMATCH', '微信订单状态、交易号或金额未通过核对。');
    }
    const row = await this.refundRequest('POST', '/v3/refund/domestic/refunds', {
      transaction_id: target.transactionId, out_refund_no: target.id,
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
      amount: { refund: target.amountCents, total: target.amountCents, currency: 'CNY' },
    });
    if (!row) throw new WechatPayError('WECHAT_REFUND_UNCONFIRMED', '微信退款尚未确认。');
    this.refundStatus(target, row);
    return 'processing';
  }

  async queryRefund(target: RefundTarget) {
    const row = await this.refundRequest('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(target.id)}`);
    return row ? this.refundStatus(target, row) : 'not-found' as const;
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

  private decryptNotification(headers: Record<string, string | string[] | undefined>, rawBody: string) {
    this.verifyResponse(headers, rawBody);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch { throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知不是有效 JSON。'); }
    const resource = parsed?.resource;
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
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) throw new WechatPayError('WECHAT_NOTIFY_INVALID', '微信支付通知明文无效。');
    return { parsed, item, transaction };
  }

  parseRefundNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): WechatRefundNotification {
    const { parsed, transaction } = this.decryptNotification(headers, rawBody);
    const result = refundResult(transaction, transaction.refund_status);
    if (transaction.mchid !== this.config.mchid || parsed.event_type !== `REFUND.${transaction.refund_status}`) {
      throw new WechatPayError('WECHAT_REFUND_NOTIFY_INVALID', '微信退款通知的商户或状态不匹配。', 400);
    }
    return result;
  }

  parseNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): NotifyPayload {
    const { parsed, item, transaction } = this.decryptNotification(headers, rawBody);
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
