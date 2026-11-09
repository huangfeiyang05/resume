import type { MembershipTermKind, PaidPlanId } from '../shared/types.js';
import { calculateMembershipPeriod } from './membership.js';
import { membershipAt, membershipPeriods } from './membership-periods.js';
import type { StoredRefund } from './refund-storage.js';

export const quotaWeekMilliseconds = 7 * 24 * 60 * 60 * 1000;
export const weeklyTokenLimits: Readonly<Record<PaidPlanId, number>> = { basic: 200_000, premium: 800_000 };

/** Supplier totals, without resume content or contact details. Detail counters must not be added again. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestId?: string;
}

export interface MembershipBasis {
  planId: PaidPlanId;
  startsAt: string;
  expiresAt: string;
  quotaAnchorAt: string;
}

export interface MembershipActivation extends MembershipBasis {
  verifiedEventId: string;
  idempotencyKey: string;
  verifiedPaymentAt: string;
  kind: MembershipTermKind;
  /** Late receipts are booked at settlement without shifting previously paid periods. */
  appliedAt?: string;
  deferTierChange?: true;
  /** Basis used at booking if it differs from the preceding activation. */
  basis?: MembershipBasis | null;
}

export interface StoredMembership extends MembershipBasis {
  userId: string;
  updatedAt: string;
  activations: MembershipActivation[];
}

export interface QuotaReconciliation {
  idempotencyKey: string;
  reason: string;
  createdAt: string;
  usage?: TokenUsage;
  confirmedNoUsage?: true;
}

export interface StoredAiUsage {
  userId: string;
  taskId: string;
  inputHash: string;
  mode: 'preview' | 'metered';
  planId: PaidPlanId | null;
  quotaAnchorAt: string | null;
  cycleStartsAt: string | null;
  cycleEndsAt: string | null;
  reservedTokens: number;
  status: 'reserved' | 'dispatched' | 'pending' | 'settled' | 'released';
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  usage?: TokenUsage;
  reconciliations: QuotaReconciliation[];
}

export interface QuotaStorage { version?: 3 | 4 | 5 | 6; memberships: StoredMembership[]; aiUsage: StoredAiUsage[]; refunds?: StoredRefund[] }

function malformed(): never { throw new Error('Unsupported or malformed quota database.'); }

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  const item = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) return malformed();
  return item;
}

export function quotaIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

