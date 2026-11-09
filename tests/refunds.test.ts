import assert from 'node:assert/strict';
import { createCipheriv, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AlipayClient } from '../server/alipay.js';
import { newOutTradeNo, type StoredPaymentOrder } from '../server/payment-storage.js';
import { QuotaService } from '../server/quota.js';
import type { RefundGateway, RefundTarget } from '../server/refund-gateway.js';
import { AdminRefunds } from '../server/refunds.js';
import { JsonStore } from '../server/store.js';
import { WechatPayClient, type WechatPayGateway } from '../server/wechat-pay.js';
import { getWorkbenchAccess } from '../server/workbench-access.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-refunds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'db.json'));
  let clock = Date.parse('2025-01-01T01:00:00Z');
  const now = () => clock;
  const at = (date: string) => { clock = Date.parse(date); };
  const quota = new QuotaService(store, () => new Date(now()));
  async function paid(planId: 'basic' | 'premium', channel: StoredPaymentOrder['channel'] = 'alipay-page') {
    const paidAt = new Date(now()).toISOString(), transactionId = randomUUID();
    const provider = channel.startsWith('alipay-') ? 'alipay' : 'wechat';
    const activation = { userId: 'alice', planId, verifiedPaymentAt: paidAt, verifiedEventId: transactionId, idempotencyKey: `${provider}:${transactionId}` };
    const period = await quota.activateMembership(activation);
    const order: StoredPaymentOrder = { id: randomUUID(), userId: 'alice', status: 'paid', channel, planId,
      amountCents: 3499, createdAt: paidAt, paidAt, expiresAt: new Date(now() + 7_200_000).toISOString(),
      transactionId, paymentEventId: transactionId, outTradeNo: newOutTradeNo(now()), description: '合成会员订单' };
    await store.mutate(database => database.orders.push(order));
    return { order, activation, period };
  }
  return { store, quota, paid, now, at, access: () => getWorkbenchAccess(store, 'alice', new Date(now())) };
}

test('refund preview is actor-bound, idempotent, and cancels the upgrade only after provider confirmation', async t => {
  const f = await fixture(t);
  const basic = await f.paid('basic');
  f.at('2025-01-12T01:00:00Z');
  const upgrade = await f.paid('premium');
  f.at('2025-01-13T01:00:00Z');
  const renewal = await f.paid('premium');
  f.at('2025-01-14T01:00:00Z');
  await f.quota.reserve('alice', 'used-task', 'a'.repeat(64), 20_000);
  await f.quota.dispatch('alice', 'used-task');
  await f.quota.settle('alice', 'used-task', { inputTokens: 10_000, outputTokens: 10_000, totalTokens: 20_000 });
  const submitted: RefundTarget[] = [];
  const gateway: RefundGateway = {
    async submitRefund(target) { submitted.push(target); return 'processing'; },
    async queryRefund(target) { assert.deepEqual(target, submitted[0]); return 'succeeded'; },
  };
  const refunds = new AdminRefunds(f.store, { alipay: gateway }, f.now);
  t.after(() => refunds.stop());
  const orderId = upgrade.order.id;
  const preview = await refunds.preview({ orderId }, 'operator');
  assert.equal(preview.amountCents, upgrade.order.amountCents);
  assert.equal(preview.before.planId, 'premium');
  assert.equal(preview.after.planId, 'basic');
  assert.deepEqual(preview.remaining, [basic.period, renewal.period].map(({ planId, startsAt, expiresAt }) => ({ planId, startsAt, expiresAt })));
  const apply = { orderId, previewId: preview.id, confirmed: true };
  await assert.rejects(refunds.apply({ ...apply, amountCents: 1 }, 'operator'), { status: 400 });
  await assert.rejects(refunds.apply(apply, 'other-admin'), { code: 'REFUND_PREVIEW_STALE' });
  await Promise.all([refunds.apply(apply, 'operator'), refunds.apply(apply, 'operator')]);
  assert.deepEqual(submitted, [{ id: preview.id, outTradeNo: upgrade.order.outTradeNo, transactionId: upgrade.order.transactionId, amountCents: 3499 }]);
  assert.equal((await f.access()).planId, 'premium');
  await assert.rejects(refunds.refresh({ orderId }), { status: 429 });
  f.at('2025-01-14T01:01:00Z');
  const receipt = await refunds.refresh({ orderId });
  assert.equal(receipt.status, 'succeeded');
  assert.equal((await f.access()).planId, 'basic');
  assert.equal((await f.quota.current('alice')).remainingPercent, 90);
  assert.equal((await f.store.read()).version, 4);
  assert.deepEqual(await refunds.apply(apply, 'operator'), receipt);
  await f.quota.activateMembership(upgrade.activation);
  assert.equal((await f.access()).planId, 'basic');
  await f.quota.reserve('alice', 'after-refund', 'b'.repeat(64), 100);
  const restarted = new JsonStore(f.store.path);
  assert.equal((await getWorkbenchAccess(restarted, 'alice', new Date(f.now()))).planId, 'basic');
  assert.equal((await restarted.read()).aiUsage.length, 2);
  f.at('2025-02-15T01:00:00Z');
  assert.equal((await f.access()).planId, 'free');
  f.at('2025-03-15T01:00:00Z');
  assert.equal((await f.access()).planId, 'premium');
  assert.equal((await f.access()).expiresAt, renewal.period.expiresAt);
});

