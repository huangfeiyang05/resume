import type { AdminOrder, AdminOrderQuery, AdminOverview, AdminPage, AdminTask, AdminTaskQuery, AdminUser, PaymentChannel } from '../shared/types.js';
import { adminTaskStatuses, adminUsageStatuses } from '../shared/admin.js';
import { paymentChannels, paymentOrderStatuses } from '../shared/payment.js';
import { invalid } from './errors.js';
import { membershipAt, membershipPeriods } from './membership-periods.js';
import { paymentActivation, summarizePaymentOrder } from './payment-storage.js';
import { summarizeQuota } from './quota.js';
import { quotaIdentifier, quotaWeekMilliseconds, type StoredAiUsage } from './quota-storage.js';
import { summarizeRefund } from './refund-storage.js';
import { workbenchAccessForMembership } from './workbench-access.js';
import type { Database } from './store.js';

const pageSize = 20;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,79}$/;

export function parseAdminUserIds(value = ''): ReadonlySet<string> {
  if (!value.trim()) return new Set();
  const ids = value.split(',').map(id => id.trim());
  if (!ids.every(quotaIdentifier)) throw new Error('ADMIN_USER_IDS must contain comma-separated account IDs.');
  return new Set(ids);
}

function parseSearch(value: unknown, filters: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请提供查询对象。');
  const input = value as Record<string, unknown>;
  const allowed = ['page', 'query', ...filters];
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid('查询包含不支持的字段。');
  const { page = 1, query = '' } = input;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 100_000) invalid('页码无效。');
  if (typeof query !== 'string' || query.length > 254 || /[\u0000-\u001f\u007f]/.test(query)) invalid('查询标识无效。');
  return { input, page, query: query.trim() };
}

export function parseAdminQuery(value: unknown, kind: 'users' | 'tasks'): AdminTaskQuery & { page: number; query: string } {
  const { input, page, query } = parseSearch(value, kind === 'users' ? [] : ['status', 'usageStatus']);
  const { status, usageStatus } = input;
  const taskStatus = adminTaskStatuses.find(value => value === status);
  const taskUsage = adminUsageStatuses.find(value => value === usageStatus);
  if (status !== undefined && !taskStatus) invalid('诊断状态无效。');
  if (usageStatus !== undefined && !taskUsage) invalid('用量状态无效。');
  return { page, query, status: taskStatus, usageStatus: taskUsage };
}

export function parseAdminOrderQuery(value: unknown): AdminOrderQuery & { page: number; query: string } {
  const { input, page, query } = parseSearch(value, ['userId', 'status', 'channel']);
  const { userId, status, channel } = input;
  if (userId !== undefined && !quotaIdentifier(userId)) invalid('用户 ID 无效。');
  const orderStatus = paymentOrderStatuses.find(value => value === status);
  const paymentChannel = paymentChannels.find(value => value === channel);
  if (status !== undefined && !orderStatus) invalid('订单状态无效。');
  if (channel !== undefined && !paymentChannel) invalid('支付渠道无效。');
  return { page, query, userId, status: orderStatus, channel: paymentChannel };
}

