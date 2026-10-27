import type { MembershipPolicy, MembershipPreview, PaidPlanId, Plan } from '../shared/types.js';
import { HttpError, invalid } from './errors.js';

/** Current product design. Paid benefits are neither sold nor enforced in preview mode. */
const plans: Plan[] = [
  {
    id: 'free', name: '免费体验', priceCents: 0, durationMonths: 0, periodLabel: '免费',
    description: '使用基础简历模板，整理和展示自己的真实经历。',
    features: {
      templates: '3 款基础模板', optimization: '不包含', companyJobs: '不包含',
      studyMaterials: '不包含', smartDelivery: '不包含',
    },
  },
  {
    id: 'basic', name: '初级会员', priceCents: null, durationMonths: 1, periodLabel: '月', highlight: '优化简历',
    description: '规划权益：简历优化，逐项对照审核，确认后再应用。',
    features: {
      templates: '包含基础模板', optimization: '包含', companyJobs: '不包含',
      studyMaterials: '不包含', smartDelivery: '不包含',
    },
  },
  {
    id: 'premium', name: '高级会员', priceCents: null, durationMonths: 1, periodLabel: '月', highlight: '精选投递',
    description: '规划权益：包含初级权益，增加分专业岗位资料、复习资料与精选投递。',
    features: {
      templates: '包含基础模板', optimization: '包含初级全部优化权益', companyJobs: '分专业岗位筛选、收藏与官方招聘入口',
      studyMaterials: '分专业原创准备清单与复习提纲', smartDelivery: '精选投递计划与手动进度记录',
    },
  },
];

const policy: MembershipPolicy = {
  durationMonths: 1, timeZone: 'Asia/Shanghai', monthEnd: 'clamp',
  activation: 'verified-payment', autoRenew: false, renewalBase: 'later-of-payment-or-expiry',
  upgrade: {
    fromPlanId: 'basic', toPlanId: 'premium', charge: 'full-price-difference',
    effective: 'immediate', expiryBase: 'payment-time', unusedTime: 'replaced',
  },
};

export function listPlans(): Plan[] {
  return structuredClone(plans);
}

export function getMembership(): MembershipPreview {
  return {
    mode: 'preview', currentPlanId: 'free', currentPlanName: '免费体验',
    paymentAvailable: false, limitsEnforced: false, policy: structuredClone(policy),
  };
}

/** Date calculation only: never grants, stores, or charges for a membership. */
export function calculateMembershipPeriod(input: {
  planId: PaidPlanId;
  verifiedPaymentAt: string;
  current?: { planId: PaidPlanId; expiresAt: string };
}): { kind: 'purchase' | 'renewal' | 'upgrade'; planId: PaidPlanId; startsAt: string; expiresAt: string } {
  if (!['basic', 'premium'].includes(input.planId)) invalid('请选择有效的会员等级。');
  const paidAt = parseInstant(input.verifiedPaymentAt);
  const current = input.current;
  if (current && !['basic', 'premium'].includes(current.planId)) invalid('当前会员等级无效。');
  const currentExpiry = current ? parseInstant(current.expiresAt) : undefined;
  const active = currentExpiry !== undefined && currentExpiry > paidAt;
  if (active && current!.planId === 'premium' && input.planId === 'basic') {
    throw new HttpError(409, 'MEMBERSHIP_DOWNGRADE_NOT_SUPPORTED', '高级会员有效期内不能改为初级会员，请在到期后选择。');
  }
  const kind = !active ? 'purchase' : current!.planId === input.planId ? 'renewal' : 'upgrade';
  const startsAt = kind === 'renewal' ? currentExpiry! : paidAt;
  return { kind, planId: input.planId, startsAt: new Date(startsAt).toISOString(), expiresAt: nextCalendarMonth(startsAt) };
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
