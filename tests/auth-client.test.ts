import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AuthSession } from '../shared/auth.js';
import { api, ApiError, request, setAuthToken } from '../src/services/api.js';
import { useAuth, useEmailChallenge, validateAuthForm } from '../src/services/auth.js';
import { useWorkspace } from '../src/services/workspace.js';

type RequestOptions = {
  url: string; method: string; data?: unknown; header: Record<string, string>; withCredentials?: boolean;
  success: (response: { statusCode: number; data: unknown }) => void;
  fail: (reason: unknown) => void;
};
function session(id: string, token?: string): AuthSession {
  return { user: { id, email: `${id.toLowerCase()}@example.test`, createdAt: '2026-10-25T00:00:00.000Z', emailVerified: false }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...(token ? { token } : {}) };
}
function fixture(t: TestContext, native = false) {
  const globals = globalThis as typeof globalThis & { uni?: unknown; wx?: unknown };
  const originalUni = globals.uni, originalWx = globals.wx;
  if (native) globals.wx = {}; else delete globals.wx;
  const storage = new Map<string, unknown>();
  const requests: RequestOptions[] = [];
  let respond = (options: RequestOptions) => {
    if (options.url.endsWith('/auth/providers')) options.success({ statusCode: 200, data: { data: { emailPassword: true, wechat: false, phone: false, emailVerification: false, passwordReset: false } } });
    else options.success({ statusCode: 200, data: { data: session('A', native ? 'a'.repeat(43) : undefined) } });
  };
  globals.uni = {
    request: (options: RequestOptions) => { requests.push(options); respond(options); },
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  };
  setAuthToken('');
  const auth = useAuth({ autoRestore: false });
  t.after(() => { auth.dispose(); setAuthToken(''); globals.uni = originalUni; if (originalWx === undefined) delete globals.wx; else globals.wx = originalWx; });
  return { auth, storage, requests, respond: (handler: typeof respond) => { respond = handler; } };
}

test('email form validates the password policy and trims the email', async t => {
  assert.match(validateAuthForm('register', 'bad-email', 'long-password', 'long-password'), /邮箱/);
  assert.match(validateAuthForm('register', 'a@example.test', 'long-password', 'other-password'), /不一致/);
  assert.match(validateAuthForm('login', 'a@example.test', 'short'), /6/);
  assert.match(validateAuthForm('register', 'a@example.test', 'short', 'short'), /6 至 16/);
  assert.match(validateAuthForm('register', 'a@example.test', 'has space1', 'has space1'), /空格|符号/);
  assert.match(validateAuthForm('register', 'a@example.test', '密码123456', '密码123456'), /中文/);
  assert.equal(validateAuthForm('register', 'a@example.test', 'Abc!2345', 'Abc!2345'), '');
  const { auth, requests } = fixture(t);
  const password = 'Abc!2345';
  assert.equal(await auth.authenticate('register', { email: ' A@example.test ', password }), true);
  const submitted = requests.find(item => item.url.endsWith('/auth/register'));
  assert.deepEqual(submitted?.data, { email: 'A@example.test', password });
});

test('H5 restores through a cookie without sending or persisting a bearer token', async t => {
  const { auth, storage, requests } = fixture(t);
  setAuthToken('this-must-never-be-sent-in-h5');
  await auth.restore();
  assert.equal(auth.user.value?.id, 'A');
  assert.equal(auth.signedIn.value, true);
  assert.equal(storage.size, 0);
  assert.ok(requests.every(item => item.withCredentials === true));
  assert.ok(requests.every(item => !('Authorization' in item.header) && !('X-Auth-Client' in item.header)));
});

test('network failure during logout keeps the authenticated session until the server confirms logout', async t => {
  const { auth, respond } = fixture(t);
  await auth.authenticate('login', { email: 'a@example.test', password: 'valid-password' });
  respond(options => options.fail({ errMsg: 'network error' }));
  await auth.signOut();
  assert.equal(auth.user.value?.id, 'A');
  assert.equal(auth.signedIn.value, true);
  assert.match(auth.error.value, /退出未完成/);
  respond(options => options.success({ statusCode: 200, data: { data: { signedOut: true } } }));
  await auth.signOut();
  assert.equal(auth.user.value, undefined);
  assert.equal(auth.status.value, 'anonymous');
});

test('a late 401 from an earlier session cannot sign out a newly signed in account', async t => {
  const { auth, respond } = fixture(t);
  await auth.authenticate('login', { email: 'a@example.test', password: 'valid-password' });
  let pending!: RequestOptions;
  respond(options => { pending = options; });
  const previousRequest = api.resumes();
  respond(options => options.success({ statusCode: 200, data: { data: session('B') } }));
  await auth.authenticate('login', { email: 'b@example.test', password: 'valid-password' });
  pending.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'expired' } } });
  await assert.rejects(previousRequest, error => error instanceof ApiError && error.status === 401);
  assert.equal(auth.user.value?.id, 'B');
  assert.equal(auth.signedIn.value, true);
});

