// Command-line checks against compiled artifacts and an isolated temporary database.
// No real accounts, SMTP, model calls, production writes, browser or visual checks.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const releaseRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const load = file => import(pathToFileURL(join(releaseRoot, 'api/server', file)).href);
const [{ createApiServer }, { ResumeService }, { JsonStore }] = await Promise.all([load('http.js'), load('service.js'), load('store.js')]);
const catalog = JSON.parse(await readFile(join(releaseRoot, 'api/server/assets/career/catalog.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'youfang-release-check-'));
const server = createApiServer(new ResumeService(new JsonStore(join(directory, 'isolated.json'))), { secureCookies: false });
const checks = [];
try {
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
    const result = await request('/auth/register', 'POST', { email: `deployment-${randomUUID()}@example.test`, password: 'Smoke26!Pass' });
    assert.equal(result.status, 201);
    return result.headers.get('set-cookie').split(';')[0];
  }
  for (const path of ['/resumes', '/career', '/career/companies']) assert.equal((await request(path)).status, 401);
  checks.push('private-routes-require-session');
  const owner = await account(), other = await account();
  const companies = await request('/career/companies', 'GET', undefined, owner);
  assert.equal(companies.status, 200);
  assert.equal(companies.body.data.access, 'authenticated-test');
  assert.equal(companies.body.data.catalogState, 'empty');
  assert.equal(companies.body.data.total, 0);
  assert.deepEqual(companies.body.data.items, []);
  assert.equal((await request('/career/companies?page=0', 'GET', undefined, owner)).status, 400);
  assert.equal((await request('/career/companies/missing-company', 'GET', undefined, owner)).status, 404);
  checks.push('shared-company-test-access-honest-empty-state-and-query-validation');
  const workspace = await request('/career', 'GET', undefined, owner);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.data.catalogState, 'ready');
  assert.ok(catalog.materials.length > 0 && catalog.portals.length > 0);
  assert.deepEqual(workspace.body.data.materials, catalog.materials);
  assert.deepEqual(workspace.body.data.portals, catalog.portals);
  assert.deepEqual(workspace.body.data.jobs, catalog.jobs);
  assert.equal(workspace.body.data.externalDeliveryAvailable, false);
  checks.push('bundled-materials-and-portals-separate-from-jobs');
  const created = await request('/resumes', 'POST', {
    title: '合成部署验收简历', targetRole: '合成测试岗位',
    text: '合成部署验收内容，不对应真实个人。\n项目经历\n整理测试需求与接口约定，核对实际交付并记录验收依据。',
  }, owner);
  assert.equal(created.status, 201);
  const original = created.body.data, path = `/resumes/${original.id}`;
  assert.equal((await request(path, 'PUT', { title: '缺少版本' }, owner)).status, 400);
  assert.equal((await request(path, 'PUT', { title: '合成编辑版本', revision: 1 }, owner)).status, 200);
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
  assert.equal((await request(path, 'DELETE', undefined, owner)).status, 200);
  assert.equal((await request(`${path}/versions`, 'GET', undefined, owner)).status, 404);
  for (const cookie of [owner, other]) assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 200);
  checks.push('deletion-cleans-history-and-sessions-can-logout');
  console.log(JSON.stringify({ passed: true, checks, isolatedDatabase: true, realEmailsSent: 0, modelCalls: 0, visualVerification: false, weixinDeviceVerification: false }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
