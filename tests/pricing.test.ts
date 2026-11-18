import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AdminPricing } from '../server/admin-pricing.js';
import type { AlipayNotification, AlipayPaymentInput } from '../server/alipay.js';
import { AuthService } from '../server/auth.js';
import { createApiServer } from '../server/http.js';
import { PaymentService } from '../server/payments.js';
import { QuotaService } from '../server/quota.js';
import { AdminRefunds } from '../server/refunds.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { getWorkbenchAccess } from '../server/workbench-access.js';
import type { MembershipQuote, Plan } from '../shared/types.js';

const credentials = { email: 'operator@example.test', password: 'Synthetic26!' };
const newPrices = { basicMonthlyCents: 1200, premiumMonthlyCents: 3500, premiumFirstPurchaseCents: 2800 };

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-pricing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('reviewed pricing is published atomically and pending orders retain the amount originally approved', async t => {
  const store = new JsonStore(join(await temporary(t), 'public.json'));
  const userId = (await new AuthService(store).register(credentials)).session.user.id;
  const calls: AlipayPaymentInput[] = [];
  const payment = new PaymentService({ store, quota: new QuotaService(store), alipay: {
    async createPayment(input) { calls.push(input); return { redirectUrl: 'https://fixture.invalid/checkout' }; },
    parseNotification() { throw new Error('This test never contacts a gateway.'); },
  } });
  const admin = new AdminPricing(store);
  const before = await admin.state();
  const oldQuote = await payment.quote(userId, 'basic');
  assert.equal(oldQuote.amountCents, before.prices.basicMonthlyCents);
  const input = { planId: 'basic', channel: 'alipay-page', requestId: 'request-pending-old-price', expectedAmountCents: oldQuote.amountCents };
  const first = await payment.checkout(userId, input);
  const draft = { revision: before.revision, prices: newPrices };
  const stale = await admin.preview(draft, 'other-admin');
  const preview = await admin.preview(draft, 'admin');
  assert.equal((await payment.quote(userId, 'basic')).amountCents, oldQuote.amountCents);
  await assert.rejects(admin.apply({ id: preview.id, confirmed: true }, 'other-admin'), { code: 'PRICING_PREVIEW_STALE' });
  await assert.rejects(admin.apply({ id: preview.id, confirmed: false }, 'admin'), { status: 400 });
  for (const prices of [{ ...newPrices, basicMonthlyCents: 0 }, { ...newPrices, premiumFirstPurchaseCents: 3500 }, { ...newPrices, amountCents: 1 }]) {
    await assert.rejects(admin.preview({ revision: before.revision, prices }, 'third-admin'), { status: 400 });
  }
  const entry = await admin.apply({ id: preview.id, confirmed: true }, 'admin');
  assert.equal(entry.revision, 1);
  await assert.rejects(admin.apply({ id: stale.id, confirmed: true }, 'other-admin'), { code: 'PRICING_PREVIEW_STALE' });
  const restarted = new JsonStore(store.path);
  assert.deepEqual(await new AdminPricing(restarted).apply({ id: preview.id, confirmed: true }, 'admin'), entry);
  assert.equal((await restarted.read()).version, 5);
  assert.equal((await payment.plans()).find(plan => plan.id === 'premium')!.priceCents, 2800);
  assert.equal((await payment.quote(userId, 'basic')).amountCents, 1200);
  assert.equal((await payment.quote(userId, 'premium')).amountCents, 2800);
  assert.deepEqual((await payment.checkout(userId, input)).order, first.order);
  await assert.rejects(payment.checkout(userId, { ...input, expectedAmountCents: 1200 }), { code: 'IDEMPOTENCY_KEY_CONFLICT' });
  const next = { ...input, requestId: 'request-new-price-quote' };
  await assert.rejects(payment.checkout(userId, next), { code: 'BILLING_PRICE_CHANGED' });
  await assert.rejects(payment.checkout(userId, { ...next, expectedAmountCents: undefined }), { code: 'BILLING_QUOTE_REQUIRED' });
  assert.equal(calls.length, 2, 'price mismatch rejects before calling the provider');
  const paid = await payment.checkout(userId, { ...next, expectedAmountCents: 1200 });
  assert.equal(paid.order.amountCents, 1200);
  assert.deepEqual(calls.map(call => call.amountCents), [oldQuote.amountCents, oldQuote.amountCents, 1200]);
});

