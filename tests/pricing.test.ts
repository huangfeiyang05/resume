import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AdminPricing } from '../server/admin-pricing.js';
import type { AlipayPaymentInput } from '../server/alipay.js';
import { AuthService } from '../server/auth.js';
import { createApiServer } from '../server/http.js';
import { PaymentService } from '../server/payments.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

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
  const orderId = simulated.body.data.id;
  const refund = await sandbox.request('/admin/orders/refund-preview', { orderId }, sandbox.admin);
  assert.equal(refund.body.data.amountCents, 2800);
  const confirmed = await sandbox.request('/admin/orders/refund-apply', { orderId, previewId: refund.body.data.id, confirmed: true }, sandbox.admin);
  assert.equal(confirmed.body.data.status, 'succeeded');
  assert.equal((await sandbox.request('/membership/workbench', undefined, sandbox.user)).body.data.planId, 'free');
  assert.equal((await new JsonStore(sandbox.store.path, 'test').read()).version, 5);
  const publicData = await live.store.read();
  assert.deepEqual([publicData.orders, publicData.refunds, publicData.memberships, publicData.pricingHistory], [[], [], [], []]);
});
