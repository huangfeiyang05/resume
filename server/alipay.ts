import { createSign, createVerify } from 'node:crypto';
import type { AlipayPaymentParams } from '../shared/payment.js';
import type { AlipayConfig } from './payment-config.js';
import type { GatewayRefundStatus, RefundGateway, RefundTarget } from './refund-gateway.js';

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

export interface AlipayGateway extends Partial<RefundGateway> {
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

function sameAmount(value: unknown, amountCents: number) {
  return typeof value === 'string' && /^\d{1,9}(?:\.\d{1,2})?$/.test(value) && Math.round(Number(value) * 100) === amountCents;
}

/** Alipay signs/verifies raw values (not URL-encoded), sorted by key. Requests include sign_type; notifications exclude it. */
function signableContent(params: Record<string, string>, includeSignType: boolean): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && (includeSignType || key !== 'sign_type') && params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

export function alipaySignContent(params: Record<string, string>): string {
  return signableContent(params, true);
}

function alipayNotificationSignContent(params: Record<string, string>): string {
  return signableContent(params, false);
}

export class AlipayClient implements AlipayGateway {
  constructor(readonly config: AlipayConfig, private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: typeof fetch = fetch) {}

  private sign(params: Record<string, string>): string {
    return createSign('RSA-SHA256').update(alipaySignContent(params), 'utf8').sign(this.config.privateKeyPem, 'base64');
  }

  private verify(params: Record<string, string>, signature: string): boolean {
    try {
      return createVerify('RSA-SHA256').update(alipayNotificationSignContent(params), 'utf8')
        .verify(this.config.alipayPublicKeyPem, signature, 'base64');
    } catch {
      return false;
    }
  }

  private async refundApi(method: 'alipay.trade.query' | 'alipay.trade.refund' | 'alipay.trade.fastpay.refund.query', biz: Record<string, string>) {
    const params: Record<string, string> = { app_id: this.config.appId, method, format: 'JSON', charset: 'utf-8',
      sign_type: 'RSA2', timestamp: beijingDateTime(this.now()), version: '1.0', biz_content: JSON.stringify(biz) };
    params.sign = this.sign(params);
    let raw: string;
    try {
      const response = await this.fetchImpl(this.config.gateway, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
        headers: { Accept: 'application/json' }, body: new URLSearchParams(params) });
      if (!response.ok) throw new Error();
      raw = await response.text();
    } catch { throw new AlipayError('ALIPAY_REFUND_UNAVAILABLE', '暂时无法核对支付宝退款结果。'); }
    // Signatures cover the original response object, including its JSON escaping.
    const envelope = raw.match(/^\s*\{\s*"([a-z_]+)"\s*:\s*(\{[\s\S]*\})\s*,\s*"sign"\s*:\s*"([A-Za-z0-9+/=]+)"\s*\}\s*$/);
    if (!envelope || ![method.replaceAll('.', '_') + '_response', 'error_response'].includes(envelope[1])
      || !createVerify('RSA-SHA256').update(envelope[2], 'utf8').verify(this.config.alipayPublicKeyPem, envelope[3], 'base64')) {
      throw new AlipayError('ALIPAY_REFUND_SIGNATURE_INVALID', '支付宝退款响应验签失败。');
    }
    try { return JSON.parse(envelope[2]) as Record<string, unknown>; }
    catch { throw new AlipayError('ALIPAY_REFUND_INVALID', '支付宝退款响应格式无效。'); }
  }

  async submitRefund(target: RefundTarget): Promise<GatewayRefundStatus> {
    const trade = { out_trade_no: target.outTradeNo, trade_no: target.transactionId };
    const payment = await this.refundApi('alipay.trade.query', trade);
    if (payment.code !== '10000' || !['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(payment.trade_status))
      || payment.out_trade_no !== trade.out_trade_no || payment.trade_no !== trade.trade_no || !sameAmount(payment.total_amount, target.amountCents)) {
      throw new AlipayError('ALIPAY_REFUND_PAYMENT_MISMATCH', '支付宝订单状态、交易号或金额未通过核对。');
    }
    const row = await this.refundApi('alipay.trade.refund', {
      ...trade, out_request_no: target.id, refund_amount: amountText(target.amountCents),
    });
    if (row.code !== '10000') throw new AlipayError('ALIPAY_REFUND_UNCONFIRMED', '支付宝退款结果暂未确认，请核对后重试。');
    if (row.out_trade_no !== trade.out_trade_no || row.trade_no !== trade.trade_no) {
      throw new AlipayError('ALIPAY_REFUND_MISMATCH', '支付宝退款结果与原订单不匹配。');
    }
    return row.fund_change === 'Y' && sameAmount(row.refund_fee, target.amountCents) ? 'succeeded' : 'processing';
  }

  async queryRefund(target: RefundTarget): Promise<GatewayRefundStatus | 'not-found'> {
    const row = await this.refundApi('alipay.trade.fastpay.refund.query', {
      out_trade_no: target.outTradeNo, trade_no: target.transactionId, out_request_no: target.id,
    });
    if (row.code !== '10000') throw new AlipayError('ALIPAY_REFUND_UNCONFIRMED', '支付宝退款状态暂未确认。');
    if (row.refund_status === undefined || row.refund_status === '') return 'not-found';
    if (row.out_trade_no !== target.outTradeNo || row.trade_no !== target.transactionId || row.out_request_no !== target.id
      || !sameAmount(row.refund_amount, target.amountCents) || !sameAmount(row.total_amount, target.amountCents)) {
      throw new AlipayError('ALIPAY_REFUND_MISMATCH', '支付宝退款查询结果与原订单不匹配。');
    }
    return row.refund_status === 'REFUND_SUCCESS' ? 'succeeded' : 'unknown';
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