test('reviewed renewals keep each paid period, switch entitlements on time, and survive a refund and reload', async t => {
  const store = new JsonStore(join(await temporary(t), 'public.json'));
  const auth = new AuthService(store);
  const userId = (await auth.register(credentials)).session.user.id;
  const basicUserId = (await auth.register({ ...credentials, email: 'basic@example.test' })).session.user.id;
  let time = '2026-10-31T02:00:00.000Z';
  const now = () => new Date(time);
  let notification: AlipayNotification;
  const calls: AlipayPaymentInput[] = [];
  const alipay = {
    async createPayment(input: AlipayPaymentInput) { calls.push(input); return { redirectUrl: 'https://fixture.invalid/checkout' }; },
    parseNotification() { return notification; },
    async submitRefund() { return 'succeeded' as const; },
    async queryRefund() { return 'succeeded' as const; },
  };
  const quota = new QuotaService(store, now);
  const payments = new PaymentService({ store, quota, alipay, now });
  const refunds = new AdminRefunds(store, { alipay }, () => now().getTime());
  t.after(() => refunds.stop());
  function checkoutInput(quote: MembershipQuote, requestId: string) {
    return { planId: quote.planId, channel: 'alipay-page', requestId, expectedAmountCents: quote.amountCents, reviewId: quote.reviewId };
  }
  async function pay(owner: string, quote: MembershipQuote, requestId: string) {
    const { order } = await payments.checkout(owner, checkoutInput(quote, requestId));
    notification = { appId: 'fixture', outTradeNo: calls.at(-1)!.outTradeNo, tradeNo: `trade-${requestId}`,
      tradeStatus: 'TRADE_SUCCESS', amountCents: order.amountCents, paidAt: time };
    await payments.applyAlipayNotification({});
    await payments.applyAlipayNotification({});
    assert.equal((await payments.getOrder(owner, order.id)).status, 'paid');
    return order;
  }
  await pay(userId, await payments.quote(userId, 'premium'), 'initial-premium-order');
  await pay(basicUserId, await payments.quote(basicUserId, 'basic'), 'initial-basic-order');
  const firstEnd = '2026-11-30T02:00:00.000Z';
  const renewedEnd = '2026-12-30T02:00:00.000Z';
  const basicEnd = '2027-01-30T02:00:00.000Z';
  const premiumEnd = '2027-02-28T02:00:00.000Z';

  time = '2026-11-12T02:00:00.000Z';
  const basicRenewal = await payments.quote(basicUserId, 'basic');
  assert.equal(basicRenewal.kind, 'renewal');
  assert.deepEqual(basicRenewal.period, { startsAt: firstEnd, expiresAt: renewedEnd });
  await pay(basicUserId, basicRenewal, 'same-tier-basic-renewal');
  assert.equal((await payments.membership(basicUserId)).quota.expiresAt, renewedEnd);
  const firstSchedule = await payments.quote(userId, 'basic');
  assert.equal(firstSchedule.kind, 'scheduled');
  assert.deepEqual(firstSchedule.period, { startsAt: firstEnd, expiresAt: renewedEnd });
  await assert.rejects(payments.checkout(userId, { ...checkoutInput(firstSchedule, 'unreviewed-queued-basic'), reviewId: undefined }),
    { code: 'BILLING_QUOTE_REQUIRED' });
  const premiumRenewal = await payments.quote(userId, 'premium');
  assert.equal(premiumRenewal.kind, 'renewal');
  assert.equal(premiumRenewal.amountCents, 2990);
  assert.deepEqual(premiumRenewal.period, { startsAt: firstEnd, expiresAt: renewedEnd });
  await pay(userId, premiumRenewal, 'same-tier-premium-renewal');
  const basicSchedule = await payments.quote(userId, 'basic');
  assert.equal(basicSchedule.amountCents, firstSchedule.amountCents);
  assert.deepEqual(basicSchedule.period, { startsAt: renewedEnd, expiresAt: basicEnd });
  await assert.rejects(payments.checkout(userId, checkoutInput(firstSchedule, 'stale-queued-basic')), { code: 'BILLING_PERIOD_CHANGED' });
  assert.equal(calls.length, 4);
  await pay(userId, basicSchedule, 'queued-basic-renewal');
  const stillPremium = await payments.membership(userId);
  assert.equal(stillPremium.currentPlanId, 'premium');
  assert.equal(stillPremium.quota.expiresAt, renewedEnd);
  assert.deepEqual(stillPremium.nextPeriod, { planId: 'basic', startsAt: renewedEnd, expiresAt: basicEnd });

  const premiumSchedule = await payments.quote(userId, 'premium');
  assert.equal(premiumSchedule.kind, 'scheduled');
  assert.equal(premiumSchedule.amountCents, premiumRenewal.amountCents);
  assert.deepEqual(premiumSchedule.period, { startsAt: basicEnd, expiresAt: premiumEnd });
  const scheduled = await pay(userId, premiumSchedule, 'queued-premium-renewal');
  time = '2026-12-29T02:00:00.000Z';
  await quota.reserve(userId, 'task-before-tier-change', 'a'.repeat(64), 20_000);
  await quota.dispatch(userId, 'task-before-tier-change');
  await quota.settle(userId, 'task-before-tier-change', { inputTokens: 18_000, outputTokens: 2_000, totalTokens: 20_000 });
  const preview = await refunds.preview({ orderId: scheduled.id }, 'operator');
  assert.equal((await refunds.apply({ orderId: scheduled.id, previewId: preview.id, confirmed: true }, 'operator')).status, 'succeeded');
  const restarted = new JsonStore(store.path);
  const reopenedPayments = new PaymentService({ store: restarted, quota: new QuotaService(restarted, now), now });
  const saved = await restarted.read();
  assert.equal(saved.version, 6);
  assert.equal(saved.memberships.find(record => record.userId === userId)!.activations.length, 4);
  assert.deepEqual((await reopenedPayments.membership(userId)).nextPeriod, stillPremium.nextPeriod);
  assert.equal((await getWorkbenchAccess(restarted, userId, now())).planId, 'premium');

  time = renewedEnd;
  const switched = await reopenedPayments.membership(userId);
  assert.equal(switched.currentPlanId, 'basic');
  assert.equal(switched.quota.expiresAt, basicEnd);
  assert.equal(switched.quota.remainingPercent, 90, 'the tier switch keeps usage in the same quota week');
  assert.equal((await getWorkbenchAccess(restarted, userId, now())).features.companyJobs, false);
  time = basicEnd;
  assert.equal((await reopenedPayments.membership(userId)).currentPlanId, 'free');
  const returning = await reopenedPayments.quote(userId, 'premium');
  assert.equal(returning.kind, 'purchase');
  const premium = (await reopenedPayments.plans(userId)).find(plan => plan.id === 'premium')!;
  assert.equal(premium.priceCents, returning.amountCents);
  assert.equal(premium.promotionLabel, undefined, 'an expired membership does not restore the first-purchase price');
});