export function quotaInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function plan(value: unknown): value is PaidPlanId { return value === 'basic' || value === 'premium'; }
function natural(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export function normalizeTokenUsage(value: unknown): TokenUsage {
  const item = object(value, ['inputTokens', 'outputTokens', 'totalTokens'], ['requestId']);
  if (!natural(item.inputTokens) || !natural(item.outputTokens) || !natural(item.totalTokens)
    || !Number.isSafeInteger(item.inputTokens + item.outputTokens) || item.inputTokens + item.outputTokens !== item.totalTokens
    || (item.requestId !== undefined && !quotaIdentifier(item.requestId))) return malformed();
  return { inputTokens: item.inputTokens, outputTokens: item.outputTokens, totalTokens: item.totalTokens, ...(item.requestId === undefined ? {} : { requestId: item.requestId as string }) };
}

function normalizeActivation(value: unknown): MembershipActivation {
  const item = object(value, ['verifiedEventId', 'idempotencyKey', 'planId', 'verifiedPaymentAt', 'kind', 'startsAt', 'expiresAt', 'quotaAnchorAt'], ['basis', 'appliedAt', 'deferTierChange']);
  if (!quotaIdentifier(item.verifiedEventId) || !quotaIdentifier(item.idempotencyKey) || !plan(item.planId)
    || !['purchase', 'renewal', 'upgrade', 'scheduled'].includes(item.kind as string)
    || ![item.verifiedPaymentAt, item.startsAt, item.expiresAt, item.quotaAnchorAt].every(quotaInstant)
    || Date.parse(item.expiresAt as string) <= Date.parse(item.startsAt as string)
    || Date.parse(item.quotaAnchorAt as string) > Date.parse(item.startsAt as string)
    || Date.parse(item.verifiedPaymentAt as string) > Date.parse(item.startsAt as string)) return malformed();
  if (item.appliedAt !== undefined && (!quotaInstant(item.appliedAt) || Date.parse(item.appliedAt) <= Date.parse(item.verifiedPaymentAt as string)
    || Date.parse(item.appliedAt) > Date.parse(item.startsAt as string))) return malformed();
  if (item.deferTierChange !== undefined && (item.deferTierChange !== true || item.kind === 'upgrade')) return malformed();
  if (item.basis !== undefined && item.basis !== null) {
    const basis = object(item.basis, ['planId', 'startsAt', 'expiresAt', 'quotaAnchorAt']);
    if (!plan(basis.planId) || ![basis.startsAt, basis.expiresAt, basis.quotaAnchorAt].every(quotaInstant)
      || Date.parse(basis.expiresAt as string) <= Date.parse(basis.startsAt as string)
      || Date.parse(basis.quotaAnchorAt as string) > Date.parse(basis.startsAt as string)) return malformed();
  }
  return structuredClone(item) as unknown as MembershipActivation;
}

function normalizeMembership(value: unknown): StoredMembership {
  const item = object(value, ['userId', 'planId', 'startsAt', 'expiresAt', 'quotaAnchorAt', 'updatedAt', 'activations']);
  if (!quotaIdentifier(item.userId) || !plan(item.planId) || ![item.startsAt, item.expiresAt, item.quotaAnchorAt, item.updatedAt].every(quotaInstant)
    || Date.parse(item.expiresAt as string) <= Date.parse(item.startsAt as string)
    || Date.parse(item.quotaAnchorAt as string) > Date.parse(item.startsAt as string)
    || !Array.isArray(item.activations) || item.activations.length === 0) return malformed();
  const activations = item.activations.map(normalizeActivation);
  const latest = activations.at(-1)!;
  const bookedAt = (event: MembershipActivation) => Date.parse(event.appliedAt ?? event.verifiedPaymentAt);
  if (latest.planId !== item.planId || latest.expiresAt !== item.expiresAt || latest.quotaAnchorAt !== item.quotaAnchorAt
    || bookedAt(latest) > Date.parse(item.updatedAt as string)
    || activations.some((event, index) => index > 0 && bookedAt(event) < bookedAt(activations[index - 1]))) return malformed();
  let previous: MembershipActivation | undefined, expectedStartsAt: string | undefined;
  for (const event of activations) {
    if (event.basis !== undefined && !previous) return malformed();
    const basis = event.basis === undefined ? previous : event.basis;
    let expected;
    try { expected = calculateMembershipPeriod({ planId: event.planId, verifiedPaymentAt: event.appliedAt ?? event.verifiedPaymentAt,
      deferTierChange: event.kind === 'scheduled',
      ...(basis ? { current: { planId: basis.planId, expiresAt: basis.expiresAt } } : {}) }); }
    catch { return malformed(); }
    if (expected.kind !== event.kind || expected.startsAt !== event.startsAt || expected.expiresAt !== event.expiresAt
      || event.quotaAnchorAt !== (expected.kind === 'purchase' ? expected.startsAt : basis?.quotaAnchorAt)) return malformed();
    if (event.kind !== 'renewal') expectedStartsAt = event.startsAt;
    else if (event.basis) expectedStartsAt = event.basis.startsAt;
    previous = event;
  }
  if (expectedStartsAt !== item.startsAt) return malformed();
  return { ...(structuredClone(item) as unknown as StoredMembership), activations };
}

function normalizeReconciliation(value: unknown): QuotaReconciliation {
  const item = object(value, ['idempotencyKey', 'reason', 'createdAt'], ['usage', 'confirmedNoUsage']);
  if (!quotaIdentifier(item.idempotencyKey) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500
    || /\0/.test(item.reason) || !quotaInstant(item.createdAt)
    || (item.usage !== undefined) === (item.confirmedNoUsage !== undefined)
    || (item.confirmedNoUsage !== undefined && item.confirmedNoUsage !== true)) return malformed();
  return { idempotencyKey: item.idempotencyKey, reason: item.reason, createdAt: item.createdAt,
    ...(item.usage === undefined ? { confirmedNoUsage: true as const } : { usage: normalizeTokenUsage(item.usage) }) };
}

function normalizeUsage(value: unknown): StoredAiUsage {
  const item = object(value, ['userId', 'taskId', 'inputHash', 'mode', 'planId', 'quotaAnchorAt', 'cycleStartsAt', 'cycleEndsAt', 'reservedTokens', 'status', 'createdAt', 'updatedAt', 'reconciliations'], ['dispatchedAt', 'usage']);
  if (!quotaIdentifier(item.userId) || !quotaIdentifier(item.taskId) || typeof item.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.inputHash)
    || !['preview', 'metered'].includes(item.mode as string) || !natural(item.reservedTokens) || item.reservedTokens === 0
    || !['reserved', 'dispatched', 'pending', 'settled', 'released'].includes(item.status as string)
    || ![item.createdAt, item.updatedAt].every(quotaInstant) || Date.parse(item.updatedAt as string) < Date.parse(item.createdAt as string)
    || (item.dispatchedAt !== undefined && (!quotaInstant(item.dispatchedAt) || Date.parse(item.dispatchedAt) < Date.parse(item.createdAt as string)))
    || !Array.isArray(item.reconciliations)) return malformed();
  if (item.mode === 'preview') {
    if ([item.planId, item.quotaAnchorAt, item.cycleStartsAt, item.cycleEndsAt].some(value => value !== null)) return malformed();
  } else {
    if (!plan(item.planId) || ![item.quotaAnchorAt, item.cycleStartsAt, item.cycleEndsAt].every(quotaInstant)) return malformed();
    const anchor = Date.parse(item.quotaAnchorAt as string), start = Date.parse(item.cycleStartsAt as string), end = Date.parse(item.cycleEndsAt as string);
    if (start < anchor || (start - anchor) % quotaWeekMilliseconds !== 0 || end <= start || end > start + quotaWeekMilliseconds
      || Date.parse(item.createdAt as string) < start || Date.parse(item.createdAt as string) >= end) return malformed();
  }
  if (['dispatched', 'pending', 'settled'].includes(item.status as string) && item.dispatchedAt === undefined) return malformed();
  if (item.status === 'reserved' && item.dispatchedAt !== undefined) return malformed();
  if (item.dispatchedAt !== undefined && Date.parse(item.updatedAt as string) < Date.parse(item.dispatchedAt as string)) return malformed();
  if ((item.status === 'settled') !== (item.usage !== undefined)) return malformed();
  const usage = item.usage === undefined ? undefined : normalizeTokenUsage(item.usage);
  const reconciliations = item.reconciliations.map(normalizeReconciliation);
  if (new Set(reconciliations.map(event => event.idempotencyKey)).size !== reconciliations.length
    || reconciliations.some(event => Date.parse(event.createdAt) < Date.parse(item.dispatchedAt as string)
      || Date.parse(event.createdAt) > Date.parse(item.updatedAt as string)
      || (event.usage ? item.status !== 'settled' || JSON.stringify(event.usage) !== JSON.stringify(usage) : item.status !== 'released'))) return malformed();
  return { ...(structuredClone(item) as unknown as StoredAiUsage), ...(usage ? { usage } : {}), reconciliations };
}

