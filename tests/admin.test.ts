import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adminSessionTtlMs, AuthService } from '../server/auth.js';
import { parseAdminUserIds } from '../server/admin.js';
import { createApiServer } from '../server/http.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

test('admin allowlist is server-side and rejects malformed entries', () => {
  assert.equal(parseAdminUserIds().size, 0);
  assert.deepEqual([...parseAdminUserIds(' alpha, beta,alpha ')], ['alpha', 'beta']);
  assert.throws(() => parseAdminUserIds('alpha,'), /ADMIN_USER_IDS/);
  assert.throws(() => parseAdminUserIds('operator@example.test'), /ADMIN_USER_IDS/);
});

test('admin HTTP isolates sessions and exposes paginated, redacted snapshots of actual business state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-admin-'));
  const store = new JsonStore(join(directory, 'fixture.json'));
  let now = Date.now();
  const auth = new AuthService(store, { now: () => now });
  const credentials = { email: 'operator@example.test', password: 'Synthetic26!' };
  const operator = await auth.register(credentials);
  const otherCredentials = { email: 'other@example.test', password: 'Synthetic27!' };
  const other = await auth.register(otherCredentials);
  const adminIds = new Set<string>();
  const service = new ResumeService(store);
  const server = createApiServer(service, { auth, adminUserIds: adminIds, secureCookies: true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(path: string, options: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {}) {
    const response = await fetch(base + path, {
      method: options.payload === undefined ? 'GET' : 'POST',
      headers: { ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  const operatorId = operator.session.user.id;
  const otherId = other.session.user.id;
  const userCookie = `youfang_session=${operator.token}`;
  assert.equal((await request('/admin/overview')).body.error.code, 'ADMIN_NOT_CONFIGURED');
  adminIds.add(operatorId);
  assert.equal((await request('/admin/overview')).status, 401);
  assert.equal((await request('/admin/overview', { cookie: userCookie })).status, 401);
  assert.equal((await request('/admin/users/search', { cookie: `youfang_admin=${operator.token}`, payload: {} })).status, 401);
  assert.equal((await request('/admin/login', { payload: credentials })).status, 403);
  await store.mutate(data => {
    data.users.find(user => user.id === operatorId)!.emailVerified = true;
    const target = data.users.find(user => user.id === otherId)!;
    target.emailVerified = true;
    target.phone = '13912345678';
    target.phoneVerified = true;
    for (let i = 0; i < 20; i++) data.users.push({
      id: randomUUID(), email: `paging${i}@example.test`, emailVerified: true,
      createdAt: new Date(now - 8 * 86400_000).toISOString(), wechatOpenid: `paging-fixture-${i}`,
    });
  });
  assert.equal((await request('/admin/login', { payload: otherCredentials })).status, 403);
  assert.equal((await request('/admin/login', { payload: { ...credentials, admin: true } })).status, 400);
  assert.equal((await request('/admin/login', { payload: credentials, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const signedIn = await request('/admin/login', { payload: credentials });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(Object.keys(signedIn.body.data), ['expiresAt']);
  assert.equal(Date.parse(signedIn.body.data.expiresAt) - now, adminSessionTtlMs);
  const header = signedIn.headers.get('set-cookie')!;
  assert.match(header, /^youfang_admin=[^;]+; Path=\/api\/v1\/admin; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
  const adminCookie = header.split(';')[0];
  const adminToken = adminCookie.slice('youfang_admin='.length);
  assert.equal((await request('/admin/overview', { headers: { Authorization: `Bearer ${adminToken}` } })).status, 401);
  assert.equal((await request('/auth/me', { cookie: `youfang_session=${adminToken}` })).status, 401);
  const legacyHash = createHash('sha256').update(adminToken).digest('hex');
  assert.ok((await store.read()).sessions.every(session => session.tokenHash !== legacyHash));
  const call = (path: string, payload?: unknown) => request(`/admin/${path}`, { cookie: adminCookie, payload });
  adminIds.add('replacement-admin');
  adminIds.delete(operatorId);
  assert.equal((await call('overview')).status, 403);
  adminIds.add(operatorId);

  const quota = new QuotaService(store);
  const iso = new Date(now - 10_000).toISOString();
  await quota.activateMembership({ userId: otherId, planId: 'premium', verifiedPaymentAt: iso, verifiedEventId: 'fixture-purchase', idempotencyKey: 'fixture-activation' });
  const privateText = '合成简历正文，只属于用户。项目经历：维护接口和测试记录。';
  const privateJD = '合成私密岗位描述';
  const owned = service.forUser(otherId);
  const resume = await owned.createResume({ title: '合成标题', targetRole: '开发', text: privateText });
  const inputHash = 'a'.repeat(64);
  const taskId = randomUUID();
  await store.mutate(data => data.analysisTasks.push({
    userId: otherId, inputHash, requestHash: inputHash, snapshot: resume,
    input: { resumeId: resume.id, jobDescription: privateJD }, engine: 'bailian', workflowVersion: 'rules-and-model-v1',
    job: { id: taskId, resumeId: resume.id, createdAt: iso, updatedAt: iso, status: 'failed',
      error: { code: 'MODEL_INVALID_OUTPUT', message: privateText } },
  }));
  await quota.reserve(otherId, taskId, inputHash, 1000);
  await quota.dispatch(otherId, taskId);
  await quota.finish(otherId, taskId);

  const before = await store.read();
  assert.deepEqual((await call('overview')).body.data,
    { users: 22, newUsers7Days: 2, activeMembers: 1, failedTasks: 1, pendingUsage: 1 });
  assert.equal((await call('users/search', {})).body.data.items.length, 20);
  assert.equal((await call('users/search', { page: 2 })).body.data.items.length, 2);
  assert.equal((await call('users/search', { query: 'other' })).body.data.total, 0);
  const lookup = await call('users/search', { query: 'OTHER@example.test' });
  const [user] = lookup.body.data.items;
  assert.equal(lookup.headers.get('cache-control'), 'no-store');
  assert.deepEqual(user.email, { masked: 'o***@e***', verified: true });
  assert.equal(user.phoneMasked, '139****5678');
  assert.equal(user.membership.latestEvent, 'purchase');
  assert.equal(user.workbench.features.companyJobs, true);
  assert.deepEqual(user.quota, await quota.current(otherId));
  assert.equal((await call('users/search', { query: '13912345678' })).body.data.items[0].id, otherId);
  assert.equal((await call('users/search', { page: 0 })).status, 400);
  assert.equal((await call('users/search', { userId: otherId })).status, 400);
  assert.equal((await call('users/search?query=other')).status, 400);

  const tasks = await call('tasks/search', { query: 'model_invalid_output', status: 'failed', usageStatus: 'pending' });
  assert.deepEqual(tasks.body.data.items, [{ id: taskId, userId: otherId, engine: 'bailian', status: 'failed', errorCode: 'MODEL_INVALID_OUTPUT',
    resumeRevision: 1, createdAt: iso, updatedAt: iso, usageStatus: 'pending' }]);
  for (const secret of [otherCredentials.email, '13912345678', privateText, privateJD, 'tokenHash', 'passwordHash', 'reservedTokens', 'inputHash']) {
    assert.ok(!JSON.stringify([lookup.body, tasks.body]).includes(secret));
  }
  assert.equal((await call('tasks/search', { usageStatus: 'unknown' })).status, 400);
  assert.equal((await call('tasks/search', { query: operatorId })).body.data.total, 0);
  assert.deepEqual(await store.read(), before, 'admin searches leave business records untouched');

  await owned.deleteResume(resume.id);
  const [orphan] = (await call('tasks/search', { usageStatus: 'pending' })).body.data.items;
  assert.equal(orphan.id, taskId);
  assert.equal(orphan.status, null);
  assert.equal(orphan.resumeRevision, null);
  assert.equal((await call('logout', {})).status, 200);
  assert.equal((await call('overview')).status, 401);
  assert.equal((await request('/auth/me', { cookie: userCookie })).status, 200);

  const again = await request('/admin/login', { payload: credentials });
  assert.equal(again.status, 200);
  now += adminSessionTtlMs;
  assert.equal((await request('/admin/overview', { cookie: again.headers.get('set-cookie')!.split(';')[0] })).status, 401);
});
