import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuthService } from '../server/auth.js';
import { EmailCodeService, type CodeMail, type MailSender } from '../server/email-codes.js';
import { HttpError } from '../server/errors.js';
import { JsonStore } from '../server/store.js';
import type { EmailCodePurpose } from '../shared/auth.js';

const password = 'Synthetic-2026!';
const replacementPassword = 'Replace-2026!ab';
const secret = 'synthetic-test-only-mail-code-secret-256-bit';
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

class FakeMailer implements MailSender {
  enabled = true;
  messages: CodeMail[] = [];
  failure = false;
  gate?: Promise<void>;
  async sendCode(input: CodeMail) {
    this.messages.push(input);
    if (this.gate) await this.gate;
    if (this.failure) throw new Error('Synthetic SMTP error must not be exposed.');
  }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-email-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'database.json');
  let clock = Date.parse('2026-10-25T00:00:00Z');
  const now = () => clock;
  const store = new JsonStore(path);
  const mailer = new FakeMailer();
  const codes = new EmailCodeService(store, mailer, { secret, now });
  const auth = new AuthService(store, { emailCodes: codes, requireEmailVerification: true, now });
  const request = async (email: string, purpose: EmailCodePurpose, userId?: string, client = 'synthetic-client') => {
    const challenge = await auth.requestEmailCode({ email, purpose }, client, userId);
    const message = mailer.messages.at(-1)!;
    assert.equal(message.email, email.toLowerCase().trim());
    return { email, code: message.code, challengeId: challenge.challengeId, challenge };
  };
  const register = async (email: string) => {
    const proof = await request(email, 'register');
    return auth.register({ email, password, code: proof.code, challengeId: proof.challengeId });
  };
  return { path, store, mailer, codes, auth, now, request, register, advance(ms: number) { clock += ms; } };
}

test('SMTP-backed registration requires a delivered challenge and never persists or returns its plaintext code', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.auth.register({ email: 'new@example.test', password }), hasCode('EMAIL_VERIFICATION_REQUIRED'));
  assert.deepEqual((await f.store.read()).users, []);
  const proof = await f.request('new@example.test', 'register');
  assert.equal(proof.challenge.resendAfterSeconds, 60);
  assert.equal(Date.parse(proof.challenge.expiresAt) - f.now(), 10 * 60_000);
  assert.match(proof.code, /^\d{6}$/);
  assert.equal(Object.hasOwn(proof.challenge, 'code'), false);
  const persisted = await readFile(f.path, 'utf8');
  assert.equal(persisted.includes(proof.code), false);
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('synthetic-client'), false);
  const stored = (await f.store.read()).emailChallenges[0];
  assert.match(stored.codeHash, /^[a-f0-9]{64}$/);
  assert.equal(stored.status, 'sent');
  const result = await f.auth.register({ email: proof.email, password, challengeId: proof.challengeId, code: proof.code });
  assert.equal(result.session.user.emailVerified, true);
  assert.equal((await f.auth.authenticate(result.token)).user.emailVerified, true);
  const consumed = (await f.store.read()).emailChallenges[0];
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.codeHash, '');
  assert.equal((await f.store.read()).version, 3);
});

