import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { AuthService } from '../server/auth.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const password = 'Abc!2345';
const weakText = '部署验收合成测试资料。\n个人简介\n拥有后端开发经验，热爱技术与学习。\n工作经历\n负责日常业务的接口维护和需求跟进工作。\n参与业务系统相关文档的整理和部门沟通。';

interface RequestOptions {
  cookie?: string;
  token?: string;
  headers?: Record<string, string>;
}

function sessionCookie(headers: Headers): string {
  const value = headers.get('set-cookie');
  assert.ok(value, 'successful authentication must set a session cookie');
  const cookie = value.split(';')[0];
  assert.match(cookie, /^youfang_session=[^;]+$/);
  return cookie;
}

async function fixture(t: TestContext, initialDatabase?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-auth-'));
  const path = join(directory, 'database.json');
  if (initialDatabase !== undefined) await writeFile(path, JSON.stringify(initialDatabase));
  let store = new JsonStore(path);
  let server = createApiServer(new ResumeService(store), {
    secureCookies: true, trustedOrigins: ['https://www.youfangcv.site'],
  });
  let base = '';
  const start = async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  };
  const close = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await start();
  const request = async (route: string, method = 'GET', data?: unknown, options: RequestOptions = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const register = async (email: string, options?: RequestOptions) => {
    const response = await request('/auth/register', 'POST', { email, password }, options);
    assert.equal(response.status, 201);
    return { ...response, cookie: sessionCookie(response.headers) };
  };
  return {
    request, register, path,
    get store() { return store; },
    async restart() {
      await close();
      store = new JsonStore(path);
      server = createApiServer(new ResumeService(store), {
        secureCookies: true, trustedOrigins: ['https://www.youfangcv.site'],
      });
      await start();
    },
  };
}

test('email registration signs in with a secure cookie and persists only password and token hashes', async t => {
  const f = await fixture(t);
  const registration = await f.register('  Case.User+auth@Example.test  ');
  assert.equal(registration.body.data.user.email, 'case.user+auth@example.test');
  assert.equal(registration.body.data.user.emailVerified, false, 'an address is not verified without an email delivery flow');
  assert.equal(typeof registration.body.data.user.id, 'string');
  assert.ok(Number.isFinite(Date.parse(registration.body.data.expiresAt)));
  assert.equal(registration.body.data.token, undefined, 'H5 must not expose the HttpOnly token in JSON');
  assert.match(registration.headers.get('set-cookie')!, /;\s*HttpOnly/i);
  assert.match(registration.headers.get('set-cookie')!, /;\s*Secure/i);
  assert.match(registration.headers.get('set-cookie')!, /;\s*SameSite=Lax/i);
  assert.match(registration.headers.get('cache-control')!, /no-store/);

  const current = await f.request('/auth/me', 'GET', undefined, { cookie: registration.cookie });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body.data.user, registration.body.data.user);
  assert.equal(current.body.data.token, undefined);
  assert.equal(/"(?:password|passwordHash|tokenHash)"|scrypt\$/i.test(JSON.stringify(current.body)), false, 'public auth data must omit credential material');
  assert.equal(current.body.data.user.hasPassword, true, 'only the availability flag is public');

  const serialized = await readFile(f.path, 'utf8');
  assert.equal(serialized.includes(password), false, 'plaintext passwords must never be persisted');
  assert.equal(serialized.includes(registration.cookie.slice('youfang_session='.length)), false, 'raw session tokens must never be persisted');
  const database = JSON.parse(serialized);
  assert.equal(database.version, 3, 'the email challenge store upgrades the persisted format to version 3');
  assert.deepEqual(database.emailChallenges, []);
  assert.equal(database.users.length, 1);
  assert.ok(database.users[0].passwordHash);
  assert.ok(database.sessions[0].tokenHash);

  await f.restart();
  const restored = await f.request('/auth/me', 'GET', undefined, { cookie: registration.cookie });
  assert.equal(restored.status, 200, 'a persisted session remains valid after restarting the process');
  assert.equal(restored.body.data.user.id, registration.body.data.user.id);
});

