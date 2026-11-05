import type { AiQuotaSummary, AlipayPaymentParams, CheckoutResult, MembershipQuote, MembershipState, NativePaymentParams, PaymentChannel, PaymentOrder, Plan, PlanId, WechatPaymentParams } from '../../shared/types';
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
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.paymentAvailable !== 'boolean') invalidResponse();
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
      || policy.upgrade.expiryBase !== 'current-expiry' || policy.upgrade.unusedTime !== 'stacked') invalidResponse();
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
      && (plan.listPriceCents === undefined || (Number.isSafeInteger(plan.listPriceCents) && plan.listPriceCents >= 0 && plan.priceCents !== null && plan.listPriceCents >= plan.priceCents))
      && (plan.promotionLabel === undefined || (typeof plan.promotionLabel === 'string' && plan.promotionLabel.length > 0 && plan.promotionLabel.length <= 20))
      && (plan.id === 'free' ? plan.priceCents === 0 && plan.durationMonths === 0 : plan.priceCents !== 0 && plan.durationMonths === 1)
      && typeof plan.name === 'string' && typeof plan.periodLabel === 'string' && typeof plan.description === 'string'
      && (plan.highlight === undefined || typeof plan.highlight === 'string')
      && plan.features && features.every((key) => typeof plan.features[key] === 'string'),
    )) invalidResponse();
    return ids.map((id) => plans.find((plan) => plan.id === id)!);
  },
  async quote(planId: PlanId): Promise<MembershipQuote> {
    const quote = await request<MembershipQuote>(`/billing/quote?planId=${encodeURIComponent(planId)}`);
    if (!quote || typeof quote !== 'object' || Array.isArray(quote)
      || !['basic', 'premium'].includes(quote.planId) || !Number.isSafeInteger(quote.amountCents) || quote.amountCents <= 0
      || !['purchase', 'renewal', 'upgrade'].includes(quote.kind) || !['free', 'basic', 'premium'].includes(quote.currentPlanId)
      || (quote.kind === 'purchase' && quote.currentPlanId !== 'free')
      || (quote.kind === 'upgrade' && quote.currentPlanId !== 'basic')
      || (quote.listPriceCents !== undefined && (!Number.isSafeInteger(quote.listPriceCents) || quote.listPriceCents < quote.amountCents))
      || (quote.promotionLabel !== undefined && (typeof quote.promotionLabel !== 'string' || !quote.promotionLabel))) invalidResponse();
    return quote;
  },
  async bindWechat(code: string): Promise<{ bound: true; openidMasked: string }> {
    const result = await request<{ bound: true; openidMasked: string }>('/auth/wechat/bind', 'POST', { code });
    if (!result || result.bound !== true || typeof result.openidMasked !== 'string') invalidResponse();
    return result;
  },
  async methods(): Promise<{ wechat: boolean; alipay: boolean }> {
    const result = await request<{ wechat: boolean; alipay: boolean }>('/billing/payment-methods');
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !['wechat', 'alipay'].includes(key))
      || typeof result.wechat !== 'boolean' || typeof result.alipay !== 'boolean') invalidResponse();
    return result;
  },
  async checkout(planId: PlanId, requestId: string, channel: PaymentChannel = 'jsapi'): Promise<CheckoutResult> {
    const result = await request<CheckoutResult>('/billing/checkout', 'POST', { planId, requestId, channel });
    if (!result || typeof result !== 'object' || Array.isArray(result)) invalidResponse();
    const order = validateOrder(result.order);
    if (order.channel === 'alipay-page' || order.channel === 'alipay-wap') {
      const alipay = result.alipay as AlipayPaymentParams;
      if (!alipay || typeof alipay !== 'object' || Array.isArray(alipay)
        || Object.keys(alipay).some(key => !['redirectUrl'].includes(key))
        || typeof alipay.redirectUrl !== 'string' || !/^https:\/\//.test(alipay.redirectUrl) || alipay.redirectUrl.length > 4000
        || result.payment !== undefined || result.native !== undefined) invalidResponse();
      return { order, alipay };
    }
    if (order.channel === 'native') {
      const native = result.native as NativePaymentParams;
      if (!native || typeof native !== 'object' || Array.isArray(native)
        || Object.keys(native).some(key => !['codeUrl', 'qrCodeDataUrl', 'expiresAt'].includes(key))
        || typeof native.codeUrl !== 'string' || !/^weixin:\/\/[^\s]{10,512}$/.test(native.codeUrl)
        || typeof native.qrCodeDataUrl !== 'string' || !native.qrCodeDataUrl.startsWith('data:image/svg+xml;base64,') || native.qrCodeDataUrl.length > 200_000
        || native.expiresAt !== order.expiresAt || result.payment !== undefined) invalidResponse();
      return { order, native };
    }
    const payment = result.payment as WechatPaymentParams;
    if (!payment || typeof payment !== 'object' || Array.isArray(payment) || result.native !== undefined
      || typeof payment.appId !== 'string' || !/^wx[a-f0-9]{16}$/i.test(payment.appId)
      || typeof payment.timeStamp !== 'string' || !/^\d{10,13}$/.test(payment.timeStamp)
      || typeof payment.nonceStr !== 'string' || !payment.nonceStr || payment.nonceStr.length > 64
      || typeof payment.package !== 'string' || !/^prepay_id=[A-Za-z0-9_-]{10,128}$/.test(payment.package)
      || payment.signType !== 'RSA' || typeof payment.paySign !== 'string' || !payment.paySign) invalidResponse();
    return { order, payment };
  },
  async order(orderId: string): Promise<PaymentOrder> {
    return validateOrder(await request<PaymentOrder>(`/billing/orders/${encodeURIComponent(orderId)}`));
  },
};

function validateOrder(value: unknown): PaymentOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const order = value as PaymentOrder;
  if (typeof order.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(order.id)
    || !['basic', 'premium'].includes(order.planId) || !Number.isSafeInteger(order.amountCents) || order.amountCents <= 0
    || !['pending', 'paid', 'closed', 'failed'].includes(order.status) || !['jsapi', 'native', 'alipay-page', 'alipay-wap'].includes(order.channel)
    || !isInstant(order.createdAt) || !isInstant(order.expiresAt)
    || (order.paidAt !== undefined && !isInstant(order.paidAt))
    || Object.keys(order).some(key => !['id', 'planId', 'amountCents', 'status', 'channel', 'createdAt', 'expiresAt', 'paidAt'].includes(key))) invalidResponse();
  return order;
}