test('test and public APIs use separate data, prices, sessions, and payment paths', async t => {
  const directory = await temporary(t);
  async function instance(environment: 'public' | 'test') {
    const store = new JsonStore(join(directory, `${environment}.json`), environment);
    const auth = new AuthService(store);
    const userId = (await auth.register(credentials)).session.user.id;
    await store.mutate(data => { data.users.find(user => user.id === userId)!.emailVerified = true; });
    const server = createApiServer(new ResumeService(store), { auth, adminUserIds: new Set([userId]), secureCookies: false });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    async function request(path: string, payload?: unknown, cookie?: string) {
      const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const user = (await request('/auth/login', credentials)).cookie!;
    const admin = (await request('/admin/login', credentials)).cookie!;
    return { store, request, user, admin };
  }
  const live = await instance('public');
  const sandbox = await instance('test');
  assert.match(sandbox.user, /^youfang_test_session=/);
  assert.match(sandbox.admin, /^youfang_test_admin=/);
  assert.deepEqual((await sandbox.request('/environment')).body.data, { environment: 'test' });
  assert.deepEqual((await live.request('/environment')).body.data, { environment: 'public' });
  assert.equal((await sandbox.request('/membership', undefined, live.user)).status, 401);
  assert.equal((await live.request('/admin/pricing', undefined, sandbox.admin)).status, 401);
  assert.equal((await sandbox.request('/admin/pricing')).status, 401);
  await assert.rejects(new JsonStore(sandbox.store.path).read(), /environment/);
  await assert.rejects(new JsonStore(live.store.path, 'test').read(), /environment/);
  assert.throws(() => createApiServer(new ResumeService(sandbox.store), { paymentAlipay: {} as never }), /real payment gateways/);

  const base = (await sandbox.request('/admin/pricing', undefined, sandbox.admin)).body.data;
  assert.equal(base.environment, 'test');
  const draft = await sandbox.request('/admin/pricing/preview', { revision: base.revision, prices: newPrices }, sandbox.admin);
  assert.equal(draft.status, 200);
  const changed = await sandbox.request('/admin/pricing/apply', { id: draft.body.data.id, confirmed: true }, sandbox.admin);
  assert.equal(changed.status, 200);
  assert.equal((await live.request('/admin/pricing', undefined, live.admin)).body.data.revision, 0);
  const quote = await sandbox.request('/billing/quote?planId=premium', undefined, sandbox.user);
  assert.equal(quote.body.data.amountCents, 2800);
  async function premiumPlan(cookie?: string) {
    const response = await sandbox.request('/plans', undefined, cookie);
    assert.equal(response.status, 200);
    return (response.body.data as Plan[]).find(plan => plan.id === 'premium')!;
  }
  const firstPlan = await premiumPlan(sandbox.user);
  assert.equal(firstPlan.priceCents, quote.body.data.amountCents);
  assert.equal(firstPlan.listPriceCents, 3500);
  assert.equal(firstPlan.promotionLabel, '首充优惠');
  const checkout = { planId: 'premium', requestId: 'simulated-test-order-one', expectedAmountCents: 2800 };
  assert.equal((await live.request('/billing/simulate', checkout, live.user)).status, 404);
  assert.equal((await sandbox.request('/billing/alipay/notify', {}, sandbox.user)).status, 404);
  assert.equal((await sandbox.request('/billing/checkout', checkout, sandbox.user)).body.error.code, 'TEST_CHECKOUT_ONLY');
  assert.deepEqual((await sandbox.request('/billing/payment-methods')).body.data, { wechat: false, alipay: false });
  assert.equal((await sandbox.request('/billing/simulate', { ...checkout, expectedAmountCents: 1 }, sandbox.user)).status, 409);
  const simulated = await sandbox.request('/billing/simulate', checkout, sandbox.user);
  assert.equal(simulated.status, 201);
  assert.equal(simulated.body.data.status, 'paid');
  assert.deepEqual((await sandbox.request('/billing/simulate', checkout, sandbox.user)).body.data, simulated.body.data);
  const membership = await sandbox.request('/membership', undefined, sandbox.user);
  assert.equal(membership.body.data.paymentMode, 'simulation');
  assert.equal(membership.body.data.currentPlanId, 'premium');
  const renewal = (await sandbox.request('/billing/quote?planId=premium', undefined, sandbox.user)).body.data;
  assert.equal(renewal.kind, 'renewal');
  const repeatPlan = await premiumPlan(sandbox.user);
  assert.equal(repeatPlan.priceCents, 3500);
  assert.equal(repeatPlan.priceCents, renewal.amountCents);
  assert.equal(repeatPlan.listPriceCents, undefined);
  assert.equal(repeatPlan.promotionLabel, undefined);
  assert.equal((await premiumPlan()).priceCents, 2800);
  const otherUser = await sandbox.request('/auth/register', { ...credentials, email: 'fresh-account@example.test' });
  assert.equal(otherUser.status, 201);
  assert.ok(otherUser.cookie);
  assert.equal((await premiumPlan(otherUser.cookie)).priceCents, 2800);
  assert.equal((await new JsonStore(sandbox.store.path, 'test').read()).version, 5);
  const scheduled = (await sandbox.request('/billing/quote?planId=basic', undefined, sandbox.user)).body.data;
  assert.equal(scheduled.kind, 'scheduled');
  const scheduleInput = { planId: 'basic', requestId: 'simulated-test-order-two', expectedAmountCents: scheduled.amountCents, reviewId: scheduled.reviewId };
  const next = await sandbox.request('/billing/simulate', scheduleInput, sandbox.user);
  assert.equal(next.status, 201);
  assert.equal(next.body.data.status, 'paid');
  assert.deepEqual((await sandbox.request('/billing/simulate', scheduleInput, sandbox.user)).body.data, next.body.data);
  assert.deepEqual((await sandbox.request('/membership', undefined, sandbox.user)).body.data.nextPeriod, { planId: 'basic', ...scheduled.period });
  const orderId = simulated.body.data.id;
  const refund = await sandbox.request('/admin/orders/refund-preview', { orderId }, sandbox.admin);
  assert.equal(refund.body.data.amountCents, 2800);
  const confirmed = await sandbox.request('/admin/orders/refund-apply', { orderId, previewId: refund.body.data.id, confirmed: true }, sandbox.admin);
  assert.equal(confirmed.body.data.status, 'succeeded');
  assert.equal((await sandbox.request('/membership/workbench', undefined, sandbox.user)).body.data.planId, 'free');
  assert.deepEqual((await sandbox.request('/membership', undefined, sandbox.user)).body.data.nextPeriod, { planId: 'basic', ...scheduled.period });
  assert.equal((await new JsonStore(sandbox.store.path, 'test').read()).version, 6);
  const publicData = await live.store.read();
  assert.deepEqual([publicData.orders, publicData.refunds, publicData.memberships, publicData.pricingHistory], [[], [], [], []]);
});
