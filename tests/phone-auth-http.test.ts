import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuthService } from '../server/auth.js';
import { EmailCodeService, type CodeMail } from '../server/email-codes.js';
import { PhoneCodeService } from '../server/phone-codes.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import type { CodeSms } from '../server/sms.js';
import { JsonStore } from '../server/store.js';

async function fixture(t: TestContext, enabled = true, smsLoginOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'resume-phone-http-'));
  const store = new JsonStore(join(dir, 'data.json'));
  let instant = Date.now();
  const sms: CodeSms[] = [], mail: CodeMail[] = [];
  const codes = new PhoneCodeService(store, { enabled, async sendCode(message) { sms.push(message); } }, { secret: 'fixture-sms-secret-only-over-32-bytes', now: () => instant });
  const emails = new EmailCodeService(store, { enabled: true, async sendCode(message) { mail.push(message); } }, { secret: 'fixture-email-secret-only-over-32-bytes', now: () => instant });
  const auth = new AuthService(store, { phoneCodes: codes, smsLoginOnly, emailCodes: emails, requireEmailVerification: false, now: () => instant });
  const server = createApiServer(new ResumeService(store), { auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(path: string, method = 'GET', body?: unknown, cookie?: string, extra: Record<string,string> = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  }
  return { store, request, sms, mail, emails, advance: () => { instant += 61_000; } };
}

test('SMS login creates a phone-only account and uses HttpOnly cookies on H5 without leaking the session token', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/providers')).body.data.phone, true);
  const challenge = await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'login' });
  assert.equal(challenge.status, 202);
  const input = { phone: '13900000001', code: f.sms[0].code, challengeId: challenge.body.data.challengeId };
  const result = await f.request('/auth/phone', 'POST', input);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.user.email, undefined);
  assert.equal(result.body.data.user.phoneVerified, true);
  assert.equal(result.body.data.token, undefined);
  const cookie = result.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  const signedIn = await f.request('/auth/me', 'GET', undefined, cookie.split(';')[0]);
  assert.equal(signedIn.body.data.user.id, result.body.data.user.id);
  assert.equal((await f.request('/auth/phone', 'POST', input)).status, 400, 'SMS proof cannot be replayed');
  assert.equal((await f.store.read()).users.length, 1);
});

test('binding a verified phone without re-entering a password lets both sign-in methods access the same resumes', async t => {
  const f = await fixture(t);
  const account = await f.request('/auth/register', 'POST', { email: 'synthetic-owner@example.test', password: 'FixturePass26!' });
  const userId = account.body.data.user.id;
  const cookie = account.headers.get('set-cookie')!.split(';')[0];
  const saved = await f.request('/resumes', 'POST', { title: '同账号简历', text: '项目经历\n整理实际交付与验收依据。' }, cookie);
  const challenge = await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'bind-phone' }, cookie);
  assert.equal(challenge.status, 202);
  const bind = await f.request('/auth/phone/bind', 'POST', { phone: '13900000001', code: f.sms[0].code, challengeId: challenge.body.data.challengeId }, cookie);
  assert.equal(bind.status, 200); assert.equal(bind.body.data.id, userId);
  f.advance();
  const loginCode = await f.request('/auth/phone/code', 'POST', { phone: '+8613900000001', purpose: 'login' });
  const login = await f.request('/auth/phone', 'POST', { phone: '13900000001', code: f.sms[1].code, challengeId: loginCode.body.data.challengeId }, undefined, { 'X-Auth-Client': 'mp-weixin' });
  assert.equal(login.status, 200); assert.equal(login.headers.get('set-cookie'), null);
  assert.equal(login.body.data.user.id, userId); assert.ok(login.body.data.token);
  const resumes = await f.request('/resumes', 'GET', undefined, undefined, { Authorization: `Bearer ${login.body.data.token}` });
  assert.equal(resumes.body.data[0].id, saved.body.data.id);
});

test('a phone-only account binds email after both destination and current-phone proof, retaining its account identity', async t => {
  const f = await fixture(t);
  const first = await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'login' });
  const login = await f.request('/auth/phone', 'POST', { phone: '13900000001', code: f.sms[0].code, challengeId: first.body.data.challengeId });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  f.advance();
  const current = await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'verify-account' }, cookie);
  const target = await f.request('/auth/email/code', 'POST', { email: 'synthetic-phone@example.test', purpose: 'bind-email' }, cookie);
  const bound = await f.request('/auth/email/bind', 'POST', { email: 'synthetic-phone@example.test', code: f.mail[0].code, challengeId: target.body.data.challengeId, currentCode: f.sms[1].code, currentChallengeId: current.body.data.challengeId, password: 'FixturePass26!' }, cookie);
  assert.equal(bound.status, 200); assert.equal(bound.body.data.id, login.body.data.user.id);
  assert.equal(bound.body.data.emailVerified, true); assert.equal(bound.body.data.hasPassword, true);
  const emailLogin = await f.request('/auth/login', 'POST', { email: 'synthetic-phone@example.test', password: 'FixturePass26!' });
  assert.equal(emailLogin.body.data.user.id, login.body.data.user.id);
});

