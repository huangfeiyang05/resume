import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PhoneCodeService, validatePhone } from '../server/phone-codes.js';
import { JsonStore } from '../server/store.js';
import { HttpError } from '../server/errors.js';
import { SmsPhoneDailyLimitError, type CodeSms } from '../server/sms.js';
const code = (name: string) => (error: unknown) => error instanceof HttpError && error.code === name;
async function fixture(t: TestContext, options: { dailyLimit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'resume-phone-code-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(join(dir, 'data.json'));
  let now = Date.parse('2026-11-05T00:00:00.000Z'), fail = false;
  const messages: CodeSms[] = [];
  const sender = { enabled: true, async sendCode(message: CodeSms) { if (fail) throw new Error('Synthetic upstream failure'); messages.push(message); } };
  const service = new PhoneCodeService(store, sender, { secret: 'synthetic-phone-code-secret-over-32-bytes', now: () => now, ...options });
  return { store, messages, service, advance: (ms: number) => { now += ms; }, fail: (value: boolean) => { fail = value; } };
}

test('phone normalization accepts mainland numbers with explicit international prefixes and rejects fake identities', () => {
  assert.equal(validatePhone(' +8613900000001 '), '13900000001');
  assert.equal(validatePhone('008613900000001'), '13900000001');
  for (const value of [null, 13900000001, '1390000000', '+12345678901', '13900000001abc', '11900000001', '139 0000 0001']) assert.throws(() => validatePhone(value), code('VALIDATION_ERROR'));
});

test('supplier acceptance activates a hashed, single-use code bound to phone, purpose and account', async t => {
  const f = await fixture(t);
  const result = await f.service.request('13900000001', 'bind-phone', 'synthetic-client', 'owner');
  assert.equal(result.resendAfterSeconds, 60); assert.match(result.message, /提交/);
  assert.equal(f.messages.length, 1);
  const proof = { challengeId: result.challengeId, code: f.messages[0].code };
  assert.match(proof.code, /^\d{6}$/);
  const raw = await readFile(f.store.path, 'utf8'); assert.equal(raw.includes('"code":'), false);
  const stored = (await f.store.read()).phoneChallenges[0]; assert.match(stored.codeHash, /^[a-f0-9]{64}$/);
  await f.store.mutate(data => { assert.ok(f.service.consume(data, '13900000002', 'bind-phone', proof, 'owner') instanceof HttpError); });
  await f.store.mutate(data => { assert.ok(f.service.consume(data, '13900000001', 'login', proof) instanceof HttpError); });
  await f.store.mutate(data => { assert.ok(f.service.consume(data, '13900000001', 'bind-phone', proof, 'other') instanceof HttpError); });
  assert.equal(await f.store.mutate(data => f.service.consume(data, '13900000001', 'bind-phone', proof, 'owner')), undefined);
  assert.equal((await f.store.read()).phoneChallenges[0].status, 'consumed');
  await f.store.mutate(data => { assert.ok(f.service.consume(data, '13900000001', 'bind-phone', proof, 'owner') instanceof HttpError); });
});

test('five incorrect guesses persist a lock and expiry cannot be bypassed after reload', async t => {
  const f = await fixture(t);
  const result = await f.service.request('13900000001', 'login', 'synthetic-client');
  const wrong = f.messages[0].code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; ++i) assert.ok(await f.store.mutate(data => f.service.consume(data, '13900000001', 'login', { challengeId: result.challengeId, code: wrong })));
  const reloaded = await new JsonStore(f.store.path).read(); assert.equal(reloaded.phoneChallenges[0].status, 'locked'); assert.equal(reloaded.phoneChallenges[0].attempts, 5);
  f.advance(61_000);
  const second = await f.service.request('13900000001', 'login', 'synthetic-client');
  f.advance(5 * 60_000);
  assert.ok(await f.store.mutate(data => f.service.consume(data, '13900000001', 'login', { challengeId: second.challengeId, code: f.messages[1].code })));
  assert.equal((await f.store.read()).phoneChallenges[1].status, 'expired');
});

test('failed delivery never activates a new proof or invalidates the older valid proof', async t => {
  const f = await fixture(t);
  const original = await f.service.request('13900000001', 'login', 'synthetic-client');
  f.advance(61_000); f.fail(true);
  await assert.rejects(f.service.request('13900000001', 'login', 'synthetic-client'), code('SMS_DELIVERY_FAILED'));
  const rows = (await f.store.read()).phoneChallenges;
  assert.equal(rows[0].status, 'sent'); assert.equal(rows[1].status, 'failed'); assert.equal(rows[1].codeHash, '');
  assert.equal(await f.store.mutate(data => f.service.consume(data, '13900000001', 'login', { challengeId: original.challengeId, code: f.messages[0].code })), undefined);
  await assert.rejects(f.service.request('13900000001', 'login', 'synthetic-client'), code('CODE_RESEND_TOO_SOON'));
});

test('supplier daily limits return a specific 429 and leave the challenge unusable', async t => {
  const f = await fixture(t);
  const service = new PhoneCodeService(f.store, {
    enabled: true, async sendCode() { throw new SmsPhoneDailyLimitError(); },
  }, { secret: 'synthetic-phone-code-secret-over-32-bytes' });
  await assert.rejects(service.request('13900000001', 'login', 'synthetic-client'),
    error => error instanceof HttpError && error.status === 429 && error.code === 'SMS_PHONE_DAILY_LIMIT' && /明天/.test(error.message));
  const [challenge] = (await f.store.read()).phoneChallenges;
  assert.equal(challenge.status, 'failed');
  assert.equal(challenge.codeHash, '');
});

test('durable reservations enforce cooldown, hourly and global spend limits including concurrent requests', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.service.request('13900000001', 'login', 'client-a'), f.service.request('13900000001', 'login', 'client-b')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.messages.length, 1);
  for (let i = 0; i < 4; ++i) { f.advance(61_000); await f.service.request('13900000001', 'login', 'client-a'); }
  f.advance(61_000);
  await assert.rejects(f.service.request('13900000001', 'login', 'client-c'), code('SMS_RATE_LIMITED'));
  const limited = await fixture(t, { dailyLimit: 1 });
  await limited.service.request('13900000001', 'login', 'client-a');
  await assert.rejects(limited.service.request('13900000002', 'login', 'client-b'), code('SMS_RATE_LIMITED'));
});

test('unconfigured SMS and unauthenticated binding cannot silently send messages', async t => {
  const f = await fixture(t);
  const disabled = new PhoneCodeService(f.store, { enabled: false, async sendCode() { assert.fail('disabled sender called'); } }, { secret: '' });
  await assert.rejects(disabled.request('13900000001', 'login', 'client'), code('SMS_NOT_CONFIGURED'));
  await assert.rejects(f.service.request('13900000001', 'bind-phone', 'client'), code('AUTH_REQUIRED'));
  await assert.rejects(f.service.request('13900000001', 'verify-account', 'client'), code('AUTH_REQUIRED'));
  assert.equal((await f.store.read()).phoneChallenges.length, 0);
});
