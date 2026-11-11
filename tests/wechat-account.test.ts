import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuthService } from '../server/auth.js';
import { EmailCodeService } from '../server/email-codes.js';
import { HttpError } from '../server/errors.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { WechatApi, WechatPhoneVerification } from '../server/wechat-api.js';

const appid = 'wx0123456789abcdef';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6f8AAAAASUVORK5CYII=';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'youfang-wechat-account-'));
  const path = join(root, 'resumes.json');
  const store = new JsonStore(path);
  const used = new Set<string>();
  const redeemed: string[] = [];
  let sentCode = '';
  const emailCodes = new EmailCodeService(store, { enabled: true, async sendCode(input) { sentCode = input.code; } }, { secret: 'a'.repeat(64) });
  const auth = new AuthService(store, {
    emailCodes,
    wechat: { exchange: async code => ({ openid: code.startsWith('one-') ? 'openid-first-test' : 'openid-second-test' }) },
    wechatPhone: { async redeem(code) {
      redeemed.push(code);
      if (used.has(code)) throw new HttpError(400, 'WECHAT_PHONE_CODE_INVALID', 'used');
      used.add(code);
      return code.startsWith('different-') ? '13900000002' : '13800000001';
    } },
  });
  const server = createApiServer(new ResumeService(store), { auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
  const request = (route: string, token?: string, method = 'GET', data?: unknown) => fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', 'X-Auth-Client': 'mp-weixin', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const login = async (code: string) => {
    const result = await request('/auth/wechat', undefined, 'POST', { code });
    assert.equal(result.status, 200);
    return (await result.json()).data;
  };
  return { root, path, store, request, login, redeemed, sentCode: () => sentCode };
}

test('WeChat phone authorization binds the verified number to the current account and refuses existing owners', async t => {
  const f = await fixture(t);
  const a = await f.login('one-login');
  const b = await f.login('two-login');
  const capabilities = (await (await f.request('/auth/providers')).json()).data;
  assert.equal(capabilities.wechatPhone, true);
  assert.equal(capabilities.phone, false);
  const bind = (token: string | undefined, wechatCode: string, phoneCode: string) =>
    f.request('/auth/wechat/phone/bind', token, 'POST', { wechatCode, phoneCode });
  assert.equal((await bind(undefined, 'one-proof', 'not-redeemed')).status, 401);
  assert.equal((await bind(a.token, 'two-proof', 'not-redeemed')).status, 403);
  assert.deepEqual(f.redeemed, []);
  const result = await bind(a.token, 'one-proof', 'phone-code-1');
  assert.equal(result.status, 200);
  const user = (await result.json()).data;
  assert.equal(user.id, a.user.id);
  assert.equal(user.phone, '13800000001');
  assert.equal(user.phoneVerified, true);
  assert.equal(user.wechatOpenid, undefined);
  assert.equal((await bind(a.token, 'one-proof2', 'phone-code-1')).status, 400);
  assert.equal((await bind(a.token, 'one-proof3', 'phone-code-2')).status, 200);
  assert.equal((await bind(a.token, 'one-proof4', 'different-phone')).status, 409);
  const conflict = await bind(b.token, 'two-proof2', 'conflict-phone');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'PHONE_ALREADY_BOUND');
  const restored = await f.login('one-login-again');
  assert.equal(restored.user.id, a.user.id);
  assert.equal(restored.user.phone, user.phone);
  const disk = await readFile(f.path, 'utf8');
  assert.doesNotMatch(disk, /phone-code-|one-proof|conflict-phone/);
  assert.equal((await f.store.read()).users.find(row => row.id === b.user.id)?.phone, undefined);
});

test('WeChat-only accounts can bind a verified email to the same user while SMS is disabled', async t => {
  const f = await fixture(t);
  const original = await f.login('one-login');
  const email = 'same-user@example.test';
  const requested = await f.request('/auth/email/code', original.token, 'POST', { email, purpose: 'bind-email' });
  assert.equal(requested.status, 202);
  const { challengeId } = (await requested.json()).data;
  const input = { email, challengeId, code: f.sentCode(), password: 'Testpass1!' };
  assert.equal((await f.request('/auth/email/bind', original.token, 'POST', { ...input, wechatCode: 'two-proof' })).status, 403);
  const bound = await f.request('/auth/email/bind', original.token, 'POST', { ...input, wechatCode: 'one-proof' });
  assert.equal(bound.status, 200);
  assert.equal((await bound.json()).data.id, original.user.id);
  const h5 = await f.request('/auth/login', undefined, 'POST', { email, password: input.password });
  assert.equal((await h5.json()).data.user.id, original.user.id);
  assert.equal((await f.store.read()).users.length, 1);
});

