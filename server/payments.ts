import { randomUUID } from 'node:crypto';
import type { CheckoutResult, MembershipQuote, NativePaymentParams, PaymentChannel, PaymentOrder, WechatPaymentParams } from '../shared/payment.js';
import type { PaidPlanId, PlanId } from '../shared/types.js';
import { HttpError, invalid } from './errors.js';
import type { JsonStore } from './store.js';
import type { QuotaService } from './quota.js';
import { defaultPricing, planPricing, type BillingPricing } from './payment-config.js';
import { newOutTradeNo, orderTtlMilliseconds, type StoredPaymentOrder } from './payment-storage.js';
import { WechatPayError, type NativeOrder, type NotifyPayload, type WechatPayGateway } from './wechat-pay.js';
import qrcode from 'qrcode-generator';
import { listPlans, membershipState } from './membership.js';

export interface PaymentServiceOptions {
  store: JsonStore;
  quota: QuotaService;
  pricing?: BillingPricing;
  gateway?: WechatPayGateway;
  appid?: string;
  mchid?: string;
  notifyUrl?: string;
  now?: () => Date;
}

function paid(planId: unknown): PaidPlanId {
  if (typeof planId !== 'string' || !['basic', 'premium'].includes(planId)) throw new HttpError(400, 'INVALID_PLAN', '请选择有效的付费方案。');
  return planId as PaidPlanId;
}
function publicOrder(order: StoredPaymentOrder): PaymentOrder {
  return {
    id: order.id, planId: order.planId, amountCents: order.amountCents, status: order.status, channel: order.channel,
    createdAt: order.createdAt, expiresAt: order.expiresAt, ...(order.paidAt ? { paidAt: order.paidAt } : {}),
  };
}
function mapGatewayError(error: unknown): never {
  if (error instanceof WechatPayError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}
async function nativeParams(order: StoredPaymentOrder, codeUrl: string): Promise<NativePaymentParams> {
  const qr = qrcode(0, 'M');
  qr.addData(codeUrl);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return { codeUrl, qrCodeDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, expiresAt: order.expiresAt };
}

export class PaymentService {
  readonly pricing: BillingPricing;
  private readonly store: JsonStore;
  private readonly quota: QuotaService;
  private readonly gateway?: WechatPayGateway;
  private readonly appid?: string;
  private readonly mchid?: string;
  private readonly notifyUrl?: string;
  private readonly now: () => Date;

  constructor(options: PaymentServiceOptions) {
    this.store = options.store;
    this.quota = options.quota;
    this.pricing = options.pricing ?? defaultPricing;
    this.gateway = options.gateway;
    this.appid = options.appid;
    this.mchid = options.mchid;
    this.notifyUrl = options.notifyUrl;
    this.now = options.now ?? (() => new Date());
    if (this.gateway && (!this.appid || !this.mchid || !this.notifyUrl)) throw new Error('Payment gateway requires appid, mchid and notify URL.');
  }

  get available(): boolean { return this.gateway !== undefined; }

  plans() { return listPlans(this.pricing); }

  async membership(userId: string) {
    const quota = await this.quota.current(userId);
    const record = await this.quota.getMembershipRecord(userId);
    return membershipState(quota, record?.planId, this.available);
  }

  async quote(userId: string, planId: PlanId): Promise<MembershipQuote> {
    const target = paid(planId);
    const record = await this.quota.getMembershipRecord(userId);
    const now = this.now().getTime();
    const active = record !== null && Date.parse(record.startsAt) <= now && now < Date.parse(record.expiresAt);
    if (active && record.planId === 'premium' && target === 'basic') {
      throw new HttpError(409, 'MEMBERSHIP_DOWNGRADE_NOT_SUPPORTED', '高级会员有效期内不能改为初级会员，请在到期后选择。');
    }
    const targetPrice = planPricing(this.pricing, target);
    let amountCents = targetPrice.priceCents;
    let kind: MembershipQuote['kind'] = 'purchase';
    if (active && record.planId === target) kind = 'renewal';
    else if (active && record.planId === 'basic' && target === 'premium') {
      kind = 'upgrade';
      amountCents = Math.max(0, targetPrice.priceCents - planPricing(this.pricing, 'basic').priceCents);
    }
    return {
      planId: target, amountCents, kind, currentPlanId: active ? record.planId : 'free',
      ...(targetPrice.listPriceCents !== undefined ? { listPriceCents: targetPrice.listPriceCents } : {}),
      ...(targetPrice.promotionLabel !== undefined ? { promotionLabel: targetPrice.promotionLabel } : {}),
    };
  }

  async checkout(userId: string, body: unknown): Promise<CheckoutResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求体必须是 JSON 对象。');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['planId', 'requestId', 'channel'].includes(key))) invalid('请求体只支持 planId、requestId 和 channel。');
    const planId = paid(input.planId);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId)) invalid('缺少有效的支付请求标识。');
    const requestId = input.requestId;
    const channelValue = input.channel === undefined ? 'jsapi' : input.channel;
    if (channelValue !== 'jsapi' && channelValue !== 'native') invalid('支付方式不正确。');
    const channel: PaymentChannel = channelValue;
    if (!this.gateway || !this.notifyUrl) throw new HttpError(503, 'PAYMENT_NOT_CONFIGURED', '支付尚未配置完成，本次未扣费。');
    const quote = await this.quote(userId, planId);
    const snapshot = await this.store.read();
    const existing = snapshot.orders.find(order => order.userId === userId && order.requestId === requestId);
    if (existing) return this.reuse(userId, existing, quote, channel);
    const user = snapshot.users.find(candidate => candidate.id === userId);
    if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    if (channel === 'jsapi' && !user.wechatOpenid) throw new HttpError(409, 'WECHAT_NOT_BOUND', '请先在小程序内绑定微信后再支付。');
    const now = this.now();
    const order: StoredPaymentOrder = {
      id: randomUUID(), userId, planId, amountCents: quote.amountCents, status: 'pending',
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + orderTtlMilliseconds).toISOString(),
      outTradeNo: newOutTradeNo(now.getTime()), requestId, channel,
      description: `简历有方·${planId === 'basic' ? '初级' : '高级'}会员`,
    };
    const created = await this.store.mutate(database => {
      const currentUser = database.users.find(candidate => candidate.id === userId);
      if (!currentUser) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
      if (channel === 'jsapi' && !currentUser.wechatOpenid) throw new HttpError(409, 'WECHAT_NOT_BOUND', '请先在小程序内绑定微信后再支付。');
      const duplicate = database.orders.find(candidate => candidate.userId === userId && candidate.requestId === requestId);
      if (duplicate) return { order: duplicate, created: false };
      database.orders.push(order);
      return { order, created: true };
    });
    if (!created.created) return this.reuse(userId, created.order, quote, channel);
    let prepayId: string | undefined;
    let payment: WechatPaymentParams | undefined;
    let codeUrl: string | undefined;
    try {
      if (channel === 'native') {
        const result: NativeOrder = await this.gateway.createNativeOrder({
          outTradeNo: order.outTradeNo, description: order.description, amountCents: order.amountCents,
          notifyUrl: this.notifyUrl, expiresAt: order.expiresAt,
        });
        codeUrl = result.codeUrl;
      } else {
        const result = await this.gateway.createJsapiOrder({
          outTradeNo: order.outTradeNo, description: order.description, amountCents: order.amountCents,
          openid: user.wechatOpenid!, notifyUrl: this.notifyUrl, expiresAt: order.expiresAt,
        });
        prepayId = result.prepayId;
        payment = result.payment;
      }
    } catch (error) {
      await this.store.mutate(database => {
        const stored = database.orders.find(candidate => candidate.id === order.id);
        if (stored?.status === 'pending') stored.status = 'failed';
      });
      mapGatewayError(error);
    }
    const updated = await this.store.mutate(database => {
      const stored = database.orders.find(candidate => candidate.id === order.id);
      if (!stored) throw new Error('Payment order disappeared.');
      if (stored.status === 'pending') {
        if (prepayId) stored.prepayId = prepayId;
        if (codeUrl) stored.codeUrl = codeUrl;
      }
      return stored;
    });
    if (channel === 'native') {
      if (!codeUrl) throw new HttpError(502, 'WECHAT_RESPONSE_INVALID', '微信支付未返回扫码链接，请稍后重试。');
      return { order: publicOrder(updated), native: await nativeParams(order, codeUrl) };
    }
    if (!payment) throw new HttpError(502, 'WECHAT_RESPONSE_INVALID', '微信支付未返回支付参数，请稍后重试。');
    return { order: publicOrder(updated), payment };
  }

  private async reuse(userId: string, order: StoredPaymentOrder, quote: MembershipQuote, channel: PaymentChannel): Promise<CheckoutResult> {
    if (order.planId !== quote.planId || order.amountCents !== quote.amountCents || order.channel !== channel) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_CONFLICT', '相同支付请求标识不能用于不同的方案、金额或支付方式。');
    }
    if (order.status === 'paid') throw new HttpError(409, 'ORDER_ALREADY_PAID', '该订单已支付，请勿重复支付。');
    if (order.status !== 'pending') throw new HttpError(409, 'ORDER_CLOSED', '该订单已关闭，请重新下单。');
    if (Date.parse(order.expiresAt) <= this.now().getTime()) throw new HttpError(409, 'ORDER_EXPIRED', '订单已过期，请重新下单。');
    if (channel === 'native') {
      if (!order.codeUrl) throw new HttpError(409, 'ORDER_PENDING', '订单正在创建中，请稍后重试。');
      return { order: publicOrder(order), native: await nativeParams(order, order.codeUrl) };
    }
    if (!order.prepayId || !this.gateway) throw new HttpError(409, 'ORDER_PENDING', '订单正在创建中，请稍后重试。');
    return { order: publicOrder(order), payment: this.gateway.paymentParams(order.prepayId) };
  }

  async getOrder(userId: string, orderId: string): Promise<PaymentOrder> {
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(orderId)) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在。');
    const order = (await this.store.read()).orders.find(candidate => candidate.id === orderId && candidate.userId === userId);
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在。');
    return publicOrder(order);
  }

  /** Verifies and applies a WeChat Pay v3 notification. Only trusted gateway data reaches this method. */
  async applyNotification(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ code: 'SUCCESS'; message: string }> {
    if (!this.gateway || !this.appid || !this.mchid) throw new HttpError(503, 'PAYMENT_NOT_CONFIGURED', '支付尚未配置。');
    let payload: NotifyPayload;
    try { payload = this.gateway.parseNotification(headers, rawBody); } catch (error) { mapGatewayError(error); }
    if (payload.eventType !== 'TRANSACTION.SUCCESS') return { code: 'SUCCESS', message: '忽略非成功事件' };
    const transaction = payload.transaction;
    const successAt = new Date(transaction.successTime);
    if (!Number.isFinite(successAt.getTime())) throw new HttpError(400, 'WECHAT_NOTIFY_INVALID', '支付通知的支付时间无效。');
    if (transaction.mchid !== this.mchid || transaction.appid !== this.appid) throw new HttpError(401, 'WECHAT_MERCHANT_MISMATCH', '支付通知的商户或应用不匹配。');
    if (transaction.tradeState !== 'SUCCESS' || transaction.currency !== 'CNY' || !Number.isSafeInteger(transaction.amountCents) || transaction.amountCents <= 0) {
      throw new HttpError(400, 'WECHAT_NOTIFY_INVALID', '支付通知的交易状态或金额无效。');
    }
    const order = (await this.store.read()).orders.find(candidate => candidate.outTradeNo === transaction.outTradeNo);
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '支付通知对应的订单不存在。');
    if (order.amountCents !== transaction.amountCents) throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', '支付金额与订单不一致。');
    if (order.status === 'paid' && (order.transactionId !== transaction.transactionId || order.paymentEventId !== transaction.transactionId)) {
      throw new HttpError(409, 'PAYMENT_EVENT_CONFLICT', '订单已关联其他支付交易。');
    }
    if (order.status !== 'pending' && order.status !== 'paid') throw new HttpError(409, 'ORDER_NOT_PAYABLE', '订单状态不允许入账。');
    const user = (await this.store.read()).users.find(candidate => candidate.id === order.userId);
    if (!user) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单用户不存在。');
    if (order.channel === 'jsapi' && transaction.openid && user.wechatOpenid && transaction.openid !== user.wechatOpenid) {
      throw new HttpError(409, 'PAYMENT_PAYER_MISMATCH', '支付人与绑定微信不一致。');
    }
    // Activation is idempotent and happens before the order flip, so a retry repairs a crash in either direction.
    await this.quota.activateMembership({
      userId: order.userId, planId: order.planId, verifiedPaymentAt: successAt.toISOString(),
      verifiedEventId: transaction.transactionId, idempotencyKey: `wechat:${transaction.transactionId}`,
    });
    await this.store.mutate(database => {
      const stored = database.orders.find(candidate => candidate.outTradeNo === transaction.outTradeNo);
      if (!stored) throw new Error('Payment order disappeared.');
      if (stored.status === 'paid') {
        if (stored.transactionId !== transaction.transactionId) throw new HttpError(409, 'PAYMENT_EVENT_CONFLICT', '订单已关联其他支付交易。');
        return;
      }
      stored.status = 'paid';
      stored.paidAt = successAt.toISOString();
      stored.transactionId = transaction.transactionId;
      stored.paymentEventId = transaction.transactionId;
    });
    return { code: 'SUCCESS', message: '成功' };
  }
}