function paginate<T>(items: T[], page: number): AdminPage<T> {
  return { page, pageSize, total: items.length, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

export function adminOverview(database: Database, now: number): AdminOverview {
  const userIds = new Set(database.users.map(user => user.id));
  return {
    users: userIds.size,
    newUsers7Days: database.users.filter(user => {
      const createdAt = Date.parse(user.createdAt);
      return now - quotaWeekMilliseconds <= createdAt && createdAt <= now;
    }).length,
    activeMembers: database.memberships.filter(record => userIds.has(record.userId)
      && membershipAt(membershipPeriods(record, database.refunds, now), now)).length,
    failedTasks: database.analysisTasks.filter(task => task.job.status === 'failed').length,
    pendingUsage: database.aiUsage.filter(row => row.status === 'pending').length,
  };
}

export function adminUsers(database: Database, query: string, page: number, now: number): AdminPage<AdminUser> {
  const email = query.toLowerCase();
  const users = paginate(database.users.filter(user => !query || user.id === query || user.email === email || user.phone === query)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), page);
  const memberships = new Map(database.memberships.map(row => [row.userId, row]));
  const usageByUser = new Map(users.items.map(user => [user.id, [] as StoredAiUsage[]]));
  for (const row of database.aiUsage) usageByUser.get(row.userId)?.push(row);
  return { ...users, items: users.items.map(user => {
    const history = memberships.get(user.id);
    const periods = membershipPeriods(history, database.refunds, now);
    const membership = membershipAt(periods, now) ?? periods.at(-1);
    return {
      id: user.id, createdAt: user.createdAt,
      email: user.email ? { address: user.email, verified: user.emailVerified } : null,
      phone: user.phone ?? null,
      wechat: !!user.wechatOpenid,
      membership: membership ? { planId: membership.planId, startsAt: membership.startsAt, expiresAt: membership.expiresAt,
        latestEvent: membership.kind } : null,
      workbench: workbenchAccessForMembership(membership, now),
      quota: summarizeQuota({ memberships: history ? [history] : [], refunds: database.refunds, aiUsage: usageByUser.get(user.id)! }, user.id, now),
    };
  }) };
}

export function adminOrders(database: Database, { page, query, userId, status, channel }: ReturnType<typeof parseAdminOrderQuery>,
  refundAvailable?: (channel: PaymentChannel) => boolean): AdminPage<AdminOrder> {
  const orders = paginate(database.orders.filter(order =>
    (!userId || order.userId === userId) && (!status || order.status === status) && (!channel || order.channel === channel)
    && (!query || order.id === query || order.userId === query || order.outTradeNo === query))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)), page);
  const activations = new Map(database.memberships.map(membership => [membership.userId, membership.activations]));
  const refunds = new Map(database.refunds.map(refund => [refund.orderId, refund]));
  return { ...orders, items: orders.items.map(order => {
    const event = paymentActivation(order, activations.get(order.userId));
    const refund = refunds.get(order.id);
    return { ...summarizePaymentOrder(order), userId: order.userId,
      membershipActivation: event ? { kind: event.kind, startsAt: event.startsAt, expiresAt: event.expiresAt } : null,
      ...(refund ? { refund: summarizeRefund(refund) } : {}),
      ...(event && order.status === 'paid' && order.transactionId === order.paymentEventId && refundAvailable?.(order.channel)
        ? { refundable: true as const } : {}),
    };
  }) };
}

export function adminTasks(database: Database, { page, query, status, usageStatus }: ReturnType<typeof parseAdminQuery>): AdminPage<AdminTask> {
  const ledger = new Map(database.aiUsage.map(row => [row.taskId, row]));
  const rows: AdminTask[] = database.analysisTasks.map(task => {
    const { job } = task;
    const usage = ledger.get(job.id);
    const linked = usage?.userId === task.userId;
    if (linked) ledger.delete(job.id);
    const code = job.error?.code;
    return { id: job.id, userId: task.userId, engine: task.engine, status: job.status,
      errorCode: code && errorCodePattern.test(code) ? code : null, resumeRevision: task.snapshot.revision,
      createdAt: job.createdAt, updatedAt: job.updatedAt, usageStatus: linked ? usage.status : null };
  });
  // Deleting a resume removes its diagnosis tasks. Unresolved charges still need to be found.
  for (const row of ledger.values()) {
    if (row.status !== 'pending') continue;
    rows.push({ id: row.taskId, userId: row.userId, engine: 'bailian', status: null, errorCode: null,
      resumeRevision: null, createdAt: row.createdAt, updatedAt: row.updatedAt, usageStatus: row.status });
  }
  return paginate(rows.filter(row => (!query || row.id === query || row.userId === query || row.errorCode === query.toUpperCase())
    && (!status || row.status === status) && (!usageStatus || row.usageStatus === usageStatus))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), page);
}
