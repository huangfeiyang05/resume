import { createHash, randomUUID } from 'node:crypto';
import type { AdminRefundPreview, PaymentChannel } from '../shared/types.js';
import { careerObject } from './career-validation.js';
import { HttpError, invalid } from './errors.js';
import { membershipAt, membershipPeriods } from './membership-periods.js';
import { paymentActivation, type StoredPaymentOrder } from './payment-storage.js';
import { quotaIdentifier } from './quota-storage.js';
import { summarizeRefund, type StoredRefund } from './refund-storage.js';
import type { GatewayRefundStatus, RefundGateway, RefundTarget } from './refund-gateway.js';
import { WechatPayError, type WechatPayGateway } from './wechat-pay.js';
import type { Database, JsonStore } from './store.js';
import { workbenchAccessForMembership } from './workbench-access.js';

const previewLifetime = 10 * 60_000;
const terminal = (status: StoredRefund['status']) => status === 'succeeded' || status === 'closed';
const queryInterval = (channel: PaymentChannel) => channel.startsWith('alipay-') ? 10_000 : 60_000;
type Preview = { id: string; orderId: string; revision: string; expires: number };

function orderId(value: unknown) {
  if (!quotaIdentifier(value)) invalid('订单 ID 无效。');
  return value;
}

function orderFor(database: Database, id: string) {
  const order = database.orders.find(item => item.id === id);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在。');
  return order;
}

function refundableOrder(database: Database, id: string) {
  const order = orderFor(database, id);
  const membership = database.memberships.find(item => item.userId === order.userId);
  if (order.status !== 'paid' || !order.paymentEventId || order.transactionId !== order.paymentEventId
    || !paymentActivation(order, membership?.activations)) {
    throw new HttpError(409, 'REFUND_ORDER_UNVERIFIED', '订单尚无可核对的支付和会员开通记录。');
  }
  return { order, membership };
}

function target(order: StoredPaymentOrder, refund: StoredRefund): RefundTarget {
  return { id: refund.id, outTradeNo: order.outTradeNo, transactionId: order.transactionId!, amountCents: refund.amountCents };
}

export class AdminRefunds {
  private readonly previews = new Map<string, Preview>();
  private readonly inFlight = new Set<string>();
  private readonly rechecks = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private readonly notifyUrl?: string;

  constructor(private readonly store: JsonStore, private readonly gateways: {
    wechat?: WechatPayGateway; alipay?: Partial<RefundGateway>; notifyUrl?: string;
  } = {}, private readonly now: () => number = Date.now) {
    this.notifyUrl = gateways.notifyUrl ? new URL('/api/v1/billing/wechat/refund-notify', gateways.notifyUrl).toString() : undefined;
  }

  available(channel: PaymentChannel) {
    const alipay = channel.startsWith('alipay-');
    const gateway = alipay ? this.gateways.alipay : this.gateways.wechat;
    return !!(gateway?.submitRefund && gateway.queryRefund && (alipay || (this.notifyUrl && this.gateways.wechat?.parseRefundNotification)));
  }

  private gateway(channel: PaymentChannel): RefundGateway {
    if (!this.available(channel)) throw new HttpError(503, 'REFUND_NOT_CONFIGURED', '该订单的支付渠道暂未开放退款。');
    return (channel.startsWith('alipay-') ? this.gateways.alipay : this.gateways.wechat) as RefundGateway;
  }

  async recover() {
    if (!this.available('jsapi') && !this.available('alipay-page')) return;
    const database = await this.store.read();
    const orders = new Map(database.orders.map(order => [order.id, order]));
    for (const refund of database.refunds) {
      const order = orders.get(refund.orderId);
      if (order) this.schedule(order, refund);
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.rechecks.values()) clearTimeout(timer);
    this.rechecks.clear();
  }

