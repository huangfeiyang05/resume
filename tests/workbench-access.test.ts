import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { PaidPlanId } from '../shared/types.js';
import { workbenchFeatures } from '../shared/workbench.js';
import { CareerService } from '../server/career.js';
import { createApiServer } from '../server/http.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { assertWorkbenchFeature, getWorkbenchAccess } from '../server/workbench-access.js';

const syntheticJob = {
  company: '合成私人公司', title: '合成开发岗位', major: '计算机', location: '合成城市',
  description: '仅用于自动化测试的合成岗位，维护业务接口并核对需求。',
};
const syntheticResume = {
  title: '合成测试简历', targetRole: '开发工程师',
  text: '合成测试简历，不代表真实个人。\n项目经历\n整理业务需求，设计接口并与测试人员核对验收结果。',
};
const hiddenValue = '合成高级资料正文';
const hasCode = (code: string, status: number) => (error: unknown) => !!error && typeof error === 'object'
  && 'code' in error && error.code === code && 'status' in error && error.status === status;

class FailingReadStore extends JsonStore {
  readsBeforeFailure: number | null = null;
  override async read() {
    if (this.readsBeforeFailure !== null) {
      if (this.readsBeforeFailure === 0) throw new Error('Synthetic private ledger detail must never be returned.');
      this.readsBeforeFailure -= 1;
    }
    return super.read();
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-workbench-access-'));
  const store = new FailingReadStore(join(directory, 'database.json'));
  const catalogPath = join(directory, 'career-catalog.json');
  const server = createApiServer(new ResumeService(store), { careerCatalogPath: catalogPath });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(path: string, method = 'GET', input?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  }
  async function account(label: string) {
    const registered = await request('/auth/register', 'POST', { email: `${label}@example.test`, password: 'Synthetic26!' });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    return {
      userId: registered.body.data.user.id as string, cookie,
      request: (path: string, method = 'GET', input?: unknown) => request(path, method, input, cookie),
    };
  }
  async function grant(userId: string, planId: PaidPlanId, at = new Date()) {
    return new QuotaService(store).activateMembership({
      userId, planId, verifiedPaymentAt: at.toISOString(),
      verifiedEventId: `synthetic-${randomUUID()}`, idempotencyKey: randomUUID(),
    });
  }
  async function seedCatalogue() {
    const updatedAt = new Date().toISOString();
    await writeFile(catalogPath, JSON.stringify({ version: 2,
      jobs: [{ ...syntheticJob, id: 'synthetic-shared-job', origin: 'catalog', companyOverview: hiddenValue,
        sourceLabel: '合成资料来源', availability: 'open', updatedAt }],
      materials: [{ id: 'synthetic-material', title: '合成复习资料', major: '计算机', role: '开发', summary: hiddenValue,
        content: hiddenValue, sourceLabel: '合成资料来源', updatedAt }],
      portals: [{ id: 'synthetic-portal', organization: '合成招聘入口', majors: ['计算机'], audience: '合成应届生',
        description: hiddenValue, sourceUrl: 'https://example.test/careers', checkedAt: updatedAt }],
    }));
  }
  return { store, catalogPath, request, account, grant, seedCatalogue };
}

test('workbench access uses only the account effective server membership, including start and expiry boundaries', async t => {
  const f = await fixture(t);
  const startsAt = new Date('2026-01-10T00:00:00.000Z');
  const activation = await new QuotaService(f.store, () => startsAt).activateMembership({
    userId: 'synthetic-owner', planId: 'basic', verifiedPaymentAt: startsAt.toISOString(),
    verifiedEventId: 'synthetic-basic-event', idempotencyKey: 'synthetic-basic-key',
  });
  const before = await getWorkbenchAccess(f.store, 'synthetic-owner', new Date(startsAt.getTime() - 1));
  assert.equal(before.planId, 'free'); assert.equal(before.expiresAt, null);
  assert.ok(Object.values(before.features).every(value => value === false));
  const basic = await getWorkbenchAccess(f.store, 'synthetic-owner', startsAt);
  assert.equal(basic.planId, 'basic'); assert.equal(basic.expiresAt, activation.expiresAt);
  assert.deepEqual(workbenchFeatures.filter(feature => basic.features[feature]), ['resumeOptimization']);
  const expired = await getWorkbenchAccess(f.store, 'synthetic-owner', new Date(activation.expiresAt));
  assert.equal(expired.planId, 'free'); assert.equal(expired.expiresAt, null);
  const foreign = await getWorkbenchAccess(f.store, 'synthetic-other', startsAt);
  assert.equal(foreign.planId, 'free');
  await assert.rejects(assertWorkbenchFeature(f.store, 'synthetic-other', 'resumeOptimization', startsAt), hasCode('WORKBENCH_MEMBERSHIP_REQUIRED', 403));
  await assert.rejects(assertWorkbenchFeature(f.store, 'synthetic-owner', 'companyJobs', startsAt), error => {
    assert.ok(hasCode('WORKBENCH_MEMBERSHIP_REQUIRED', 403)(error));
    assert.match((error as Error).message, /公司岗位.*升级高级会员解锁/);
    return true;
  });
});

test('authenticated free, basic and premium workbench contracts cannot be upgraded by client claims', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/membership/workbench')).status, 401);
  const free = await f.account('workbench-free'), basic = await f.account('workbench-basic'), premium = await f.account('workbench-premium');
  await f.grant(basic.userId, 'basic'); await f.grant(premium.userId, 'premium');
  for (const [account, plan, allowed] of [[free, 'free', 0], [basic, 'basic', 1], [premium, 'premium', workbenchFeatures.length]] as const) {
    const result = await account.request('/membership/workbench');
    assert.equal(result.status, 200); assert.equal(result.body.data.planId, plan);
    assert.equal(Object.values(result.body.data.features).filter(Boolean).length, allowed);
    assert.deepEqual(Object.keys(result.body.data).sort(), ['expiresAt', 'features', 'planId']);
    assert.equal((await account.request('/membership/workbench', 'POST', { planId: 'premium' })).status, 405);
  }
  assert.equal((await free.request('/membership/workbench?planId=premium')).status, 400);
  const forged = await f.request('/membership/workbench', 'GET', undefined, free.cookie, { 'X-Membership': 'premium', 'X-User-Id': premium.userId });
  assert.equal(forged.body.data.planId, 'free');
  for (const account of [free, basic]) {
    for (const [path, method, input] of [
      ['/career/companies', 'GET', undefined], ['/career/companies/synthetic-company', 'GET', undefined],
      ['/career/assistant', 'POST', { message: '找岗位', requirements: '', membership: 'premium', userId: premium.userId }],
      ['/career/jobs', 'POST', { ...syntheticJob, membership: 'premium' }],
      ['/career/favorites/synthetic-job', 'PUT', { favorite: true }],
      ['/career/applications', 'POST', { planId: 'premium' }],
      ['/career/applications/synthetic-application', 'PUT', { revision: 1, note: '合成记录' }],
      ['/career/applications/synthetic-application', 'PATCH', { revision: 1, note: '合成记录' }],
    ] as const) {
      const denied = await account.request(path, method, input);
      assert.equal(denied.status, 403, `${path}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error.code, 'WORKBENCH_MEMBERSHIP_REQUIRED');
      assert.match(denied.body.error.message, /升级高级会员解锁/);
      assert.equal('data' in denied.body, false);
    }
  }
  const resume = await free.request('/resumes', 'POST', syntheticResume);
  assert.equal(resume.status, 201);
  assert.equal((await free.request('/analyses', 'POST', { resumeId: resume.body.data.id, resumeRevision: 1 })).status, 201, 'existing local rules remain available');
});

test('locked and expired workspaces disclose no shared or private content, while former members can delete their own history', async t => {
  const f = await fixture(t);
  await f.seedCatalogue();
  const free = await f.account('workbench-hidden-free'), basic = await f.account('workbench-hidden-basic');
  const expired = await f.account('workbench-expired'), premium = await f.account('workbench-data-premium');
  await f.grant(basic.userId, 'basic'); await f.grant(premium.userId, 'premium');
  await f.grant(expired.userId, 'premium', new Date(Date.now() - 90 * 24 * 3600_000));
  const career = new CareerService(f.store, expired.userId, f.catalogPath);
  const historicalJob = await career.createJob(syntheticJob);
  const historicalResume = await new ResumeService(f.store).forUser(expired.userId).createResume(syntheticResume);
  const historicalApplication = await career.createApplication({ jobId: historicalJob.id, resumeId: historicalResume.id,
    resumeRevision: historicalResume.revision, idempotencyKey: randomUUID() });
  await career.favorite(historicalJob.id, { favorite: true });
  for (const account of [free, basic, expired]) {
    const result = await account.request('/career?membership=premium');
    assert.equal(result.status, 200); assert.equal(result.body.data.catalogState, 'empty');
    assert.match(result.body.data.catalogMessage, /升级高级会员解锁/);
    for (const key of ['jobs', 'materials', 'portals', 'favoriteJobIds', 'applications']) assert.deepEqual(result.body.data[key], []);
    const payload = JSON.stringify(result.body);
    for (const privateValue of [hiddenValue, historicalJob.id, historicalApplication.id, historicalResume.text]) assert.equal(payload.includes(privateValue), false);
    assert.equal('total' in result.body.data, false); assert.equal('counters' in result.body.data, false);
  }
  const readable = await premium.request('/career');
  assert.equal(readable.body.data.catalogState, 'ready');
  assert.equal(readable.body.data.jobs.length, 1); assert.equal(readable.body.data.materials.length, 1); assert.deepEqual(readable.body.data.portals, []);
  assert.equal((await expired.request('/membership/workbench')).body.data.planId, 'free');
  assert.equal((await expired.request('/career/assistant', 'POST', { message: '找岗位', requirements: '' })).status, 403);
  assert.equal((await free.request(`/career/applications/${historicalApplication.id}`, 'DELETE', { revision: 1 })).status, 404);
  assert.equal((await free.request(`/career/jobs/${historicalJob.id}`, 'DELETE')).status, 404);
  assert.equal((await expired.request(`/career/jobs/${historicalJob.id}`, 'DELETE')).status, 409, 'deletion preserves application history checks after expiry');
  assert.equal((await expired.request(`/career/applications/${historicalApplication.id}`, 'DELETE', { revision: 1 })).status, 200);
  assert.equal((await expired.request(`/career/jobs/${historicalJob.id}`, 'DELETE')).status, 200);
  const database = await f.store.read();
  assert.equal(database.careerJobs.some(job => job.id === historicalJob.id), false);
  assert.equal(database.careerApplications.some(application => application.id === historicalApplication.id), false);
});

test('a membership lookup failure returns an unavailable error without granting or downgrading access', async t => {
  const f = await fixture(t), account = await f.account('workbench-unavailable');
  await f.grant(account.userId, 'premium');
  for (const path of ['/membership/workbench', '/career', '/career/companies']) {
    // Authentication still succeeds; only the subsequent membership lookup fails.
    f.store.readsBeforeFailure = 1;
    const result = await account.request(path);
    assert.equal(result.status, 503); assert.equal(result.body.error.code, 'WORKBENCH_ACCESS_UNAVAILABLE');
    assert.equal('data' in result.body, false);
    assert.equal(JSON.stringify(result.body).includes('Synthetic private ledger'), false);
    f.store.readsBeforeFailure = null;
  }
  assert.equal((await account.request('/membership/workbench')).body.data.planId, 'premium');
});