test('login validates external inputs, enforces the password policy and rejects bad credentials uniformly', async t => {
  const f = await fixture(t);
  for (const input of [
    null, [], {}, { email: 'not-an-email', password }, { email: 'user@example.test', password: 'short' },
    { email: 'user@example.test', password: 'x'.repeat(129) }, { email: 123, password },
    { email: 'user@example.test', password, userId: 'someone-else' },
  ]) assert.equal((await f.request('/auth/register', 'POST', input)).status, 400);

  const registration = await f.register('user@example.test');
  assert.equal((await f.request('/auth/register', 'POST', { email: 'USER@EXAMPLE.TEST', password })).status, 409);
  const badPassword = await f.request('/auth/login', 'POST', { email: 'user@example.test', password: 'incorrect-password' });
  const missingAccount = await f.request('/auth/login', 'POST', { email: 'missing@example.test', password: 'incorrect-password' });
  assert.equal(badPassword.status, 401);
  assert.equal(missingAccount.status, 401);
  assert.deepEqual(badPassword.body, missingAccount.body, 'an unknown email and incorrect password use the same public error');
  assert.equal(badPassword.headers.get('set-cookie'), null);
  const login = await f.request('/auth/login', 'POST', { email: ' USER@EXAMPLE.TEST ', password });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.id, registration.body.data.user.id);
  assert.notEqual(sessionCookie(login.headers), registration.cookie, 'each login gets a new unpredictable session');
  assert.equal((await f.request('/auth/login', 'POST', { email: 'user@example.test', password, isMember: true })).status, 400);

  for (const weak of [` ${password} `, 'Abc 12345', '密码123456', 'Abc12', 'x'.repeat(17)]) {
    assert.equal((await f.request('/auth/register', 'POST', { email: 'weak-policy@example.test', password: weak })).status, 400, `registration must reject the password ${JSON.stringify(weak)}`);
  }
  const symbols = 'a!B2#cD4eF6@hJ8';
  assert.equal((await f.request('/auth/register', 'POST', { email: 'symbols@example.test', password: symbols })).status, 201);
  assert.equal((await f.request('/auth/login', 'POST', { email: 'symbols@example.test', password: symbols })).status, 200);
});

test('anonymous requests are rejected and logout revokes the server session', async t => {
  const f = await fixture(t);
  const unknownLogout = await f.request('/auth/logout', 'POST', {}, { token: 'x'.repeat(43) });
  assert.equal(unknownLogout.status, 200);
  assert.deepEqual(unknownLogout.body.data, { signedOut: true });
  await assert.rejects(readFile(f.path), error => (error as NodeJS.ErrnoException).code === 'ENOENT', 'unknown tokens must not create or rewrite the account database');
  for (const route of ['/auth/me', '/resumes', '/membership', '/resumes/unknown', '/analyses/unknown', '/analysis-jobs/unknown']) {
    assert.equal((await f.request(route)).status, 401, route);
  }
  assert.equal((await f.request('/resumes', 'POST', { title: '匿名', text: weakText })).status, 401);
  const registration = await f.register('logout@example.test');
  const logout = await f.request('/auth/logout', 'POST', {}, { cookie: registration.cookie });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body.data, { signedOut: true });
  assert.match(logout.headers.get('set-cookie')!, /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
  const afterLogout = await stat(f.path, { bigint: true });
  const repeatedLogout = await f.request('/auth/logout', 'POST', {}, { cookie: registration.cookie });
  assert.equal(repeatedLogout.status, 200);
  const afterRepeatedLogout = await stat(f.path, { bigint: true });
  assert.equal(afterRepeatedLogout.ino, afterLogout.ino, 'repeating logout must not replace the persisted database');
  assert.equal(afterRepeatedLogout.mtimeNs, afterLogout.mtimeNs, 'repeating logout must not write the persisted database');
  assert.equal((await f.request('/auth/me', 'GET', undefined, { cookie: registration.cookie })).status, 401);
  await f.restart();
  assert.equal((await f.request('/resumes', 'GET', undefined, { cookie: registration.cookie })).status, 401);
});

test('the wechat capability reflects whether a server identity provider is configured', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-wechat-cap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'database.json'));
  const off = new AuthService(store, {});
  assert.equal(off.capabilities().wechat, false);
  const on = new AuthService(store, { wechat: { exchange: async () => ({ openid: 'openid-test' }) } });
  assert.equal(on.capabilities().wechat, true);
  assert.equal(on.capabilities().emailPassword, true);
});

test('expired sessions fail closed and bearer transport does not activate unfinished login providers', async t => {
  const f = await fixture(t);
  const capabilities = await f.request('/auth/providers');
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.data, { emailPassword: true, wechat: false, phone: false, emailVerification: false, passwordReset: false }, 'email-code features stay off until a mail service is configured');
  const registration = await f.request('/auth/register', 'POST', { email: 'miniapp@example.test', password }, {
    headers: { 'X-Auth-Client': 'mp-weixin' },
  });
  assert.equal(registration.status, 201);
  const h5 = await f.register('browser-expiry@example.test');
  const token = registration.body.data.token;
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.equal((await f.request('/auth/me', 'GET', undefined, { token })).status, 200);
  assert.equal((await f.request('/resumes', 'GET', undefined, { token: `${token}invalid` })).status, 401);
  for (const [route, code] of [['/auth/wechat', 'WECHAT_LOGIN_NOT_CONFIGURED']]) {
    const response = await f.request(route, 'POST', {});
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, code);
    assert.equal(response.headers.get('set-cookie'), null, 'placeholder providers never create a successful session');
  }
  const phone = await f.request('/auth/phone', 'POST', { phone: '13800000001', code: '123456', challengeId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(phone.status, 503);
  assert.equal(phone.body.error.code, 'SMS_NOT_CONFIGURED');
  assert.equal(phone.headers.get('set-cookie'), null, 'disabled SMS cannot create a session');
  await f.store.mutate(database => {
    for (const session of database.sessions) session.expiresAt = '2000-01-01T00:00:00.000Z';
  });
  assert.equal((await f.request('/auth/me', 'GET', undefined, { token })).status, 401);
  assert.equal((await f.request('/resumes', 'GET', undefined, { cookie: h5.cookie })).status, 401);
});

