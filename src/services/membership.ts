import type { AiQuotaSummary, MembershipState, Plan, PlanId } from '../../shared/types';
import { request } from './api';

export class MembershipApiError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
    this.name = 'MembershipApiError';
  }
}

function invalidResponse(): never {
  throw new MembershipApiError('权益信息暂时不可用，请稍后重试。', 'INVALID_RESPONSE', 502);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(Number(value.slice(0, 4)), month, 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= monthEnd.getUTCDate()
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}

/** Only percentages leave the server; an incompatible balance must never look usable. */
export function validateQuota(value: unknown): AiQuotaSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const quota = value as AiQuotaSummary;
  if (Object.keys(quota).some(key => !['status', 'remainingPercent', 'resetsAt', 'expiresAt', 'pending'].includes(key))
    || typeof quota.pending !== 'boolean' || !['preview', 'active', 'inactive'].includes(quota.status)) invalidResponse();
  if (quota.status === 'active') {
    if (!Number.isInteger(quota.remainingPercent) || quota.remainingPercent === null || quota.remainingPercent < 0 || quota.remainingPercent > 100
      || !isInstant(quota.resetsAt) || !isInstant(quota.expiresAt)) invalidResponse();
  } else if (quota.remainingPercent !== null || quota.resetsAt !== null
    || (quota.status === 'preview' ? quota.expiresAt !== null : quota.expiresAt !== null && !isInstant(quota.expiresAt))) invalidResponse();
  return quota;
}

export const membershipApi = {
  async current(): Promise<MembershipState> {
    const state = await request<MembershipState>('/membership');
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.paymentAvailable !== false) invalidResponse();
    const quota = validateQuota(state.quota);
    if (state.mode === 'preview') {
      if (state.currentPlanId !== 'free' || state.currentPlanName !== '免费体验' || state.limitsEnforced !== false || quota.status === 'active') invalidResponse();
    } else if (state.mode === 'active') {
      if (!['basic', 'premium'].includes(state.currentPlanId) || state.currentPlanName !== (state.currentPlanId === 'basic' ? '初级会员' : '高级会员')
        || state.limitsEnforced !== true || quota.status === 'preview') invalidResponse();
    } else invalidResponse();
    const policy = state.policy;
    if (!policy || policy.durationMonths !== 1 || policy.timeZone !== 'Asia/Shanghai' || policy.monthEnd !== 'clamp'
      || policy.activation !== 'verified-payment' || policy.autoRenew !== false || policy.renewalBase !== 'later-of-payment-or-expiry'
      || !policy.upgrade || policy.upgrade.fromPlanId !== 'basic' || policy.upgrade.toPlanId !== 'premium'
      || policy.upgrade.charge !== 'full-price-difference' || policy.upgrade.effective !== 'immediate'
      || policy.upgrade.expiryBase !== 'payment-time' || policy.upgrade.unusedTime !== 'replaced') invalidResponse();
    return state;
  },
  async quota(): Promise<AiQuotaSummary> {
    return validateQuota(await request<unknown>('/membership/quota'));
  },
  async plans(): Promise<Plan[]> {
    const plans = await request<Plan[]>('/plans');
    const ids: PlanId[] = ['free', 'basic', 'premium'];
    const features: Array<keyof Plan['features']> = ['templates', 'optimization', 'aiQuota', 'companyJobs', 'studyMaterials', 'smartDelivery'];
    if (!Array.isArray(plans) || plans.length !== 3 || new Set(plans.map((plan) => plan?.id)).size !== 3 || !plans.every((plan) =>
      plan && ids.includes(plan.id) && (plan.priceCents === null || (Number.isSafeInteger(plan.priceCents) && plan.priceCents >= 0))
      && (plan.id === 'free' ? plan.priceCents === 0 && plan.durationMonths === 0 : plan.priceCents !== 0 && plan.durationMonths === 1)
      && typeof plan.name === 'string' && typeof plan.periodLabel === 'string' && typeof plan.description === 'string'
      && (plan.highlight === undefined || typeof plan.highlight === 'string')
      && plan.features && features.every((key) => typeof plan.features[key] === 'string'),
    )) invalidResponse();
    return ids.map((id) => plans.find((plan) => plan.id === id)!);
  },
  async checkout(planId: PlanId): Promise<never> {
    await request<unknown>('/billing/checkout', 'POST', { planId });
    // This prototype cannot grant membership even if an incompatible service returns HTTP 200.
    throw new MembershipApiError('开通结果暂时无法确认，请稍后查看权益。', 'UNEXPECTED_CHECKOUT_RESULT', 200);
  },
};
