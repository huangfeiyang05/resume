import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { MembershipPreview, Plan } from '../shared/types.js';
import { createApiServer } from '../server/http.js';
import { HttpError } from '../server/errors.js';
import { calculateMembershipPeriod } from '../server/membership.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { QuotaService } from '../server/quota.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-membership-'));
  const path = join(directory, 'resumes.json');
  const service = new ResumeService(new JsonStore(path));
  const server = createApiServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const registration = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'membership-fixture@example.test', password: 'Fixture-pw-26!' }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  const request = async (route: string, method = 'GET', body?: unknown) => {
    const result = await fetch(`${base}${route}`, {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json() as any };
  };
  return { path, service, request };
}

test('membership is explicit preview state without fabricated AI balances or enforced quotas', async (t) => {
  const { request } = await fixture(t);
  const result = await request('/membership');
  assert.equal(result.status, 200);
  const membership = result.body.data as MembershipPreview;
  assert.equal(membership.mode, 'preview');
  assert.equal(membership.currentPlanId, 'free');
  assert.equal(membership.paymentAvailable, false);
  assert.equal(membership.limitsEnforced, false);
  assert.equal('expiresAt' in membership, false, 'preview must not invent a paid expiry');
  assert.equal('remainingQuota' in membership, false, 'preview must not invent paid credits');
  assert.equal(membership.policy.durationMonths, 1);
  assert.equal(membership.policy.timeZone, 'Asia/Shanghai');
  assert.equal(membership.policy.autoRenew, false);
  assert.equal(membership.policy.activation, 'verified-payment');
  assert.equal(membership.policy.upgrade.fromPlanId, 'basic');
  assert.equal(membership.policy.upgrade.toPlanId, 'premium');
  assert.equal(membership.policy.upgrade.charge, 'full-price-difference');
  assert.equal(membership.policy.upgrade.expiryBase, 'payment-time');
  assert.equal(membership.policy.upgrade.unusedTime, 'replaced');
  assert.equal((await request('/membership', 'POST', {})).status, 405);
});

test('three current tiers expose configured prices and honest promotion labels', async (t) => {
  const { request } = await fixture(t);
  const result = await request('/plans');
  assert.equal(result.status, 200);
  const plans = result.body.data as Plan[];
  assert.deepEqual(plans.map(({ id, priceCents, listPriceCents, durationMonths }) => ({ id, priceCents, listPriceCents, durationMonths })), [
    { id: 'free', priceCents: 0, listPriceCents: undefined, durationMonths: 0 },
    { id: 'basic', priceCents: 990, listPriceCents: undefined, durationMonths: 1 },
    { id: 'premium', priceCents: 2490, listPriceCents: 2990, durationMonths: 1 },
  ]);
  assert.equal(plans[2].promotionLabel, '限时优惠');
  const [free, basic, premium] = plans;
  assert.match(free.features.templates, /3/);
  assert.equal(free.features.optimization, '不包含');
  assert.notEqual(basic.features.optimization, '不包含');
  assert.match(premium.features.optimization, /初级/);
  for (const feature of ['companyJobs', 'studyMaterials', 'smartDelivery'] as const) {
    assert.equal(basic.features[feature], '不包含');
    assert.notEqual(premium.features[feature], '不包含');
  }
  assert.match(premium.features.companyJobs, /专业/);
  assert.match(premium.features.smartDelivery, /精选投递/);
  assert.equal((await request('/plans', 'POST', {})).status, 405);
});

test('trusted membership exposes only a user-scoped remaining percentage and rules do not consume AI quota', async t => {
  const { service, request } = await fixture(t);
  const userId = (await request('/auth/me')).body.data.user.id as string;
  const quota = new QuotaService(service.store);
  await quota.activateMembership({ userId, planId: 'basic', verifiedPaymentAt: new Date().toISOString(), verifiedEventId: 'verified-membership-test', idempotencyKey: 'membership-test-event' });
  const initial = await request('/membership');
  assert.equal(initial.body.data.mode, 'active');
  assert.equal(initial.body.data.currentPlanId, 'basic');
  assert.equal(initial.body.data.paymentAvailable, false);
  assert.equal(initial.body.data.quota.remainingPercent, 100);
  assert.equal(initial.body.data.limitsEnforced, true);
  await quota.reserve(userId, 'metered-membership-test', 'a'.repeat(64), 50_000);
  await quota.dispatch(userId, 'metered-membership-test');
  await quota.settle(userId, 'metered-membership-test', { inputTokens: 30_000, outputTokens: 10_000, totalTokens: 40_000 });
  const result = await request('/membership/quota');
  assert.deepEqual(Object.keys(result.body.data).sort(), ['expiresAt', 'pending', 'remainingPercent', 'resetsAt', 'status']);
  assert.equal(result.body.data.remainingPercent, 80);
  assert.equal(/tokens|inputHash|requestId|200000|800000/i.test(JSON.stringify(result.body)), false);
  const resume = await request('/resumes', 'POST', { title: '规则不扣额度', text: '项目经历\n负责真实业务开发并维护实际验收记录。' });
  assert.equal((await request('/analyses', 'POST', { resumeId: resume.body.data.id })).status, 201);
  assert.equal((await request('/membership/quota')).body.data.remainingPercent, 80);
  assert.equal((await request('/membership/quota', 'POST', { remainingPercent: 100 })).status, 405);
  assert.equal((await service.store.read()).aiUsage.length, 1);
});

