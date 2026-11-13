import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ApplicationCreateInput, CareerApplication, CareerJob, CareerMaterial, PaidPlanId, Resume } from '../shared/types.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { QuotaService } from '../server/quota.js';

const resumeText = '合成测试简历，不代表真实个人。\n项目经历\n围绕明确业务问题整理需求，设计接口并与测试人员核对验收结果。';
const personalJob = {
  company: '合成测试公司', title: '业务系统开发', major: '计算机', location: '合成测试城市',
  description: '合成测试岗位资料：维护业务接口，整理需求，与测试人员核对验收结果。',
};

async function fixture(t: TestContext, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-career-'));
  const path = join(directory, 'database.json');
  const catalogPath = join(directory, 'career-catalog.json');
  if (legacy) await writeFile(path, JSON.stringify({ version: 3, users: [], sessions: [], emailChallenges: [], resumes: [], analyses: [] }));
  let store = new JsonStore(path);
  let server = createApiServer(new ResumeService(store), { careerCatalogPath: catalogPath });
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
  const request = async (route: string, method = 'GET', data?: unknown, cookie?: string) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const register = async (label: string, planId: PaidPlanId | null = 'premium') => {
    const result = await request('/auth/register', 'POST', { email: `${label}@example.test`, password: 'Fixture-pw-26!' });
    assert.equal(result.status, 201);
    if (planId) await new QuotaService(store).activateMembership({
      userId: result.body.data.user.id, planId, verifiedPaymentAt: new Date().toISOString(),
      verifiedEventId: `synthetic-event-${label}`, idempotencyKey: `synthetic-member-${label}`,
    });
    const cookie = result.headers.get('set-cookie')!.split(';')[0];
    return (route: string, method = 'GET', data?: unknown) => request(route, method, data, cookie);
  };
  const catalog = (jobs: CareerJob[] = [], materials: CareerMaterial[] = []) => writeFile(catalogPath, JSON.stringify({ version: 1, jobs, materials }));
  return {
    request, register, path, directory, catalogPath, catalog,
    async restart() {
      await close();
      store = new JsonStore(path);
      server = createApiServer(new ResumeService(store), { careerCatalogPath: catalogPath });
      await start();
    },
  };
}

type UserRequest = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['register']>>;

function error(result: { status: number; body: any }, code: string, status?: number) {
  if (status !== undefined) assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error?.code, code, JSON.stringify(result.body));
}

async function createResume(request: UserRequest, text = resumeText): Promise<Resume> {
  const result = await request('/resumes', 'POST', { title: '合成测试简历', targetRole: personalJob.title, text });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

async function createJob(request: UserRequest): Promise<CareerJob> {
  const result = await request('/career/jobs', 'POST', personalJob);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

function createInput(job: CareerJob, resume: Resume): ApplicationCreateInput {
  return { jobId: job.id, resumeId: resume.id, resumeRevision: resume.revision, idempotencyKey: randomUUID() };
}

async function createApplication(request: UserRequest, job: CareerJob, resume: Resume): Promise<CareerApplication> {
  const result = await request('/career/applications', 'POST', createInput(job, resume));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

function catalogJob(overrides: Partial<CareerJob> = {}): CareerJob {
  return {
    id: 'synthetic-catalog-job', origin: 'catalog', ...personalJob, companyOverview: '仅供自动化测试的公司介绍。',
    sourceLabel: '合成测试来源', sourceUrl: 'https://example.test/jobs/synthetic',
    availability: 'open', deadline: '2099-12-31', updatedAt: '2026-10-25T00:00:00.000Z', ...overrides,
  };
}

test('career requires a session and an empty catalogue never fabricates jobs, materials or a paid membership', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.request('/career')).status, 401);
  const request = await f.register('career-empty', null);
  const result = await request('/career');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.mode, 'preview');
  assert.equal(result.body.data.externalDeliveryAvailable, false);
  assert.equal(result.body.data.catalogState, 'empty');
  for (const key of ['jobs', 'materials', 'favoriteJobIds', 'applications']) assert.deepEqual(result.body.data[key], []);
  assert.equal((await request('/membership')).body.data.currentPlanId, 'free');
  assert.equal((await request('/career', 'POST', {})).status, 405);
  await f.restart();
  assert.equal((await request('/career')).body.data.catalogState, 'empty', 'an old v3 database must remain readable after restart');
});

