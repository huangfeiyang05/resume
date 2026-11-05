import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CheckoutResult, MembershipState, Plan } from '../shared/types.js';
import { AuthService } from '../server/auth.js';
import { createApiServer } from '../server/http.js';
import { defaultPricing } from '../server/payment-config.js';
import type { JsapiOrderInput, NotifyPayload, WechatPayGateway } from '../server/wechat-pay.js';
import type { AlipayGateway, AlipayNotification } from '../server/alipay.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const appid = 'wx7c30911964bf6fe7';
const mchid = '1900000109';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-payment-'));
  const path = join(directory, 'resumes.json');
  const service = new ResumeService(new JsonStore(path));
  const auth = new AuthService(service.store, { wechat: { exchange: async (code: string) => ({ openid: code === 'alice-code' ? 'openid-alice-1234' : 'openid-other-5678' }) } });
  let notification: NotifyPayload | undefined;
  let alipayNotification: AlipayNotification | undefined;
  const gateway: WechatPayGateway = {
    async createJsapiOrder(input: JsapiOrderInput) {
      return {
        prepayId: 'wx_prepay_1234567890',
        payment: { appId: appid, timeStamp: '1762345678', nonceStr: 'nonce-value', package: 'prepay_id=wx_prepay_1234567890', signType: 'RSA', paySign: 'signature-value' },
      };
    },
    async createNativeOrder(_input) {
      return { codeUrl: 'weixin://wxpay/bizpayurl?pr=1234567890abcdef' };
    },
    paymentParams: (prepayId: string) => ({ appId: appid, timeStamp: '1762345678', nonceStr: 'nonce-value', package: `prepay_id=${prepayId}`, signType: 'RSA', paySign: 'signature-value' }),
    parseNotification: () => {
      if (!notification) throw new Error('notification fixture missing');
      return notification;
    },
  };
  const alipay: AlipayGateway = {
    async createPayment(input) {
      return { redirectUrl: `https://openapi.alipay.com/gateway.do?out_trade_no=${input.outTradeNo}&mode=${input.mode}` };
    },
    parseNotification: () => {
      if (!alipayNotification) throw new Error('alipay notification fixture missing');
      return alipayNotification;
    },
  };
  const server = createApiServer(service, {
    auth, paymentGateway: gateway, paymentAlipay: alipay, pricing: defaultPricing,
    paymentAppid: appid, paymentMchid: mchid, paymentNotifyUrl: 'https://www.youfangcv.site/api/v1/billing/wechat/notify',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const registration = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'payment-fixture@example.test', password: 'Fixture-pw-26!' }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  const request = async (route: string, method = 'GET', body?: unknown) => {
    const result = await fetch(`${base}${route}`, {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json() as any };
  };
  return {
    service, request,
    bind: async () => assert.equal((await request('/auth/wechat/bind', 'POST', { code: 'alice-code' })).status, 200),
    setNotification: (value: NotifyPayload) => { notification = value; },
    setAlipayNotification: (value: AlipayNotification) => { alipayNotification = value; },
    notifyAlipay: async (fields: Record<string, string>) => {
      const result = await fetch(`${base}/billing/alipay/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
      return { status: result.status, text: await result.text() };
    },
  };
}

test('payment availability requires a configured gateway and prices come from the server', async (t) => {
  const { request } = await fixture(t);
  const membership = (await request('/membership')).body.data as MembershipState;
  assert.equal(membership.paymentAvailable, true);
  assert.equal(membership.mode, 'preview');
  const plans = (await request('/plans')).body.data as Plan[];
  assert.equal(plans[1].priceCents, 990);
  assert.equal(plans[2].priceCents, 2490);
  assert.equal(plans[2].listPriceCents, 2990);
  assert.equal(plans[2].promotionLabel, '首充优惠');
  const firstQuote = await request('/billing/quote?planId=premium');
  assert.equal(firstQuote.body.data.amountCents, 2490);
  assert.equal(firstQuote.body.data.listPriceCents, 2990);
  assert.equal(firstQuote.body.data.promotionLabel, '首充优惠');
  const checkout = await request('/billing/checkout', 'POST', { planId: 'basic' });
  assert.equal(checkout.status, 400);
});

test('checkout binds WeChat, creates one pending order per request id and quotes upgrade differences', async (t) => {
  const { service, request, bind } = await fixture(t);
  const quote = await request('/billing/quote?planId=basic');
  assert.equal(quote.status, 200);
  assert.deepEqual(quote.body.data, { planId: 'basic', amountCents: 990, kind: 'purchase', currentPlanId: 'free' });
  assert.equal((await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'request-id-123456' })).body.error.code, 'WECHAT_NOT_BOUND');
  await bind();
  const first = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'request-id-123456' });
  assert.equal(first.status, 201);
  const firstResult = first.body.data as CheckoutResult;
  assert.equal(firstResult.order.amountCents, 990);
  assert.equal(firstResult.order.status, 'pending');
  assert.equal(firstResult.order.channel, 'jsapi');
  assert.ok(firstResult.payment);
  assert.match(firstResult.payment.package, /^prepay_id=/);
  const repeated = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'request-id-123456' });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.data.order.id, firstResult.order.id);
  assert.equal((await request('/billing/checkout', 'POST', { planId: 'premium', requestId: 'request-id-654321' })).body.data.order.amountCents, 2490);
  assert.equal((await service.store.read()).orders.length, 2);
});

test('native checkout creates a scan order without binding WeChat', async (t) => {
  const { service, request } = await fixture(t);
  const checkout = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'native-request-123456', channel: 'native' });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  const result = checkout.body.data as CheckoutResult;
  assert.equal(result.order.channel, 'native');
  assert.equal(result.payment, undefined);
  assert.match(result.native?.codeUrl ?? '', /^weixin:\/\//);
  assert.match(result.native?.qrCodeDataUrl ?? '', /^data:image\/svg\+xml;base64,/);
  assert.equal(result.native?.expiresAt, result.order.expiresAt);
  const repeated = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'native-request-123456', channel: 'native' });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.data.order.id, result.order.id);
  assert.equal((await service.store.read()).orders.length, 1);
  const mismatch = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'native-request-123456', channel: 'jsapi' });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
});

test('Alipay page and wap checkout return a signed redirect without binding WeChat', async (t) => {
  const { service, request } = await fixture(t);
  const methods = await request('/billing/payment-methods');
  assert.equal(methods.status, 200);
  assert.deepEqual(methods.body.data, { wechat: true, alipay: true });
  const page = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'alipay-page-123456', channel: 'alipay-page' });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  const pageResult = page.body.data as CheckoutResult;
  assert.equal(pageResult.order.channel, 'alipay-page');
  assert.equal(pageResult.payment, undefined);
  assert.equal(pageResult.native, undefined);
  assert.match(pageResult.alipay?.redirectUrl ?? '', /^https:\/\/openapi\.alipay\.com\//);
  const wap = await request('/billing/checkout', 'POST', { planId: 'premium', requestId: 'alipay-wap-123456', channel: 'alipay-wap' });
  assert.equal(wap.status, 201, JSON.stringify(wap.body));
  const wapResult = wap.body.data as CheckoutResult;
  assert.equal(wapResult.order.channel, 'alipay-wap');
  assert.equal(wapResult.order.amountCents, 2490);
  assert.match(wapResult.alipay?.redirectUrl ?? '', /^https:\/\/openapi\.alipay\.com\//);
  assert.equal((await service.store.read()).orders.length, 2);
  const repeated = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'alipay-page-123456', channel: 'alipay-page' });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.data.order.id, pageResult.order.id);
  const mismatch = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'alipay-page-123456', channel: 'alipay-wap' });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
});

test('a verified Alipay notification activates the order and retries are idempotent', async (t) => {
  const { service, request, setAlipayNotification, notifyAlipay } = await fixture(t);
  const checkout = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'alipay-notify-123456', channel: 'alipay-wap' });
  assert.equal(checkout.status, 201);
  const order = checkout.body.data.order as CheckoutResult['order'];
  const stored = (await service.store.read()).orders.find(candidate => candidate.id === order.id)!;
  const notification: AlipayNotification = { appId: '2021000000000000', sellerId: '2088000000000000', outTradeNo: stored.outTradeNo, tradeNo: '2026110522000000001', tradeStatus: 'TRADE_SUCCESS', amountCents: 990, paidAt: '2026-11-05T01:00:00.000Z' };
  setAlipayNotification(notification);
  const applied = await notifyAlipay({ sign: 'fixture-signature', sign_type: 'RSA2' });
  assert.equal(applied.status, 200);
  assert.equal(applied.text, 'success');
  const active = (await request('/membership')).body.data as MembershipState;
  assert.equal(active.mode, 'active');
  assert.equal(active.currentPlanId, 'basic');
  const expiresAt = active.quota.expiresAt;
  const repeated = await notifyAlipay({ sign: 'fixture-signature', sign_type: 'RSA2' });
  assert.equal(repeated.text, 'success');
  assert.equal(((await request('/membership')).body.data as MembershipState).quota.expiresAt, expiresAt);
  setAlipayNotification({ ...notification, amountCents: 1 });
  const mismatch = await notifyAlipay({ sign: 'fixture-signature', sign_type: 'RSA2' });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.text, 'failure');
});

test('a verified payment notification grants the term once and never trusts or re-applies duplicates', async (t) => {
  const { service, request, bind, setNotification } = await fixture(t);
  await bind();
  const checkout = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'request-id-123456' });
  assert.equal(checkout.status, 201);
  const order = checkout.body.data.order as CheckoutResult['order'];
  const stored = (await service.store.read()).orders.find(candidate => candidate.id === order.id)!;
  const base = { mchid, appid, outTradeNo: stored.outTradeNo, transactionId: '4200000000000001', tradeState: 'SUCCESS', successTime: '2026-11-05T10:00:00+08:00', amountCents: 990, currency: 'CNY', openid: 'openid-alice-1234' };
  setNotification({ id: 'notify-1', eventType: 'TRANSACTION.SUCCESS', transaction: base });
  const applied = await request('/billing/wechat/notify', 'POST', { id: 'notify-1' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const active = (await request('/membership')).body.data as MembershipState;
  assert.equal(active.mode, 'active');
  assert.equal(active.currentPlanId, 'basic');
  assert.equal(active.quota.status, 'active');
  assert.equal(active.quota.remainingPercent, 100);
  const expiresAt = active.quota.expiresAt;
  const secondQuote = await request('/billing/quote?planId=premium');
  assert.equal(secondQuote.body.data.amountCents, 2000);
  assert.equal(secondQuote.body.data.listPriceCents, undefined);
  assert.equal(secondQuote.body.data.promotionLabel, undefined);
  const repeated = await request('/billing/wechat/notify', 'POST', { id: 'notify-1' });
  assert.equal(repeated.status, 200);
  assert.equal(((await request('/membership')).body.data as MembershipState).quota.expiresAt, expiresAt);
  setNotification({ id: 'notify-2', eventType: 'TRANSACTION.SUCCESS', transaction: { ...base, amountCents: 1 } });
  const mismatch = await request('/billing/wechat/notify', 'POST', { id: 'notify-2' });
  assert.equal(mismatch.status, 409);
});