/** Missing old fields are migrated; malformed present fields stop loading instead of granting free usage. */
export function normalizeQuotaStorage(source: unknown, refunds: readonly StoredRefund[] = []): QuotaStorage {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return malformed();
  const item = source as Record<string, unknown>;
  if ((item.memberships !== undefined && !Array.isArray(item.memberships)) || (item.aiUsage !== undefined && !Array.isArray(item.aiUsage))) return malformed();
  const memberships = ((item.memberships ?? []) as unknown[]).map(normalizeMembership);
  const aiUsage = ((item.aiUsage ?? []) as unknown[]).map(normalizeUsage);
  if (new Set(memberships.map(record => record.userId)).size !== memberships.length || new Set(aiUsage.map(record => record.taskId)).size !== aiUsage.length) return malformed();
  const events = memberships.flatMap(record => record.activations);
  if (new Set(events.map(event => event.verifiedEventId)).size !== events.length || new Set(events.map(event => event.idempotencyKey)).size !== events.length) return malformed();
  const requestIds = aiUsage.flatMap(record => record.usage?.requestId ? [record.usage.requestId] : []);
  if (new Set(requestIds).size !== requestIds.length) return malformed();
  const reconciliationKeys = aiUsage.flatMap(record => record.reconciliations.map(event => event.idempotencyKey));
  if (new Set(reconciliationKeys).size !== reconciliationKeys.length) return malformed();
  const pendingUsers = aiUsage.filter(record => ['reserved', 'dispatched', 'pending'].includes(record.status)).map(record => record.userId);
  if (new Set(pendingUsers).size !== pendingUsers.length) return malformed();
  for (const row of aiUsage) {
    if (row.mode === 'metered') {
      const membership = memberships.find(record => record.userId === row.userId);
      const createdAt = Date.parse(row.createdAt), cycleStart = Date.parse(row.cycleStartsAt!);
      if (!membership || row.reservedTokens > weeklyTokenLimits[row.planId!]) return malformed();
      const matchesPeriod = (period: MembershipBasis) => period.planId === row.planId && period.quotaAnchorAt === row.quotaAnchorAt
        && row.cycleEndsAt === new Date(Math.min(cycleStart + quotaWeekMilliseconds, Date.parse(period.expiresAt))).toISOString();
      const legacy = membership.activations.some((event, index) => {
        const next = membership.activations[index + 1];
        return Date.parse(event.appliedAt ?? event.verifiedPaymentAt) <= createdAt && Date.parse(event.expiresAt) > createdAt
          && (!next || createdAt <= Date.parse(next.appliedAt ?? next.verifiedPaymentAt)) && matchesPeriod(event);
      });
      if (!legacy) {
        // A receipt or refund may have been saved in the same millisecond as the reservation.
        const validAt = (at: number) => {
          const period = membershipAt(membershipPeriods(membership, refunds, at), at);
          return period && matchesPeriod(period);
        };
        if (!validAt(createdAt) && !validAt(createdAt - 1)) return malformed();
      }
    }
  }
  return { memberships, aiUsage };
}
