import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuthService } from '../server/auth.js';
import { EmailCodeService, type CodeMail, type MailSender } from '../server/email-codes.js';
import { HttpError } from '../server/errors.js';
import { PhoneCodeService } from '../server/phone-codes.js';
import type { CodeSms, SmsSender } from '../server/sms.js';
import { JsonStore } from '../server/store.js';
import { ResumeService } from '../server/service.js';
import type { EmailCodePurpose, PhoneCodePurpose } from '../shared/auth.js';

const password = 'Fixture-2026!';
const secret = 'synthetic-phone-auth-only-secret-more-than-32-bytes';
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-phone-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'users.json');
  const store = new JsonStore(path);
  let instant = Date.parse('2026-11-05T00:00:00.000Z');
  const now = () => instant;
  const messages: CodeSms[] = [], mails: CodeMail[] = [];
  const sender: SmsSender = { enabled: true, async sendCode(input) { messages.push(input); } };
  const mailer: MailSender = { enabled: true, async sendCode(input) { mails.push(input); } };
  const phoneCodes = new PhoneCodeService(store, sender, { secret, now });
  const emailCodes = new EmailCodeService(store, mailer, { secret, now });
  const auth = new AuthService(store, { now, phoneCodes, emailCodes, requireEmailVerification: false });
  async function phone(phone: string, purpose: PhoneCodePurpose = 'login', userId?: string) {
    instant += 61_000;
    const challenge = await auth.requestPhoneCode({ phone, purpose }, 'synthetic-phone-client', userId);
    return { phone, code: messages.at(-1)!.code, challengeId: challenge.challengeId };
  }
  async function email(email: string, purpose: EmailCodePurpose, userId?: string) {
    instant += 61_000;
    const challenge = await auth.requestEmailCode({ email, purpose }, 'synthetic-mail-client', userId);
    return { email, code: mails.at(-1)!.code, challengeId: challenge.challengeId };
  }
  return { path, store, auth, phoneCodes, emailCodes, now, phone, email,
    restart: () => new AuthService(new JsonStore(path), { now, phoneCodes, emailCodes, requireEmailVerification: false }),
  };
}

