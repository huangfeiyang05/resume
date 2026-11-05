import type { PaidPlanId } from '../shared/types.js';
import { HttpError } from './errors.js';
import { calculateMembershipPeriod } from './membership.js';
import {
  normalizeQuotaStorage, normalizeTokenUsage, quotaIdentifier, quotaInstant, quotaWeekMilliseconds, weeklyTokenLimits,
  type MembershipActivation, type QuotaStorage, type StoredAiUsage, type StoredMembership, type TokenUsage,
} from './quota-storage.js';

/** Structural store boundary keeps quota persistence independent of the other local JSON domains. */
export interface QuotaStore {
  read(): Promise<QuotaStorage>;
  mutate<T>(operation: (database: QuotaStorage) => T | Promise<T>): Promise<T>;
}

export interface QuotaSummary {
  status: 'preview' | 'active' | 'inactive';
  remainingPercent: number | null;
  resetsAt: string | null;
  expiresAt: string | null;
  pending: boolean;
}

export interface TrustedMembershipActivation {
  userId: string;
  planId: PaidPlanId;
  verifiedPaymentAt: string;
  verifiedEventId: string;
  idempotencyKey: string;
}

export type TrustedReconciliation = { idempotencyKey: string; reason: string } & (
  { usage: TokenUsage; confirmedNoUsage?: never } | { confirmedNoUsage: true; usage?: never }
);

function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
function validId(value: unknown): void { if (!quotaIdentifier(value)) fail(400, 'INVALID_QUOTA_INPUT', '额度请求标识无效。'); }
function outstanding(row: StoredAiUsage): boolean { return ['reserved', 'dispatched', 'pending'].includes(row.status); }
function sameUsage(left: TokenUsage | undefined, right: TokenUsage): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function actualUsage(value: unknown): TokenUsage {
  try { return normalizeTokenUsage(value); } catch { return fail(502, 'MODEL_USAGE_INVALID', '供应商用量暂时无法确认，额度保留待核对。'); }
}
function rowFor(storage: QuotaStorage, userId: string, taskId: string): StoredAiUsage {
  const row = storage.aiUsage.find(record => record.taskId === taskId && record.userId === userId);
  if (!row) return fail(404, 'QUOTA_TASK_NOT_FOUND', '额度任务不存在。');
  return row;
}
function cycleFor(membership: StoredMembership, instant: number) {
  const anchor = Date.parse(membership.quotaAnchorAt);
  const start = anchor + Math.floor((instant - anchor) / quotaWeekMilliseconds) * quotaWeekMilliseconds;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(Math.min(start + quotaWeekMilliseconds, Date.parse(membership.expiresAt))).toISOString() };
}
function counts(storage: QuotaStorage, membership: StoredMembership, cycleStartsAt: string) {
  let used = 0, reserved = 0;
  for (const row of storage.aiUsage) {
    if (row.userId !== membership.userId || row.mode !== 'metered' || row.quotaAnchorAt !== membership.quotaAnchorAt || row.cycleStartsAt !== cycleStartsAt) continue;
    if (row.status === 'settled') used += row.usage!.totalTokens;
    else if (outstanding(row)) reserved += row.reservedTokens;
  }
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(reserved)) return fail(503, 'QUOTA_UNAVAILABLE', '额度记录暂时不可用。');
  return { used, reserved };
}

/** Local single-process ledger. Callers must obtain userId from a trusted session. No HTTP grant endpoint. */
export class QuotaService {
  constructor(readonly store: QuotaStore, private readonly now: () => Date = () => new Date()) {}

  async getMembershipRecord(userId: string): Promise<StoredMembership | null> {
    validId(userId);
    return (await this.store.read()).memberships.find(record => record.userId === userId) ?? null;
  }

  async current(userId: string): Promise<QuotaSummary> {
    validId(userId);
    const storage = await this.store.read();
    const membership = storage.memberships.find(record => record.userId === userId);
    const pending = storage.aiUsage.some(row => row.userId === userId && outstanding(row));
    if (!membership) return { status: 'preview', remainingPercent: null, resetsAt: null, expiresAt: null, pending };
    const instant = this.now().getTime();
    if (instant < Date.parse(membership.startsAt) || instant >= Date.parse(membership.expiresAt)) {
      return { status: 'inactive', remainingPercent: null, resetsAt: null, expiresAt: membership.expiresAt, pending };
    }
    const cycle = cycleFor(membership, instant);
    const { used } = counts(storage, membership, cycle.startsAt);
    const limit = weeklyTokenLimits[membership.planId];
    return { status: 'active', remainingPercent: Math.ceil(Math.max(0, limit - used) / limit * 100),
      resetsAt: cycle.endsAt, expiresAt: membership.expiresAt, pending };
  }

