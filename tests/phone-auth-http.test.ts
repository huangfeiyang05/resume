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
  return { store, request, sms, mail, advance: () => { instant += 61_000; } };
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

test('binding a verified phone makes SMS and email login share the same user and saved resumes', async t => {
  const f = await fixture(t);
  const account = await f.request('/auth/register', 'POST', { email: 'synthetic-owner@example.test', password: 'FixturePass26!' });
  const userId = account.body.data.user.id;
  const cookie = account.headers.get('set-cookie')!.split(';')[0];
  const saved = await f.request('/resumes', 'POST', { title: '同账号简历', text: '项目经历\n整理实际交付与验收依据。' }, cookie);
  const challenge = await f.request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'bind-phone' }, cookie);
  assert.equal(challenge.status, 202);
  const bind = await f.request('/auth/phone/bind', 'POST', { phone: '13900000001', code: f.sms[0].code, challengeId: challenge.body.data.challengeId, currentPassword: 'FixturePass26!' }, cookie);
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
