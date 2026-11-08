// Command-line checks against compiled artifacts and an isolated temporary database.
// No real accounts, SMTP, SMS, model calls, production writes, browser or visual checks.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const releaseRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const load = file => import(pathToFileURL(join(releaseRoot, 'api/server', file)).href);
const [{ createApiServer }, { ResumeService }, { JsonStore }, { QuotaService }, { AuthService }, { PhoneCodeService }] = await Promise.all([load('http.js'), load('service.js'), load('store.js'), load('quota.js'), load('auth.js'), load('phone-codes.js')]);
const catalog = JSON.parse(await readFile(join(releaseRoot, 'api/server/assets/career/catalog.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'youfang-release-check-'));
const store = new JsonStore(join(directory, 'isolated.json'));
let fixtureTime = Date.now();
const smsMessages = [];
const phoneCodes = new PhoneCodeService(store, { enabled: true, async sendCode(input) { smsMessages.push(input); } }, { secret: 'release-fixture-sms-secret-more-than-32-bytes', now: () => fixtureTime });
const auth = new AuthService(store, { phoneCodes, now: () => fixtureTime, requireEmailVerification: false });
const adminIds = new Set();
const server = createApiServer(new ResumeService(store), { secureCookies: false, auth, adminUserIds: adminIds });
const checks = [];
try {
  // The existing server serves .js as JavaScript; .mjs can be octet-stream and blocked by nosniff.
  const assetNames = await readdir(join(releaseRoot, 'www/assets'));
  const pdfWorkers = assetNames.filter(name => /^pdf\.worker.*\.js$/.test(name));
  assert.equal(pdfWorkers.length, 1, 'PDF worker must be emitted as a JavaScript asset');
  assert.equal(assetNames.some(name => /^pdf\.worker.*\.mjs$/.test(name)), false);
  const scripts = await Promise.all(assetNames.filter(name => name.endsWith('.js') && !pdfWorkers.includes(name))
    .map(name => readFile(join(releaseRoot, 'www/assets', name), 'utf8')));
  assert.ok(scripts.some(script => script.includes(pdfWorkers[0])), 'PDF parser must reference the emitted worker');
  checks.push('pdf-worker-module-has-javascript-extension-and-reference');
  const adminPage = await readFile(join(releaseRoot, 'www/admin/index.html'), 'utf8');
  const adminScript = adminPage.match(/src="\/admin\/(assets\/[^"]+\.js)"/)?.[1];
  assert.ok(adminScript, 'Admin entry must load its own compiled script under /admin/');
  assert.ok((await readFile(join(releaseRoot, 'www/admin', adminScript), 'utf8')).includes('/api/v1/admin/'));
  checks.push('admin-static-entry-and-script');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(route, method = 'GET', input, cookie) {
    const response = await fetch(`${base}${route}`, {
      method, headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function account() {
    const credentials = { email: `deployment-${randomUUID()}@example.test`, password: 'Smoke26!Pass' };
    const result = await request('/auth/register', 'POST', credentials);
    assert.equal(result.status, 201);
    return { credentials, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  for (const path of ['/resumes', '/career', '/career/companies', '/membership', '/membership/quota', '/membership/workbench']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/career/assistant', 'POST', { requirements: '', message: '查找企业' })).status, 401);
  checks.push('private-routes-require-session');
  assert.equal((await request('/admin/overview')).body.error.code, 'ADMIN_NOT_CONFIGURED');
  checks.push('admin-disabled-without-allowlist');
  const operator = await account(), owner = operator.cookie, { cookie: other } = await account(), { cookie: quotaAccount } = await account();
  const preview = await request('/membership', 'GET', undefined, owner);
  assert.equal(preview.body.data.quota.status, 'preview');
  assert.equal(preview.body.data.quota.remainingPercent, null);
  const freeAccess = await request('/membership/workbench', 'GET', undefined, owner);
  assert.equal(freeAccess.body.data.planId, 'free');
  assert.ok(Object.values(freeAccess.body.data.features).every(value => value === false));
  const lockedWorkspace = await request('/career', 'GET', undefined, owner);
  for (const key of ['jobs', 'materials', 'portals', 'favoriteJobIds', 'applications']) assert.deepEqual(lockedWorkspace.body.data[key], []);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).status, 403);
  assert.equal((await request('/career/assistant', 'POST', { message: '查找企业', planId: 'premium' }, owner)).status, 403);
  const userId = (await request('/auth/me', 'GET', undefined, owner)).body.data.user.id;
  const quotaUserId = (await request('/auth/me', 'GET', undefined, quotaAccount)).body.data.user.id;
  const quota = new QuotaService(store);
  // Trusted synthetic events affect only this isolated database, never a provider or production account.
  for (const cookie of [owner, other, quotaAccount]) {
    const fixtureUserId = (await request('/auth/me', 'GET', undefined, cookie)).body.data.user.id;
    await quota.activateMembership({ userId: fixtureUserId, planId: cookie === quotaAccount ? 'basic' : 'premium', verifiedPaymentAt: new Date().toISOString(), verifiedEventId: `fixture-${randomUUID()}`, idempotencyKey: `fixture-${randomUUID()}` });
  }
  const basicAccess = (await request('/membership/workbench', 'GET', undefined, quotaAccount)).body.data;
  assert.equal(basicAccess.planId, 'basic');
  assert.equal(basicAccess.features.resumeOptimization, true);
  assert.equal(basicAccess.features.careerAssistant, false);
  assert.equal((await request('/career/companies', 'GET', undefined, quotaAccount)).status, 403);
  assert.deepEqual((await request('/career', 'GET', undefined, quotaAccount)).body.data.materials, []);
  const premiumAccess = (await request('/membership/workbench', 'GET', undefined, owner)).body.data;
  assert.equal(premiumAccess.planId, 'premium');
  assert.ok(Object.values(premiumAccess.features).every(value => value === true));
  checks.push('trusted-workbench-tiers-and-no-locked-content-leakage');
  const companies = await request('/career/companies', 'GET', undefined, owner);
  assert.equal(companies.status, 200);
  assert.equal(companies.body.data.access, 'authenticated-test');
  assert.equal(companies.body.data.catalogState, 'empty');
  assert.equal(companies.body.data.total, 0);
  assert.deepEqual(companies.body.data.items, []);
  assert.equal((await request('/career/companies?page=0', 'GET', undefined, owner)).status, 400);
  assert.equal((await request('/career/companies/missing-company', 'GET', undefined, owner)).status, 404);
  checks.push('premium-company-access-honest-empty-state-and-query-validation');
  const workspace = await request('/career', 'GET', undefined, owner);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.data.catalogState, 'ready');
  assert.ok(catalog.materials.length > 0 && catalog.portals.length > 0);
  assert.deepEqual(workspace.body.data.materials, catalog.materials);
  assert.deepEqual(workspace.body.data.portals, catalog.portals);
  assert.deepEqual(workspace.body.data.jobs, catalog.jobs);
  assert.equal(workspace.body.data.externalDeliveryAvailable, false);
  checks.push('bundled-materials-and-portals-separate-from-jobs');
  adminIds.add(userId);
  await store.mutate(data => { data.users.find(user => user.id === userId).emailVerified = true; });
  assert.equal((await request('/admin/career-content', 'GET', undefined, owner)).status, 401);
  const signedIn = await request('/admin/login', 'POST', operator.credentials);
  assert.equal(signedIn.status, 200);
  const admin = signedIn.headers.get('set-cookie').split(';')[0];
  const { id: materialId, updatedAt: _updatedAt, ...material } = catalog.materials[0];
  const contentPath = `/admin/career-content/material/${materialId}`;
  const currentContent = async () => (await request(contentPath, 'GET', undefined, admin)).body.data;
  const currentWorkspace = async () => (await request('/career', 'GET', undefined, owner)).body.data;
  const draft = { revision: (await currentContent()).revision, operationId: randomUUID(), content: { ...material, title: '合成发布验收提纲' } };
  assert.deepEqual((await request(`${contentPath}/draft`, 'POST', draft, admin)).body.data, { version: 1 });
  assert.deepEqual((await currentWorkspace()).materials, catalog.materials);
  async function releaseContent(action, sourceVersion) {
    const input = { action, sourceVersion, revision: (await currentContent()).revision };
    const review = await request(`${contentPath}/preview`, 'POST', input, admin);
    assert.equal(review.status, 200);
    const apply = { ...input, token: review.body.data.token, confirmed: true, operationId: randomUUID() };
    const result = await request(`${contentPath}/apply`, 'POST', apply, admin);
    assert.equal(result.status, 200);
    assert.deepEqual((await request(`${contentPath}/apply`, 'POST', apply, admin)).body.data, result.body.data);
  }
  await releaseContent('publish');
  assert.equal((await currentWorkspace()).materials.find(item => item.id === materialId).title, draft.content.title);
  assert.deepEqual((await request('/career', 'GET', undefined, quotaAccount)).body.data.materials, []);
  await releaseContent('restore', 0);
  assert.deepEqual((await currentWorkspace()).materials, catalog.materials);
  assert.deepEqual((await currentContent()).history.map(entry => entry.action), ['restore', 'publish', 'draft']);
  checks.push('admin-reviewed-content-release-idempotent-restore-and-member-visibility');
  const created = await request('/resumes', 'POST', {
    title: '合成部署验收简历', targetRole: '合成测试岗位',
    text: '合成部署验收内容，不对应真实个人。\n项目经历\n整理测试需求与接口约定，核对实际交付并记录验收依据。',
  }, owner);
  assert.equal(created.status, 201);
  const original = created.body.data, path = `/resumes/${original.id}`;
  const assistantInput = { resumeId: original.id, resumeRevision: 1, requirements: '杭州', message: '优化简历' };
  const assistant = await request('/career/assistant', 'POST', assistantInput, owner);
  assert.equal(assistant.status, 200);
  assert.equal(assistant.body.data.engine, 'local-rules');
  assert.equal(assistant.body.data.resume.revision, 1);
  assert.equal(assistant.body.data.action.type, 'analyze-resume');
  assert.equal(assistant.body.data.catalogState, 'empty');
  assert.deepEqual(assistant.body.data.companies, []);
  assert.deepEqual((await request(path, 'GET', undefined, owner)).body.data, original);
  assert.equal((await request('/career/assistant', 'POST', assistantInput, other)).status, 404);
  assert.equal((await request(path, 'PUT', { title: '缺少版本' }, owner)).status, 400);
  assert.equal((await request(path, 'PUT', { title: '合成编辑版本', revision: 1 }, owner)).status, 200);
  assert.equal((await request('/career/assistant', 'POST', assistantInput, owner)).status, 409);
  assert.equal((await request('/analyses', 'POST', { resumeId: original.id, resumeRevision: 1 }, owner)).status, 409);
  checks.push('local-assistant-owned-resume-no-mutation-and-revision-guard');
  assert.equal((await request(path, 'PUT', { title: '过期请求', revision: 1 }, owner)).status, 409);
  assert.equal((await request(`${path}/versions`, 'GET', undefined, other)).status, 404);
  const restore = { revision: 2, confirmed: true, idempotencyKey: `deploy-${randomUUID()}` };
  assert.equal((await request(`${path}/versions/1/restore`, 'POST', { ...restore, confirmed: false }, owner)).status, 400);
  assert.equal((await request(`${path}/versions/1/restore`, 'POST', restore, other)).status, 404);
  const restored = await request(`${path}/versions/1/restore`, 'POST', restore, owner);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.resume.revision, 3);
  assert.equal(restored.body.data.resume.text, original.text);
  assert.equal(restored.body.data.resume.title, original.title);
  const repeated = await request(`${path}/versions/1/restore`, 'POST', restore, owner);
  assert.equal(repeated.body.data.alreadyRestored, true);
  assert.equal(repeated.body.data.resume.revision, 3);
  assert.deepEqual((await request(`${path}/versions`, 'GET', undefined, owner)).body.data.map(item => item.revision), [3, 2, 1]);
  checks.push('revision-conflicts-private-history-and-idempotent-restoration');
  // Synthetic trusted events test compiled ledger behavior only; no real membership or provider request.
  await quota.reserve(quotaUserId, 'release-quota-fixture', 'a'.repeat(64), 50000);
  await quota.dispatch(quotaUserId, 'release-quota-fixture');
  await quota.settle(quotaUserId, 'release-quota-fixture', { inputTokens: 30000, outputTokens: 10000, totalTokens: 40000 });
  const summary = (await request('/membership/quota', 'GET', undefined, quotaAccount)).body.data;
  assert.equal(summary.remainingPercent, 80);
  assert.deepEqual(Object.keys(summary).sort(), ['expiresAt', 'pending', 'remainingPercent', 'resetsAt', 'status']);
  assert.equal((await request('/membership/quota', 'GET', undefined, other)).body.data.remainingPercent, 100);
  assert.equal((await request('/analyses', 'POST', { resumeId: original.id, resumeRevision: 3 }, owner)).status, 201);
  assert.equal((await request('/membership/quota', 'GET', undefined, owner)).body.data.remainingPercent, 100);
  assert.equal((await new QuotaService(new JsonStore(store.path)).current(quotaUserId)).remainingPercent, 80);
  checks.push('percentage-only-private-quota-actual-token-ledger-reload-and-free-rules');
  const phoneChallenge = await request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'bind-phone' }, owner);
  assert.equal(phoneChallenge.status, 202);
  const phoneBound = await request('/auth/phone/bind', 'POST', { phone: '13900000001', code: smsMessages[0].code, challengeId: phoneChallenge.body.data.challengeId, currentPassword: 'Smoke26!Pass' }, owner);
  assert.equal(phoneBound.status, 200); assert.equal(phoneBound.body.data.id, userId);
  fixtureTime += 61000;
  const loginChallenge = await request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'login' });
  const phoneLogin = await request('/auth/phone', 'POST', { phone: '13900000001', code: smsMessages[1].code, challengeId: loginChallenge.body.data.challengeId });
  assert.equal(phoneLogin.status, 200); assert.equal(phoneLogin.body.data.user.id, userId); assert.equal(phoneLogin.body.data.token, undefined);
  const phoneCookie = phoneLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(path, 'GET', undefined, phoneCookie)).body.data.id, original.id);
  const newPhoneChallenge = await request('/auth/phone/code', 'POST', { phone: '13900000002', purpose: 'login' });
  const phoneOnly = await request('/auth/phone', 'POST', { phone: '13900000002', code: smsMessages[2].code, challengeId: newPhoneChallenge.body.data.challengeId });
  assert.equal(phoneOnly.status, 200); assert.equal(phoneOnly.body.data.user.email, undefined); assert.equal(phoneOnly.body.data.user.phoneVerified, true);
  assert.ok((await new JsonStore(store.path).read()).users.some(user => user.id === phoneOnly.body.data.user.id && !user.email));
  checks.push('synthetic-sms-phone-registration-binding-same-account-and-phone-only-storage');
  assert.equal((await request(path, 'DELETE', undefined, owner)).status, 200);
  assert.equal((await request(`${path}/versions`, 'GET', undefined, owner)).status, 404);
  for (const cookie of [owner, other, quotaAccount]) assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 200);
  checks.push('deletion-cleans-history-and-sessions-can-logout');
  console.log(JSON.stringify({ passed: true, checks, isolatedDatabase: true, realEmailsSent: 0, realSmsSent: 0, modelCalls: 0, visualVerification: false, weixinDeviceVerification: false }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