  async reserve(userId: string, taskId: string, inputHash: string, reserveTokens: number): Promise<StoredAiUsage> {
    validId(userId); validId(taskId);
    if (!/^[a-f0-9]{64}$/.test(inputHash) || !Number.isSafeInteger(reserveTokens) || reserveTokens <= 0) return fail(400, 'INVALID_QUOTA_INPUT', '额度预占参数无效。');
    return this.store.mutate(storage => {
      const previous = storage.aiUsage.find(row => row.taskId === taskId);
      if (previous) {
        if (previous.userId !== userId) return fail(404, 'QUOTA_TASK_NOT_FOUND', '额度任务不存在。');
        if (previous.inputHash !== inputHash || previous.reservedTokens !== reserveTokens) return fail(409, 'QUOTA_IDEMPOTENCY_CONFLICT', '相同额度任务不能携带不同输入。');
        return previous;
      }
      const instant = this.now().getTime(), createdAt = new Date(instant).toISOString();
      const membership = storage.memberships.find(record => record.userId === userId);
      if (membership && (instant < Date.parse(membership.startsAt) || instant >= Date.parse(membership.expiresAt))) return fail(403, 'MEMBERSHIP_EXPIRED', '会员已到期，暂不能发起新的 AI 调用。');
      if (storage.aiUsage.some(row => row.userId === userId && outstanding(row))) return fail(429, 'QUOTA_TASK_PENDING', '已有 AI 调用正在处理或等待用量核对，请稍后重试。');
      const cycle = membership ? cycleFor(membership, instant) : null;
      if (membership && cycle) {
        const { used, reserved } = counts(storage, membership, cycle.startsAt);
        if (reserveTokens > weeklyTokenLimits[membership.planId] - used - reserved) return fail(429, 'AI_QUOTA_EXHAUSTED', '本周剩余额度不足，请在额度刷新后重试。');
      }
      const row: StoredAiUsage = {
        userId, taskId, inputHash, mode: membership ? 'metered' : 'preview', planId: membership?.planId ?? null,
        quotaAnchorAt: membership?.quotaAnchorAt ?? null, cycleStartsAt: cycle?.startsAt ?? null, cycleEndsAt: cycle?.endsAt ?? null,
        reservedTokens: reserveTokens, status: 'reserved', createdAt, updatedAt: createdAt, reconciliations: [],
      };
      storage.aiUsage.push(row);
      return row;
    });
  }

  async dispatch(userId: string, taskId: string): Promise<StoredAiUsage> {
    validId(userId); validId(taskId);
    return this.store.mutate(storage => {
      const row = rowFor(storage, userId, taskId);
      if (row.status === 'dispatched') return row;
      if (row.status !== 'reserved') return fail(409, 'QUOTA_TASK_STATE_CONFLICT', '该额度任务不能再次发送。');
      row.status = 'dispatched'; row.dispatchedAt = row.updatedAt = this.now().toISOString();
      return row;
    });
  }

  /** Settle actual supplier usage even when validation, cancellation, or saving the report failed. */
  async settle(userId: string, taskId: string, value: TokenUsage): Promise<StoredAiUsage> {
    validId(userId); validId(taskId);
    const usage = actualUsage(value);
    return this.store.mutate(storage => this.settleRow(storage, rowFor(storage, userId, taskId), usage));
  }

  private settleRow(storage: QuotaStorage, row: StoredAiUsage, usage: TokenUsage): StoredAiUsage {
    if (row.status === 'settled') {
      if (!sameUsage(row.usage, usage)) return fail(409, 'QUOTA_USAGE_CONFLICT', '相同调用不能使用不同的供应商用量结算。');
      return row;
    }
    if (!['dispatched', 'pending'].includes(row.status)) return fail(409, 'QUOTA_TASK_STATE_CONFLICT', '该额度任务状态不允许结算。');
    if (usage.requestId && storage.aiUsage.some(other => other.taskId !== row.taskId && other.usage?.requestId === usage.requestId)) return fail(409, 'QUOTA_USAGE_CONFLICT', '该供应商调用已关联其他额度任务。');
    row.status = 'settled'; row.usage = usage; row.updatedAt = this.now().toISOString();
    return row;
  }

  async finish(userId: string, taskId: string): Promise<StoredAiUsage> {
    validId(userId); validId(taskId);
    return this.store.mutate(storage => {
      const row = rowFor(storage, userId, taskId);
      if (row.status === 'reserved') row.status = 'released';
      else if (row.status === 'dispatched') row.status = 'pending';
      else return row;
      row.updatedAt = this.now().toISOString();
      return row;
    });
  }

  /** Invoke once on process startup, before accepting model tasks. Unknown usage is never silently freed. */
  async recover(): Promise<void> {
    const storage = await this.store.read();
    if (!storage.aiUsage.some(row => row.status === 'reserved' || row.status === 'dispatched')) return;
    await this.store.mutate(database => {
      const updatedAt = this.now().toISOString();
      for (const row of database.aiUsage) {
        if (row.status === 'reserved') { row.status = 'released'; row.updatedAt = updatedAt; }
        else if (row.status === 'dispatched') { row.status = 'pending'; row.updatedAt = updatedAt; }
      }
    });
  }