test('SMS login atomically creates one phone-only identity without a fabricated email or password', async t => {
  const f = await fixture(t);
  const proof = await f.phone('+8613800000001');
  const results = await Promise.allSettled([f.auth.phoneLogin(proof), f.auth.phoneLogin(proof)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const result = (results.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<AuthService['phoneLogin']>>>).value;
  assert.equal(result.session.user.phone, '13800000001');
  assert.equal(result.session.user.phoneVerified, true);
  assert.equal(result.session.user.hasPassword, false);
  assert.equal(result.session.user.emailVerified, false);
  assert.equal('email' in result.session.user, false);
  const database = await f.store.read();
  assert.equal(database.users.length, 1);
  assert.equal(database.users[0].passwordHash, undefined);
  assert.equal(database.phoneChallenges[0].status, 'consumed');
  assert.equal((await f.restart().authenticate(result.token)).user.id, result.session.user.id);
  const repeat = await f.auth.phoneLogin(await f.phone('13800000001'));
  assert.equal(repeat.session.user.id, result.session.user.id);
  assert.equal((await f.store.read()).users.length, 1);
  assert.equal(f.auth.capabilities().phone, true);
});

test('an existing email account can bind a phone; either login retrieves the same account and resume', async t => {
  const f = await fixture(t);
  const account = await f.auth.register({ email: 'email-first@example.test', password });
  const service = new ResumeService(f.store).forUser(account.session.user.id);
  const resume = await service.createResume({ title: '合成账号资料', text: '项目经历\n记录实际交付并保留测试验证依据。' });
  const proof = await f.phone('13800000002', 'bind-phone', account.session.user.id);
  const bound = await f.auth.bindPhone(account.session.user.id, { ...proof, currentPassword: password });
  assert.equal(bound.id, account.session.user.id);
  assert.equal(bound.phoneVerified, true);
  assert.equal(bound.email, 'email-first@example.test');
  const replay = await f.auth.bindPhone(account.session.user.id, { ...proof, currentPassword: password });
  assert.deepEqual(replay, bound);
  const mobile = await f.auth.phoneLogin(await f.phone('13800000002'));
  const mail = await f.auth.login({ email: 'email-first@example.test', password });
  assert.equal(mobile.session.user.id, mail.session.user.id);
  assert.equal((await new ResumeService(f.store).forUser(mobile.session.user.id).getResume(resume.id)).text, resume.text);
  assert.equal((await f.store.read()).users.length, 1);
});

test('phone-only account binds a verified email and sets a password after proving both identities', async t => {
  const f = await fixture(t);
  const mobile = await f.auth.phoneLogin(await f.phone('13800000003'));
  const userId = mobile.session.user.id;
  const target = await f.email('phone-first@example.test', 'bind-email', userId);
  const current = await f.phone('13800000003', 'verify-account', userId);
  const input = { ...target, password, currentCode: current.code, currentChallengeId: current.challengeId };
  const result = await f.auth.bindEmail(userId, input);
  assert.equal(result.email, target.email); assert.equal(result.emailVerified, true); assert.equal(result.hasPassword, true);
  assert.equal(result.phone, '13800000003');
  assert.deepEqual(await f.auth.bindEmail(userId, input), result, 'a response replay cannot change the account or require another SMS');
  const loggedIn = await f.auth.login({ email: target.email, password });
  assert.equal(loggedIn.session.user.id, userId);
  const restarted = await f.restart().authenticate(mobile.token);
  assert.equal(restarted.user.email, target.email);
  assert.equal((await f.store.read()).users.length, 1);
});

test('binding requires current identity and a target-bound challenge; phone/email purposes cannot be interchanged', async t => {
  const f = await fixture(t);
  const account = await f.auth.register({ email: 'identity-check@example.test', password });
  const proof = await f.phone('13800000004', 'bind-phone', account.session.user.id);
  await assert.rejects(f.auth.bindPhone(account.session.user.id, proof), hasCode('CURRENT_IDENTITY_REQUIRED'));
  await assert.rejects(f.auth.bindPhone(account.session.user.id, { ...proof, currentPassword: 'Incorrect-26!' }), hasCode('CURRENT_IDENTITY_INVALID'));
  const another = await f.auth.register({ email: 'another-owner@example.test', password });
  await assert.rejects(f.auth.bindPhone(another.session.user.id, { ...proof, currentPassword: password }), hasCode('CODE_INVALID_OR_EXPIRED'));
  await assert.rejects(f.auth.phoneLogin(proof), hasCode('CODE_INVALID_OR_EXPIRED'));
  assert.equal((await f.store.read()).phoneChallenges.find(item => item.id === proof.challengeId)?.status, 'sent');
  await f.auth.bindPhone(account.session.user.id, { ...proof, currentPassword: password });
  await assert.rejects(f.auth.requestPhoneCode({ phone: '13800000005', purpose: 'verify-account' }, 'test', account.session.user.id), hasCode('PHONE_MISMATCH'));
  await assert.rejects(f.auth.bindPhone(account.session.user.id, { ...proof, userId: another.session.user.id }), hasCode('VALIDATION_ERROR'));
});

test('conflicting phone/email identifiers reject linking instead of merging accounts or moving private data', async t => {
  const f = await fixture(t);
  const emailAccount = await f.auth.register({ email: 'already-owned@example.test', password });
  const mobile = await f.auth.phoneLogin(await f.phone('13800000006'));
  const mobileUser = mobile.session.user.id;
  const phoneProof = await f.phone('13800000006', 'bind-phone', emailAccount.session.user.id);
  await assert.rejects(f.auth.bindPhone(emailAccount.session.user.id, { ...phoneProof, currentPassword: password }), hasCode('PHONE_ALREADY_BOUND'));
  const target = await f.email('already-owned@example.test', 'bind-email', mobileUser);
  const current = await f.phone('13800000006', 'verify-account', mobileUser);
  await assert.rejects(f.auth.bindEmail(mobileUser, { ...target, password, currentCode: current.code, currentChallengeId: current.challengeId }), hasCode('EMAIL_ALREADY_BOUND'));
  const users = (await f.store.read()).users;
  assert.equal(users.length, 2);
  assert.equal(users.find(user => user.id === emailAccount.session.user.id)?.phone, undefined);
  assert.equal(users.find(user => user.id === mobileUser)?.email, undefined);
  await assert.rejects(f.auth.requestEmailCode({ email: 'replace@example.test', purpose: 'bind-email' }, 'test', emailAccount.session.user.id), hasCode('EMAIL_CHANGE_NOT_SUPPORTED'));
});

test('phone identity proof and target email guesses persist limits without consuming valid current proof on a wrong target code', async t => {
  const f = await fixture(t);
  const account = await f.auth.phoneLogin(await f.phone('13800000007'));
  const userId = account.session.user.id;
  const target = await f.email('wrong-target@example.test', 'bind-email', userId);
  const current = await f.phone('13800000007', 'verify-account', userId);
  const wrong = target.code === '000000' ? '999999' : '000000';
  const input = { ...target, password, currentCode: current.code, currentChallengeId: current.challengeId };
  await assert.rejects(f.auth.bindEmail(userId, { ...input, code: wrong }), hasCode('CODE_INVALID_OR_EXPIRED'));
  const data = await f.store.read();
  assert.equal(data.emailChallenges.find(item => item.id === target.challengeId)?.attempts, 1);
  assert.equal(data.phoneChallenges.find(item => item.id === current.challengeId)?.status, 'sent');
  assert.equal((await f.auth.bindEmail(userId, input)).emailVerified, true);
});

test('wrong current-phone identity guesses commit their lock without consuming the target email proof', async t => {
  const f = await fixture(t);
  const account = await f.auth.phoneLogin(await f.phone('13800000009'));
  const userId = account.session.user.id;
  const target = await f.email('current-proof@example.test', 'bind-email', userId);
  const current = await f.phone('13800000009', 'verify-account', userId);
  const wrong = current.code === '000000' ? '999999' : '000000';
  const input = { ...target, password, currentCode: wrong, currentChallengeId: current.challengeId };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(f.auth.bindEmail(userId, input), hasCode('CODE_INVALID_OR_EXPIRED'));
    assert.equal((await f.store.read()).phoneChallenges.find(item => item.id === current.challengeId)?.attempts, attempt);
  }
  const data = await f.store.read();
  assert.equal(data.phoneChallenges.find(item => item.id === current.challengeId)?.status, 'locked');
  assert.equal(data.emailChallenges.find(item => item.id === target.challengeId)?.status, 'sent');
  assert.equal(data.users.find(user => user.id === userId)?.email, undefined);
});

test('legacy email databases gain no phone identity and malformed or duplicate identifiers fail closed', async t => {
  const f = await fixture(t);
  await f.auth.register({ email: 'legacy-only@example.test', password });
  const original = JSON.parse(await readFile(f.path, 'utf8'));
  delete original.phoneChallenges;
  await writeFile(f.path, JSON.stringify(original));
  const migrated = await new JsonStore(f.path).read();
  assert.deepEqual(migrated.phoneChallenges, []);
  assert.equal(migrated.users[0].phone, undefined);
  for (const mutate of [
    (data: any) => { data.users[0].phone = '13800000008'; },
    (data: any) => { data.users.push({ ...data.users[0], id: 'duplicate-user' }); },
    (data: any) => { data.phoneChallenges = null; },
  ]) {
    const data = structuredClone(original); mutate(data);
    await writeFile(f.path, JSON.stringify(data));
    await assert.rejects(new JsonStore(f.path).read());
  }
});
