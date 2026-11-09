import type { AdminPricePublication, MembershipPrices } from '../shared/types.js';
import { careerObject } from './career-validation.js';
import { invalid } from './errors.js';
import type { BillingPricing } from './payment-config.js';
import { quotaIdentifier, quotaInstant } from './quota-storage.js';

export const maxPricePublications = 256;
export const membershipPriceFields = ['basicMonthlyCents', 'premiumMonthlyCents', 'premiumFirstPurchaseCents'] as const;

export function parseMembershipPrices(value: unknown): MembershipPrices {
  const input = careerObject(value, [...membershipPriceFields]);
  const cents = (amount: unknown): number => {
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 || amount > 99_999_999) {
      invalid('价格须在 0.01 元至 999999.99 元之间，精确到分。');
    }
    return amount;
  };
  const basicMonthlyCents = cents(input.basicMonthlyCents);
  const premiumMonthlyCents = cents(input.premiumMonthlyCents);
  const premiumFirstPurchaseCents = input.premiumFirstPurchaseCents === null ? null : cents(input.premiumFirstPurchaseCents);
  if (premiumMonthlyCents <= basicMonthlyCents || (premiumFirstPurchaseCents !== null && premiumFirstPurchaseCents >= premiumMonthlyCents)) {
    invalid('高级月价须高于初级月价。启用首充优惠时，首充价须低于高级月价。');
  }
  return { basicMonthlyCents, premiumMonthlyCents, premiumFirstPurchaseCents };
}

export function normalizePricingHistory(value: unknown): AdminPricePublication[] {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value) || value.length > maxPricePublications) throw new Error();
    const ids = new Set<string>();
    return value.map((raw, index) => {
      const row = careerObject(raw, ['id', 'revision', 'actorId', 'publishedAt', 'prices']);
      if (!quotaIdentifier(row.id) || ids.has(row.id) || row.revision !== index + 1
        || !quotaIdentifier(row.actorId) || !quotaInstant(row.publishedAt)) throw new Error();
      ids.add(row.id);
      return { id: row.id, revision: index + 1, actorId: row.actorId, publishedAt: row.publishedAt, prices: parseMembershipPrices(row.prices) };
    });
  } catch { throw new Error('Unsupported or malformed membership pricing history.'); }
}

export function membershipPrices(pricing: BillingPricing): MembershipPrices {
  const premiumMonthlyCents = pricing.premium.listPriceCents ?? pricing.premium.priceCents;
  return {
    basicMonthlyCents: pricing.basic.priceCents, premiumMonthlyCents,
    premiumFirstPurchaseCents: premiumMonthlyCents > pricing.premium.priceCents ? pricing.premium.priceCents : null,
  };
}

export function billingPricing(history: AdminPricePublication[], baseline: BillingPricing): BillingPricing {
  const prices = history.at(-1)?.prices;
  if (!prices) return baseline;
  const first = prices.premiumFirstPurchaseCents;
  return {
    basic: { priceCents: prices.basicMonthlyCents },
    premium: first === null ? { priceCents: prices.premiumMonthlyCents } : {
      priceCents: first, listPriceCents: prices.premiumMonthlyCents, promotionLabel: baseline.premium.promotionLabel ?? '首充优惠',
    },
  };
}