test('server sessions isolate resume writes, reports, suggestions and diagnosis jobs across accounts', async t => {
  const f = await fixture(t);
  const alice = await f.register('alice@example.test');
  const bob = await f.register('bob@example.test');
  const asAlice = { cookie: alice.cookie };
  const asBob = { cookie: bob.cookie };
  const created = await f.request('/resumes', 'POST', { title: 'Alice 合成测试', targetRole: '后端开发', text: weakText }, asAlice);
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const diagnosed = await f.request('/analyses', 'POST', { resumeId: id }, asAlice);
  assert.equal(diagnosed.status, 201);
  const report = diagnosed.body.data;
  const started = await f.request('/analysis-jobs', 'POST', { resumeId: id }, asAlice);
  assert.equal(started.status, 202);
  const jobId = started.body.data.id;
  assert.deepEqual((await f.request('/resumes', 'GET', undefined, asBob)).body.data, []);
  assert.deepEqual((await f.request(`/resumes?userId=${alice.body.data.user.id}`, 'GET', undefined, asBob)).body.data, []);
  const attempts: [string, string, unknown?][] = [
    [`/resumes/${id}`, 'GET'], [`/resumes/${id}`, 'PUT', { title: '越权覆盖', revision: 1 }],
    [`/resumes/${id}`, 'DELETE'], [`/resumes/${id}/analyses`, 'GET'], [`/analyses/${report.id}`, 'GET'],
    [`/analyses/${report.id}/suggestions/${report.suggestions[0].id}/apply`, 'POST', { confirmed: true, replacement: '越权内容', revision: 1 }],
    ['/analyses', 'POST', { resumeId: id }], ['/analysis-jobs', 'POST', { resumeId: id }],
    [`/analysis-jobs/${jobId}`, 'GET'], [`/analysis-jobs/${jobId}`, 'DELETE'],
  ];
  for (const [route, method, data] of attempts) {
    const result = await f.request(route, method, data, asBob);
    assert.equal(result.status, 404, `${method} ${route}`);
  }
  const forgedOwner = await f.request('/resumes', 'POST', { title: '伪造归属', text: weakText, userId: alice.body.data.user.id }, asBob);
  assert.equal(forgedOwner.status, 400);
  assert.equal((await f.request(`/resumes/${id}`, 'GET', undefined, asAlice)).body.data.revision, 1);
  assert.equal((await f.request(`/analyses/${report.id}`, 'GET', undefined, asAlice)).body.data.id, report.id);
  assert.equal((await f.request(`/analysis-jobs/${jobId}`, 'GET', undefined, asAlice)).status, 200);
});

test('cross-site cookie writes and login CSRF are rejected even with a forged miniapp header', async t => {
  const f = await fixture(t);
  const account = await f.register('csrf@example.test');
  const crossSiteHeaders: Record<string, string>[] = [
    { Origin: 'https://evil.example' },
    { Origin: 'https://evil.example', 'X-Auth-Client': 'mp-weixin' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const headers of crossSiteHeaders) {
    const crossSite = { cookie: account.cookie, headers };
    assert.equal((await f.request('/resumes', 'POST', { title: '不应保存', text: weakText }, crossSite)).status, 403);
    assert.equal((await f.request('/auth/login', 'POST', { email: 'csrf@example.test', password }, crossSite)).status, 403);
  }
  const trusted = await f.request('/resumes', 'POST', { title: '同源合成测试', text: weakText }, {
    cookie: account.cookie, headers: { Origin: 'https://www.youfangcv.site' },
  });
  assert.equal(trusted.status, 201);
  assert.equal((await f.request('/resumes', 'GET', undefined, { cookie: account.cookie })).body.data.length, 1);
});

test('legacy shared data stays unclaimed and simultaneous registration cannot create duplicate accounts', async t => {
  const f = await fixture(t, { version: 1, resumes: [{
    id: 'legacy-resume', title: '旧共享演示内容', targetRole: '', text: weakText, revision: 1,
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
  }], analyses: [] });
  const duplicate = await Promise.all([
    f.request('/auth/register', 'POST', { email: 'same@example.test', password }),
    f.request('/auth/register', 'POST', { email: 'SAME@EXAMPLE.TEST', password }),
  ]);
  assert.deepEqual(duplicate.map(result => result.status).sort(), [201, 409]);
  const signedIn = duplicate.find(result => result.status === 201)!;
  const cookie = sessionCookie(signedIn.headers);
  assert.deepEqual((await f.request('/resumes', 'GET', undefined, { cookie })).body.data, []);
  assert.equal((await f.request('/resumes/legacy-resume', 'GET', undefined, { cookie })).status, 404);
  const database = await f.store.read();
  assert.equal(database.users.length, 1);
  assert.equal(database.resumes.length, 1, 'migration preserves old data instead of deleting or assigning it');
  assert.equal(database.resumes[0].id, 'legacy-resume');
});
