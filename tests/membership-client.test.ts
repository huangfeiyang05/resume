import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { getMembership, listPlans, membershipState } from '../server/membership.js';
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
    statusCode: 200, data: { data: options.url.endsWith('/plans') ? listPlans() : options.url.endsWith('/quota') ? getMembership().quota : getMembership() },
  });
  globals.uni = { request: (options: RequestOptions) => { requests.push(options); respond(options); } };
  setAuthToken('');
  t.after(() => {
    setAuthToken(''); globals.uni = originalUni;
    if (originalWx === undefined) delete globals.wx; else globals.wx = originalWx;
  });
  return { requests, respond: (handler: typeof respond) => { respond = handler; } };
}

test('membership H5 requests use the shared cookie transport and accept configured paid tiers', async t => {
  const { requests, respond } = fixture(t);
  setAuthToken('must-not-send-in-h5');
  const state = await membershipApi.current();
  assert.equal(state.currentPlanId, 'free');
  respond(options => options.success({ statusCode: 200, data: { data: listPlans().reverse() } }));
  const plans = await membershipApi.plans();
  assert.deepEqual(plans.map(plan => plan.id), ['free', 'basic', 'premium']);
  assert.equal(plans[1].priceCents, 990);
  assert.equal(plans[2].priceCents, 2490);
  assert.equal(plans[2].listPriceCents, 2990);
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
    (plans: any[]) => { delete plans[1].features.aiQuota; },
    (plans: any[]) => { plans[2].features.aiQuota = 800000; },
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
    (state: any) => { state.paymentAvailable = 'yes'; },
    (state: any) => { delete state.policy; },
    (state: any) => { state.policy.upgrade.expiryBase = 'payment-time'; },
    (state: any) => { state.policy.upgrade.unusedTime = 'replaced'; },
    (state: any) => { state.policy.activation = 'client-confirmed'; },
    (state: any) => { state.policy.timeZone = 'UTC'; },
    (state: any) => { state.policy.autoRenew = true; },
  ]) {
    const state = getMembership(); mutate(state);
    respond(options => options.success({ statusCode: 200, data: { data: state } }));
    await assert.rejects(membershipApi.current(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
});

test('checkout sends a stable request id, accepts only a verified payment payload and surfaces configuration errors', async t => {
  const { requests, respond } = fixture(t);
  const order = { id: 'order-12345678', planId: 'premium' as const, amountCents: 2490, status: 'pending' as const, channel: 'jsapi' as const, createdAt: '2026-11-05T02:00:00.000Z', expiresAt: '2026-11-05T04:00:00.000Z' };
  const payment = { appId: 'wx7c30911964bf6fe7', timeStamp: '1762345678', nonceStr: 'nonce-value', package: 'prepay_id=wx1234567890abcdef', signType: 'RSA' as const, paySign: 'signature-value' };
  respond(options => options.success({ statusCode: 201, data: { data: { order, payment } } }));
  const result = await membershipApi.checkout('premium', 'request-id-123456');
  assert.deepEqual(result, { order, payment });
  assert.deepEqual(requests.at(-1)?.data, { planId: 'premium', requestId: 'request-id-123456', channel: 'jsapi' });
  assert.equal(requests.at(-1)?.method, 'POST');
  for (const invalid of [null, {}, { order, payment: { ...payment, signType: 'MD5' } }, { order: { ...order, amountCents: 0 }, payment }, { order, payment: { ...payment, package: 'wrong' } }]) {
    respond(options => options.success({ statusCode: 201, data: { data: invalid } }));
    await assert.rejects(membershipApi.checkout('premium', 'request-id-123456'), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
  respond(options => options.success({ statusCode: 503, data: { error: { code: 'PAYMENT_NOT_CONFIGURED', message: '支付尚未配置完成，本次未扣费。' } } }));
  await assert.rejects(membershipApi.checkout('basic', 'request-id-123456'), error => error instanceof ApiError && error.code === 'PAYMENT_NOT_CONFIGURED');
});

test('native checkout accepts a scan payload and rejects broken QR data', async t => {
  const { respond } = fixture(t);
  const order = { id: 'order-12345678', planId: 'basic' as const, amountCents: 990, status: 'pending' as const, channel: 'native' as const, createdAt: '2026-11-05T02:00:00.000Z', expiresAt: '2026-11-05T04:00:00.000Z' };
  const native = { codeUrl: 'weixin://wxpay/bizpayurl?pr=1234567890abcdef', qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', expiresAt: order.expiresAt };
  respond(options => options.success({ statusCode: 201, data: { data: { order, native } } }));
  assert.deepEqual(await membershipApi.checkout('basic', 'request-id-123456', 'native'), { order, native });
  for (const invalid of [{ order, native: { ...native, codeUrl: 'https://example.test/' } }, { order, native: { ...native, qrCodeDataUrl: 'data:text/html;base64,PHN2Zy8+' } }, { order, native, payment: { appId: 'wx7c30911964bf6fe7', timeStamp: '1762345678', nonceStr: 'nonce-value', package: 'prepay_id=wx1234567890abcdef', signType: 'RSA', paySign: 'signature-value' } }]) {
    respond(options => options.success({ statusCode: 201, data: { data: invalid } }));
    await assert.rejects(membershipApi.checkout('basic', 'request-id-123456', 'native'), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
});

test('Alipay checkout accepts a signed redirect and payment methods are strictly validated', async t => {
  const { requests, respond } = fixture(t);
  respond(options => options.success({ statusCode: 200, data: { data: { wechat: true, alipay: true } } }));
  assert.deepEqual(await membershipApi.methods(), { wechat: true, alipay: true });
  assert.match(requests.at(-1)!.url, /\/billing\/payment-methods$/);
  for (const invalid of [null, {}, { wechat: true }, { wechat: 'yes', alipay: true }, { wechat: true, alipay: true, extra: true }]) {
    respond(options => options.success({ statusCode: 200, data: { data: invalid } }));
    await assert.rejects(membershipApi.methods(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
  const order = { id: 'order-12345678', planId: 'premium' as const, amountCents: 2490, status: 'pending' as const, channel: 'alipay-page' as const, createdAt: '2026-11-05T02:00:00.000Z', expiresAt: '2026-11-05T04:00:00.000Z' };
  const alipay = { redirectUrl: 'https://openapi.alipay.com/gateway.do?out_trade_no=YF20261105abcdef' };
  respond(options => options.success({ statusCode: 201, data: { data: { order, alipay } } }));
  assert.deepEqual(await membershipApi.checkout('premium', 'request-id-123456', 'alipay-page'), { order, alipay });
  assert.deepEqual(requests.at(-1)?.data, { planId: 'premium', requestId: 'request-id-123456', channel: 'alipay-page' });
  for (const invalid of [{ order, alipay: { redirectUrl: 'http://openapi.alipay.com/' } }, { order, alipay: { redirectUrl: '' } }, { order, alipay, payment: { appId: 'wx7c30911964bf6fe7', timeStamp: '1762345678', nonceStr: 'nonce-value', package: 'prepay_id=wx1234567890abcdef', signType: 'RSA', paySign: 'signature-value' } }]) {
    respond(options => options.success({ statusCode: 201, data: { data: invalid } }));
    await assert.rejects(membershipApi.checkout('premium', 'request-id-123456', 'alipay-page'), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
});

test('payment quote and order responses are strictly validated', async t => {
  const { respond } = fixture(t);
  const quote = { planId: 'premium', amountCents: 2490, listPriceCents: 2990, promotionLabel: '首充优惠', kind: 'purchase', currentPlanId: 'free' };
  respond(options => options.success({ statusCode: 200, data: { data: quote } }));
  assert.deepEqual(await membershipApi.quote('premium'), quote);
  for (const invalid of [{ ...quote, amountCents: '2490' }, { ...quote, kind: 'upgrade' , currentPlanId: 'free' }, { ...quote, listPriceCents: 2000 }, { ...quote, promotionLabel: 1 }]) {
    respond(options => options.success({ statusCode: 200, data: { data: invalid } }));
    await assert.rejects(membershipApi.quote('premium'), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
  const order = { id: 'order-12345678', planId: 'basic', amountCents: 990, status: 'paid', channel: 'jsapi', createdAt: '2026-11-05T02:00:00.000Z', expiresAt: '2026-11-05T04:00:00.000Z', paidAt: '2026-11-05T02:01:00.000Z' };
  respond(options => options.success({ statusCode: 200, data: { data: order } }));
  assert.deepEqual(await membershipApi.order(order.id), order);
  respond(options => options.success({ statusCode: 200, data: { data: { ...order, status: 'refunded' } } }));
  await assert.rejects(membershipApi.order(order.id), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
});

test('mini-program virtual checkout sends fresh identity proof and rejects payment data for a different reviewed amount', async t => {
  const { requests, respond } = fixture(t, true);
  const order = { id: 'order-virtual-01', planId: 'basic', amountCents: 990, status: 'pending', channel: 'wechat-virtual',
    createdAt: '2026-11-05T02:00:00.000Z', expiresAt: '2026-11-05T04:00:00.000Z' };
  const signed = { offerId: '12345', buyQuantity: 1, env: 0, currencyType: 'CNY', productId: 'basic_month',
    goodsPrice: 990, outTradeNo: 'synthetic-out-trade-no' };
  const virtual = { mode: 'short_series_goods', signData: JSON.stringify(signed), paySig: 'a'.repeat(64), signature: 'b'.repeat(64) };
  const proof = { wechatCode: 'fresh-login-code', device: 'ios' as const };
  const reviewId = 'a'.repeat(64);
  const checkout = () => membershipApi.checkout('basic', 'virtual-request-123', 'wechat-virtual', 990, reviewId, proof);
  const reply = (data: unknown) => respond(options => options.success({ statusCode: 201, data: { data } }));
  reply({ order, virtual });
  assert.deepEqual(await checkout(), { order, virtual });
  assert.deepEqual(requests.at(-1)?.data, { planId: 'basic', requestId: 'virtual-request-123', channel: 'wechat-virtual', expectedAmountCents: 990, reviewId, ...proof });
  reply({ order, virtual: { ...virtual, signData: JSON.stringify({ ...signed, goodsPrice: 1 }) } });
  await assert.rejects(checkout(), { code: 'INVALID_RESPONSE' });
});

test('scheduled renewal dates must be valid and the reviewed quote accompanies checkout', async t => {
  const { requests, respond } = fixture(t);
  const period = { startsAt: '2026-12-05T07:00:00.000Z', expiresAt: '2027-01-05T07:00:00.000Z' };
  const quote = { planId: 'basic', amountCents: 990, kind: 'scheduled', currentPlanId: 'premium', period, reviewId: 'a'.repeat(64) };
  const reply = (data: unknown) => respond(options => options.success({ statusCode: 200, data: { data } }));
  reply(quote);
  assert.deepEqual(await membershipApi.quote('basic'), quote);
  for (const invalid of [{ ...quote, period: undefined }, { ...quote, reviewId: undefined },
    { ...quote, period: { ...period, startsAt: period.expiresAt } }]) {
    reply(invalid);
    await assert.rejects(membershipApi.quote('basic'), { code: 'INVALID_RESPONSE' });
  }
  const active = membershipState({ status: 'active', remainingPercent: 100, resetsAt: '2026-11-12T07:00:00.000Z',
    expiresAt: period.startsAt, pending: false }, 'premium');
  const nextPeriod = { planId: 'basic', ...period };
  reply({ ...active, nextPeriod });
  assert.deepEqual((await membershipApi.current()).nextPeriod, nextPeriod);
  reply({ ...active, nextPeriod: { ...nextPeriod, startsAt: '2026-12-01T07:00:00.000Z' } });
  await assert.rejects(membershipApi.current(), { code: 'INVALID_RESPONSE' });

  const order = { id: 'order-12345678', planId: 'basic', amountCents: 990, status: 'pending', channel: 'alipay-page',
    createdAt: '2026-11-05T02:00:00.000Z', expiresAt: '2026-11-05T04:00:00.000Z' };
  reply({ order, alipay: { redirectUrl: 'https://openapi.alipay.com/gateway.do' } });
  await membershipApi.checkout('basic', 'queued-request-123456', 'alipay-page', quote.amountCents, quote.reviewId);
  assert.deepEqual(requests.at(-1)?.data, { planId: 'basic', requestId: 'queued-request-123456', channel: 'alipay-page',
    expectedAmountCents: quote.amountCents, reviewId: quote.reviewId });
});

test('membership accepts trusted paid states and exposes percentage-only quota summaries', async t => {
  const { requests, respond } = fixture(t);
  const quota = { status: 'active' as const, remainingPercent: 78, resetsAt: '2026-11-12T07:00:00.000Z', expiresAt: '2026-12-05T07:00:00.000Z', pending: false };
  for (const planId of ['basic', 'premium'] as const) {
    const state = membershipState(quota, planId);
    respond(options => options.success({ statusCode: 200, data: { data: options.url.endsWith('/quota') ? quota : state } }));
    const current = await membershipApi.current();
    assert.equal(current.mode, 'active');
    assert.equal(current.currentPlanId, planId);
    assert.deepEqual(current.quota, quota);
    assert.deepEqual(await membershipApi.quota(), quota);
  }
  assert.ok(requests.some(item => item.url.endsWith('/membership/quota')));
  const inactive = { status: 'inactive' as const, remainingPercent: null, resetsAt: null, expiresAt: '2026-11-05T07:00:00.000Z', pending: true };
  respond(options => options.success({ statusCode: 200, data: { data: membershipState(inactive) } }));
  assert.deepEqual((await membershipApi.current()).quota, inactive);
});

test('membership rejects missing, fabricated, out-of-range and leaking quota responses', async t => {
  const { respond } = fixture(t);
  const active = { status: 'active', remainingPercent: 78, resetsAt: '2026-11-12T07:00:00.000Z', expiresAt: '2026-12-05T07:00:00.000Z', pending: false };
  const malformed: unknown[] = [undefined, null, [], {},
    { ...active, remainingPercent: -1 }, { ...active, remainingPercent: 101 }, { ...active, remainingPercent: 78.5 },
    { ...active, remainingPercent: '78' }, { ...active, remainingPercent: null },
    { ...active, resetsAt: null }, { ...active, resetsAt: 'not-a-date' },
    { ...active, resetsAt: '2026-02-31T00:00:00Z' }, { ...active, resetsAt: '2026-11-12T24:00:00Z' }, { ...active, resetsAt: '2026-11-12T15:00:00' },
    { ...active, expiresAt: null }, { ...active, pending: 'false' },
    { ...active, remainingTokens: 156000 }, { ...active, limitTokens: 200000 },
    { status: 'preview', remainingPercent: 100, resetsAt: null, expiresAt: null, pending: false },
    { status: 'inactive', remainingPercent: 78, resetsAt: null, expiresAt: null, pending: false },
  ];
  for (const quota of malformed) {
    respond(options => options.success({ statusCode: 200, data: { data: quota } }));
    await assert.rejects(membershipApi.quota(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
    respond(options => options.success({ statusCode: 200, data: { data: { ...getMembership(), quota } } }));
    await assert.rejects(membershipApi.current(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
  }
  // A valid active balance cannot be attached to a preview/free identity.
  respond(options => options.success({ statusCode: 200, data: { data: { ...getMembership(), quota: active } } }));
  await assert.rejects(membershipApi.current(), error => error instanceof MembershipApiError && error.code === 'INVALID_RESPONSE');
});
