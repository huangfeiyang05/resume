import type { MembershipPolicy, MembershipPreview, MembershipState, AiQuotaSummary, PaidPlanId, Plan, MembershipTerm, MembershipTermKind } from '../shared/types.js';
import { HttpError, invalid } from './errors.js';
import { defaultPricing, type BillingPricing } from './payment-config.js';

/** Displayed plans; workbench access is resolved separately from trusted membership records. */
const plans: Plan[] = [
  {
    id: 'free', name: '免费体验', priceCents: 0, durationMonths: 0, periodLabel: '免费',
    description: '使用基础简历模板，整理和展示自己的真实经历。',
    features: {
      templates: '3 款基础模板', optimization: '不包含', companyJobs: '不包含',
      studyMaterials: '不包含', smartDelivery: '不包含',
      aiQuota: '规则功能不消耗 AI 额度',
    },
  },
  {
    id: 'basic', name: '初级会员', priceCents: null, durationMonths: 1, periodLabel: '月', highlight: '优化简历',
    description: '工作台简历优化，逐项对照审核，确认后再应用。',
    features: {
      templates: '包含基础模板', optimization: '包含', companyJobs: '不包含',
      studyMaterials: '不包含', smartDelivery: '不包含',
      aiQuota: '标准 AI 工具周额度',
    },
  },
  {
    id: 'premium', name: '高级会员', priceCents: null, durationMonths: 1, periodLabel: '月', highlight: '精选投递',
    description: '包含初级权益，增加公司岗位、招聘入口、复习资料与手动投递计划。',
    features: {
      templates: '包含基础模板', optimization: '包含初级全部优化权益', companyJobs: '分专业岗位筛选、收藏与官方招聘入口',
      studyMaterials: '分专业原创准备清单与复习提纲', smartDelivery: '精选投递计划与手动进度记录',
      aiQuota: '高级 AI 工具周额度',
    },
  },
];

const policy: MembershipPolicy = {
  durationMonths: 1, timeZone: 'Asia/Shanghai', monthEnd: 'clamp',
  activation: 'verified-payment', autoRenew: false, renewalBase: 'later-of-payment-or-expiry',
  upgrade: {
    fromPlanId: 'basic', toPlanId: 'premium', charge: 'full-price-difference',
    effective: 'immediate', expiryBase: 'current-expiry', unusedTime: 'stacked',
  },
};

export function listPlans(pricing: BillingPricing = defaultPricing): Plan[] {
  return structuredClone(plans).map((plan) => plan.id === 'free' ? plan : {
    ...plan, priceCents: pricing[plan.id].priceCents,
    ...(pricing[plan.id].listPriceCents !== undefined ? { listPriceCents: pricing[plan.id].listPriceCents } : {}),
    ...(pricing[plan.id].promotionLabel !== undefined ? { promotionLabel: pricing[plan.id].promotionLabel } : {}),
  });
}

export function getMembership(paymentAvailable = false): MembershipPreview {
  return {
    mode: 'preview', currentPlanId: 'free', currentPlanName: '免费体验',
    paymentAvailable, limitsEnforced: false, policy: structuredClone(policy),
    quota: { status: 'preview', remainingPercent: null, resetsAt: null, expiresAt: null, pending: false },
  };
}

/** The caller resolves this from a trusted account record, never from a request body. */
export function membershipState(quota: AiQuotaSummary, planId?: PaidPlanId, paymentAvailable = false): MembershipState {
  if (quota.status !== 'active' || !planId) return { ...getMembership(paymentAvailable), quota };
  return {
    mode: 'active', currentPlanId: planId, currentPlanName: planId === 'basic' ? '初级会员' : '高级会员',
    paymentAvailable, limitsEnforced: true, policy: structuredClone(policy), quota,
  };
}

/** Date calculation only: never grants, stores, or charges for a membership. */
export function calculateMembershipPeriod(input: {
  planId: PaidPlanId;
  verifiedPaymentAt: string;
  current?: { planId: PaidPlanId; expiresAt: string };
  deferTierChange?: boolean;
}): MembershipTerm & { kind: MembershipTermKind } {
  if (!['basic', 'premium'].includes(input.planId)) invalid('请选择有效的会员等级。');
  const paidAt = parseInstant(input.verifiedPaymentAt);
  const current = input.current;
  if (current && !['basic', 'premium'].includes(current.planId)) invalid('当前会员等级无效。');
  const currentExpiry = current ? parseInstant(current.expiresAt) : undefined;
  const active = currentExpiry !== undefined && currentExpiry > paidAt;
  const kind = !active ? 'purchase' : current!.planId === input.planId ? 'renewal'
    : input.planId === 'basic' || input.deferTierChange ? 'scheduled' : 'upgrade';
  const startsAt = kind === 'renewal' || kind === 'scheduled' ? currentExpiry! : paidAt;
  const expiryBase = kind === 'upgrade' ? currentExpiry! : startsAt;
  return { kind, planId: input.planId, startsAt: new Date(startsAt).toISOString(), expiresAt: nextCalendarMonth(expiryBase) };
}

function parseInstant(value: string): number {
  // Require an explicit offset so dates never depend on the server's local timezone.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid('会员时间必须包含明确的时区。');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > monthEnd.getUTCDate()
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid('会员时间无效。');
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) invalid('会员时间无效。');
  return instant;
}

function nextCalendarMonth(instant: number): string {
  const shanghaiOffset = 8 * 60 * 60 * 1000;
  const local = new Date(instant + shanghaiOffset);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + 1);
  const monthEnd = new Date(local);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  local.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return new Date(local.getTime() - shanghaiOffset).toISOString();
}

/** Validate the choice; never accept client prices, membership state, or payment assertions. */
export function checkout(body: unknown): never {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求体必须是 JSON 对象。');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'planId')) invalid('请求体只支持 planId 字段，价格与权益由服务端确定。');
  if (typeof input.planId !== 'string' || !plans.some(({ id }) => id === input.planId)) {
    throw new HttpError(400, 'INVALID_PLAN', '请选择有效的权益方案。');
  }
  if (input.planId === 'free') throw new HttpError(400, 'FREE_PLAN_NOT_PURCHASABLE', '免费体验无需充值。');
  throw new HttpError(503, 'PAYMENT_NOT_CONFIGURED', '会员价格待定，支付暂未开放，本次未扣费。');
}
