import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CheckoutResult, MembershipQuote } from '../shared/types.js';
import { AdminPricing } from '../server/admin-pricing.js';
import { AuthService } from '../server/auth.js';
import { createApiServer } from '../server/http.js';
import { defaultPricing } from '../server/payment-config.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { WechatApi } from '../server/wechat-api.js';
import { WechatMessagePush } from '../server/wechat-message-push.js';
import { loadWechatVirtualConfig, WechatVirtualGateway } from '../server/wechat-virtual-gateway.js';

const appid = 'wx0123456789abcdef';
const aes = Buffer.alloc(32, 7);
const token = 'TESTpushtoken';
const appKey = 'synthetic-app-key';
const sessionKey = 'synthetic-session-key';
const endpoint = '/billing/wechat-virtual/notify';
const signature = (...fields: string[]) => createHash('sha1').update([token, ...fields].sort().join('')).digest('hex');
const mac = (key: string, body: string) => createHmac('sha256', key).update(body).digest('hex');

function encryptedPush(data: unknown, target = appid) {
  const msg = Buffer.from(JSON.stringify(data));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(msg.length);
  const body = Buffer.concat([Buffer.alloc(16, 1), length, msg, Buffer.from(target)]);
  const padding = 32 - body.length % 32;
  const cipher = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
  const nonce = 'noncetest', timestamp = String(Math.floor(Date.now() / 1000));
  return {
    body: { Encrypt: encrypted },
    params: new URLSearchParams({ timestamp, nonce, encrypt_type: 'aes', msg_signature: signature(timestamp, nonce, encrypted) }),
  };
}

