import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';
import { type StoredPaymentOrder } from './payment-storage.js';
import { recordMembershipActivation } from './quota.js';
import type { Database, JsonStore } from './store.js';
import { wechatRecord } from './wechat-identity.js';
import type { VirtualReceipt, WechatVirtualGateway } from './wechat-virtual-gateway.js';

type PaidReceipt = Extract<VirtualReceipt, { wxOrderId: string }>;
type VirtualOrder = StoredPaymentOrder & { virtual: NonNullable<StoredPaymentOrder['virtual']> };
type OrderCheck = { order: StoredPaymentOrder; verifiedUnpaid: boolean };
const checkInterval = 2500;

function virtualOrder(order: StoredPaymentOrder | undefined): VirtualOrder {
  if (!order?.virtual || order.channel !== 'wechat-virtual') throw new HttpError(404, 'ORDER_NOT_FOUND', '虚拟支付订单不存在。');
  return order as VirtualOrder;
}

function mismatch(): never {
  throw new HttpError(409, 'WECHAT_VIRTUAL_RECEIPT_MISMATCH', '微信虚拟支付凭证与订单不一致。');
}

function eventId(id: string) { return 'XPAY-' + createHash('sha256').update(id).digest('hex').slice(0, 48); }

export class WechatVirtualPayments {
  private readonly inFlight = new Map<string, Promise<OrderCheck>>();
  private readonly recentChecks = new Map<string, { startedAt: number; verifiedUnpaid: boolean }>();
  private notifications = 0;

  constructor(private readonly store: JsonStore, readonly gateway: WechatVirtualGateway, private readonly now = Date.now) {}

  private payer(database: Database, order: StoredPaymentOrder): string {
    const openid = database.users.find(user => user.id === order.userId)?.wechatOpenid;
    if (!openid) return mismatch();
    return openid;
  }

  /** Owner-authenticated status checks recover a payment even if the delivery push was missed. */
  async refresh(order: StoredPaymentOrder): Promise<OrderCheck> {
    const unchecked = { order, verifiedUnpaid: false };
    if (!order.virtual || order.status === 'closed' || (order.status === 'paid' && order.virtual.delivered)) return unchecked;
    const existing = this.inFlight.get(order.id);
    if (existing) return existing;
    const now = this.now();
    const recent = this.recentChecks.get(order.id);
    if (recent && now - recent.startedAt < checkInterval) {
      return { order, verifiedUnpaid: order.status === 'pending' && recent.verifiedUnpaid };
    }
    if (this.inFlight.size >= 4) return unchecked;
    this.recentChecks.delete(order.id);
    if (this.recentChecks.size >= 512) this.recentChecks.delete(this.recentChecks.keys().next().value!);
    const check = { startedAt: now, verifiedUnpaid: false };
    this.recentChecks.set(order.id, check);
    const operation = this.check(virtualOrder(order)).then(result => {
      check.verifiedUnpaid = result.verifiedUnpaid;
      return result;
    }).catch(error => {
      if (error instanceof HttpError) return unchecked;
      throw error;
    }).finally(() => { this.inFlight.delete(order.id); });
    this.inFlight.set(order.id, operation);
    return operation;
  }

  private async check(order: VirtualOrder): Promise<OrderCheck> {
    const openid = this.payer(await this.store.read(), order);
    const receipt = await this.gateway.query(order, openid);
    if (receipt.status === 'pending') {
      const current = virtualOrder((await this.store.read()).orders.find(row => row.id === order.id));
      return { order: current, verifiedUnpaid: current.status === 'pending' };
    }
    if (receipt.status === 'closed') {
      const current = await this.store.mutate(database => {
        const current = virtualOrder(database.orders.find(row => row.id === order.id));
        if (current.status === 'pending') current.status = 'closed';
        return current;
      });
      return { order: current, verifiedUnpaid: false };
    }
    if (!('wxOrderId' in receipt)) return mismatch();
    const paid = await this.record(order, openid, receipt);
    if (!paid.virtual.delivered) {
      // The entitlement is committed before acknowledging provider delivery.
      try { await this.gateway.confirmDelivery(paid); }
      catch { return { order: paid, verifiedUnpaid: false }; }
      const delivered = await this.store.mutate(database => {
        const current = virtualOrder(database.orders.find(row => row.id === order.id));
        current.virtual.delivered = true;
        return current;
      });
      return { order: delivered, verifiedUnpaid: false };
    }
    return { order: paid, verifiedUnpaid: false };
  }

