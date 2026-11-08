import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../server/auth.js';
import { CareerService } from '../server/career.js';
import { createApiServer } from '../server/http.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const existingMaterial = {
  id: 'sample-guide', title: '原目录提纲', major: '计算机与软件', role: '', summary: '', content: '旧版正文。',
  sourceLabel: '项目原创', updatedAt: '2026-10-27T10:00:00+08:00',
};
const sampleJob = {
  id: 'sample-job', origin: 'catalog', company: '合成企业', title: '合成岗位', major: '计算机与软件', location: '合成地区',
  description: '用于验证现有岗位目录未被内容发布改动。', companyOverview: '', sourceLabel: '合成测试', availability: 'closed',
  updatedAt: '2026-10-27T10:00:00+08:00',
};
const { id: _id, updatedAt: _updatedAt, ...editableMaterial } = existingMaterial;

test('admin drafts, reviewed releases and restores are atomic, auditable and visible only to eligible workbench users', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-career-content-'));
  const databasePath = join(directory, 'db.json');
  const catalogPath = join(directory, 'catalog.json');
  const base = JSON.stringify({ version: 2, materials: [existingMaterial], portals: [], jobs: [sampleJob] });
  await writeFile(catalogPath, base);
  const store = new JsonStore(databasePath);
  const auth = new AuthService(store);
  const credentials = { email: 'content-operator@example.test', password: 'Synthetic26!' };
  const operator = await auth.register(credentials);
  const subscriber = await auth.register({ email: 'content-reader@example.test', password: 'Synthetic26!' });
  const operatorId = operator.session.user.id, subscriberId = subscriber.session.user.id;
  await store.mutate(data => { data.users.find(user => user.id === operatorId)!.emailVerified = true; });
  await new QuotaService(store).activateMembership({
    userId: subscriberId, planId: 'premium', verifiedPaymentAt: new Date(Date.now() - 1000).toISOString(),
    verifiedEventId: 'fixture-content-member', idempotencyKey: 'fixture-content-activation',
  });
  const server = createApiServer(new ResumeService(store), { auth, adminUserIds: new Set([operatorId]), careerCatalogPath: catalogPath });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(route: string, cookie?: string, input?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(origin + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  const operatorNormal = `youfang_session=${operator.token}`, reader = `youfang_session=${subscriber.token}`;
  const signedIn = await request('/admin/login', undefined, credentials);
  assert.equal(signedIn.status, 200);
  const admin = signedIn.cookie!;
  const content = '/admin/career-content';
  const material = `${content}/material/${existingMaterial.id}`;
  const inspect = async (route = material) => (await request(route, admin)).body.data;
  const workbench = async (cookie = reader) => (await request('/career', cookie)).body.data;
  const write = (route: string, input: unknown) => request(route, admin, input);
  const newDraft = (revision: string | null, content: object) => ({ revision, content, operationId: randomUUID() });
  const preview = async (route: string, input: object) => {
    const result = await write(`${route}/preview`, input);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { ...input, token: result.body.data.token, operationId: randomUUID(), confirmed: true };
  };

  assert.equal((await request(content)).status, 401);
  assert.equal((await request(material, operatorNormal)).status, 401);
  assert.equal((await request(`${material}/draft`, reader, {})).status, 401);
  assert.equal((await request(`${material}/apply`, admin, {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request(`${material}/draft`, admin, {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.deepEqual((await workbench()).materials, [existingMaterial]);

  const initial = await inspect();
  const draft = newDraft(initial.revision, { ...editableMaterial, title: '第一次草稿' });
  assert.equal((await write(`${material}/draft`, { ...draft, actorId: subscriberId })).status, 400);
  assert.equal((await write(`${material}/draft`, draft)).body.data.version, 1);
  assert.equal((await write(`${material}/draft`, draft)).body.data.version, 1);
  assert.equal((await write(`${material}/draft`, { ...draft, content: editableMaterial })).body.error.code, 'CAREER_CONTENT_OPERATION_CONFLICT');
  assert.equal((await write(`${material}/draft`, newDraft(initial.revision, editableMaterial))).body.error.code, 'CAREER_CONTENT_CONFLICT');
  assert.deepEqual((await workbench()).materials, [existingMaterial]);

  const firstPreview = await preview(material, { revision: (await inspect()).revision, action: 'publish' });
  const newEdit = newDraft((await inspect()).revision, { ...editableMaterial, title: '已审核新标题', content: '新稿仅在确认发布后展示。' });
  assert.equal((await write(`${material}/draft`, newEdit)).status, 200);
  assert.equal((await write(`${material}/apply`, firstPreview)).body.error.code, 'CAREER_CONTENT_CONFLICT');
  const reviewed = await preview(material, { revision: (await inspect()).revision, action: 'publish' });
  assert.equal((await write(`${material}/apply`, { ...reviewed, confirmed: false })).status, 400);
  assert.equal((await write(`${material}/apply`, { ...reviewed, token: '0'.repeat(64) })).body.error.code, 'CAREER_CONTENT_REVIEW_CHANGED');
  const duplicate = await Promise.all([write(`${material}/apply`, reviewed), write(`${material}/apply`, reviewed)]);
  for (const result of duplicate) assert.deepEqual(result.body.data, { version: 3 });
  const afterPublish = await workbench();
  assert.equal(afterPublish.materials[0].title, '已审核新标题');
  assert.deepEqual(afterPublish.jobs, [sampleJob]);
  assert.deepEqual((await workbench(operatorNormal)).materials, []);
  assert.equal((await inspect()).draft, null);

  const withdrawal = await preview(material, { revision: (await inspect()).revision, action: 'withdraw' });
  assert.equal((await write(`${material}/apply`, withdrawal)).body.data.version, 4);
  assert.deepEqual((await workbench()).materials, []);
  const restorePublished = await preview(material, { revision: (await inspect()).revision, action: 'restore', sourceVersion: 3 });
  assert.equal((await write(`${material}/apply`, restorePublished)).body.data.version, 5);
  assert.deepEqual((await workbench()).materials, afterPublish.materials);
  const restoreBaseline = await preview(material, { revision: (await inspect()).revision, action: 'restore', sourceVersion: 0 });
  assert.equal((await write(`${material}/apply`, restoreBaseline)).body.data.version, 6);
  assert.deepEqual((await workbench()).materials, [existingMaterial]);
  const history = (await inspect()).history;
  assert.deepEqual(history.map((entry: { action: string }) => entry.action), ['restore', 'restore', 'withdraw', 'publish', 'draft', 'draft']);
  assert.equal(history[0].sourceVersion, 0);
  assert.ok(history.every((entry: { actorId: string; at: string }) => entry.actorId === operatorId && Number.isFinite(Date.parse(entry.at))));
  assert.equal(Object.hasOwn(history[0], 'requestHash'), false);

  const portal = `${content}/portal/admin-${randomUUID()}`;
  const portalData = { organization: '合成机构', majors: ['计算机与软件'], audience: '应届生',
    description: '合成测试渠道，仅用于验证入口发布。', sourceUrl: 'https://example.test/careers', checkedAt: '2025-10-01T00:00:00+08:00' };
  assert.equal((await write(`${portal}/draft`, newDraft(null, { ...portalData, sourceUrl: 'http://example.test' }))).status, 400);
  assert.equal((await write(`${portal}/draft`, newDraft(null, { ...portalData, checkedAt: '2099-10-01T00:00:00+08:00' }))).status, 400);
  assert.equal((await write(`${portal}/draft`, newDraft(null, { ...portalData, availability: 'open' }))).status, 400);
  assert.equal((await write(`${portal}/draft`, newDraft(null, portalData))).status, 200);
  assert.deepEqual((await workbench()).portals, []);
  const portalRelease = await preview(portal, { revision: (await inspect(portal)).revision, action: 'publish' });
  assert.equal((await write(`${portal}/apply`, portalRelease)).status, 200);
  assert.equal((await workbench()).portals[0].organization, portalData.organization);
  assert.deepEqual((await workbench()).jobs, [sampleJob]);
  assert.equal(await readFile(catalogPath, 'utf8'), base, 'managed changes must leave the base catalog file untouched');

  const reloaded = new CareerService(new JsonStore(databasePath), subscriberId, catalogPath);
  assert.deepEqual((await reloaded.workspace()).materials, [existingMaterial]);
  assert.equal((await reloaded.workspace()).portals[0].organization, portalData.organization);
  const persisted = await new JsonStore(databasePath).read();
  assert.equal(persisted.careerContent[0].changes.length, 6);

  await writeFile(catalogPath, '{invalid');
  assert.equal((await request(content, admin)).body.error.code, 'CAREER_CATALOG_UNAVAILABLE');
  assert.equal((await workbench()).catalogState, 'unavailable');
});