test('profile avatars are private, persisted and replaced or removed by their owner', async t => {
  const f = await fixture(t);
  const a = await f.login('one-login');
  const b = await f.login('two-login');
  const update = (data: unknown) => f.request('/auth/profile', a.token, 'PUT', data);
  assert.equal((await update({ nickname: 'forged', userId: b.user.id })).status, 400);
  assert.equal((await update({ nickname: 'invalid', avatar: Buffer.from('<svg>invalid avatar image</svg>').toString('base64') })).status, 400);
  assert.equal((await update({ nickname: 'bad\nnickname' })).status, 400);
  const saved = await update({ nickname: '  简历同学  ', avatar: png });
  assert.equal(saved.status, 200);
  const user = (await saved.json()).data;
  assert.equal(user.id, a.user.id);
  assert.equal(user.nickname, '简历同学');
  assert.equal(user.avatar, undefined);
  const route = '/auth/profile/avatar/' + user.avatarId;
  assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request(route, b.token)).status, 404);
  const image = await f.request(route, a.token);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'private, no-store');
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), png);
  assert.equal((await new JsonStore(f.path).read()).users.find(row => row.id === a.user.id)?.avatarId, user.avatarId);
  const kept = await update({ nickname: '换个昵称' });
  assert.equal((await kept.json()).data.avatarId, user.avatarId);
  const replaced = await update({ nickname: '换个头像', avatar: png });
  const replacement = (await replaced.json()).data;
  assert.notEqual(replacement.avatarId, user.avatarId);
  assert.equal((await f.request(route, a.token)).status, 404);
  assert.deepEqual(await readdir(join(f.root, 'account-avatars')), [replacement.avatarId + '.img']);
  const cleared = await update({ nickname: null, avatar: null });
  assert.equal((await cleared.json()).data.avatarId, undefined);
  assert.deepEqual(await readdir(join(f.root, 'account-avatars')), []);
});

test('the phone gateway verifies the app and freshness of the phone code response and shares its app token', async () => {
  const now = Date.parse('2026-11-11T05:00:00.000Z');
  let tokenRequests = 0;
  let timestamp = now / 1000;
  let responseApp = appid;
  let countryCode = '86';
  const api = new WechatApi({ appid, appSecret: 'synthetic' }, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/cgi-bin/stable_token') {
      tokenRequests++;
      return Response.json({ access_token: 'test-token', expires_in: 7200 });
    }
    assert.equal(url.pathname, '/wxa/business/getuserphonenumber');
    assert.equal(url.searchParams.get('access_token'), 'test-token');
    const { code } = JSON.parse(String(init?.body));
    if (code === 'used') return Response.json({ errcode: 40029 });
    return Response.json({ errcode: 0, phone_info: { purePhoneNumber: '13800000001', countryCode, watermark: { appid: responseApp, timestamp } } });
  });
  const phone = new WechatPhoneVerification(api, appid, () => now);
  assert.deepEqual(await Promise.all([phone.redeem('code1'), phone.redeem('code2')]), ['13800000001', '13800000001']);
  assert.equal(tokenRequests, 1);
  await assert.rejects(phone.redeem('used'), { code: 'WECHAT_PHONE_CODE_INVALID' });
  timestamp -= 301;
  await assert.rejects(phone.redeem('stale'), { code: 'WECHAT_PHONE_RESPONSE_INVALID' });
  timestamp = now / 1000;
  responseApp = 'wx9999999999999999';
  await assert.rejects(phone.redeem('foreign-app'), { code: 'WECHAT_PHONE_RESPONSE_INVALID' });
  responseApp = appid;
  countryCode = '852';
  await assert.rejects(phone.redeem('foreign-number'), { code: 'WECHAT_PHONE_REGION_UNSUPPORTED' });
});
