import type { MembershipPreview, Plan, PlanId } from '../../shared/types';
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

export const membershipApi = {
  async current(): Promise<MembershipPreview> {
    const state = await request<MembershipPreview>('/membership');
    if (!state || state.mode !== 'preview' || state.currentPlanId !== 'free' || state.currentPlanName !== '免费体验' || state.paymentAvailable !== false || state.limitsEnforced !== false) invalidResponse();
    const policy = state.policy;
    if (!policy || policy.durationMonths !== 1 || policy.timeZone !== 'Asia/Shanghai' || policy.monthEnd !== 'clamp'
      || policy.activation !== 'verified-payment' || policy.autoRenew !== false || policy.renewalBase !== 'later-of-payment-or-expiry'
      || !policy.upgrade || policy.upgrade.fromPlanId !== 'basic' || policy.upgrade.toPlanId !== 'premium'
      || policy.upgrade.charge !== 'full-price-difference' || policy.upgrade.effective !== 'immediate'
      || policy.upgrade.expiryBase !== 'payment-time' || policy.upgrade.unusedTime !== 'replaced') invalidResponse();
    return state;
  },
  async plans(): Promise<Plan[]> {
    const plans = await request<Plan[]>('/plans');
    const ids: PlanId[] = ['free', 'basic', 'premium'];
    const features: Array<keyof Plan['features']> = ['templates', 'optimization', 'companyJobs', 'studyMaterials', 'smartDelivery'];
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