  private async record(order: VirtualOrder, openid: string, receipt: PaidReceipt, pushed = false) {
    return this.store.mutate(database => {
      const current = virtualOrder(database.orders.find(row => row.id === order.id));
      const now = this.now();
      const paidAt = Date.parse(receipt.paidAt);
      const paymentId = eventId(receipt.wxOrderId);
      if (this.payer(database, current) !== openid || current.amountCents !== receipt.amountCents
        || !Number.isFinite(paidAt) || paidAt < Math.floor(Date.parse(current.createdAt) / 1000) * 1000 || paidAt > now
        || database.orders.some(row => row.id !== current.id && row.virtual?.wxOrderId === receipt.wxOrderId)) mismatch();
      if (current.status === 'paid') {
        if (current.virtual.wxOrderId !== receipt.wxOrderId || current.paymentEventId !== paymentId || current.paidAt !== receipt.paidAt) mismatch();
      } else {
        recordMembershipActivation(database, {
          userId: current.userId, planId: current.planId, verifiedPaymentAt: receipt.paidAt,
          verifiedEventId: paymentId, idempotencyKey: 'wechat-virtual:' + paymentId,
          ...(current.deferTierChange ? { deferTierChange: true as const } : {}),
        }, now);
        current.status = 'paid';
        current.paidAt = receipt.paidAt;
        current.paymentEventId = paymentId;
        current.transactionId = paymentId;
        current.virtual.wxOrderId = receipt.wxOrderId;
      }
      if (receipt.delivered || pushed) current.virtual.delivered = true;
      if (receipt.status === 'refunded') this.recordRefund(database, current, now);
      return current;
    });
  }

  private recordRefund(database: Database, order: VirtualOrder, now: number) {
    if (database.refunds.some(row => row.orderId === order.id)) return;
    const timestamp = new Date(now).toISOString();
    database.refunds.push({
      id: 'XPR-' + order.id, orderId: order.id, userId: order.userId, paymentEventId: order.paymentEventId!,
      status: 'succeeded', amountCents: order.amountCents, requestedBy: 'wechat-virtual',
      createdAt: timestamp, updatedAt: timestamp, confirmedAt: timestamp,
    });
  }

  /** Accepts only an event already authenticated and decrypted by WeChat message push. */
  async notification(event: Record<string, unknown>) {
    const delivery = event.Event === 'xpay_goods_deliver_notify';
    const refund = event.Event === 'xpay_refund_notify';
    if (event.MsgType !== 'event' || (!delivery && !refund) || (refund && event.RetCode !== 0)) return;
    if (this.notifications >= 8) throw new HttpError(503, 'WECHAT_VIRTUAL_BUSY', '虚拟支付核验正忙，请稍后重试。');
    this.notifications++;
    try {
      const outTradeNo = delivery ? event.OutTradeNo : event.MchOrderId;
      const snapshot = await this.store.read();
      const order = virtualOrder(snapshot.orders.find(row => row.outTradeNo === outTradeNo));
      const openid = this.payer(snapshot, order);
      if (event.OpenId !== openid || (delivery && event.Env !== 0)) mismatch();
      if (delivery) {
        const goods = wechatRecord(event.GoodsInfo);
        if (goods.ProductId !== order.virtual.productId || goods.Quantity !== 1 || goods.ActualPrice !== order.amountCents) mismatch();
        if (order.status === 'paid' && order.virtual.delivered) return;
        const receipt = await this.gateway.query(order, openid);
        if (!('wxOrderId' in receipt)) mismatch();
        await this.record(order, openid, receipt, true);
      } else {
        await this.applyRefund(order, openid, event);
      }
    } finally { this.notifications--; }
  }

  private async applyRefund(order: VirtualOrder, openid: string, event: Record<string, unknown>) {
    const fee = event.RefundFee;
    if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee <= 0 || fee > order.amountCents
      || typeof event.WxOrderId !== 'string') mismatch();
    if (order.status === 'paid' && fee === order.amountCents) {
      await this.store.mutate(database => {
        const current = virtualOrder(database.orders.find(row => row.id === order.id));
        if (this.payer(database, current) !== openid || current.virtual.wxOrderId !== event.WxOrderId) mismatch();
        this.recordRefund(database, current, this.now());
      });
      return;
    }
    // Handles an out-of-order push or several partial refunds using the platform's remaining balance.
    const receipt = await this.gateway.query(order, openid);
    if (!('wxOrderId' in receipt) || receipt.wxOrderId !== event.WxOrderId
      || (fee === order.amountCents && receipt.status !== 'refunded')) mismatch();
    await this.record(order, openid, receipt);
  }
}
