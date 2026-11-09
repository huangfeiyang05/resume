import { paymentChannels, paymentOrderStatuses, type PaymentChannel, type PaymentOrder, type PaymentOrderStatus } from '../shared/payment.js';
import type { PaidPlanId } from '../shared/membership.js';
import { randomBytes } from 'node:crypto';
import type { MembershipActivation } from './quota-storage.js';

export const orderTtlMilliseconds = 2 * 60 * 60 * 1000;

/** Server-only order record. Out-trade numbers and openids never leave the API boundary. */
export interface StoredPaymentOrder extends PaymentOrder {
  userId: string;
  outTradeNo: string;
  description: string;
  prepayId?: string;
  codeUrl?: string;
  requestId?: string;
  reviewId?: string;
  deferTierChange?: true;
  transactionId?: string;
  paymentEventId?: string;
}

export interface PaymentStorage { orders: StoredPaymentOrder[] }

export function paymentActivation(order: StoredPaymentOrder, events: readonly MembershipActivation[] = []) {
  const { paymentEventId, paidAt } = order;
  if (!paymentEventId || !paidAt) return undefined;
  const provider = order.channel.startsWith('alipay-') ? 'alipay' : 'wechat';
  return events.find(event => event.verifiedEventId === paymentEventId && event.idempotencyKey === `${provider}:${paymentEventId}`
    && event.planId === order.planId && Date.parse(event.verifiedPaymentAt) === Date.parse(paidAt));
}

export function summarizePaymentOrder(order: StoredPaymentOrder): PaymentOrder {
  return {
    id: order.id, planId: order.planId, amountCents: order.amountCents, status: order.status, channel: order.channel,
    createdAt: order.createdAt, expiresAt: order.expiresAt, ...(order.paidAt ? { paidAt: order.paidAt } : {}),
  };
}

const plans: PaidPlanId[] = ['basic', 'premium'];
const tradeNumber = /^[A-Za-z0-9_-]{20,32}$/;

function malformed(): never { throw new Error('Unsupported or malformed payment database.'); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  const item = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) return malformed();
  return item;
}
function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function optionalString(value: unknown, pattern: RegExp): boolean {
  return value === undefined || (typeof value === 'string' && pattern.test(value));
}

function normalizeOrder(value: unknown): StoredPaymentOrder {
  const item = object(value,
    ['id', 'userId', 'planId', 'amountCents', 'status', 'createdAt', 'expiresAt', 'outTradeNo', 'description'],
    ['paidAt', 'prepayId', 'codeUrl', 'requestId', 'reviewId', 'deferTierChange', 'transactionId', 'paymentEventId', 'channel']);
  const channel = item.channel === undefined ? 'jsapi' : item.channel;
  if (!paymentChannels.includes(channel as PaymentChannel)) return malformed();
  if (!identifier(item.id) || !identifier(item.userId) || !plans.includes(item.planId as PaidPlanId)
    || !Number.isSafeInteger(item.amountCents) || (item.amountCents as number) <= 0
    || !paymentOrderStatuses.includes(item.status as PaymentOrderStatus)
    || !instant(item.createdAt) || !instant(item.expiresAt)
    || Date.parse(item.expiresAt as string) <= Date.parse(item.createdAt as string)
    || typeof item.outTradeNo !== 'string' || !tradeNumber.test(item.outTradeNo)
    || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 120
    || (item.paidAt !== undefined && !instant(item.paidAt))
    || !optionalString(item.prepayId, /^[A-Za-z0-9_-]{10,128}$/)
    || !optionalString(item.codeUrl, /^weixin:\/\/[^\s]{10,512}$/)
    || !optionalString(item.reviewId, /^[a-f0-9]{64}$/)
    || (item.deferTierChange !== undefined && (item.deferTierChange !== true || item.reviewId === undefined))
    || !optionalString(item.requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
    || !optionalString(item.transactionId, /^[A-Za-z0-9_-]{6,64}$/)
    || !optionalString(item.paymentEventId, /^[A-Za-z0-9_-]{6,128}$/)) return malformed();
  const status = item.status as PaymentOrderStatus;
  if ((status === 'paid') !== (item.paidAt !== undefined) || (status === 'paid') !== (item.transactionId !== undefined) || (status === 'paid') !== (item.paymentEventId !== undefined)) return malformed();
  return { ...(structuredClone(item) as unknown as StoredPaymentOrder), channel: channel as PaymentChannel };
}

/** Missing fields are migrated to an empty list; malformed present fields refuse to load. */
export function normalizePaymentStorage(source: unknown): PaymentStorage {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return malformed();
  const item = source as Record<string, unknown>;
  if (item.orders !== undefined && !Array.isArray(item.orders)) return malformed();
  const orders = ((item.orders ?? []) as unknown[]).map(normalizeOrder);
  if (new Set(orders.map(order => order.id)).size !== orders.length
    || new Set(orders.map(order => order.outTradeNo)).size !== orders.length
    || new Set(orders.map(order => order.transactionId).filter(Boolean)).size !== orders.filter(order => order.transactionId).length
    || new Set(orders.map(order => order.paymentEventId).filter(Boolean)).size !== orders.filter(order => order.paymentEventId).length) return malformed();
  for (const order of orders) {
    if (order.requestId !== undefined && orders.filter(other => other.userId === order.userId && other.requestId === order.requestId).length > 1) return malformed();
    if (order.channel === 'native' && order.codeUrl === undefined && order.status === 'paid') return malformed();
  }
  return { orders };
}

export function newOutTradeNo(now = Date.now()): string {
  const date = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll('-', '');
  return `YF${date}${randomBytes(9).toString('hex').toUpperCase()}`.slice(0, 32);
}
