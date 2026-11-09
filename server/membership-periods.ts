import type { MembershipActivation, MembershipBasis, StoredMembership } from './quota-storage.js';
import type { StoredRefund } from './refund-storage.js';
import type { PaidPlanId } from '../shared/types.js';
import { calculateMembershipPeriod } from './membership.js';

export interface MembershipPeriod extends MembershipBasis {
  kind: MembershipActivation['kind'];
}

/** Preserve the dates of every paid term. An upgrade raises the plan on the surviving
 * underlying dates and owns only the extra term appended at the previous expiry. */
export function membershipPeriods(record: StoredMembership | undefined, refunds: readonly StoredRefund[],
  now: number, excludeEventId?: string): MembershipPeriod[] {
  if (!record) return [];
  const revoked = new Set(refunds.filter(refund => refund.userId === record.userId && refund.confirmedAt
    && Date.parse(refund.confirmedAt) <= now).map(refund => refund.paymentEventId));
  if (excludeEventId) revoked.add(excludeEventId);
  let periods: MembershipPeriod[] = [];
  for (const [index, event] of record.activations.entries()) {
    if (Date.parse(event.appliedAt ?? event.verifiedPaymentAt) > now) break;
    if (revoked.has(event.verifiedEventId)) continue;
    let startsAt = event.startsAt;
    if (event.kind === 'upgrade') {
      startsAt = event.basis?.expiresAt ?? record.activations[index - 1].expiresAt;
      periods = periods.flatMap(period => {
        if (Date.parse(period.expiresAt) <= Date.parse(event.startsAt)) return [period];
        const upgraded: MembershipPeriod = { ...period, planId: event.planId, kind: event.kind };
        if (Date.parse(period.startsAt) >= Date.parse(event.startsAt)) return [upgraded];
        return [{ ...period, expiresAt: event.startsAt }, { ...upgraded, startsAt: event.startsAt }];
      });
    }
    periods.push({ planId: event.planId, kind: event.kind, startsAt, expiresAt: event.expiresAt, quotaAnchorAt: event.quotaAnchorAt });
  }
  const merged: MembershipPeriod[] = [];
  for (const period of periods) {
    const previous = merged.at(-1);
    if (previous?.planId === period.planId && previous.expiresAt === period.startsAt && previous.quotaAnchorAt === period.quotaAnchorAt) {
      previous.expiresAt = period.expiresAt;
      previous.kind = period.kind;
    } else merged.push(period);
  }
  return merged;
}

export function membershipAt(periods: MembershipPeriod[], now: number): MembershipPeriod | undefined {
  return periods.find(period => Date.parse(period.startsAt) <= now && now < Date.parse(period.expiresAt));
}

/** Append after paid windows. Upgrade immediately only when the last paid window is active now. */
export function planMembershipPeriod(periods: MembershipPeriod[], planId: PaidPlanId, at: number, deferTierChange = false) {
  const current = membershipAt(periods, at);
  const basis = periods.at(-1);
  const term = calculateMembershipPeriod({ planId, verifiedPaymentAt: new Date(at).toISOString(),
    ...(basis ? { current: basis, deferTierChange: deferTierChange || current !== basis } : {}) });
  return { current, basis, term };
}