  private schedule(order: StoredPaymentOrder, refund: ReturnType<typeof summarizeRefund>, attempt = 0) {
    const multiplier = [1, 3, 6][attempt];
    if (this.stopped || !multiplier || terminal(refund.status) || !this.available(order.channel) || this.rechecks.has(refund.id)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(refund.id);
      void this.recheck(order, refund.id, attempt);
    }, multiplier * queryInterval(order.channel));
    this.rechecks.set(refund.id, timer.unref());
  }

  private async recheck(order: StoredPaymentOrder, id: string, attempt: number) {
    if (this.stopped) return;
    try {
      const refund = (await this.store.read()).refunds.find(item => item.id === id);
      if (!refund || terminal(refund.status) || this.stopped) return;
      const summary = this.now() - Date.parse(refund.updatedAt) < queryInterval(order.channel)
        ? refund : await this.run(order, refund, 'query');
      this.schedule(order, summary, attempt + 1);
    } catch {
      // Persisted intents remain queryable after an unavailable store or restart.
    }
  }

  private review(database: Database, id: string) {
    const { order, membership } = refundableOrder(database, id);
    this.gateway(order.channel);
    const refunds = database.refunds.filter(refund => refund.userId === order.userId);
    if (refunds.some(refund => refund.orderId === id || !terminal(refund.status))) {
      throw new HttpError(409, 'REFUND_ALREADY_REQUESTED', '本单已有退款记录，或该账号还有待核对的退款。');
    }
    const now = this.now();
    const current = membershipPeriods(membership, refunds, now);
    const remaining = membershipPeriods(membership, refunds, now, order.paymentEventId);
    const review = { orderId: id, userId: order.userId, channel: order.channel, amountCents: order.amountCents,
      before: workbenchAccessForMembership(membershipAt(current, now), now),
      after: workbenchAccessForMembership(membershipAt(remaining, now), now),
      remaining: remaining.filter(period => Date.parse(period.expiresAt) > now)
        .map(({ planId, startsAt, expiresAt }) => ({ planId, startsAt, expiresAt })),
    };
    const revision = createHash('sha256').update(JSON.stringify({ review, order, membership, refunds })).digest('hex');
    return { order, review, revision };
  }

  async preview(body: unknown, actorId: string): Promise<AdminRefundPreview> {
    const id = orderId(careerObject(body, ['orderId']).orderId);
    const { review, revision } = this.review(await this.store.read(), id);
    const now = this.now();
    for (const [actor, preview] of this.previews) if (preview.expires <= now) this.previews.delete(actor);
    const preview = { id: randomUUID(), orderId: id, revision, expires: now + previewLifetime };
    this.previews.set(actorId, preview);
    return { id: preview.id, ...review };
  }

  async apply(body: unknown, actorId: string) {
    const input = careerObject(body, ['orderId', 'previewId', 'confirmed']);
    const id = orderId(input.orderId);
    if (!quotaIdentifier(input.previewId) || input.confirmed !== true) invalid('请核对退款金额和会员变化后确认。');
    const previewId = input.previewId;
    const result = await this.store.mutate(database => {
      const existing = database.refunds.find(refund => refund.orderId === id);
      if (existing?.id === previewId && existing.requestedBy === actorId) return { refund: existing };
      const preview = this.previews.get(actorId);
      if (!preview || preview.id !== previewId || preview.orderId !== id || preview.expires <= this.now()) {
        throw new HttpError(409, 'REFUND_PREVIEW_STALE', '退款预览已过期，请重新核对。');
      }
      const { order, revision } = this.review(database, id);
      if (preview.revision !== revision) throw new HttpError(409, 'REFUND_PREVIEW_STALE', '订单或会员权益已变化，请重新核对。');
      const at = new Date(this.now()).toISOString();
      const refund: StoredRefund = { id: previewId, orderId: id, userId: order.userId, paymentEventId: order.paymentEventId!,
        amountCents: order.amountCents, requestedBy: actorId, status: 'requested', createdAt: at, updatedAt: at };
      database.refunds.push(refund);
      database.version = 4;
      return { refund, order };
    });
    if (!result.order) return summarizeRefund(result.refund);
    if (this.previews.get(actorId)?.id === previewId) this.previews.delete(actorId);
    const summary = await this.run(result.order, result.refund, 'submit');
    this.schedule(result.order, summary);
    return summary;
  }

  async refresh(body: unknown) {
    const input = careerObject(body, ['orderId', 'retry']);
    const id = orderId(input.orderId);
    if (input.retry !== undefined && input.retry !== true) invalid('退款重试参数无效。');
    const database = await this.store.read();
    const refund = database.refunds.find(item => item.orderId === id);
    if (!refund) throw new HttpError(404, 'REFUND_NOT_FOUND', '这笔订单没有退款记录。');
    if (terminal(refund.status)) return summarizeRefund(refund);
    const order = orderFor(database, id);
    if (this.now() - Date.parse(refund.updatedAt) < queryInterval(order.channel)) {
      throw new HttpError(429, 'REFUND_QUERY_COOLDOWN', '支付渠道正在处理，请稍后再次查询。');
    }
    const summary = await this.run(order, refund, input.retry === true ? 'retry' : 'query');
    this.schedule(order, summary);
    return summary;
  }

  private async run(order: StoredPaymentOrder, refund: StoredRefund, operation: 'submit' | 'query' | 'retry') {
    if (this.inFlight.has(refund.id) || this.inFlight.size >= 8) return summarizeRefund(refund);
    const gateway = this.gateway(order.channel);
    const payment = target(order, refund);
    this.inFlight.add(refund.id);
    try {
      let status: GatewayRefundStatus | 'not-found';
      try {
        status = operation === 'submit' ? await gateway.submitRefund(payment, this.notifyUrl) : await gateway.queryRefund(payment);
        if (operation === 'retry' && status === 'not-found' && ['requested', 'unknown'].includes(refund.status)) {
          status = await gateway.submitRefund(payment, this.notifyUrl);
        }
      } catch {
        // A timeout or an invalid response leaves the outcome unknown. A refresh
        // always queries the same refund number before an explicit resubmission.
        status = 'unknown';
      }
      return await this.record(refund.id, status === 'not-found' ? 'unknown' : status);
    } finally { this.inFlight.delete(refund.id); }
  }

  private async record(id: string, status: GatewayRefundStatus) {
    const result = await this.store.mutate(database => {
      const refund = database.refunds.find(row => row.id === id);
      if (!refund) throw new HttpError(404, 'REFUND_NOT_FOUND', '退款记录不存在。');
      if (refund.status === 'succeeded' || (refund.status === 'closed' && status !== 'succeeded')) return refund;
      if (status !== 'unknown' || !['processing', 'abnormal'].includes(refund.status)) refund.status = status;
      refund.updatedAt = new Date(Math.max(this.now(), Date.parse(refund.updatedAt))).toISOString();
      if (status === 'succeeded') refund.confirmedAt = refund.updatedAt;
      return refund;
    });
    if (terminal(result.status)) {
      const timer = this.rechecks.get(result.id);
      if (timer) clearTimeout(timer);
      this.rechecks.delete(result.id);
    }
    return summarizeRefund(result);
  }

  async wechatNotification(headers: Record<string, string | string[] | undefined>, raw: string) {
    const gateway = this.gateways.wechat;
    if (!gateway?.parseRefundNotification) throw new HttpError(503, 'REFUND_NOT_CONFIGURED', '微信退款未配置。');
    let notification;
    try { notification = gateway.parseRefundNotification(headers, raw); }
    catch (error) {
      if (error instanceof WechatPayError) throw new HttpError(400, error.code, '微信退款通知未通过校验。');
      throw error;
    }
    const database = await this.store.read();
    const refund = database.refunds.find(item => item.id === notification.id);
    if (!refund) throw new HttpError(404, 'REFUND_NOT_FOUND', '退款记录不存在。');
    const order = orderFor(database, refund.orderId), expected = target(order, refund);
    if (order.channel.startsWith('alipay-') || expected.outTradeNo !== notification.outTradeNo
      || expected.transactionId !== notification.transactionId || expected.amountCents !== notification.amountCents) {
      throw new HttpError(409, 'REFUND_RESULT_MISMATCH', '微信退款通知与订单不匹配。');
    }
    return this.record(refund.id, notification.status);
  }
}