test('a late session restore does not replace an account signed in while it was pending', async t => {
  const { auth, respond } = fixture(t);
  let pending!: RequestOptions;
  respond(options => {
    if (options.url.endsWith('/auth/me')) pending = options;
    else options.success({ statusCode: 200, data: { data: session('B') } });
  });
  const restoring = auth.restore();
  await auth.authenticate('login', { email: 'b@example.test', password: 'valid-password' });
  pending.success({ statusCode: 200, data: { data: session('A') } });
  await restoring;
  assert.equal(auth.user.value?.id, 'B');
});

test('failed login is recoverable and does not treat a credentials rejection as session expiry', async t => {
  const { auth, respond } = fixture(t);
  respond(options => options.success({ statusCode: 401, data: { error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误。' } } }));
  assert.equal(await auth.authenticate('login', { email: 'a@example.test', password: 'valid-password' }), false);
  assert.match(auth.error.value, /邮箱或密码错误/);
  assert.equal(auth.busy.value, false);
  assert.equal(auth.user.value, undefined);
});

test('mini-program persists its opaque token, adds native headers, and clears it on an authenticated 401', async t => {
  const { auth, storage, requests, respond } = fixture(t, true);
  await auth.authenticate('register', { email: 'a@example.test', password: 'valid-password' });
  const saved = storage.get('youfang-auth-session-v1') as { token: string };
  assert.equal(saved.token, 'a'.repeat(43));
  respond(options => options.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'expired' } } }));
  await assert.rejects(api.resumes());
  assert.equal(requests.at(-1)?.header.Authorization, `Bearer ${'a'.repeat(43)}`);
  assert.equal(requests.at(-1)?.header['X-Auth-Client'], 'mp-weixin');
  assert.equal(storage.has('youfang-auth-session-v1'), false);
  assert.equal(auth.user.value, undefined);
  assert.equal(auth.status.value, 'anonymous');
});

test('mini-program rejects an expired saved token before restoring private account data', async t => {
  const { auth, storage, requests } = fixture(t, true);
  storage.set('youfang-auth-session-v1', { token: 'a'.repeat(43), expiresAt: '2020-01-01T00:00:00.000Z' });
  await auth.restore();
  assert.equal(auth.status.value, 'anonymous');
  assert.equal(storage.has('youfang-auth-session-v1'), false);
  assert.equal(requests.some(item => item.url.endsWith('/auth/me')), false);
});

test('mini-program restores WeChat identity when its cached app session has been revoked', async t => {
  const { auth, storage, requests, respond } = fixture(t, true);
  storage.set('youfang-auth-session-v1', { token: 'a'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const native = globalThis as unknown as { uni: { login(options: { success(result: { code: string }): void }): void } };
  native.uni.login = options => options.success({ code: 'fresh-wechat-code' });
  const capabilities = { emailPassword: true, wechat: true, phone: false, emailVerification: false, passwordReset: false };
  respond(options => {
    if (options.url.endsWith('/auth/me')) {
      options.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'expired' } } });
    } else {
      options.success({ statusCode: 200, data: { data: options.url.endsWith('/auth/providers') ? capabilities : session('A', 'b'.repeat(43)) } });
    }
  });
  await auth.restore();
  const wechat = requests.find(request => request.url.endsWith('/auth/wechat'));
  assert.deepEqual(wechat?.data, { code: 'fresh-wechat-code' });
  assert.equal(wechat?.header.Authorization, undefined);
  assert.equal(auth.signedIn.value, true);
  assert.equal(auth.user.value?.id, 'A');
  assert.equal((storage.get('youfang-auth-session-v1') as { token: string }).token, 'b'.repeat(43));
});

test('registered accounts have separate draft namespaces and cannot read old anonymous drafts', async t => {
  const { storage } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  storage.set('resume-draft-new', { title: '旧匿名草稿', text: '这份匿名草稿不应显示在任何已注册用户的工作空间。' });
  const first = useWorkspace({ autoLoad: false, userId: 'A' });
  first.openEditor();
  assert.notEqual(first.editorTitle.value, '旧匿名草稿');
  first.editorText.value = '用户 A 尚未保存的真实经历正文：记录业务范围、个人行动与核实依据。';
  first.saveDraft();
  const second = useWorkspace({ autoLoad: false, userId: 'B' });
  second.openEditor();
  assert.notEqual(second.editorText.value, first.editorText.value);
  second.editorText.value = '用户 B 尚未保存的真实经历正文：记录自己的业务背景、交付范围和核实依据。';
  second.saveDraft();
  const restoredFirst = useWorkspace({ autoLoad: false, userId: 'A' });
  restoredFirst.openEditor();
  assert.equal(restoredFirst.editorText.value, first.editorText.value);
  assert.ok(storage.has('resume-user-A-draft-new'));
  assert.ok(storage.has('resume-user-B-draft-new'));
});

