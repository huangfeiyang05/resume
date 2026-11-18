import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AuthSession, AuthUser } from '../shared/auth.js';
import { setAuthToken } from '../src/services/api.js';
import { useAuth, usePhoneChallenge, validAuthUser } from '../src/services/auth.js';

type RequestOptions = {
  url: string; method: string; data?: unknown; header: Record<string, string>; withCredentials?: boolean;
  success: (response: { statusCode: number; data: unknown }) => void;
  fail: (reason: unknown) => void;
};
const phoneUser = (id = 'A'): AuthUser => ({ id, phone: '13800138000', phoneVerified: true, hasPassword: false, emailVerified: false, createdAt: '2026-11-05T00:00:00.000Z' });
function session(user: AuthUser, native = false): AuthSession {
  return { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...(native ? { token: 'p'.repeat(43) } : {}) };
}
function fixture(t: TestContext, native = false) {
  const globals = globalThis as typeof globalThis & { uni?: unknown; wx?: unknown };
  const originalUni = globals.uni, originalWx = globals.wx;
  if (native) globals.wx = {}; else delete globals.wx;
  const storage = new Map<string, unknown>(), requests: RequestOptions[] = [];
  let respond = (input: RequestOptions) => input.success({ statusCode: 200, data: { data: session(phoneUser(), native) } });
  globals.uni = { request: (input: RequestOptions) => { requests.push(input); respond(input); }, getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: unknown) => storage.set(key, value), removeStorageSync: (key: string) => storage.delete(key) };
  setAuthToken('');
  const auth = useAuth({ autoRestore: false });
  auth.capabilities.value = { emailPassword: true, wechat: false, phone: true, emailVerification: true, passwordReset: true };
  t.after(() => { auth.dispose(); setAuthToken(''); globals.uni = originalUni; if (originalWx === undefined) delete globals.wx; else globals.wx = originalWx; });
  return { auth, storage, requests, respond: (handler: typeof respond) => { respond = handler; } };
}
const login = { phone: '+86 13800138000', code: '123456', challengeId: 'synthetic-login-challenge' };

test('phone login accepts a verified phone-only account and H5 never persists phone, OTP or token', async t => {
  const { auth, requests, storage } = fixture(t);
  assert.equal(await auth.authenticatePhone(login), true);
  assert.equal(auth.signedIn.value, true); assert.equal(auth.user.value?.id, 'A'); assert.equal(auth.user.value?.email, undefined);
  assert.deepEqual(requests.at(-1)?.data, { ...login, phone: '13800138000' });
  assert.ok(requests.every(request => request.withCredentials === true && !request.header.Authorization));
  assert.equal(storage.size, 0);
});

test('disabled SMS and malformed proofs do not dispatch login requests', async t => {
  const { auth, requests } = fixture(t);
  auth.capabilities.value!.phone = false;
  assert.equal(await auth.authenticatePhone(login), false); assert.equal(requests.length, 0);
  auth.capabilities.value!.phone = true;
  for (const input of [{ ...login, phone: '123' }, { ...login, code: 'abc123' }, { ...login, challengeId: '' }]) {
    assert.equal(await auth.authenticatePhone(input), false);
  }
  assert.equal(requests.length, 0);
});

test('unverified or invalid phone-only sessions cannot become authenticated accounts', async t => {
  const { auth, respond } = fixture(t);
  for (const user of [{ ...phoneUser(), phoneVerified: false }, { ...phoneUser(), phone: undefined }, { ...phoneUser(), phone: 'invalid' }, { ...phoneUser(), emailVerified: true }]) {
    respond(input => input.success({ statusCode: 200, data: { data: session(user) } }));
    assert.equal(await auth.authenticatePhone(login), false); assert.equal(auth.user.value, undefined);
  }
  assert.equal(validAuthUser({ ...phoneUser(), hasPassword: 'yes' }), false);
});

test('mini-program phone login stores only its opaque session and restores the same account', async t => {
  const { auth, storage, requests, respond } = fixture(t, true);
  assert.equal(await auth.authenticatePhone(login), true);
  assert.deepEqual(storage.get('youfang-auth-session-v1'), { token: 'p'.repeat(43), expiresAt: (storage.get('youfang-auth-session-v1') as { expiresAt: string }).expiresAt });
  assert.equal(storage.size, 1);
  respond(input => input.success({ statusCode: 200, data: { data: input.url.endsWith('/auth/providers') ? auth.capabilities.value : session(phoneUser(), true) } }));
  await auth.restore();
  assert.equal(auth.user.value?.id, 'A');
  assert.equal(requests.find(request => request.url.endsWith('/auth/me'))?.header.Authorization, `Bearer ${'p'.repeat(43)}`);
});

test('SMS delivery failures never create proof or a fabricated successful cooldown', async t => {
  const { respond, storage } = fixture(t);
  const challenge = usePhoneChallenge({ autoTick: false }); t.after(challenge.dispose);
  challenge.setTarget('13800138000', 'login');
  respond(input => input.success({ statusCode: 503, data: { error: { code: 'SMS_NOT_CONFIGURED', message: '短信尚未配置。' } } }));
  assert.equal(await challenge.send(), false);
  assert.equal(challenge.challenge.value, undefined); assert.equal(challenge.remaining.value, 0); assert.equal(challenge.message.value, '');
  assert.equal(storage.size, 0);
});

