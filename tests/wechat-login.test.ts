import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { AuthUser } from '../shared/auth.js';
import { AuthService } from '../server/auth.js';
import { HttpError } from '../server/errors.js';
import { createApiServer } from '../server/http.js';
import type { WechatIdentityProvider } from '../server/wechat-identity.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const origin = 'https://www.youfangcv.site';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-wechat-login-'));
  const path = join(directory, 'database.json');
  let store = new JsonStore(path);
  const provider: WechatIdentityProvider = {
    exchange: async (code: string) => {
      if (code === 'valid-code-1') return { openid: 'openid_test_user_1' };
      if (code === 'valid-code-2') return { openid: 'openid_test_user_2' };
      throw new HttpError(400, 'WECHAT_CODE_INVALID', '微信登录凭证已失效，请重试。');
    },
  };
  let auth = new AuthService(store, { wechat: provider });
  let server = createApiServer(new ResumeService(store), { auth, secureCookies: true, trustedOrigins: [origin] });
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
  const request = async (route: string, data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        Origin: origin,
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  return {
    request, path,
    get store() { return store; },
    async restart() {
      await close();
      store = new JsonStore(path);
      auth = new AuthService(store, { wechat: provider });
      server = createApiServer(new ResumeService(store), { auth, secureCookies: true, trustedOrigins: [origin] });
      await start();
    },
  };
}

test('mini-program silent WeChat login creates one openid account and returns a bearer token', async t => {
  const f = await fixture(t);
  const first = await f.request('/auth/wechat', { code: 'valid-code-1' }, { 'X-Auth-Client': 'mp-weixin' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const user = first.body.data.user as AuthUser;
  assert.equal(user.wechat, true);
  assert.equal(user.email, undefined);
  assert.equal(user.phone, undefined);
  assert.equal(user.emailVerified, false);
  assert.equal(typeof first.body.data.token, 'string');
  assert.match(first.body.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.headers.get('set-cookie'), null, 'mini-program tokens use the Authorization header, not cookies');

  const again = await f.request('/auth/wechat', { code: 'valid-code-1' }, { 'X-Auth-Client': 'mp-weixin' });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.user.id, user.id, 'the same openid must reuse the same account');
  assert.notEqual(again.body.data.token, first.body.data.token);

  const database = await f.store.read();
  assert.equal(database.users.length, 1);
  assert.equal(database.users[0].wechatOpenid, 'openid_test_user_1');
  assert.equal(database.users[0].passwordHash, undefined);
  assert.equal(database.users[0].email, undefined);

  const me = await f.request('/auth/me', undefined, { Authorization: `Bearer ${again.body.data.token}` });
  assert.equal(me.status, 200);
  assert.equal((me.body.data.user as AuthUser).id, user.id);
  assert.equal((me.body.data.user as AuthUser).wechat, true);

  await f.restart();
  const restored = await f.request('/auth/me', undefined, { Authorization: `Bearer ${again.body.data.token}` });
  assert.equal(restored.status, 200);
  assert.equal((restored.body.data.user as AuthUser).id, user.id);
});

test('mini-program silent WeChat login separates openids and rejects invalid codes', async t => {
  const f = await fixture(t);
  const one = await f.request('/auth/wechat', { code: 'valid-code-1' }, { 'X-Auth-Client': 'mp-weixin' });
  const two = await f.request('/auth/wechat', { code: 'valid-code-2' }, { 'X-Auth-Client': 'mp-weixin' });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.notEqual(one.body.data.user.id, two.body.data.user.id);

  const invalid = await f.request('/auth/wechat', { code: 'invalid-code' }, { 'X-Auth-Client': 'mp-weixin' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'WECHAT_CODE_INVALID');
  assert.equal(invalid.headers.get('set-cookie'), null);

  const extra = await f.request('/auth/wechat', { code: 'valid-code-1', userId: 'forge' }, { 'X-Auth-Client': 'mp-weixin' });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.error.code, 'VALIDATION_ERROR');
});

test('H5 WeChat login uses an HttpOnly cookie and never exposes the session token', async t => {
  const f = await fixture(t);
  const response = await f.request('/auth/wechat', { code: 'valid-code-1' });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.token, undefined);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  assert.match(cookie, /^youfang_session=[^;]+/);
  assert.match(cookie, /HttpOnly/i);
  const me = await f.request('/auth/me', undefined, { Cookie: cookie.split(';')[0] });
  assert.equal(me.status, 200);
  assert.equal((me.body.data.user as AuthUser).wechat, true);
});

test('an account database rejects a WeChat user without an openid and duplicate openids', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-wechat-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'database.json');
  const base = { version: 3, users: [], sessions: [], emailChallenges: [], phoneChallenges: [], resumes: [], analyses: [] };
  await writeFile(path, JSON.stringify({ ...base, users: [{ id: 'user-1', emailVerified: false, createdAt: new Date().toISOString() }] }));
  await assert.rejects(() => new JsonStore(path).read(), /malformed account database/i);
  await writeFile(path, JSON.stringify({
    ...base,
    users: [
      { id: 'user-1', wechatOpenid: 'openid_duplicate_1', emailVerified: false, createdAt: new Date().toISOString() },
      { id: 'user-2', wechatOpenid: 'openid_duplicate_1', emailVerified: false, createdAt: new Date().toISOString() },
    ],
  }));
  await assert.rejects(() => new JsonStore(path).read(), /Duplicate account identifiers/i);
});