test('a lost refund response retries the saved number and a verified callback revokes only the original term', async t => {
  const f = await fixture(t);
  const { order } = await f.paid('premium', 'jsapi');
  let attempts = 0;
  let notification: RefundTarget;
  const gateway = {
    async submitRefund(target: RefundTarget) {
      notification = target;
      if (++attempts === 1) throw new Error('synthetic timeout');
      return 'processing' as const;
    },
    async queryRefund(target: RefundTarget) { assert.deepEqual(target, notification); return 'not-found' as const; },
    parseRefundNotification(_headers: unknown, raw: string) {
      return { ...notification, status: 'succeeded' as const, amountCents: raw === 'wrong' ? 1 : notification.amountCents };
    },
  } as WechatPayGateway;
  const refunds = new AdminRefunds(f.store, { wechat: gateway, alipay: gateway, notifyUrl: 'https://example.test/api/v1/billing/wechat/notify' }, f.now);
  t.after(() => refunds.stop());
  const orderId = order.id;
  const preview = await refunds.preview({ orderId }, 'operator');
  f.at('2025-01-01T01:01:00Z');
  const replacement = await f.paid('premium');
  await assert.rejects(refunds.apply({ orderId, previewId: preview.id, confirmed: true }, 'operator'), { code: 'REFUND_PREVIEW_STALE' });
  const checked = await refunds.preview({ orderId: replacement.order.id }, 'operator');
  const original = await refunds.preview({ orderId }, 'operator');
  await assert.rejects(refunds.apply({ orderId: replacement.order.id, previewId: checked.id, confirmed: true }, 'operator'), { code: 'REFUND_PREVIEW_STALE' });
  const pending = await refunds.apply({ orderId, previewId: original.id, confirmed: true }, 'operator');
  assert.equal(pending.status, 'unknown');
  assert.equal((await f.access()).planId, 'premium');
  f.at('2025-01-01T01:02:00Z');
  assert.equal((await refunds.refresh({ orderId, retry: true })).id, pending.id);
  assert.equal(attempts, 2);
  await assert.rejects(refunds.wechatNotification({}, 'wrong'), { code: 'REFUND_RESULT_MISMATCH' });
  assert.equal((await f.access()).planId, 'premium');
  const confirmed = await refunds.wechatNotification({}, 'verified');
  assert.equal(confirmed.status, 'succeeded');
  assert.deepEqual(await refunds.wechatNotification({}, 'verified'), confirmed);
  assert.equal((await f.access()).planId, 'free');
  assert.equal((await f.quota.current('alice')).status, 'inactive');
  f.at('2025-02-02T01:00:00Z');
  assert.equal((await f.access()).expiresAt, replacement.period.expiresAt);
});

test('after refunding the only term, a new purchase starts fresh and survives a reload', async t => {
  const f = await fixture(t);
  const { order } = await f.paid('premium');
  const gateway: RefundGateway = { async submitRefund() { return 'succeeded'; }, async queryRefund() { return 'succeeded'; } };
  const refunds = new AdminRefunds(f.store, { alipay: gateway }, f.now);
  t.after(() => refunds.stop());
  const input = { orderId: order.id };
  const preview = await refunds.preview(input, 'operator');
  assert.deepEqual(preview.remaining, []);
  assert.equal((await refunds.apply({ ...input, previewId: preview.id, confirmed: true }, 'operator')).status, 'succeeded');
  assert.equal((await f.access()).planId, 'free');
  await assert.rejects(f.quota.reserve('alice', 'blocked', 'c'.repeat(64), 1000), { code: 'MEMBERSHIP_EXPIRED' });
  f.at('2025-01-03T01:00:00Z');
  const repurchase = await f.paid('basic');
  assert.equal(repurchase.period.kind, 'purchase');
  assert.equal(repurchase.period.startsAt, '2025-01-03T01:00:00.000Z');
  const restarted = new JsonStore(f.store.path);
  assert.equal((await getWorkbenchAccess(restarted, 'alice', new Date(f.now()))).planId, 'basic');
  assert.equal((await restarted.read()).memberships[0].activations.length, 2);
});

const target = { id: 'fixture-refund', outTradeNo: 'YF20251109000000000001', transactionId: 'fixture-transaction', amountCents: 3499 };
const time = Date.parse('2025-11-09T01:00:00Z');
function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { privateKey, publicKey };
}

