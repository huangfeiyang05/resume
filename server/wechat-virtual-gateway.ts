import { createHmac } from 'node:crypto';
import { wechatVirtualIosMinimumCents, type WechatVirtualDevice, type WechatVirtualPaymentParams } from '../shared/payment.js';
import type { PaidPlanId } from '../shared/membership.js';
import { HttpError } from './errors.js';
import { virtualOfferIdPattern, virtualProductIdPattern, virtualTransactionIdPattern, type StoredPaymentOrder, type StoredVirtualOrder } from './payment-storage.js';
import { wechatFlag, type WechatApi } from './wechat-api.js';
import { wechatRecord } from './wechat-identity.js';

export interface WechatVirtualConfig {
  enabled: boolean;
  ios: boolean;
  offerId: string;
  appKey: string;
  pushToken: string;
  pushAesKey: Buffer;
  products: ReadonlyMap<string, string>;
}

function productKey(planId: PaidPlanId, amount: number) { return planId + ':' + amount; }

export function loadWechatVirtualConfig(env: NodeJS.ProcessEnv = process.env): WechatVirtualConfig | undefined {
  const enabled = wechatFlag('WECHAT_VIRTUAL_PAY_ENABLED', env);
  const ios = wechatFlag('WECHAT_VIRTUAL_PAY_IOS_ENABLED', env);
  const offerId = env.WECHAT_VIRTUAL_PAY_OFFER_ID;
  const appKey = env.WECHAT_VIRTUAL_PAY_APP_KEY;
  const pushToken = env.WECHAT_VIRTUAL_PAY_PUSH_TOKEN;
  const aes = env.WECHAT_VIRTUAL_PAY_PUSH_AES_KEY;
  const catalog = env.WECHAT_VIRTUAL_PAY_PRODUCTS;
  if (!enabled && ![offerId, appKey, pushToken, aes, catalog].some(Boolean)) return undefined;
  if (!offerId || !virtualOfferIdPattern.test(offerId) || !appKey?.trim() || appKey.length > 256
    || !pushToken || !/^[A-Za-z0-9]{3,32}$/.test(pushToken)
    || !aes || !/^[A-Za-z0-9+/]{43}$/.test(aes) || !catalog) {
    throw new Error('WeChat virtual payment requires OfferID, AppKey, message push keys and product mapping.');
  }
  let entries: unknown;
  try { entries = JSON.parse(catalog); } catch { throw new Error('Invalid WeChat virtual payment product mapping.'); }
  const products = new Map<string, string>();
  const ids = new Set<string>();
  for (const [plan, prices] of Object.entries(wechatRecord(entries))) {
    if (plan !== 'basic' && plan !== 'premium') throw new Error('Invalid WeChat virtual payment product plan.');
    for (const [cents, id] of Object.entries(wechatRecord(prices))) {
      if (!/^[1-9]\d{0,7}$/.test(cents) || typeof id !== 'string' || !virtualProductIdPattern.test(id) || ids.has(id)) {
        throw new Error('Invalid or duplicate WeChat virtual payment product.');
      }
      ids.add(id);
      products.set(productKey(plan, Number(cents)), id);
    }
  }
  if (!products.size) throw new Error('WeChat virtual payment product mapping is empty.');
  return { enabled, ios, offerId, appKey, pushToken, pushAesKey: Buffer.from(aes + '=', 'base64'), products };
}

export type VirtualReceipt = { status: 'pending' | 'closed' } | {
  status: 'paid' | 'refunded';
  amountCents: number;
  wxOrderId: string;
  paidAt: string;
  delivered: boolean;
};

export function xpayMac(key: string, value: string) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function invalidResponse(): never {
  throw new HttpError(502, 'WECHAT_VIRTUAL_RESPONSE_INVALID', '微信虚拟支付订单信息暂无法核验。');
}

export class WechatVirtualGateway {
  constructor(readonly config: WechatVirtualConfig, private readonly api: WechatApi) {}

