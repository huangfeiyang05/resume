import { createSign, createVerify } from 'node:crypto';
import type { AlipayPaymentParams } from '../shared/payment.js';
import type { AlipayConfig } from './payment-config.js';

export interface AlipayPaymentInput {
  mode: 'page' | 'wap';
  outTradeNo: string;
  description: string;
  amountCents: number;
  expiresAt: string;
}

export interface AlipayPayment {
  redirectUrl: string;
}

export interface AlipayNotification {
  appId: string;
  sellerId?: string;
  outTradeNo: string;
  tradeNo: string;
  tradeStatus: 'TRADE_SUCCESS' | 'TRADE_FINISHED';
  amountCents: number;
  paidAt: string;
}

export interface AlipayGateway {
  /** Returns a signed Alipay cashier URL for the H5 browser to open. */
  createPayment(input: AlipayPaymentInput): Promise<AlipayPayment>;
  /** Verifies the RSA2 signature of an asynchronous notification and returns trusted fields. */
  parseNotification(form: Record<string, string>): AlipayNotification;
}

export class AlipayError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); this.name = 'AlipayError'; }
}

const beijingOffsetMilliseconds = 8 * 60 * 60 * 1000;

function beijingDateTime(value: Date): string {
  const shifted = new Date(value.getTime() + beijingOffsetMilliseconds);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function amountText(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AlipayError('ALIPAY_AMOUNT_INVALID', '支付金额无效。', 400);
  return (amountCents / 100).toFixed(2);
}

/** Alipay signs/verifies raw values (not URL-encoded), sorted by key, excluding sign and sign_type. */
export function alipaySignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

export class AlipayClient implements AlipayGateway {
  constructor(readonly config: AlipayConfig, private readonly now: () => Date = () => new Date()) {}

  private sign(params: Record<string, string>): string {
    return createSign('RSA-SHA256').update(alipaySignContent(params), 'utf8').sign(this.config.privateKeyPem, 'base64');
  }

  private verify(params: Record<string, string>, signature: string): boolean {
    try {
      return createVerify('RSA-SHA256').update(alipaySignContent(params), 'utf8')
        .verify(this.config.alipayPublicKeyPem, signature, 'base64');
    } catch {
      return false;
    }
  }

  async createPayment(input: AlipayPaymentInput): Promise<AlipayPayment> {
    const page = input.mode === 'page';
    const createdAt = this.now();
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
      throw new AlipayError('ALIPAY_ORDER_EXPIRED', '订单已过期，请重新下单。', 409);
    }
    const params: Record<string, string> = {
      app_id: this.config.appId,
      method: page ? 'alipay.trade.page.pay' : 'alipay.trade.wap.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: beijingDateTime(createdAt),
      version: '1.0',
      notify_url: this.config.notifyUrl,
      return_url: this.config.returnUrl,
      biz_content: JSON.stringify({
        out_trade_no: input.outTradeNo,
        total_amount: amountText(input.amountCents),
        subject: input.description,
        product_code: page ? 'FAST_INSTANT_TRADE_PAY' : 'QUICK_WAP_WAY',
        time_expire: beijingDateTime(expiresAt),
      }),
    };
    params.sign = this.sign(params);
    const query = new URLSearchParams(params).toString();
    return { redirectUrl: `${this.config.gateway}${this.config.gateway.includes('?') ? '&' : '?'}${query}` };
  }

  parseNotification(form: Record<string, string>): AlipayNotification {
    const signature = form.sign;
    if (!signature) throw new AlipayError('ALIPAY_SIGNATURE_MISSING', '支付宝通知缺少签名。', 401);
    if (form.sign_type !== undefined && form.sign_type !== 'RSA2') throw new AlipayError('ALIPAY_SIGNATURE_TYPE_INVALID', '支付宝通知签名类型不正确。', 401);
    if (!this.verify(form, signature)) throw new AlipayError('ALIPAY_SIGNATURE_INVALID', '支付宝通知签名校验失败。', 401);
    if (form.app_id !== this.config.appId) throw new AlipayError('ALIPAY_APP_MISMATCH', '支付宝通知的应用不匹配。', 401);
    if (this.config.sellerId !== undefined && form.seller_id !== this.config.sellerId) {
      throw new AlipayError('ALIPAY_SELLER_MISMATCH', '支付宝通知的收款商户不匹配。', 401);
    }
    const tradeStatus = form.trade_status;
    if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
      throw new AlipayError('ALIPAY_TRADE_NOT_SUCCESS', '支付宝交易尚未支付成功。', 409);
    }
    if (typeof form.out_trade_no !== 'string' || !/^[A-Za-z0-9_-]{20,32}$/.test(form.out_trade_no)) {
      throw new AlipayError('ALIPAY_NOTIFY_INVALID', '支付宝通知的商户订单号无效。', 400);
    }
    if (typeof form.trade_no !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(form.trade_no)) {
      throw new AlipayError('ALIPAY_NOTIFY_INVALID', '支付宝通知的交易号无效。', 400);
    }
    if (typeof form.total_amount !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(form.total_amount)) {
      throw new AlipayError('ALIPAY_NOTIFY_INVALID', '支付宝通知的金额无效。', 400);
    }
    const amountCents = Math.round(Number(form.total_amount) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AlipayError('ALIPAY_NOTIFY_INVALID', '支付宝通知的金额无效。', 400);
    if (typeof form.gmt_payment !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(form.gmt_payment)) {
      throw new AlipayError('ALIPAY_NOTIFY_INVALID', '支付宝通知的支付时间无效。', 400);
    }
    const paidAt = new Date(`${form.gmt_payment.replace(' ', 'T')}+08:00`).toISOString();
    if (!Number.isFinite(Date.parse(paidAt))) throw new AlipayError('ALIPAY_NOTIFY_INVALID', '支付宝通知的支付时间无效。', 400);
    return {
      appId: form.app_id, ...(form.seller_id ? { sellerId: form.seller_id } : {}),
      outTradeNo: form.out_trade_no, tradeNo: form.trade_no, tradeStatus, amountCents, paidAt,
    };
  }
}

export function publicAlipayPayment(payment: AlipayPayment): AlipayPaymentParams {
  return { redirectUrl: payment.redirectUrl };
}