  /** Only trusted supplier evidence may resolve unknown usage; this method is not an HTTP operation. */
  async reconcile(userId: string, taskId: string, input: TrustedReconciliation): Promise<StoredAiUsage> {
    validId(userId); validId(taskId);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['idempotencyKey', 'reason', 'usage', 'confirmedNoUsage'].includes(key))
      || !quotaIdentifier(input.idempotencyKey) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 || /\0/.test(input.reason)
      || (input.usage !== undefined) === (input.confirmedNoUsage !== undefined)
      || (input.confirmedNoUsage !== undefined && input.confirmedNoUsage !== true)) return fail(400, 'INVALID_QUOTA_RECONCILIATION', '用量核对必须包含互斥的真实用量或未计费证据，以及审计原因。');
    const usage = input.usage === undefined ? undefined : actualUsage(input.usage);
    return this.store.mutate(storage => {
      const row = rowFor(storage, userId, taskId);
      const previous = row.reconciliations.find(event => event.idempotencyKey === input.idempotencyKey);
      const evidence = { reason: input.reason.trim(), ...(usage ? { usage } : { confirmedNoUsage: true as const }) };
      if (previous) {
        if (JSON.stringify({ reason: previous.reason, ...(previous.usage ? { usage: previous.usage } : { confirmedNoUsage: true }) }) !== JSON.stringify(evidence)) return fail(409, 'QUOTA_IDEMPOTENCY_CONFLICT', '相同核对标识不能携带不同证据。');
        return row;
      }
      if (storage.aiUsage.some(other => other.taskId !== taskId && other.reconciliations.some(event => event.idempotencyKey === input.idempotencyKey))) return fail(409, 'QUOTA_IDEMPOTENCY_CONFLICT', '该核对标识已用于其他调用。');
      if (usage) this.settleRow(storage, row, usage);
      else {
        if (!row.dispatchedAt || row.status === 'settled') return fail(409, 'QUOTA_TASK_STATE_CONFLICT', '已计费用量不能通过未计费证据撤销。');
        row.status = 'released'; row.updatedAt = this.now().toISOString();
      }
      const createdAt = this.now().toISOString();
      row.updatedAt = createdAt;
      row.reconciliations.push({ idempotencyKey: input.idempotencyKey, ...evidence, createdAt });
      return row;
    });
  }

  /** For a future verified payment adapter or audited server operation only. Never expose client grants. */
  async activateMembership(input: TrustedMembershipActivation): Promise<MembershipActivation> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['userId', 'planId', 'verifiedPaymentAt', 'verifiedEventId', 'idempotencyKey'].includes(key))) return fail(400, 'INVALID_MEMBERSHIP_ACTIVATION', '可信会员事件无效。');
    validId(input.userId); validId(input.verifiedEventId); validId(input.idempotencyKey);
    if (!['basic', 'premium'].includes(input.planId) || !quotaInstant(input.verifiedPaymentAt)
      || Date.parse(input.verifiedPaymentAt) > this.now().getTime()) return fail(400, 'INVALID_MEMBERSHIP_ACTIVATION', '可信会员事件的等级或时间无效。');
    return this.store.mutate(storage => {
      for (const membership of storage.memberships) {
        const previous = membership.activations.find(event => event.verifiedEventId === input.verifiedEventId || event.idempotencyKey === input.idempotencyKey);
        if (previous) {
          if (membership.userId !== input.userId || previous.verifiedEventId !== input.verifiedEventId || previous.idempotencyKey !== input.idempotencyKey
            || previous.planId !== input.planId || previous.verifiedPaymentAt !== input.verifiedPaymentAt) return fail(409, 'MEMBERSHIP_EVENT_CONFLICT', '相同会员事件不能携带不同输入。');
          return previous;
        }
      }
      const previous = storage.memberships.find(record => record.userId === input.userId);
      if (previous && Date.parse(input.verifiedPaymentAt) < Date.parse(previous.activations.at(-1)!.verifiedPaymentAt)) return fail(409, 'MEMBERSHIP_EVENT_OUT_OF_ORDER', '会员事件时间早于已处理事件。');
      const period = calculateMembershipPeriod({ planId: input.planId, verifiedPaymentAt: input.verifiedPaymentAt,
        ...(previous ? { current: { planId: previous.planId, expiresAt: previous.expiresAt } } : {}) });
      const quotaAnchorAt = period.kind === 'purchase' ? period.startsAt : previous!.quotaAnchorAt;
      const activation: MembershipActivation = { verifiedEventId: input.verifiedEventId, idempotencyKey: input.idempotencyKey,
        verifiedPaymentAt: input.verifiedPaymentAt, ...period, quotaAnchorAt };
      const record: StoredMembership = { userId: input.userId, planId: input.planId,
        startsAt: period.kind === 'renewal' ? previous!.startsAt : period.startsAt, expiresAt: period.expiresAt,
        quotaAnchorAt, updatedAt: this.now().toISOString(), activations: [...(previous?.activations ?? []), activation] };
      if (previous) storage.memberships[storage.memberships.indexOf(previous)] = record;
      else storage.memberships.push(record);
      // Keep the same strict schema used when the process next loads the ledger.
      normalizeQuotaStorage(storage);
      return activation;
    });
  }
}