test('anonymous binding and foreign-origin SMS sends are rejected before any delivery', async t => {
  const f = await fixture(t);
  for (const path of ['/auth/phone/bind', '/auth/email/bind']) assert.equal((await f.request(path, 'POST', {})).status, 401);
  assert.equal((await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'bind-phone' })).status, 401);
  assert.equal((await f.request('/auth/email/code', 'POST', { email: 'test@example.test', purpose: 'bind-email' })).status, 401);
  assert.equal((await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'login' }, undefined, { Origin: 'https://foreign.example.test' })).status, 403);
  assert.equal(f.sms.length, 0); assert.equal(f.mail.length, 0);
});

test('disabled SMS never returns a successful challenge or phone session', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request('/auth/providers')).body.data.phone, false);
  assert.equal((await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'login' })).body.error.code, 'SMS_NOT_CONFIGURED');
  const result = await f.request('/auth/phone', 'POST', { phone: '13900000001', code: '123456', challengeId: randomUUID() });
  assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(f.sms.length, 0); assert.equal((await f.store.read()).users.length, 0);
});

test('login-only SMS signs in but rejects binding and current account SMS before delivery', async t => {
  const f = await fixture(t, true, true);
  const { data } = (await f.request('/auth/providers')).body;
  assert.equal(data.phone, true);
  assert.equal(data.smsLoginOnly, true);
  const phone = '13900000001';
  const challenge = await f.request('/auth/phone/code', 'POST', { phone, purpose: 'login' });
  assert.equal(challenge.status, 202);
  const proof = { phone, code: f.sms[0].code, challengeId: challenge.body.data.challengeId };
  const login = await f.request('/auth/phone', 'POST', proof);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const purpose of ['bind-phone', 'verify-account']) {
    const rejected = await f.request('/auth/phone/code', 'POST', { phone, purpose }, cookie);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.error.code, 'SMS_LOGIN_ONLY');
  }
  assert.equal((await f.request('/auth/phone/bind', 'POST', proof, cookie)).body.error.code, 'SMS_LOGIN_ONLY');
  assert.deepEqual(f.sms.map(message => message.purpose), ['login']);
});

test('signed-in password change verifies the old password and revokes all existing sessions', async t => {
  const f = await fixture(t);
  const email = 'password-owner@example.test', oldPassword = 'FixturePass26!', newPassword = 'NewFixture26!';
  const owner = await f.request('/auth/register', 'POST', { email, password: oldPassword });
  const cookie = owner.headers.get('set-cookie')!.split(';')[0];
  const otherSession = await f.request('/auth/login', 'POST', { email, password: oldPassword });
  const otherCookie = otherSession.headers.get('set-cookie')!.split(';')[0];
  const endpoint = '/auth/password/change';
  const input = { currentPassword: oldPassword, newPassword };
  assert.equal((await f.request(endpoint, 'POST', input)).status, 401);
  assert.equal((await f.request(endpoint, 'POST', { ...input, newPassword: oldPassword }, cookie)).status, 400);
  assert.equal((await f.request(endpoint, 'POST', { ...input, currentPassword: 'WrongFixture!' }, cookie)).body.error.code, 'CURRENT_IDENTITY_INVALID');
  assert.equal((await f.request('/auth/me', 'GET', undefined, cookie)).status, 200);
  const changed = await f.request(endpoint, 'POST', input, cookie);
  assert.equal(changed.body.data.passwordChanged, true);
  assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await f.request('/auth/me', 'GET', undefined, cookie)).status, 401);
  assert.equal((await f.request('/auth/me', 'GET', undefined, otherCookie)).status, 401);
  assert.equal((await f.request('/auth/login', 'POST', { email, password: oldPassword })).status, 401);
  const loggedIn = await f.request('/auth/login', 'POST', { email, password: newPassword });
  assert.equal(loggedIn.body.data.user.id, owner.body.data.user.id);
});

