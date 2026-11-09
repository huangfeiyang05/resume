import { randomUUID } from 'node:crypto';
import type { AdminPricePublication, AdminPricingPreview, AdminPricingState } from '../shared/types.js';
import { careerObject } from './career-validation.js';
import { HttpError, invalid } from './errors.js';
import { defaultPricing, type BillingPricing } from './payment-config.js';
import { billingPricing, maxPricePublications, membershipPrices, parseMembershipPrices } from './pricing-storage.js';
import type { JsonStore } from './store.js';

const lifetime = 10 * 60_000;
const stale = () => new HttpError(409, 'PRICING_PREVIEW_STALE', '价格版本已变化或预览已过期，请刷新后重新核对。');

export class AdminPricing {
  private readonly previews = new Map<string, AdminPricingPreview & { expires: number }>();

  constructor(private readonly store: JsonStore, private readonly baseline: BillingPricing = defaultPricing,
    private readonly environment: AdminPricingState['environment'] = 'public', private readonly now: () => number = Date.now) {}

  async state(): Promise<AdminPricingState> {
    const { pricingHistory } = await this.store.read();
    return { environment: this.environment, revision: pricingHistory.at(-1)?.revision ?? 0,
      prices: membershipPrices(billingPricing(pricingHistory, this.baseline)), history: [...pricingHistory].reverse() };
  }

  async preview(body: unknown, actorId: string): Promise<AdminPricingPreview> {
    const input = careerObject(body, ['revision', 'prices']);
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) invalid('价格版本无效。');
    const after = parseMembershipPrices(input.prices);
    const state = await this.state();
    if (input.revision !== state.revision) throw stale();
    if (JSON.stringify(after) === JSON.stringify(state.prices)) invalid('价格未变化。');
    const now = this.now();
    for (const [actor, preview] of this.previews) if (preview.expires <= now) this.previews.delete(actor);
    const preview = { id: randomUUID(), revision: state.revision, before: state.prices, after };
    this.previews.set(actorId, { ...preview, expires: now + lifetime });
    return preview;
  }

  async apply(body: unknown, actorId: string): Promise<AdminPricePublication> {
    const { id, confirmed } = careerObject(body, ['id', 'confirmed']);
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || confirmed !== true) invalid('请核对价格差异后确认发布。');
    const publication = await this.store.mutate(database => {
      const history = database.pricingHistory;
      const prior = history.find(item => item.id === id);
      if (prior) {
        if (prior.actorId !== actorId) throw stale();
        return prior;
      }
      const preview = this.previews.get(actorId);
      const revision = history.at(-1)?.revision ?? 0;
      if (!preview || preview.id !== id || preview.revision !== revision || preview.expires <= this.now()) throw stale();
      if (history.length >= maxPricePublications) throw new HttpError(409, 'PRICING_HISTORY_FULL', '价格历史已达上限，请联系维护人员。');
      const entry: AdminPricePublication = {
        id, revision: revision + 1, actorId, publishedAt: new Date(this.now()).toISOString(), prices: preview.after,
      };
      if (database.version < 5) database.version = 5;
      history.push(entry);
      return entry;
    });
    if (this.previews.get(actorId)?.id === id) this.previews.delete(actorId);
    return publication;
  }
}
