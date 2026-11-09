import { refundStatuses, type AdminRefund } from '../shared/admin.js';
import type { StoredPaymentOrder } from './payment-storage.js';
import { quotaIdentifier, quotaInstant } from './quota-storage.js';

export interface StoredRefund extends AdminRefund {
  orderId: string;
  userId: string;
  paymentEventId: string;
}

export function summarizeRefund(refund: StoredRefund): AdminRefund {
  const { id, status, amountCents, requestedBy, createdAt, updatedAt, confirmedAt } = refund;
  return { id, status, amountCents, requestedBy, createdAt, updatedAt, ...(confirmedAt ? { confirmedAt } : {}) };
}

export function normalizeRefunds(value: unknown, orders: StoredPaymentOrder[]): StoredRefund[] {
  if (value === undefined) return [];
  const malformed = () => { throw new Error('Unsupported or malformed refund database.'); };
  if (!Array.isArray(value)) return malformed();
  const byId = new Map(orders.map(order => [order.id, order]));
  const ids = new Set<string>(), orderIds = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'orderId', 'userId', 'paymentEventId', 'amountCents', 'status', 'requestedBy', 'createdAt', 'updatedAt', 'confirmedAt'].includes(key))) return malformed();
    const row = item as Partial<StoredRefund>;
    const order = row.orderId && byId.get(row.orderId);
    if (!order || order.status !== 'paid' || order.userId !== row.userId || order.amountCents !== row.amountCents
      || order.paymentEventId !== row.paymentEventId || !quotaIdentifier(row.paymentEventId)
      || !quotaIdentifier(row.id) || ids.has(row.id) || orderIds.has(order.id) || !quotaIdentifier(row.requestedBy)
      || !refundStatuses.some(status => status === row.status) || !quotaInstant(row.createdAt) || !quotaInstant(row.updatedAt)
      || Date.parse(row.updatedAt) < Date.parse(row.createdAt)
      || (row.status === 'succeeded' ? !quotaInstant(row.confirmedAt) || row.confirmedAt !== row.updatedAt : row.confirmedAt !== undefined)) return malformed();
    ids.add(row.id);
    orderIds.add(order.id);
    return structuredClone(row) as StoredRefund;
  });
}