test('wrong guesses persist, lock after five attempts and remain locked after a process restart', async t => {
  const f = await fixture(t);
  const proof = await f.request('attempts@example.test', 'register');
  const wrong = proof.code === '000000' ? '111111' : '000000';
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(() => f.auth.register({ email: proof.email, password, code: wrong, challengeId: proof.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
    assert.equal((await f.store.read()).emailChallenges[0].attempts, attempt);
  }
  assert.equal((await f.store.read()).emailChallenges[0].status, 'locked');
  const freshStore = new JsonStore(f.path);
  const freshCodes = new EmailCodeService(freshStore, f.mailer, { secret, now: f.now });
  const freshAuth = new AuthService(freshStore, { emailCodes: freshCodes, now: f.now });
  await assert.rejects(() => freshAuth.register({ email: proof.email, password, code: proof.code, challengeId: proof.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  assert.deepEqual((await freshStore.read()).users, []);
});

test('challenges are bound to address and purpose, expire and are superseded only after successful resending', async t => {
  const f = await fixture(t);
  const first = await f.request('binding@example.test', 'register');
  await assert.rejects(() => f.auth.register({ email: 'other@example.test', password, code: first.code, challengeId: first.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  await assert.rejects(() => f.auth.resetPassword({ email: first.email, password: replacementPassword, code: first.code, challengeId: first.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  assert.equal((await f.store.read()).emailChallenges[0].status, 'sent');
  await assert.rejects(() => f.request(first.email, 'reset-password'), hasCode('CODE_RESEND_TOO_SOON'));
  f.advance(60_001);
  const second = await f.request(first.email, 'register');
  assert.equal((await f.store.read()).emailChallenges[0].status, 'superseded');
  await assert.rejects(() => f.auth.register({ email: first.email, password, code: first.code, challengeId: first.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  f.advance(10 * 60_000 + 1);
  await assert.rejects(() => f.auth.register({ email: second.email, password, code: second.code, challengeId: second.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  assert.equal((await f.store.read()).emailChallenges.at(-1)!.status, 'expired');
  assert.deepEqual((await f.store.read()).users, []);
});

test('failed SMTP delivery and unfinished reservations cannot create or verify accounts', async t => {
  const f = await fixture(t);
  f.mailer.failure = true;
  await assert.rejects(() => f.auth.requestEmailCode({ email: 'failed@example.test', purpose: 'register' }), error => error instanceof HttpError && error.code === 'MAIL_DELIVERY_FAILED' && !error.message.includes('Synthetic SMTP'));
  const failed = (await f.store.read()).emailChallenges[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.codeHash, '');
  await assert.rejects(() => f.auth.register({ email: failed.email, password, code: f.mailer.messages[0].code, challengeId: failed.id }), hasCode('CODE_INVALID_OR_EXPIRED'));
  f.mailer.failure = false;
  let release!: () => void;
  f.mailer.gate = new Promise<void>(resolve => { release = resolve; });
  const sending = f.auth.requestEmailCode({ email: 'pending@example.test', purpose: 'register' });
  for (let i = 0; i < 20 && !f.mailer.messages.some(message => message.email === 'pending@example.test'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  const pending = (await f.store.read()).emailChallenges.find(challenge => challenge.email === 'pending@example.test')!;
  assert.equal(pending.status, 'pending');
  await assert.rejects(() => f.auth.register({ email: pending.email, password, code: f.mailer.messages.at(-1)!.code, challengeId: pending.id }), hasCode('CODE_INVALID_OR_EXPIRED'));
  release(); await sending;
  assert.equal((await f.store.read()).emailChallenges.find(challenge => challenge.id === pending.id)!.status, 'sent');
  f.mailer.gate = undefined;
  f.advance(60_001);
  f.mailer.failure = true;
  await assert.rejects(() => f.request(pending.email, 'register'), hasCode('MAIL_DELIVERY_FAILED'));
  assert.equal((await f.store.read()).emailChallenges.find(challenge => challenge.id === pending.id)!.status, 'sent', 'a failed resend leaves a previously delivered code usable');
});

test('email-wide rate limits survive restart and cannot be bypassed by alternating purposes', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    await f.request('limits@example.test', i % 2 ? 'register' : 'reset-password');
    f.advance(61_000);
  }
  const freshStore = new JsonStore(f.path);
  const fresh = new EmailCodeService(freshStore, f.mailer, { secret, now: f.now });
  await assert.rejects(() => fresh.request('limits@example.test', 'register', 'different-client'), hasCode('MAIL_RATE_LIMITED'));
  assert.equal(f.mailer.messages.length, 5);
  f.advance(60 * 60_000);
  await fresh.request('limits@example.test', 'register', 'different-client');
  assert.equal(f.mailer.messages.length, 6);
});

test('password reset atomically consumes proof, replaces password and revokes every old session', async t => {
  const f = await fixture(t);
  const email = 'reset@example.test';
  const first = await f.register(email);
  const second = await f.auth.login({ email, password });
  f.advance(60_001);
  const proof = await f.request(email, 'reset-password');
  const results = await Promise.allSettled([
    f.auth.resetPassword({ email, password: replacementPassword, code: proof.code, challengeId: proof.challengeId }, 'reset-one'),
    f.auth.resetPassword({ email, password: replacementPassword, code: proof.code, challengeId: proof.challengeId }, 'reset-two'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  await assert.rejects(() => f.auth.authenticate(first.token), hasCode('AUTH_REQUIRED'));
  await assert.rejects(() => f.auth.authenticate(second.token), hasCode('AUTH_REQUIRED'));
  await assert.rejects(() => f.auth.login({ email, password }), hasCode('INVALID_CREDENTIALS'));
  const loggedIn = await f.auth.login({ email, password: replacementPassword });
  assert.equal(loggedIn.session.user.id, first.session.user.id);
  assert.equal(loggedIn.session.user.emailVerified, true);
  assert.equal((await f.store.read()).sessions.length, 1, 'reset did not create a session by itself');
});

test('unknown and old unverified accounts cannot be recovered merely by proving access to an address', async t => {
  const f = await fixture(t);
  const legacy = new AuthService(f.store, { now: f.now });
  const old = await legacy.register({ email: 'old-unverified@example.test', password });
  assert.equal(old.session.user.emailVerified, false);
  const beforeHash = (await f.store.read()).users[0].passwordHash;
  const unknown = await f.request('unknown@example.test', 'reset-password');
  const unverified = await f.request(old.session.user.email, 'reset-password');
  assert.deepEqual(Object.keys(unknown.challenge), Object.keys(unverified.challenge));
  for (const proof of [unknown, unverified]) await assert.rejects(() => f.auth.resetPassword({ email: proof.email, password: replacementPassword, code: proof.code, challengeId: proof.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  assert.equal((await f.store.read()).users[0].passwordHash, beforeHash);
  assert.equal((await f.auth.authenticate(old.token)).user.id, old.session.user.id, 'failed recovery does not revoke the rightful existing session');
  assert.equal(f.mailer.messages.length, 2, 'both valid request addresses follow the same mail path');
});

test('existing accounts verify only their own address in an authenticated scope and then become recoverable', async t => {
  const f = await fixture(t);
  const legacy = new AuthService(f.store, { now: f.now });
  const alice = await legacy.register({ email: 'legacy-alice@example.test', password });
  const bob = await legacy.register({ email: 'legacy-bob@example.test', password });
  await assert.rejects(() => f.auth.requestEmailCode({ email: alice.session.user.email, purpose: 'verify-email' }), hasCode('AUTH_REQUIRED'));
  await assert.rejects(() => f.auth.requestEmailCode({ email: alice.session.user.email, purpose: 'verify-email' }, 'bob', bob.session.user.id), hasCode('EMAIL_MISMATCH'));
  const proof = await f.request(alice.session.user.email, 'verify-email', alice.session.user.id);
  await assert.rejects(() => f.auth.verifyEmail(bob.session.user.id, { code: proof.code, challengeId: proof.challengeId }), hasCode('CODE_INVALID_OR_EXPIRED'));
  const verified = await f.auth.verifyEmail(alice.session.user.id, { code: proof.code, challengeId: proof.challengeId });
  assert.equal(verified.emailVerified, true);
  assert.equal((await f.auth.authenticate(alice.token)).user.emailVerified, true);
  assert.equal((await f.auth.authenticate(bob.token)).user.emailVerified, false);
  f.advance(60_001);
  const reset = await f.request(alice.session.user.email, 'reset-password');
  await f.auth.resetPassword({ email: reset.email, password: replacementPassword, code: reset.code, challengeId: reset.challengeId });
  await assert.rejects(() => f.auth.authenticate(alice.token), hasCode('AUTH_REQUIRED'));
  assert.equal((await f.auth.authenticate(bob.token)).user.id, bob.session.user.id);
});

test('v2 account migration preserves sessions and ownership and defaults missing verification to false', async t => {
  const f = await fixture(t);
  const legacy = new AuthService(f.store, { now: f.now });
  const account = await legacy.register({ email: 'migration@example.test', password });
  const database = await f.store.read();
  const old: any = { ...database, version: 2 };
  delete old.emailChallenges; delete old.users[0].emailVerified;
  await writeFile(f.path, JSON.stringify(old));
  const fresh = new JsonStore(f.path);
  const auth = new AuthService(fresh, { now: f.now });
  assert.equal((await auth.authenticate(account.token)).user.emailVerified, false);
  assert.equal((await fresh.read()).version, 3);
  assert.deepEqual((await fresh.read()).emailChallenges, []);
  assert.equal((await fresh.read()).users[0].id, account.session.user.id);
});

test('missing or disabled mail configuration rejects verification without bypassing a required registration proof', async t => {
  const f = await fixture(t);
  const mailer = new FakeMailer(); mailer.enabled = false;
  const codes = new EmailCodeService(f.store, mailer, { secret: '' });
  const auth = new AuthService(f.store, { emailCodes: codes, requireEmailVerification: true });
  assert.equal(auth.capabilities().emailVerification, false);
  await assert.rejects(() => auth.register({ email: 'disabled@example.test', password }), hasCode('MAIL_NOT_CONFIGURED'));
  await assert.rejects(() => auth.requestEmailCode({ email: 'disabled@example.test', purpose: 'register' }), hasCode('MAIL_NOT_CONFIGURED'));
  assert.deepEqual((await f.store.read()).users, []);
  assert.equal(mailer.messages.length, 0);
});

test('HTTP email proof routes register verified accounts, reject cross-site requests and reset without creating a session', async t => {
  const { createApiServer } = await import('../server/http.js');
  const { ResumeService } = await import('../server/service.js');
  const f = await fixture(t);
  const server = createApiServer(new ResumeService(f.store), { auth: f.auth, secureCookies: true, trustedOrigins: ['https://www.youfangcv.site'] });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const request = async (route: string, data?: unknown, cookie?: string, origin = 'https://www.youfangcv.site') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  assert.deepEqual((await request('/auth/providers')).body.data, { emailPassword: true, wechat: false, phone: false, emailVerification: true, passwordReset: true });
  assert.equal((await request('/auth/email/code', { email: 'http-proof@example.test', purpose: 'register' }, undefined, 'https://untrusted.example')).status, 403);
  assert.equal(f.mailer.messages.length, 0);
  const sent = await request('/auth/email/code', { email: 'http-proof@example.test', purpose: 'register' });
  assert.equal(sent.status, 202); assert.equal(sent.body.data.code, undefined);
  const register = await request('/auth/register', { email: 'http-proof@example.test', password, code: f.mailer.messages.at(-1)!.code, challengeId: sent.body.data.challengeId });
  assert.equal(register.status, 201); assert.equal(register.body.data.user.emailVerified, true);
  const cookie = register.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/auth/email/verify', { code: '123456', challengeId: '00000000-0000-0000-0000-000000000000' })).status, 401);
  f.advance(61_000);
  const resetCode = await request('/auth/email/code', { email: 'http-proof@example.test', purpose: 'reset-password' });
  const reset = await request('/auth/password/reset', { email: 'http-proof@example.test', password: replacementPassword, code: f.mailer.messages.at(-1)!.code, challengeId: resetCode.body.data.challengeId });
  assert.equal(reset.status, 200); assert.deepEqual(reset.body.data, { passwordReset: true });
  assert.match(reset.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await request('/auth/me', undefined, cookie)).status, 401);
  assert.equal((await request('/auth/login', { email: 'http-proof@example.test', password })).status, 401);
  assert.equal((await request('/auth/login', { email: 'http-proof@example.test', password: replacementPassword })).status, 200);
});