async function fixture(t: TestContext, { basic = 990, ios = true, enabled = true,
  products = { basic: { [basic]: 'basic_month' } } as Record<string, Record<string, string>> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-virtual-payment-'));
  const path = join(directory, 'resumes.json');
  const store = new JsonStore(path);
  const pricing = { ...defaultPricing, basic: { priceCents: basic } };
  const config = loadWechatVirtualConfig({
    WECHAT_VIRTUAL_PAY_ENABLED: String(enabled), WECHAT_VIRTUAL_PAY_IOS_ENABLED: String(ios),
    WECHAT_VIRTUAL_PAY_OFFER_ID: '12345', WECHAT_VIRTUAL_PAY_APP_KEY: appKey,
    WECHAT_VIRTUAL_PAY_PUSH_TOKEN: token, WECHAT_VIRTUAL_PAY_PUSH_AES_KEY: aes.toString('base64').slice(0, -1),
    WECHAT_VIRTUAL_PAY_PRODUCTS: JSON.stringify(products),
  })!;
  const remote = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const api = new WechatApi({ appid, appSecret: 'synthetic-app-secret' }, async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'provider-token', expires_in: 7200 });
    const raw = String(init?.body);
    assert.equal(url.searchParams.get('pay_sig'), mac(appKey, url.pathname + '&' + raw));
    assert.equal(url.searchParams.get('access_token'), 'provider-token');
    const request = JSON.parse(raw);
    assert.equal(request.env, 0);
    if (url.pathname === '/xpay/notify_provide_goods') return new Response(null, { status: 204 });
    assert.equal(url.pathname, '/xpay/query_order');
    assert.match(request.openid, /^test-openid-[ab]$/);
    return Response.json({ errcode: 0, order: remote.get(request.order_id)
      ?? { order_id: request.order_id, env_type: 1, order_type: 0, status: 1 } });
  });
  const auth = new AuthService(store, { wechat: { async exchange(code) {
    return { openid: code.startsWith('a-') ? 'test-openid-a' : 'test-openid-b', sessionKey };
  } } });
  const server = createApiServer(new ResumeService(store), {
    auth, pricing, paymentVirtual: { gateway: new WechatVirtualGateway(config, api), push: new WechatMessagePush(appid, token, aes) },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
  const request = (route: string, token?: string, data?: unknown, mini = true) => fetch(base + route, {
    method: data === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json',
      ...(mini ? { 'X-Auth-Client': 'mp-weixin' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  async function login(code: string) {
    const result = await request('/auth/wechat', undefined, { code });
    assert.equal(result.status, 200);
    return (await result.json()).data;
  }
  async function checkoutInput(userToken: string, planId: 'basic' | 'premium' = 'basic', requestId = 'virtual-order-test-123') {
    const quote = (await (await request('/billing/quote?planId=' + planId, userToken)).json()).data as MembershipQuote;
    return { planId, channel: 'wechat-virtual', requestId, expectedAmountCents: quote.amountCents, reviewId: quote.reviewId, wechatCode: 'a-payment', device: 'ios' };
  }
  return { request, login, checkoutInput, remote, store, path, calls };
}

test('virtual checkout checks platform availability, SKU and the reviewed quote before signing', async t => {
  const f = await fixture(t, { basic: 1 });
  const { token: bearer } = await f.login('a-login');
  assert.deepEqual((await (await f.request('/billing/payment-methods', undefined, undefined, false)).json()).data, { wechat: false, alipay: false });
  assert.deepEqual((await (await f.request('/billing/payment-methods')).json()).data.wechatVirtual, { ios: true });
  const input = await f.checkoutInput(bearer);
  const belowMinimum = await f.request('/billing/checkout', bearer, input);
  assert.equal((await belowMinimum.json()).error.code, 'WECHAT_VIRTUAL_IOS_MINIMUM');
  const unavailable = await f.request('/billing/checkout', bearer, await f.checkoutInput(bearer, 'premium'));
  assert.equal((await unavailable.json()).error.code, 'WECHAT_VIRTUAL_PRODUCT_UNAVAILABLE');
  const wrongQuote = await f.request('/billing/checkout', bearer, { ...input, device: 'other', expectedAmountCents: 2 });
  assert.equal((await wrongQuote.json()).error.code, 'BILLING_PRICE_CHANGED');
  const noReview = await f.request('/billing/checkout', bearer, { ...input, device: 'other', reviewId: undefined });
  assert.equal((await noReview.json()).error.code, 'BILLING_QUOTE_REQUIRED');
  assert.equal((await f.store.read()).orders.length, 0);
  const result = await f.request('/billing/checkout', bearer, { ...input, device: 'other' });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).data.order.amountCents, 1);
});

test('named virtual products follow published prices and preserve the original amount on existing orders', async t => {
  const f = await fixture(t, { products: {
    basic: { month: 'basic_month' }, premium: { first: 'premium_first', month: 'premium_month' },
  } });
  const a = await f.login('a-login');
  const b = await f.login('b-login');

  async function place(bearer: string, input: Awaited<ReturnType<typeof f.checkoutInput>>) {
    const response = await f.request('/billing/checkout', bearer, input);
    assert.equal(response.status, 201);
    return (await response.json()).data as CheckoutResult;
  }
  async function confirmPaid(bearer: string, order: CheckoutResult, wxOrderId: string) {
    const { outTradeNo, goodsPrice } = JSON.parse(order.virtual!.signData);
    f.remote.set(outTradeNo, { order_id: outTradeNo, env_type: 1, order_type: 7, status: 2, order_fee: goodsPrice,
      paid_fee: goodsPrice, wx_order_id: wxOrderId, paid_time: Math.floor(Date.now() / 1000) });
    const response = await f.request('/billing/orders/' + order.order.id, bearer);
    assert.equal((await response.json()).data.status, 'paid');
  }

  const originalInput = await f.checkoutInput(a.token, 'premium', 'premium-first-original');
  const original = await place(a.token, originalInput);
  assert.equal(JSON.parse(original.virtual!.signData).productId, 'premium_first');
  assert.equal(JSON.parse(original.virtual!.signData).goodsPrice, 2490);

  const admin = new AdminPricing(f.store);
  const preview = await admin.preview({ revision: 0, prices: {
    basicMonthlyCents: 990, premiumFirstPurchaseCents: 1490, premiumMonthlyCents: 2480,
  } }, 'test-admin');
  await admin.apply({ id: preview.id, confirmed: true }, 'test-admin');
  const quote = (await (await f.request('/billing/quote?planId=premium', a.token)).json()).data as MembershipQuote;
  assert.equal(quote.virtualProductAvailable, true);
  assert.equal(quote.amountCents, 1490);
  const stale = await f.request('/billing/checkout', a.token, { ...originalInput, requestId: 'premium-first-stale' });
  assert.equal((await stale.json()).error.code, 'BILLING_PRICE_CHANGED');
  const replay = await place(a.token, originalInput);
  assert.equal(replay.order.id, original.order.id);
  assert.deepEqual(replay.virtual, original.virtual);
  const updated = await place(a.token, await f.checkoutInput(a.token, 'premium', 'premium-first-updated'));
  assert.equal(JSON.parse(updated.virtual!.signData).productId, 'premium_first');
  assert.equal(JSON.parse(updated.virtual!.signData).goodsPrice, 1490);

  await confirmPaid(a.token, original, 'wx-paid-premium-original');
  const renewal = await place(a.token, await f.checkoutInput(a.token, 'premium', 'premium-renewal-updated'));
  assert.equal(JSON.parse(renewal.virtual!.signData).productId, 'premium_month');
  assert.equal(JSON.parse(renewal.virtual!.signData).goodsPrice, 2480);

  const basic = await place(b.token, { ...await f.checkoutInput(b.token), wechatCode: 'b-payment' });
  assert.equal(JSON.parse(basic.virtual!.signData).productId, 'basic_month');
  assert.equal(JSON.parse(basic.virtual!.signData).goodsPrice, 990);
  await confirmPaid(b.token, basic, 'wx-paid-basic-updated');
  const upgrade = (await (await f.request('/billing/quote?planId=premium', b.token)).json()).data as MembershipQuote;
  assert.equal(upgrade.kind, 'upgrade');
  assert.equal(upgrade.amountCents, 1490);
  assert.equal(upgrade.virtualProductAvailable, false);
  const unavailable = await f.request('/billing/checkout', b.token, { ...await f.checkoutInput(b.token, 'premium', 'upgrade-no-mapping'), wechatCode: 'b-payment' });
  assert.equal((await unavailable.json()).error.code, 'WECHAT_VIRTUAL_PRODUCT_UNAVAILABLE');
});

test('signed WeChat delivery confirms payment exactly once and signed refunds revoke only that order', async t => {
  const f = await fixture(t);
  const a = await f.login('a-login');
  const b = await f.login('b-login');
  const input = await f.checkoutInput(a.token);
  const sameSession = await f.request('/billing/checkout', a.token, { ...input, wechatCode: 'b-conflict' });
  assert.equal(sameSession.status, 409);
  const placed = await f.request('/billing/checkout', a.token, input);
  assert.equal(placed.status, 201);
  const result = (await placed.json()).data as CheckoutResult;
  const virtual = result.virtual!;
  const fields = JSON.parse(virtual.signData);
  assert.equal(fields.productId, 'basic_month');
  assert.equal(fields.goodsPrice, 990);
  assert.equal(virtual.paySig, mac(appKey, 'requestVirtualPayment&' + virtual.signData));
  assert.equal(virtual.signature, mac(sessionKey, virtual.signData));
  assert.equal(result.order.status, 'pending');
  const duplicated = (await (await f.request('/billing/checkout', a.token, { ...input, wechatCode: 'a-fresh' })).json()).data;
  assert.equal(duplicated.order.id, result.order.id);
  const changed = await f.request('/billing/checkout', a.token, { ...input, device: 'other' });
  assert.equal((await changed.json()).error.code, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal((await f.request('/billing/orders/' + result.order.id, b.token)).status, 404);
  assert.equal((await f.store.read()).memberships.length, 0);

  const wxOrderId = 'wx-test-paid-001';
  const paidAt = Math.floor(Date.now() / 1000);
  f.remote.set(fields.outTradeNo, { order_id: fields.outTradeNo, env_type: 1, order_type: 7,
    status: 2, order_fee: 990, paid_fee: 990, wx_order_id: wxOrderId, paid_time: paidAt });
  const event = { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OutTradeNo: fields.outTradeNo, Env: 0, OpenId: 'test-openid-a',
    GoodsInfo: { ProductId: 'basic_month', Quantity: 1, ActualPrice: 990 } };
  const notice = (event: unknown, target?: string) => {
    const { body, params } = encryptedPush(event, target);
    return f.request(endpoint + '?' + params, undefined, body);
  };
  const challenge = new URLSearchParams({ timestamp: '1000000', nonce: '123', echostr: 'echo123', signature: signature('1000000', '123') });
  assert.equal(await (await f.request(endpoint + '?' + challenge)).text(), 'echo123');
  assert.equal((await f.request(endpoint + '?' + challenge, undefined, event)).status, 401);
  assert.equal((await notice(event, 'wx0000000000000000')).status, 401);
  assert.equal((await notice({ ...event, GoodsInfo: { ...event.GoodsInfo, ActualPrice: 1 } })).status, 409);
  assert.equal((await notice({ ...event, OpenId: 'test-openid-b' })).status, 409);
  assert.equal((await f.store.read()).memberships.length, 0);
  const pushed = await Promise.all([notice(event), notice(event)]);
  for (const reply of pushed) assert.equal(await reply.text(), 'success');
  const paid = (await (await f.request('/billing/orders/' + result.order.id, a.token)).json()).data;
  assert.equal(paid.status, 'paid');
  assert.equal((await f.store.read()).memberships[0].activations.length, 1);
  const newQuote = await f.checkoutInput(a.token, 'basic', 'virtual-order-renewal');
  const next = (await (await f.request('/billing/checkout', a.token, newQuote)).json()).data as CheckoutResult;
  const nextFields = JSON.parse(next.virtual!.signData);
  f.remote.set(nextFields.outTradeNo, { order_id: nextFields.outTradeNo, env_type: 1, order_type: 7,
    status: 2, order_fee: 990, paid_fee: 990, wx_order_id: 'wx-test-paid-002', paid_time: Math.floor(Date.now() / 1000) });
  assert.equal((await notice({ ...event, OutTradeNo: nextFields.outTradeNo })).status, 200);
  const refund = { MsgType: 'event', Event: 'xpay_refund_notify', MchOrderId: fields.outTradeNo, WxOrderId: wxOrderId,
    OpenId: 'test-openid-a', RetCode: 0, RefundFee: 990 };
  assert.equal((await notice({ ...refund, WxOrderId: 'wrong-transaction' })).status, 409);
  for (const reply of await Promise.all([notice(refund), notice(refund)])) assert.equal(await reply.text(), 'success');
  const persisted = await new JsonStore(f.path).read();
  assert.equal(persisted.version, 7);
  assert.equal(persisted.memberships[0].activations.length, 2);
  assert.equal(persisted.refunds.length, 1);
  assert.equal(persisted.refunds[0].orderId, result.order.id);
  const state = (await (await f.request('/membership', a.token)).json()).data;
  assert.equal(state.currentPlanId, 'free');
  assert.equal(state.nextPeriod.planId, 'basic');
  assert.doesNotMatch(await readFile(f.path, 'utf8'), /synthetic-session-key|synthetic-app-key|a-payment/);
});

test('the order status endpoint reconciles a verified payment and acknowledges delivery without the client callback', async t => {
  const f = await fixture(t);
  const a = await f.login('a-login');
  const placed = await f.request('/billing/checkout', a.token, await f.checkoutInput(a.token));
  const result = (await placed.json()).data as CheckoutResult;
  const { outTradeNo } = JSON.parse(result.virtual!.signData);
  f.remote.set(outTradeNo, { order_id: outTradeNo, env_type: 1, order_type: 7,
    status: 2, order_fee: 990, paid_fee: 990, wx_order_id: 'xp-fallback-001', paid_time: Math.floor(Date.now() / 1000) });
  const route = '/billing/orders/' + result.order.id;
  const [legacy, virtual] = await Promise.all([f.request(route, a.token), f.request(route + '/virtual-status', a.token)]);
  const order = (await legacy.json()).data;
  assert.equal(order.status, 'paid');
  assert.equal('verifiedUnpaid' in order, false);
  assert.deepEqual((await virtual.json()).data, { order, verifiedUnpaid: false });
  assert.equal(f.calls.filter(call => call === '/xpay/query_order').length, 1);
  assert.equal(f.calls.filter(call => call === '/xpay/notify_provide_goods').length, 1);
  assert.equal((await f.store.read()).orders[0].virtual?.delivered, true);
});

test('only an authenticated payer with a verified unpaid order can see the retry state', async t => {
  const f = await fixture(t);
  const a = await f.login('a-login');
  const b = await f.login('b-login');
  const placed = await f.request('/billing/checkout', a.token, await f.checkoutInput(a.token));
  const first = (await placed.json()).data as CheckoutResult;
  const statusRoute = (id: string) => '/billing/orders/' + id + '/virtual-status';
  const path = statusRoute(first.order.id);
  assert.equal((await f.request(path, b.token)).status, 404);
  assert.equal(f.calls.filter(call => call === '/xpay/query_order').length, 0);
  assert.deepEqual((await (await f.request(path, a.token)).json()).data, { order: first.order, verifiedUnpaid: true });
  assert.equal((await f.store.read()).orders.find(row => row.id === first.order.id)?.status, 'pending');

  const nextInput = await f.checkoutInput(a.token, 'basic', 'virtual-retry-new-order');
  const next = (await (await f.request('/billing/checkout', a.token, nextInput)).json()).data as CheckoutResult;
  const firstTradeNo = JSON.parse(first.virtual!.signData).outTradeNo;
  const nextTradeNo = JSON.parse(next.virtual!.signData).outTradeNo;
  assert.notEqual(firstTradeNo, nextTradeNo);
  f.remote.set(nextTradeNo, { order_id: 'wrong-provider-order', env_type: 1, order_type: 7, status: 1 });
  assert.deepEqual((await (await f.request(statusRoute(next.order.id), a.token)).json()).data, { order: next.order, verifiedUnpaid: false });
  assert.equal((await f.store.read()).memberships.length, 0);

  f.remote.set(firstTradeNo, { order_id: firstTradeNo, env_type: 1, order_type: 7, status: 2,
    order_fee: 990, paid_fee: 990, wx_order_id: 'xp-late-receipt', paid_time: Math.floor(Date.now() / 1000) });
  const { body, params } = encryptedPush({ MsgType: 'event', Event: 'xpay_goods_deliver_notify', OutTradeNo: firstTradeNo,
    Env: 0, OpenId: 'test-openid-a', GoodsInfo: { ProductId: 'basic_month', Quantity: 1, ActualPrice: 990 } });
  assert.equal(await (await f.request(endpoint + '?' + params, undefined, body)).text(), 'success');
  const late = (await (await f.request(path, a.token)).json()).data;
  assert.equal(late.order.status, 'paid');
  assert.equal(late.verifiedUnpaid, false);
  assert.equal((await f.store.read()).memberships[0].activations.length, 1);
});

test('a disabled iOS or virtual payment channel cannot create orders', async t => {
  for (const options of [{ ios: false }, { enabled: false }]) {
    const f = await fixture(t, options);
    const a = await f.login('a-login');
    const response = await f.request('/billing/checkout', a.token, await f.checkoutInput(a.token));
    assert.equal(response.status, 503);
    assert.equal((await f.store.read()).orders.length, 0);
  }
});