test('personal jobs and idempotent favourites persist without leaking to another user', async t => {
  const f = await fixture(t);
  const a = await f.register('career-owner'), b = await f.register('career-other');
  const job = await createJob(a);
  assert.equal(job.origin, 'personal');
  assert.equal(job.company, personalJob.company);
  assert.equal('userId' in job, false);
  assert.deepEqual((await b('/career')).body.data.jobs, []);
  for (let i = 0; i < 2; ++i) {
    const result = await a(`/career/favorites/${job.id}`, 'PUT', { favorite: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, { jobId: job.id, favorite: true });
  }
  assert.deepEqual((await a('/career')).body.data.favoriteJobIds, [job.id]);
  assert.equal((await b(`/career/favorites/${job.id}`, 'PUT', { favorite: true })).status, 404);
  assert.equal((await b(`/career/jobs/${job.id}`, 'DELETE')).status, 404);
  await f.restart();
  assert.deepEqual((await a('/career')).body.data.favoriteJobIds, [job.id]);
  assert.equal((await a('/career')).body.data.jobs[0].id, job.id);
  await a(`/career/favorites/${job.id}`, 'PUT', { favorite: false });
  assert.deepEqual((await a('/career')).body.data.favoriteJobIds, []);
  assert.equal((await a(`/career/jobs/${job.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await a('/career')).body.data.jobs, []);
});

test('career validates client inputs rather than accepting membership, owner or snapshot assertions', async t => {
  const f = await fixture(t);
  const request = await f.register('career-validation');
  const resume = await createResume(request), job = await createJob(request);
  for (const input of [
    null, [], {}, { ...personalJob, userId: 'other' }, { ...personalJob, origin: 'catalog' },
    { ...personalJob, sourceUrl: 'javascript:alert(1)' }, { ...personalJob, sourceUrl: 'data:text/html,hello' },
    { ...personalJob, deadline: '2026-02-31' }, { ...personalJob, title: 'x'.repeat(1001) },
    { ...personalJob, company: '' }, { ...personalJob, description: 42 },
  ]) assert.equal((await request('/career/jobs', 'POST', input)).status, 400);
  const input = createInput(job, resume);
  for (const body of [
    { ...input, userId: 'other' }, { ...input, resumeSnapshot: resume }, { ...input, status: 'applied' },
    { ...input, planId: 'premium' }, { ...input, resumeRevision: 0 }, { ...input, resumeRevision: 1.5 },
    { ...input, idempotencyKey: '' }, { ...input, resumeHash: 'forged' },
  ]) assert.equal((await request('/career/applications', 'POST', body)).status, 400);
  for (const body of [{ favorite: 'true' }, { favorite: true, userId: 'other' }, {}]) {
    assert.equal((await request(`/career/favorites/${job.id}`, 'PUT', body)).status, 400);
  }
  assert.deepEqual((await request('/career')).body.data.applications, []);
});

test('application creation binds server snapshots and repeats deterministically through concurrent requests and restart', async t => {
  const f = await fixture(t);
  const request = await f.register('career-create');
  const resume = await createResume(request), job = await createJob(request);
  const input = createInput(job, resume);
  const results = await Promise.all([request('/career/applications', 'POST', input), request('/career/applications', 'POST', input)]);
  assert.ok(results.every(result => result.status === 201), JSON.stringify(results));
  const application: CareerApplication = results[0].body.data;
  assert.deepEqual(results[1].body.data, application);
  assert.deepEqual(application.resumeSnapshot, resume);
  assert.deepEqual(application.jobSnapshot, job);
  assert.match(application.resumeHash, /^[a-f0-9]{64}$/);
  assert.equal(application.status, 'planned');
  assert.equal(application.submissionMode, 'manual');
  assert.deepEqual(application.history.map(event => [event.status, event.source]), [['planned', 'user']]);
  assert.equal('userId' in application, false);
  const otherResume = await createResume(request, `${resumeText}\n这是另一个已保存的合成简历版本。`);
  error(await request('/career/applications', 'POST', { ...input, resumeId: otherResume.id }), 'IDEMPOTENCY_CONFLICT', 409);
  error(await request('/career/applications', 'POST', { ...input, idempotencyKey: randomUUID() }), 'APPLICATION_EXISTS', 409);
  await f.restart();
  assert.deepEqual((await request('/career/applications', 'POST', input)).body.data, application);
  assert.equal((await request('/career')).body.data.applications.length, 1);
  assert.equal((await request(`/career/jobs/${job.id}`, 'DELETE')).status, 409, 'deleting a job must not silently discard its application history');
});

test('application states require manual confirmation, optimistic locking and valid transitions', async t => {
  const f = await fixture(t);
  const request = await f.register('career-status');
  const resume = await createResume(request), job = await createJob(request);
  let application = await createApplication(request, job, resume);
  const route = `/career/applications/${application.id}`;
  error(await request(route, 'PATCH', { revision: application.revision, status: 'applied' }), 'CONFIRMATION_REQUIRED', 400);
  error(await request(route, 'PATCH', { revision: application.revision, status: 'offer' }), 'INVALID_TRANSITION', 409);
  assert.equal((await request(route, 'PATCH', { revision: application.revision, status: 'invented' })).status, 400);
  assert.equal((await request(route, 'PATCH', { revision: application.revision, note: 'x'.repeat(2001) })).status, 400);
  const plannedRevision = application.revision;
  const applied = await request(route, 'PUT', { revision: plannedRevision, status: 'applied', confirmedManualSubmission: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  application = applied.body.data;
  assert.equal(application.status, 'applied');
  assert.equal(application.revision, plannedRevision + 1);
  assert.equal(application.history.length, 2);
  error(await request(route, 'PATCH', { revision: plannedRevision, note: '过期编辑不能覆盖后续状态。' }), 'REVISION_CONFLICT', 409);
  const noChange = await request(route, 'PATCH', { revision: application.revision, status: 'applied', confirmedManualSubmission: true });
  assert.equal(noChange.status, 200);
  assert.equal(noChange.body.data.history.length, 2, 're-reporting the same state must not append duplicate events');
  assert.equal(noChange.body.data.revision, application.revision);
  const anotherResume = await createResume(request, `${resumeText}\n另一份待审核简历。`);
  assert.equal((await request(route, 'PATCH', { revision: application.revision, resumeId: anotherResume.id, resumeRevision: anotherResume.revision })).status, 409, 'an already-submitted snapshot must remain immutable');
  for (const status of ['interview', 'offer', 'withdrawn']) {
    const result = await request(route, 'PATCH', { revision: application.revision, status });
    assert.equal(result.status, 200, JSON.stringify(result.body)); application = result.body.data;
  }
  error(await request(route, 'PATCH', { revision: application.revision, status: 'planned' }), 'INVALID_TRANSITION', 409);
  assert.ok(application.history.every(event => event.source === 'user'));
  assert.deepEqual(application.resumeSnapshot, resume);
});

test('a changed resume cannot be recorded as submitted until a current snapshot is reviewed and rebound', async t => {
  const f = await fixture(t);
  const request = await f.register('career-rebind');
  const resume = await createResume(request), job = await createJob(request);
  let application = await createApplication(request, job, resume);
  const route = `/career/applications/${application.id}`;
  const oldHash = application.resumeHash;
  const update = await request(`/resumes/${resume.id}`, 'PUT', { text: `${resumeText}\n新增真实信息由用户确认。`, revision: resume.revision });
  assert.equal(update.status, 200);
  const current: Resume = update.body.data;
  error(await request(route, 'PATCH', { revision: application.revision, status: 'applied', confirmedManualSubmission: true }), 'SOURCE_CONFLICT', 409);
  error(await request('/career/applications', 'POST', { ...createInput(job, current), resumeRevision: resume.revision }), 'REVISION_CONFLICT', 409);
  assert.equal((await request(route, 'PATCH', { revision: application.revision, resumeId: current.id })).status, 400);
  error(await request(route, 'PATCH', { revision: application.revision, resumeId: current.id, resumeRevision: current.revision, status: 'applied', confirmedManualSubmission: true }), 'INVALID_TRANSITION', 409);
  const rebound = await request(route, 'PUT', { revision: application.revision, resumeId: current.id, resumeRevision: current.revision });
  assert.equal(rebound.status, 200, JSON.stringify(rebound.body)); application = rebound.body.data;
  assert.deepEqual(application.resumeSnapshot, current);
  assert.notEqual(application.resumeHash, oldHash);
  const applied = await request(route, 'PUT', { revision: application.revision, status: 'applied', confirmedManualSubmission: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.data.resumeSnapshot.revision, current.revision);
});

test('unresolved factual placeholders prevent reporting a submitted application', async t => {
  const f = await fixture(t);
  const request = await f.register('career-facts');
  const resume = await createResume(request, `${resumeText}\n[请填写真实项目成果]`), job = await createJob(request);
  const application = await createApplication(request, job, resume);
  error(await request(`/career/applications/${application.id}`, 'PATCH', { revision: application.revision, status: 'applied', confirmedManualSubmission: true }), 'PLACEHOLDERS_UNRESOLVED', 400);
  assert.equal((await request('/career')).body.data.applications[0].status, 'planned');
});

test('sessions isolate jobs, favourites, resume bindings and application mutations', async t => {
  const f = await fixture(t);
  const a = await f.register('career-scope-a'), b = await f.register('career-scope-b');
  const resumeA = await createResume(a), jobA = await createJob(a);
  const resumeB = await createResume(b), jobB = await createJob(b);
  const applicationA = await createApplication(a, jobA, resumeA);
  assert.equal((await a('/career/applications', 'POST', createInput(jobA, resumeB))).status, 404);
  assert.equal((await b('/career/applications', 'POST', createInput(jobA, resumeB))).status, 404);
  assert.equal((await b(`/career/favorites/${jobA.id}`, 'PUT', { favorite: true })).status, 404);
  assert.equal((await b(`/career/applications/${applicationA.id}`, 'PATCH', { revision: applicationA.revision, note: '越权编辑' })).status, 404);
  assert.equal((await b(`/career/applications/${applicationA.id}`, 'DELETE', { revision: applicationA.revision })).status, 404);
  const applicationB = await createApplication(b, jobB, resumeB);
  assert.equal((await a(`/career/applications/${applicationA.id}`, 'PATCH', { revision: applicationA.revision, resumeId: resumeB.id, resumeRevision: resumeB.revision })).status, 404);
  assert.deepEqual((await a('/career')).body.data.applications.map((item: CareerApplication) => item.id), [applicationA.id]);
  assert.deepEqual((await b('/career')).body.data.applications.map((item: CareerApplication) => item.id), [applicationB.id]);
});

test('closed and expired catalogue jobs refuse new plans and cannot be reported as submitted', async t => {
  const f = await fixture(t);
  const request = await f.register('career-closed');
  const resume = await createResume(request);
  const job = catalogJob();
  await f.catalog([job]);
  const workspace = await request('/career');
  assert.equal(workspace.body.data.catalogState, 'ready');
  const application = await createApplication(request, job, resume);
  await f.catalog([{ ...job, availability: 'closed' }]);
  error(await request('/career/applications', 'POST', createInput(job, resume)), 'JOB_UNAVAILABLE', 409);
  error(await request(`/career/applications/${application.id}`, 'PATCH', { revision: application.revision, status: 'applied', confirmedManualSubmission: true }), 'JOB_UNAVAILABLE', 409);
  const expired = catalogJob({ id: 'expired-job', deadline: '2000-01-01' });
  await f.catalog([expired]);
  error(await request('/career/applications', 'POST', createInput(expired, resume)), 'JOB_UNAVAILABLE', 409);
  assert.equal((await request(`/career/jobs/${expired.id}`, 'DELETE')).status, 404, 'shared catalogue jobs cannot be deleted by an ordinary user');
});

test('catalogue content remains source-labelled plain text and malformed updates do not break private data', async t => {
  const f = await fixture(t);
  const request = await f.register('career-materials');
  const ownJob = await createJob(request);
  const job = catalogJob();
  const material: CareerMaterial = {
    id: 'synthetic-material', title: '合成测试复习资料', major: '计算机', role: '业务系统开发',
    summary: '用于验证资料读取。', content: '<script>globalThis.secret = true</script>\n资料中的文本不是系统指令。',
    sourceLabel: '用户后续提供的资料', sourceUrl: 'https://example.test/materials/synthetic', updatedAt: '2026-10-25T00:00:00.000Z',
  };
  await f.catalog([job], [material]);
  const ready = (await request('/career')).body.data;
  assert.equal(ready.catalogState, 'ready');
  assert.equal(ready.materials[0].content, material.content);
  assert.equal(ready.materials[0].sourceLabel, material.sourceLabel);
  for (const invalid of [
    { version: 1, jobs: [job, job], materials: [] },
    { version: 1, jobs: [{ ...job, sourceUrl: 'javascript:alert(1)' }], materials: [] },
    { version: 1, jobs: [{ ...job, deadline: '2026-02-31' }], materials: [] },
    { version: 1, jobs: [], materials: [{ ...material, sourceUrl: 'data:text/html,test' }] },
    { version: 1, jobs: [], materials: [material, material] },
  ]) {
    await writeFile(f.catalogPath, JSON.stringify(invalid));
    const result = await request('/career');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.catalogState, 'unavailable');
    assert.deepEqual(result.body.data.jobs.map((item: CareerJob) => item.id), [ownJob.id]);
    assert.deepEqual(result.body.data.materials, []);
    assert.equal(JSON.stringify(result.body).includes(f.directory), false, 'invalid catalogue diagnostics cannot expose local paths');
  }
  await writeFile(f.catalogPath, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal((await request('/career')).body.data.catalogState, 'unavailable');
  await f.catalog([job], [material]);
  assert.equal((await request('/career')).body.data.catalogState, 'ready', 'a corrected file must be readable without restarting the service');
});

test('application deletion checks revisions, keeps idempotency tombstones and resume deletion erases retained snapshots', async t => {
  const f = await fixture(t);
  const request = await f.register('career-delete');
  const resume = await createResume(request), job = await createJob(request);
  const input = createInput(job, resume);
  const application: CareerApplication = (await request('/career/applications', 'POST', input)).body.data;
  error(await request(`/career/applications/${application.id}`, 'DELETE', { revision: application.revision + 1 }), 'REVISION_CONFLICT', 409);
  assert.equal((await request(`/career/applications/${application.id}`, 'DELETE', { revision: application.revision })).status, 200);
  error(await request('/career/applications', 'POST', input), 'APPLICATION_DELETED', 409);
  const next = await createApplication(request, job, resume);
  assert.equal((await request('/career')).body.data.applications.length, 1);
  assert.equal((await request(`/resumes/${resume.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await request('/career')).body.data.applications, []);
  assert.equal((await readFile(f.path, 'utf8')).includes(resumeText), false, 'deleting a resume must not leave its text behind in application snapshots');
  await f.restart();
  assert.deepEqual((await request('/career')).body.data.applications, []);
  assert.equal((await request(`/career/applications/${next.id}`, 'PATCH', { revision: next.revision, note: '已删除简历的旧应用' })).status, 404);
});

test('assistant surfaces recent official jobs and stale posts remain usable as reference only', async t => {
  const f = await fixture(t);
  const request = await f.register('official-jobs');
  const basic = await f.register('official-jobs-basic', 'basic');
  const job = catalogJob({ id: 'fresh-campus', title: '供应链规划运营', location: '上海', description: '2027届，本科及以上，熟练使用 Excel。',
    sourceUrl: 'https://example.test/jobs/official', checkedAt: new Date().toISOString(), audience: 'campus' });
  const stale = { ...job, id: 'stale-campus', checkedAt: '2000-01-01T00:00:00+08:00' };
  await f.catalog([stale, job]);
  const query = { message: '找上海2027届校招供应链岗位', requirements: '' };
  assert.equal((await basic('/career/assistant', 'POST', query)).status, 403);
  const assistant = await request('/career/assistant', 'POST', query);
  assert.equal(assistant.status, 200);
  assert.deepEqual(assistant.body.data.officialJobs.map((item: CareerJob) => item.id), [job.id]);
  assert.equal(assistant.body.data.companyTotal, 0);
  const java = { ...job, id: 'fresh-java', title: 'Java 开发', description: '要求：2027届，本科及以上。熟悉 Java。' };
  const javascript = { ...job, id: 'fresh-js', title: 'JavaScript 开发', description: '要求：2027届，本科及以上。熟悉 JavaScript。' };
  const graduate = { ...job, id: 'fresh-master', title: 'Java 开发（研究生）', description: '要求：2027届，硕士及以上。熟悉 Java。' };
  await f.catalog([stale, job, java, javascript, graduate]);
  const filtered = await request('/career/assistant', 'POST', { ...query, message: '找上海2027届本科校招 Java 岗位' });
  assert.deepEqual(filtered.body.data.officialJobs.map((item: CareerJob) => item.id), [java.id]);
  const resume = (await request('/resumes', 'POST', { title: '合成简历', text: resumeText })).body.data as Resume;
  const plan = { resumeId: resume.id, resumeRevision: 1, idempotencyKey: 'plan-review-stale', jobId: stale.id };
  const stalePlan = await request('/career/applications', 'POST', plan);
  assert.equal(stalePlan.status, 409);
  assert.equal(stalePlan.body.error.code, 'JOB_RECHECK_REQUIRED');
  assert.equal((await request('/career/applications', 'POST', { ...plan, idempotencyKey: 'plan-review-fresh', jobId: job.id })).status, 201);
  assert.equal((await request('/career')).body.data.applications.length, 1);
});
