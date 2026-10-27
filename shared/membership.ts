export type PlanId = 'free' | 'basic' | 'premium';
export type PaidPlanId = Exclude<PlanId, 'free'>;

/** Product planning only. Values are not active entitlements or validated launch prices. */
export interface Plan {
  id: PlanId;
  name: string;
  /** null means the monthly price has not been set; it never means free. */
  priceCents: number | null;
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
    expiryBase: 'payment-time';
    unusedTime: 'replaced';
  };
}

export interface MembershipPreview {
  mode: 'preview';
  currentPlanId: 'free';
  currentPlanName: '免费体验';
  paymentAvailable: false;
  limitsEnforced: false;
  policy: MembershipPolicy;
}

export interface CheckoutInput { planId: PlanId }