test('phone replacement requires only a valid session and a new-number SMS proof', async t => {
  const f = await fixture(t);
  const oldPhone = '13900000001', newPhone = '13900000002';
  const firstCode = await f.request('/auth/phone/code', 'POST', { phone: oldPhone, purpose: 'login' });
  const login = await f.request('/auth/phone', 'POST', { phone: oldPhone, code: f.sms.at(-1)!.code, challengeId: firstCode.body.data.challengeId });
  const cookie = login.headers.get('set-cookie')!.split(';')[0], userId = login.body.data.user.id;
  assert.equal((await f.request('/auth/password/change', 'POST', { currentPassword: 'FixturePass26!', newPassword: 'NewFixture26!' }, cookie)).body.error.code, 'PASSWORD_NOT_SET');
  assert.equal((await f.request('/auth/phone/code', 'POST', { phone: newPhone, purpose: 'bind-phone' }, cookie)).status, 409);
  const destination = await f.request('/auth/phone/code', 'POST', { phone: newPhone, purpose: 'bind-phone', replace: true }, cookie);
  const code = f.sms.at(-1)!.code;
  const input = { phone: newPhone, code, challengeId: destination.body.data.challengeId };
  const endpoint = '/auth/phone/change';
  assert.equal((await f.request(endpoint, 'POST', input)).status, 401);
  const wrong = code === '000000' ? '999999' : '000000';
  assert.equal((await f.request(endpoint, 'POST', { ...input, code: wrong }, cookie)).body.error.code, 'CODE_INVALID_OR_EXPIRED');
  const untouched = await f.store.read();
  assert.equal(untouched.phoneChallenges.find(item => item.id === input.challengeId)?.attempts, 1);
  assert.equal(untouched.users.find(item => item.id === userId)?.phone, oldPhone);
  const competingPhone = '13900000003';
  const competing = await f.request('/auth/phone/code', 'POST', { phone: competingPhone, purpose: 'bind-phone', replace: true }, cookie);
  assert.equal(competing.status, 202);
  const competingInput = { phone: competingPhone, challengeId: competing.body.data.challengeId, code: f.sms.at(-1)!.code };
  f.advance();
  const outstanding = await f.request('/auth/phone/code', 'POST', { phone: oldPhone, purpose: 'login' });
  const outstandingCode = f.sms.at(-1)!.code;
  const changed = await f.request(endpoint, 'POST', input, cookie);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.id, userId);
  assert.equal(changed.body.data.phone, newPhone);
  assert.deepEqual((await f.request(endpoint, 'POST', input, cookie)).body.data, changed.body.data);
  assert.equal((await f.request(endpoint, 'POST', competingInput, cookie)).body.error.code, 'CODE_INVALID_OR_EXPIRED');
  assert.equal((await f.request('/auth/phone', 'POST', { phone: oldPhone, code: outstandingCode, challengeId: outstanding.body.data.challengeId })).body.error.code, 'CODE_INVALID_OR_EXPIRED');
  const newCode = await f.request('/auth/phone/code', 'POST', { phone: newPhone, purpose: 'login' });
  const newLogin = await f.request('/auth/phone', 'POST', { phone: newPhone, code: f.sms.at(-1)!.code, challengeId: newCode.body.data.challengeId });
  assert.equal(newLogin.body.data.user.id, userId);
});

test('a bound email stays fixed even for older clients with a previously issued replacement code', async t => {
  const f = await fixture(t);
  const password = 'FixturePass26!', oldEmail = 'old-owner@example.test', newEmail = 'new-owner@example.test';
  const owner = await f.request('/auth/register', 'POST', { email: oldEmail, password });
  const cookie = owner.headers.get('set-cookie')!.split(';')[0];
  const userId = owner.body.data.user.id;
  for (const fields of [{}, { replace: true }]) {
    const rejected = await f.request('/auth/email/code', 'POST', { email: newEmail, purpose: 'bind-email', ...fields }, cookie);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, 'EMAIL_CHANGE_NOT_SUPPORTED');
  }
  assert.equal(f.mail.length, 0);
  const { challengeId } = await f.emails.request(newEmail, 'bind-email', 'previous-version', userId);
  const input = { email: newEmail, challengeId, code: f.mail[0].code };
  assert.equal((await f.request('/auth/email/change', 'POST', input)).status, 401);
  assert.equal((await f.request('/auth/email/change', 'POST', input, cookie)).body.error.code, 'EMAIL_CHANGE_NOT_SUPPORTED');
  assert.equal((await f.request('/auth/email/bind', 'POST', { ...input, currentPassword: password }, cookie)).body.error.code, 'EMAIL_CHANGE_NOT_SUPPORTED');
  assert.equal((await f.request('/auth/me', 'GET', undefined, cookie)).body.data.user.email, oldEmail);
  assert.equal((await f.request('/auth/login', 'POST', { email: oldEmail, password })).body.data.user.id, userId);
  assert.equal((await f.request('/auth/login', 'POST', { email: newEmail, password })).status, 401);
});