test('checkout validates plan identity and leaves membership and persisted data unchanged', async (t) => {
  const { path, service, request } = await fixture(t);
  await service.createResume({ title: '测试简历', targetRole: '后端开发', text: '项目经历\n负责真实业务的维护与开发。' });
  const beforeMembership = (await request('/membership')).body;
  const beforeFile = await readFile(path, 'utf8');
  for (const input of [
    {}, null, [], { planId: 'unknown' }, { planId: 123 }, { planId: 'free' },
    ...['single', 'weekly', 'monthly'].map(planId => ({ planId })),
    { planId: 'premium', priceCents: 1 }, { planId: 'premium', currentPlanId: 'basic' },
    { planId: 'premium', verifiedPaymentAt: '2026-10-25T00:00:00Z' },
    { planId: 'premium', paid: true }, { planId: 'premium', userId: 'other-user' },
    { planId: 'premium', expiresAt: '2099-01-01T00:00:00Z' },
    { planId: 'premium' }, { planId: 'premium', requestId: 'short' },
  ]) {
    assert.equal((await request('/billing/checkout', 'POST', input)).status, 400);
  }
  for (const planId of ['basic', 'premium', 'premium']) {
    const result = await request('/billing/checkout', 'POST', { planId, requestId: `request-${planId}-${Math.random().toString(36).slice(2, 18)}` });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'PAYMENT_NOT_CONFIGURED');
    assert.match(result.body.error.message, /未扣费/);
  }
  assert.deepEqual((await request('/membership')).body, beforeMembership);
  assert.equal(await readFile(path, 'utf8'), beforeFile, 'preview checkout must not persist orders or grant entitlements');
  assert.equal((await request('/billing/checkout')).status, 405);
});

test('upgrade starts a new calendar month immediately instead of extending the old expiry', () => {
  const input = {
    planId: 'premium' as const, verifiedPaymentAt: '2026-10-25T15:42:03.456+08:00',
    current: { planId: 'basic' as const, expiresAt: '2026-11-10T12:00:00+08:00' },
  };
  const result = calculateMembershipPeriod(input);
  assert.deepEqual(result, {
    kind: 'upgrade', planId: 'premium', startsAt: '2026-10-25T07:42:03.456Z', expiresAt: '2026-11-25T07:42:03.456Z',
  });
  assert.deepEqual(calculateMembershipPeriod(input), result, 'repeating a date calculation must be deterministic');
  assert.equal(input.current.expiresAt, '2026-11-10T12:00:00+08:00', 'a calculation cannot mutate existing membership state');
});

test('calendar months clamp month-end dates, preserve the Shanghai time and support leap years', () => {
  const cases = [
    ['2026-01-31T18:35:09.123+08:00', '2026-02-28T10:35:09.123Z'],
    ['2028-01-31T18:35:09.123+08:00', '2028-02-29T10:35:09.123Z'],
    ['2026-12-31T18:35:09.123+08:00', '2027-01-31T10:35:09.123Z'],
    ['2026-10-31T00:15:00+08:00', '2026-11-29T16:15:00.000Z'],
    ['2026-03-31T00:15:00+08:00', '2026-04-29T16:15:00.000Z'],
  ];
  for (const [verifiedPaymentAt, expected] of cases) {
    assert.equal(calculateMembershipPeriod({ planId: 'basic', verifiedPaymentAt }).expiresAt, expected);
  }
  assert.deepEqual(
    calculateMembershipPeriod({ planId: 'premium', verifiedPaymentAt: '2026-10-30T16:15:00Z' }),
    calculateMembershipPeriod({ planId: 'premium', verifiedPaymentAt: '2026-10-31T00:15:00+08:00' }),
    'timezone spellings of the same instant must produce the same term',
  );
});

test('same-tier renewals preserve an active term and expired memberships start from payment time', () => {
  const current = { planId: 'premium' as const, expiresAt: '2026-11-10T12:00:00+08:00' };
  assert.deepEqual(calculateMembershipPeriod({ planId: 'premium', verifiedPaymentAt: '2026-10-25T12:00:00+08:00', current }), {
    kind: 'renewal', planId: 'premium', startsAt: '2026-11-10T04:00:00.000Z', expiresAt: '2026-12-10T04:00:00.000Z',
  });
  for (const expiry of ['2026-10-24T12:00:00+08:00', '2026-10-25T12:00:00+08:00']) {
    assert.deepEqual(calculateMembershipPeriod({ planId: 'premium', verifiedPaymentAt: '2026-10-25T12:00:00+08:00', current: { planId: 'basic', expiresAt: expiry } }), {
      kind: 'purchase', planId: 'premium', startsAt: '2026-10-25T04:00:00.000Z', expiresAt: '2026-11-25T04:00:00.000Z',
    }, 'an expired or exactly ended basic membership is a new purchase, not a difference-price upgrade');
  }
});

test('period calculation rejects invalid timestamps, invalid plans and active downgrades', () => {
  for (const verifiedPaymentAt of ['bad-date', '2026-10-25T12:00:00', '2026-13-25T12:00:00Z', '2026-02-31T12:00:00Z']) {
    assert.throws(() => calculateMembershipPeriod({ planId: 'premium', verifiedPaymentAt }), error => error instanceof HttpError && error.status === 400);
  }
  assert.throws(() => calculateMembershipPeriod({ planId: 'free' as any, verifiedPaymentAt: '2026-10-25T00:00:00Z' }), error => error instanceof HttpError && error.status === 400);
  assert.throws(() => calculateMembershipPeriod({ planId: 'basic', verifiedPaymentAt: '2026-10-25T00:00:00Z', current: { planId: 'premium', expiresAt: '2026-11-01T00:00:00Z' } }), error => error instanceof HttpError && error.code === 'MEMBERSHIP_DOWNGRADE_NOT_SUPPORTED');
  assert.throws(() => calculateMembershipPeriod({ planId: 'basic', verifiedPaymentAt: '2026-10-25T00:00:00Z', current: { planId: 'basic', expiresAt: 'not-a-date' } }), error => error instanceof HttpError && error.status === 400);
});