  product(planId: PaidPlanId, amount: number): string | undefined {
    return this.config.products.get(productKey(planId, amount));
  }

  orderDetails(planId: PaidPlanId, amount: number, device: WechatVirtualDevice): StoredVirtualOrder {
    if (!this.config.enabled || (device === 'ios' && !this.config.ios)) {
      throw new HttpError(503, 'WECHAT_VIRTUAL_NOT_CONFIGURED', '此设备的微信小程序支付暂未开放。');
    }
    if (device === 'ios' && amount < wechatVirtualIosMinimumCents) {
      throw new HttpError(409, 'WECHAT_VIRTUAL_IOS_MINIMUM', 'iOS 虚拟支付最低金额为 ¥1，当前报价暂不可购买。');
    }
    const productId = this.product(planId, amount);
    if (!productId) throw new HttpError(409, 'WECHAT_VIRTUAL_PRODUCT_UNAVAILABLE', '当前金额对应的小程序商品暂不可购买。');
    return { offerId: this.config.offerId, productId, device };
  }

  parameters(order: StoredPaymentOrder, sessionKey: string): WechatVirtualPaymentParams {
    const { virtual } = order;
    if (!virtual || virtual.offerId !== this.config.offerId) {
      throw new HttpError(409, 'WECHAT_VIRTUAL_PRODUCT_UNAVAILABLE', '该订单的虚拟支付配置已变更，请重新核对报价。');
    }
    const signData = JSON.stringify({ offerId: virtual.offerId, buyQuantity: 1, env: 0, currencyType: 'CNY',
      productId: virtual.productId, goodsPrice: order.amountCents, outTradeNo: order.outTradeNo });
    return { mode: 'short_series_goods', signData, paySig: xpayMac(this.config.appKey, 'requestVirtualPayment&' + signData),
      signature: xpayMac(sessionKey, signData) };
  }

  private call(path: string, input: Record<string, unknown>) {
    const body = JSON.stringify(input);
    return this.api.call(path, body, xpayMac(this.config.appKey, path + '&' + body));
  }

  async query(order: StoredPaymentOrder, openid: string): Promise<VirtualReceipt> {
    if (order.virtual?.offerId !== this.config.offerId) invalidResponse();
    const payload = await this.call('/xpay/query_order', { openid, env: 0, order_id: order.outTradeNo });
    if (payload.errcode !== 0) invalidResponse();
    const result = wechatRecord(payload.order);
    if (result.order_id !== order.outTradeNo || result.env_type !== 1 || (result.order_type !== 0 && result.order_type !== 7)) invalidResponse();
    if (result.status === 0 || result.status === 1) return { status: 'pending' };
    if (result.status === 6) return { status: 'closed' };
    if (![2, 3, 4, 5, 8].includes(result.status as number)
      || result.order_fee !== order.amountCents || result.paid_fee !== order.amountCents
      || typeof result.wx_order_id !== 'string' || !virtualTransactionIdPattern.test(result.wx_order_id)
      || typeof result.paid_time !== 'number' || !Number.isSafeInteger(result.paid_time) || result.paid_time <= 0 || result.paid_time > 253402300799) invalidResponse();
    const refundStatus = result.status === 5 || result.status === 8;
    if (refundStatus && (typeof result.left_fee !== 'number' || !Number.isSafeInteger(result.left_fee)
      || result.left_fee < 0 || result.left_fee > order.amountCents)) invalidResponse();
    return { status: refundStatus && result.left_fee === 0 ? 'refunded' : 'paid', amountCents: order.amountCents,
      wxOrderId: result.wx_order_id, paidAt: new Date(result.paid_time * 1000).toISOString(), delivered: result.status === 4 || refundStatus };
  }

  async confirmDelivery(order: StoredPaymentOrder) {
    const result = await this.call('/xpay/notify_provide_goods', { order_id: order.outTradeNo, env: 0 });
    if (result.errcode !== undefined && result.errcode !== 0) invalidResponse();
  }
}
