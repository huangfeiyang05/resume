import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { getMembership, listPlans } from '../server/membership.js';
import { ApiError, onUnauthorized, setAuthToken } from '../src/services/api.js';
import { membershipApi, MembershipApiError } from '../src/services/membership.js';

type RequestOptions = {
  url: string; method: string; data?: unknown; header: Record<string, string>; withCredentials?: boolean;
  success: (response: { statusCode: number; data: unknown }) => void;
  fail: (reason: unknown) => void;
};

function fixture(t: TestContext, native = false) {
  const globals = globalThis as typeof globalThis & { uni?: unknown; wx?: unknown };
  const originalUni = globals.uni, originalWx = globals.wx;
  if (native) globals.wx = {}; else delete globals.wx;
  const requests: RequestOptions[] = [];
  let respond = (options: RequestOptions) => options.success({
    statusCode: 200, data: { data: options.url.endsWith('/plans') ? listPlans() : getMembership() },
  });
  globals.uni = { request: (options: RequestOptions) => { requests.push(options); respond(options); } };
  setAuthToken('');
  t.after(() => {
    setAuthToken(''); globals.uni = originalUni;
    if (originalWx === undefined) delete globals.wx; else globals.wx = originalWx;
  });
  return { requests, respond: (handler: typeof respond) => { respond = handler; } };
}

test('membership H5 requests use the shared cookie transport and accept unpriced paid tiers', async t => {
  const { requests, respond } = fixture(t);
  setAuthToken('must-not-send-in-h5');
  const state = await membershipApi.current();
  assert.equal(state.currentPlanId, 'free');
  respond(options => options.success({ statusCode: 200, data: { data: listPlans().reverse() } }));
  const plans = await membershipApi.plans();
  assert.deepEqual(plans.map(plan => plan.id), ['free', 'basic', 'premium']);
  assert.equal(plans[1].priceCents, null);
  assert.ok(requests.every(item => item.withCredentials === true));
  assert.ok(requests.every(item => !('Authorization' in item.header) && !('X-Auth-Client' in item.header)));
});

test('membership mini-program requests send the session token and report session expiry', async t => {
  const { requests, respond } = fixture(t, true);
  setAuthToken('synthetic-membership-session');
  await membershipApi.current();
  await membershipApi.plans();
  assert.ok(requests.every(item => item.header.Authorization === 'Bearer synthetic-membership-session'));
  assert.ok(requests.every(item => item.header['X-Auth-Client'] === 'mp-weixin'));
  let expired = 0;
  const dispose = onUnauthorized(() => { ++expired; });
  t.after(dispose);
  respond(options => options.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'expired' } } }));
  await assert.rejects(membershipApi.current(), error => error instanceof ApiError && error.status === 401);
  assert.equal(expired, 1);
});

test('membership client rejects obsolete, malformed or ambiguous plan data', async t => {
  const { respond } = fixture(t);
  const invalidPlans: unknown[] = [null, {}, [], [...listPlans(), { ...listPlans()[1], id: 'weekly' }]];
  for (const mutate of [
    (plans: any[]) => { plans[1].id = 'single'; },
    (plans: any[]) => { plans[1].id = 'free'; },
    (plans: any[]) => { plans[1].priceCents = 0; },
    (plans: any[]) => { plans[1].priceCents = -100; },
    (plans: any[]) => { plans[1].priceCents = 1.5; },
    (plans: any[]) => { plans[1].priceCents = '990'; },
    (plans: any[]) => { plans[1].priceCents = Number.MAX_SAFE_INTEGER + 1; },
    (plans: any[]) => { plans[0].priceCents = null; },
    (plans: any[]) => { plans[1].durationMonths = 0; },
    (plans: any[]) => { delete plans[2].features.studyMaterials; },
    (plans: any[]) => { plans[2].highlight = 3; },
    (plans: any[]) => { plans[2].features = null; },
  ]) {
    const plans = listPlans(); mutate(plans); invalidPlans.push(plans);
  }
  for (const data of invalidPlans) {
    respond(options => options.success({ statusCode: 200, data: { data } }));
    await assert.rejects(membershipApi.plans(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
});

test('membership client rejects a fabricated paid state or incompatible upgrade policy', async t => {
  const { respond } = fixture(t);
  for (const mutate of [
    (state: any) => { state.currentPlanId = 'premium'; },
    (state: any) => { state.paymentAvailable = true; },
    (state: any) => { delete state.policy; },
    (state: any) => { state.policy.upgrade.expiryBase = 'current-expiry'; },
    (state: any) => { state.policy.upgrade.unusedTime = 'stacked'; },
    (state: any) => { state.policy.activation = 'client-confirmed'; },
    (state: any) => { state.policy.timeZone = 'UTC'; },
    (state: any) => { state.policy.autoRenew = true; },
  ]) {
    const state = getMembership(); mutate(state);
    respond(options => options.success({ statusCode: 200, data: { data: state } }));
    await assert.rejects(membershipApi.current(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
});

test('checkout posts only the selected plan and cannot turn an unexpected success into membership', async t => {
  const { requests, respond } = fixture(t);
  const before = await membershipApi.current();
  respond(options => options.success({ statusCode: 200, data: { data: { paid: true, planId: 'premium', expiresAt: '2099-01-01T00:00:00Z' } } }));
  await assert.rejects(membershipApi.checkout('premium'), error => error instanceof MembershipApiError && error.code === 'UNEXPECTED_CHECKOUT_RESULT');
  assert.deepEqual(requests.at(-1)?.data, { planId: 'premium' });
  assert.equal(requests.at(-1)?.method, 'POST');
  respond(options => options.success({ statusCode: 200, data: { data: getMembership() } }));
  assert.deepEqual(await membershipApi.current(), before);
  respond(options => options.success({ statusCode: 503, data: { error: { code: 'PAYMENT_NOT_CONFIGURED', message: '支付暂未开放，本次未扣费。' } } }));
  await assert.rejects(membershipApi.checkout('basic'), error => error instanceof ApiError && error.code === 'PAYMENT_NOT_CONFIGURED');
});