test('WeChat submits the full stored order and trusts only signed, matching refund results', async () => {
  const merchant = keys(), platform = keys();
  const mchid = '1234567890', appid = 'wx-fixture', apiV3Key = '01234567890123456789012345678901';
  function signed(raw: string) {
    const timestamp = String(time / 1000), nonce = 'nonce-test';
    return { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': 'test-platform',
      'wechatpay-signature': createSign('RSA-SHA256').update(`${timestamp}\n${nonce}\n${raw}\n`).sign(platform.privateKey, 'base64') };
  }
  const data = { out_refund_no: target.id, out_trade_no: target.outTradeNo, transaction_id: target.transactionId,
    status: 'SUCCESS', amount: { total: 3499, refund: 3499, currency: 'CNY' } };
  let calls = 0;
  const client = new WechatPayClient({ mchid, appid, apiV3Key, appSecret: 'fixture', merchantSerialNo: 'merchant',
    privateKeyPem: merchant.privateKey, platformPublicKeyPem: platform.publicKey, platformPublicKeyId: 'test-platform',
    notifyUrl: 'https://example.test/notify' }, async (url, options) => {
    calls++;
    let raw: string;
    if (calls === 1) {
      assert.match(String(url), /\/transactions\/out-trade-no\//);
      raw = JSON.stringify({ ...data, mchid, appid, trade_state: 'SUCCESS' });
    } else {
      if (calls === 2) {
        assert.equal(options?.method, 'POST');
        assert.deepEqual(JSON.parse(String(options.body)), { transaction_id: target.transactionId, out_refund_no: target.id,
          notify_url: 'https://example.test/refund', amount: { total: 3499, refund: 3499, currency: 'CNY' } });
      }
      raw = JSON.stringify(data);
    }
    return new Response(raw, { headers: calls === 4 ? signed(raw + ' ') : signed(raw) });
  }, () => time);
  assert.equal(await client.submitRefund(target, 'https://example.test/refund'), 'processing');
  assert.equal(await client.queryRefund(target), 'succeeded');
  await assert.rejects(client.queryRefund(target), { code: 'WECHAT_SIGNATURE_INVALID' });
  const nonce = '123456789012', associated = 'refund';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), nonce);
  cipher.setAAD(Buffer.from(associated));
  const plaintext = JSON.stringify({ ...data, mchid, refund_status: 'SUCCESS' });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const envelope = JSON.stringify({ event_type: 'REFUND.SUCCESS', resource: {
    algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: associated, ciphertext,
  } });
  assert.deepEqual(client.parseRefundNotification(signed(envelope), envelope), { ...target, status: 'succeeded' });
});

test('Alipay verifies the raw response and requires a matching amount and refund ID on query', async () => {
  const merchant = keys(), platform = keys();
  let calls = 0;
  const client = new AlipayClient({ appId: 'fixture-app', privateKeyPem: merchant.privateKey, alipayPublicKeyPem: platform.publicKey,
    gateway: 'https://example.test/gateway', notifyUrl: 'https://example.test/notify', returnUrl: 'https://example.test/return' },
  () => new Date(time), async (_url, options) => {
    calls++;
    const form = options?.body as URLSearchParams;
    const method = form.get('method')!;
    const biz = JSON.parse(form.get('biz_content')!);
    assert.equal(biz.out_trade_no, target.outTradeNo);
    const trade = { code: '10000', out_trade_no: target.outTradeNo, trade_no: target.transactionId };
    let row: Record<string, unknown>;
    if (method === 'alipay.trade.query') row = { ...trade, trade_status: 'TRADE_SUCCESS', total_amount: '34.99' };
    else if (method === 'alipay.trade.refund') {
      assert.equal(biz.refund_amount, '34.99');
      assert.equal(biz.out_request_no, target.id);
      row = { ...trade, fund_change: 'N', refund_fee: '34.99' };
    } else row = { ...trade, refund_status: 'REFUND_SUCCESS', refund_amount: calls === 4 ? '1.00' : '34.99',
      total_amount: '34.99', out_request_no: target.id };
    const raw = JSON.stringify(row, null, 2);
    const signature = createSign('RSA-SHA256').update(raw).sign(platform.privateKey, 'base64');
    return new Response(`{"${method.replaceAll('.', '_')}_response":${raw}${calls === 5 ? ' ' : ''},"sign":"${calls === 5 ? 'invalid' : signature}"}`);
  });
  assert.equal(await client.submitRefund(target), 'processing');
  assert.equal(await client.queryRefund(target), 'succeeded');
  await assert.rejects(client.queryRefund(target), { code: 'ALIPAY_REFUND_MISMATCH' });
  await assert.rejects(client.queryRefund(target), { code: 'ALIPAY_REFUND_SIGNATURE_INVALID' });
});