test('phone and purpose changes invalidate proofs; late responses and closing the form cannot restore stale codes', async t => {
  const { respond } = fixture(t);
  let clock = Date.now();
  const challenge = usePhoneChallenge({ autoTick: false, now: () => clock }); t.after(challenge.dispose);
  const delivery = (id: string) => ({ challengeId: id, expiresAt: new Date(clock + 300_000).toISOString(), resendAfterSeconds: 60, message: '已提交发送，请查收短信。' });
  respond(input => input.success({ statusCode: 202, data: { data: delivery('login-proof') } }));
  challenge.setTarget('+86 13800138000', 'login'); assert.equal(await challenge.send(), true);
  challenge.code.value = '123456'; assert.equal(challenge.proof()?.challengeId, 'login-proof');
  challenge.setTarget('13800138000', 'bind-phone'); assert.equal(challenge.proof(), undefined); assert.equal(challenge.remaining.value, 0);
  let pending!: RequestOptions;
  respond(input => { pending = input; });
  const sending = challenge.send();
  challenge.clearProof();
  pending.success({ statusCode: 202, data: { data: delivery('stale-proof') } });
  assert.equal(await sending, false); assert.equal(challenge.challenge.value, undefined);
  challenge.setTarget('13900139000', 'login');
  respond(input => input.success({ statusCode: 202, data: { data: delivery('new-proof') } }));
  assert.equal(await challenge.send(), true); challenge.code.value = '123456';
  clock += 300_001; challenge.tick(); assert.equal(challenge.proof(), undefined);
});

test('binding updates only the same account and failed reauthentication preserves its session', async t => {
  const { auth, respond, requests, storage } = fixture(t);
  await auth.authenticatePhone(login);
  const input = { email: 'linked@example.test', code: '123456', challengeId: 'email-proof', currentCode: '654321', currentChallengeId: 'account-proof', password: 'Link-pw-26!' };
  respond(request => request.success({ statusCode: 200, data: { data: { ...phoneUser('B'), email: input.email, emailVerified: true, hasPassword: true } } }));
  assert.equal(await auth.bindEmail(input), false); assert.equal(auth.user.value?.id, 'A'); assert.equal(auth.user.value?.email, undefined);
  respond(request => request.success({ statusCode: 401, data: { error: { code: 'INVALID_CREDENTIALS', message: '当前身份验证失败。' } } }));
  assert.equal(await auth.bindEmail(input), false); assert.equal(auth.signedIn.value, true);
  respond(request => request.success({ statusCode: 200, data: { data: { ...phoneUser(), email: input.email, emailVerified: true, hasPassword: true } } }));
  assert.equal(await auth.bindEmail(input), true); assert.equal(auth.user.value?.id, 'A'); assert.equal(auth.user.value?.phone, phoneUser().phone); assert.equal(auth.user.value?.email, input.email);
  assert.deepEqual(requests.at(-1)?.data, input); assert.equal(storage.size, 0);
});

test('a delayed binding response cannot update a disposed account scope', async t => {
  const { auth, respond } = fixture(t);
  await auth.authenticatePhone(login);
  let pending!: RequestOptions;
  respond(input => { pending = input; });
  const binding = auth.bindEmail({ email: 'linked@example.test', code: '123456', challengeId: 'email-proof', currentCode: '654321', currentChallengeId: 'account-proof', password: 'Link-pw-26!' });
  // A transport 401 clears the old identity; another session can then be restored.
  auth.dispose();
  pending.success({ statusCode: 200, data: { data: { ...phoneUser(), email: 'linked@example.test', emailVerified: true, hasPassword: true } } });
  assert.equal(await binding, false); assert.equal(auth.user.value?.email, undefined);
});


test('an existing email account binds a verified phone without changing its email or account ID', async t => {
  const { auth, respond } = fixture(t);
  const emailUser: AuthUser = { id: 'email-owner', email: 'owner@example.test', emailVerified: true, hasPassword: true, createdAt: '2026-11-05T00:00:00.000Z' };
  respond(input => input.success({ statusCode: 200, data: { data: session(emailUser) } }));
  assert.equal(await auth.authenticate('login', { email: 'owner@example.test', password: 'Original-pw26!' }), true);
  const input = { phone: '+86 13800138000', code: '123456', challengeId: 'new-phone-proof' };
  respond(request => request.success({ statusCode: 200, data: { data: { ...emailUser, phone: '13800138000', phoneVerified: false } } }));
  assert.equal(await auth.bindPhone(input), false); assert.equal(auth.user.value?.phone, undefined);
  respond(request => request.success({ statusCode: 200, data: { data: { ...emailUser, phone: '13800138000', phoneVerified: true } } }));
  assert.equal(await auth.bindPhone(input), true);
  assert.equal(auth.user.value?.id, emailUser.id); assert.equal(auth.user.value?.email, emailUser.email);
});
