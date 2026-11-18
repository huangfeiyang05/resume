import type { AiQuotaSummary } from './quota.js';

export type PlanId = 'free' | 'basic' | 'premium';
export type PaidPlanId = Exclude<PlanId, 'free'>;
export type MembershipTermKind = 'purchase' | 'renewal' | 'upgrade' | 'scheduled';

export interface MembershipTerm {
  planId: PaidPlanId;
  startsAt: string;
  expiresAt: string;
}

export interface MembershipPrices {
  basicMonthlyCents: number;
  premiumMonthlyCents: number;
  premiumFirstPurchaseCents: number | null;
}

/** Plan features and displayed monthly price. Checkout confirms the account's current quote. */
export interface Plan {
  id: PlanId;
  name: string;
  /** null means the monthly price has not been set; it never means free. */
  priceCents: number | null;
  /** Undiscounted monthly price in cents; omitted when the current price is not a promotion. */
  listPriceCents?: number;
  /** Honest promotion wording, e.g. "首充优惠"; never a fabricated scarcity count. */
  promotionLabel?: string;
  durationMonths: 0 | 1;
  periodLabel: string;
  highlight?: string;
  description: string;
  features: {
    templates: string;
    optimization: string;
    companyJobs: string;
    studyMaterials: string;
    smartDelivery: string;
    aiQuota: string;
  };
}

/** Planned billing rules, not evidence of a paid membership or a successful payment. */
export interface MembershipPolicy {
  durationMonths: 1;
  timeZone: 'Asia/Shanghai';
  monthEnd: 'clamp';
  activation: 'verified-payment';
  autoRenew: false;
  renewalBase: 'later-of-payment-or-expiry';
  upgrade: {
    fromPlanId: 'basic';
    toPlanId: 'premium';
    charge: 'full-price-difference';
    effective: 'immediate';
    expiryBase: 'current-expiry';
    unusedTime: 'stacked';
  };
}

export interface MembershipPreview {
  mode: 'preview';
  currentPlanId: 'free';
  currentPlanName: '免费体验';
  paymentAvailable: boolean;
  paymentMode?: 'simulation';
  nextPeriod?: MembershipTerm;
  limitsEnforced: false;
  policy: MembershipPolicy;
  quota: AiQuotaSummary;
}

/** A trusted server-side entitlement in effect at the time of the request. */
export interface MembershipActive {
  mode: 'active';
  currentPlanId: PaidPlanId;
  currentPlanName: string;
  paymentAvailable: boolean;
  paymentMode?: 'simulation';
  nextPeriod?: MembershipTerm;
  limitsEnforced: true;
  policy: MembershipPolicy;
  quota: AiQuotaSummary;
}

export type MembershipState = MembershipPreview | MembershipActive;

export interface CheckoutInput {
  planId: PlanId;
  /** Client-generated idempotency key: repeating it must return the same order or be rejected. */
  requestId?: string;
}