test('email challenge proof and resend cooldown stay scoped to a mailbox and are not persisted', async t => {
  const { respond, storage } = fixture(t);
  let clock = Date.now();
  const challenge = useEmailChallenge({ autoTick: false, now: () => clock });
  t.after(challenge.dispose);
  respond(options => options.success({ statusCode: 202, data: { data: { challengeId: 'synthetic-challenge', expiresAt: new Date(clock + 600_000).toISOString(), resendAfterSeconds: 60, message: '验证码已提交发送，请查收邮箱。' } } }));
  challenge.setTarget('A@example.test', 'register');
  assert.equal(challenge.remaining.value, 0);
  assert.equal(await challenge.send(), true);
  assert.equal(challenge.remaining.value, 60, 'a frozen test clock must not hide a newly created cooldown');
  challenge.code.value = '123456';
  assert.deepEqual(challenge.proof(), { challengeId: 'synthetic-challenge', code: '123456' });
  assert.equal(storage.size, 0);
  challenge.setTarget('b@example.test', 'register');
  assert.equal(challenge.code.value, ''); assert.equal(challenge.proof(), undefined);
  assert.equal(challenge.remaining.value, 0);
  challenge.setTarget('a@example.test', 'register');
  assert.equal(challenge.remaining.value, 60);
  clock += 600_001; challenge.tick();
  assert.equal(challenge.proof(), undefined);
});

test('failed email delivery never creates a successful client challenge', async t => {
  const { respond } = fixture(t);
  const challenge = useEmailChallenge({ autoTick: false }); t.after(challenge.dispose);
  challenge.setTarget('a@example.test', 'reset-password');
  respond(options => options.success({ statusCode: 503, data: { error: { code: 'MAIL_DELIVERY_FAILED', message: '邮件未能提交发送。' } } }));
  assert.equal(await challenge.send(), false);
  assert.equal(challenge.challenge.value, undefined); assert.equal(challenge.message.value, '');
  assert.equal(challenge.remaining.value, 0); assert.match(challenge.error.value, /未能提交/);
});

test('a late email send response cannot replace the current mailbox challenge', async t => {
  const { respond } = fixture(t);
  const challenge = useEmailChallenge({ autoTick: false }); t.after(challenge.dispose);
  let pending!: RequestOptions;
  respond(options => { pending = options; });
  challenge.setTarget('a@example.test', 'register');
  const first = challenge.send();
  challenge.setTarget('b@example.test', 'register');
  const proof = { challengeId: 'B', expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAfterSeconds: 60, message: 'B submitted' };
  respond(options => options.success({ statusCode: 202, data: { data: proof } }));
  assert.equal(await challenge.send(), true);
  pending.success({ statusCode: 202, data: { data: { ...proof, challengeId: 'A', message: 'A submitted' } } });
  assert.equal(await first, false);
  assert.equal(challenge.challenge.value?.challengeId, 'B'); assert.equal(challenge.message.value, 'B submitted');
});

test('email verification updates only the current user and password reset never signs in automatically', async t => {
  const { auth, respond, requests } = fixture(t);
  await auth.authenticate('login', { email: 'a@example.test', password: 'valid-password' });
  auth.capabilities.value = { emailPassword: true, wechat: false, phone: false, emailVerification: true, passwordReset: true };
  respond(options => options.success({ statusCode: 200, data: { data: { ...session('B').user, emailVerified: true } } }));
  assert.equal(await auth.verifyEmail({ code: '123456', challengeId: 'test' }), false);
  assert.equal(auth.user.value?.id, 'A'); assert.equal(auth.user.value?.emailVerified, false);
  respond(options => options.success({ statusCode: 200, data: { data: { ...session('A').user, emailVerified: true } } }));
  assert.equal(await auth.verifyEmail({ code: '123456', challengeId: 'test' }), true);
  assert.equal(auth.user.value?.emailVerified, true);
  const loginCount = requests.filter(item => item.url.endsWith('/auth/login')).length;
  respond(options => options.success({ statusCode: 200, data: { data: { passwordReset: true } } }));
  assert.equal(await auth.resetPassword({ email: 'a@example.test', password: 'Replacement!26', code: '123456', challengeId: 'test' }), true);
  assert.equal(auth.status.value, 'anonymous'); assert.equal(auth.user.value, undefined);
  assert.match(auth.notice.value, /新密码登录/);
  assert.equal(requests.filter(item => item.url.endsWith('/auth/login')).length, loginCount);
});
