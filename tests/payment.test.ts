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
  const gateway: WechatPayGateway = {
    async createJsapiOrder(input: JsapiOrderInput) {
      return {
        prepayId: 'wx_prepay_1234567890',
        payment: { appId: appid, timeStamp: '1762345678', nonceStr: 'nonce-value', package: 'prepay_id=wx_prepay_1234567890', signType: 'RSA', paySign: 'signature-value' },
      };
    },
    paymentParams: (prepayId: string) => ({ appId: appid, timeStamp: '1762345678', nonceStr: 'nonce-value', package: `prepay_id=${prepayId}`, signType: 'RSA', paySign: 'signature-value' }),
    parseNotification: () => {
      if (!notification) throw new Error('notification fixture missing');
      return notification;
    },
  };
  const server = createApiServer(service, {
    auth, paymentGateway: gateway, pricing: defaultPricing,
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
  assert.equal(plans[2].promotionLabel, '限时优惠');
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
  assert.match(firstResult.payment.package, /^prepay_id=/);
  const repeated = await request('/billing/checkout', 'POST', { planId: 'basic', requestId: 'request-id-123456' });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.data.order.id, firstResult.order.id);
  assert.equal((await request('/billing/checkout', 'POST', { planId: 'premium', requestId: 'request-id-654321' })).body.data.order.amountCents, 2490);
  assert.equal((await service.store.read()).orders.length, 2);
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
  const repeated = await request('/billing/wechat/notify', 'POST', { id: 'notify-1' });
  assert.equal(repeated.status, 200);
  assert.equal(((await request('/membership')).body.data as MembershipState).quota.expiresAt, expiresAt);
  setNotification({ id: 'notify-2', eventType: 'TRANSACTION.SUCCESS', transaction: { ...base, amountCents: 1 } });
  const mismatch = await request('/billing/wechat/notify', 'POST', { id: 'notify-2' });
  assert.equal(mismatch.status, 409);
});
