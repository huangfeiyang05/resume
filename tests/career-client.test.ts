import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CareerApplication, CareerJob, CareerWorkspace, Resume } from '../shared/types.js';
import { ApiError, onUnauthorized, setAuthToken } from '../src/services/api.js';
import { careerApi, jobAcceptingPlans, useCareerWorkspace } from '../src/services/career.js';
import { careerJobMatchesQuery } from '../shared/career.js';
import { shortRecruitmentCohort } from '../shared/recruitment-cohort.js';

type RequestOptions = {
  url: string; method: string; data?: unknown; header: Record<string, string>; withCredentials?: boolean;
  success: (response: { statusCode: number; data: unknown }) => void;
  fail: (reason: unknown) => void;
};
const timestamp = '2026-10-25T00:00:00.000Z';
const job: CareerJob = {
  id: 'synthetic-job', origin: 'personal', company: '合成测试公司', title: '合成测试岗位', major: '计算机', location: '合成测试城市',
  description: '自动化测试使用的岗位资料。', companyOverview: '', sourceLabel: '本人添加，信息待核实', availability: 'open', updatedAt: timestamp,
};
const resume: Resume = { id: 'synthetic-resume', title: '合成测试简历', targetRole: job.title, text: '这是自动化测试用的简历正文，不代表任何真实个人经历。', revision: 1, createdAt: timestamp, updatedAt: timestamp };
function application(overrides: Partial<CareerApplication> = {}): CareerApplication {
  return {
    id: 'synthetic-application', jobId: job.id, jobSnapshot: job, resumeSnapshot: resume, resumeHash: 'a'.repeat(64), status: 'planned', note: '',
    revision: 1, createdAt: timestamp, updatedAt: timestamp, history: [{ status: 'planned', at: timestamp, source: 'user' }], submissionMode: 'manual', ...overrides,
  };
}
function workspace(): CareerWorkspace {
  return { mode: 'preview', externalDeliveryAvailable: false, catalogState: 'empty', catalogMessage: '资料后续补充', jobs: [job], materials: [], portals: [], favoriteJobIds: [], applications: [] };
}

test('job search recognizes alternate cohort formats and keeps explicit years separate from dates', () => {
  assert.equal(shortRecruitmentCohort('2026届'), '26届');
  assert.equal(shortRecruitmentCohort('2026届及以后'), '2026届及以后');
  const titled = { ...job, title: '合成工程师（26届校招）', description: '截至 2027 年 1 月。' };
  const described = { ...job, description: '要求：２０２６ 届毕业生。' };
  const openEnded = { ...job, description: '要求：2024届及以后毕业。' };
  for (const query of ['26届', '2026', '2026届', '2026届毕业生']) {
    for (const candidate of [titled, described, openEnded]) assert.ok(careerJobMatchesQuery(candidate, query));
  }
  assert.ok(!careerJobMatchesQuery(titled, '27届'));
  assert.ok(!careerJobMatchesQuery(openEnded, '23届'));
  assert.ok(!careerJobMatchesQuery({ ...job, description: '不接受2026届。' }, '26届'));
  assert.ok(!careerJobMatchesQuery(job, '26届'));
  assert.ok(careerJobMatchesQuery(described, '合成测试城市'));
  assert.equal(described.description, '要求：２０２６ 届毕业生。');
});
function fixture(t: TestContext, native = false) {
  const globals = globalThis as typeof globalThis & { uni?: unknown; wx?: unknown };
  const originalUni = globals.uni, originalWx = globals.wx;
  if (native) globals.wx = {}; else delete globals.wx;
  const requests: RequestOptions[] = [];
  let respond = (options: RequestOptions) => options.success({ statusCode: 200, data: { data: workspace() } });
  globals.uni = { request: (options: RequestOptions) => { requests.push(options); respond(options); } };
  setAuthToken('');
  t.after(() => { setAuthToken(''); globals.uni = originalUni; if (originalWx === undefined) delete globals.wx; else globals.wx = originalWx; });
  return { requests, respond: (handler: typeof respond) => { respond = handler; } };
}

test('career uses the shared authenticated H5/native transport and a uni-compatible update method', async t => {
  const { requests, respond } = fixture(t);
  setAuthToken('must-not-send-in-h5');
  await careerApi.workspace();
  respond(options => options.success({ statusCode: 200, data: { data: application({ note: '已核对岗位信息。' }) } }));
  await careerApi.updateApplication('synthetic-application', { revision: 1, note: '已核对岗位信息。' });
  assert.ok(requests.every(item => item.withCredentials === true));
  assert.ok(requests.every(item => !('Authorization' in item.header)));
  assert.equal(requests.at(-1)?.method, 'PUT', 'uni.request has no PATCH method in the supported mini-program transport');
  const globals = globalThis as typeof globalThis & { wx?: unknown };
  globals.wx = {};
  respond(options => options.success({ statusCode: 200, data: { data: workspace() } }));
  setAuthToken('synthetic-career-session');
  await careerApi.workspace();
  assert.equal(requests.at(-1)?.header.Authorization, 'Bearer synthetic-career-session');
  assert.equal(requests.at(-1)?.header['X-Auth-Client'], 'mp-weixin');
  let expired = 0;
  const dispose = onUnauthorized(() => { ++expired; }); t.after(dispose);
  respond(options => options.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'expired' } } }));
  await assert.rejects(careerApi.workspace(), error => error instanceof ApiError && error.status === 401);
  assert.equal(expired, 1);
});

test('career rejects fabricated execution capabilities and malformed server data before displaying it', async t => {
  const { respond } = fixture(t);
  for (const mutate of [
    (value: any) => { value.externalDeliveryAvailable = true; },
    (value: any) => { value.jobs = [job, job]; },
    (value: any) => { value.jobs = [{ ...job, sourceUrl: 'javascript:alert(1)' }]; },
    (value: any) => { value.jobs = [{ ...job, availability: 'invented' }]; },
    (value: any) => { value.applications = [application({ submissionMode: 'automatic' as any })]; },
    (value: any) => { value.applications = [application({ jobId: 'other-job' })]; },
    (value: any) => { value.applications = [application({ status: 'succeeded' as any })]; },
    (value: any) => { value.applications = [application({ history: [{ status: 'applied', at: timestamp, source: 'system' as any }] })]; },
    (value: any) => { value.materials = [{ id: 'bad', content: 'missing provenance and classification' }]; },
    (value: any) => { value.portals = [{ id: 'bad', organization: '缺少来源的招聘入口' }]; },
  ]) {
    const value = workspace(); mutate(value);
    respond(options => options.success({ statusCode: 200, data: { data: value } }));
    await assert.rejects(careerApi.workspace(), error => error instanceof ApiError && error.code === 'INVALID_CAREER_RESPONSE');
  }
});

test('career distinguishes checked recruitment portals from jobs and rejects unsafe or duplicate portal data', async t => {
  const { respond } = fixture(t);
  const portal = { id: 'synthetic-portal', organization: '合成测试机构', majors: ['计算机与软件'], audience: '校园招聘', description: '仅作入口，不代表在招岗位。', sourceUrl: 'https://example.test/careers', checkedAt: timestamp };
  const value = { ...workspace(), jobs: [], portals: [portal] };
  respond(options => options.success({ statusCode: 200, data: { data: value } }));
  const result = await careerApi.workspace();
  assert.deepEqual(result.portals, [portal]);
  assert.deepEqual(result.jobs, []);
  for (const portals of [[{ ...portal, sourceUrl: 'javascript:alert(1)' }], [{ ...portal, sourceUrl: 'http://example.test/careers' }], [{ ...portal, majors: [] }], [{ ...portal, checkedAt: 'yesterday' }], [portal, portal]]) {
    respond(options => options.success({ statusCode: 200, data: { data: { ...value, portals } } }));
    await assert.rejects(careerApi.workspace(), error => error instanceof ApiError && error.code === 'INVALID_CAREER_RESPONSE');
  }
});

test('career cannot accept a mutation response for another application or resume version', async t => {
  const { respond } = fixture(t);
  const input = { jobId: job.id, resumeId: resume.id, resumeRevision: resume.revision, idempotencyKey: 'synthetic-create-request' };
  for (const response of [
    application({ jobId: 'other-job', jobSnapshot: { ...job, id: 'other-job' } }),
    application({ resumeSnapshot: { ...resume, id: 'other-resume' } }),
    application({ resumeSnapshot: { ...resume, revision: 2 } }),
  ]) {
    respond(options => options.success({ statusCode: 201, data: { data: response } }));
    await assert.rejects(careerApi.createApplication(input), error => error instanceof ApiError && error.code === 'INVALID_CAREER_RESPONSE');
  }
  for (const response of [application({ id: 'other-application' }), application({ note: '另一段未请求的内容。' })]) {
    respond(options => options.success({ statusCode: 200, data: { data: response } }));
    await assert.rejects(careerApi.updateApplication('synthetic-application', { revision: 1, note: '' }), error => error instanceof ApiError && error.code === 'INVALID_CAREER_RESPONSE');
  }
});

test('a late workspace GET cannot undo a favourite saved while the read was pending', async t => {
  const { respond } = fixture(t);
  const service = useCareerWorkspace({ autoLoad: false }); t.after(service.dispose);
  await service.load();
  let pending!: RequestOptions;
  respond(options => { pending = options; });
  const loading = service.load();
  respond(options => options.success({ statusCode: 200, data: { data: { jobId: job.id, favorite: true } } }));
  await service.favorite(job.id, true);
  pending.success({ statusCode: 200, data: { data: workspace() } });
  await loading;
  assert.deepEqual(service.favoriteJobIds.value, [job.id]);
  assert.equal(service.loading.value, false);
});

test('failed application creation retains its idempotency key for retry and changes it for a different input', async t => {
  const { requests, respond } = fixture(t);
  const service = useCareerWorkspace({ autoLoad: false }); t.after(service.dispose);
  await service.load();
  const input = { jobId: job.id, resumeId: resume.id, resumeRevision: resume.revision };
  respond(options => options.fail({ errMsg: 'synthetic lost response' }));
  assert.equal(await service.createApplication(input), undefined);
  const first = requests.at(-1)?.data as { idempotencyKey: string };
  assert.match(first.idempotencyKey, /^[a-f0-9-]+$/);
  assert.deepEqual(service.applications.value, []);
  assert.equal(service.notice.value, '');
  respond(options => options.success({ statusCode: 201, data: { data: application() } }));
  const saved = await service.createApplication(input);
  assert.equal(saved?.id, 'synthetic-application');
  assert.equal((requests.at(-1)?.data as { idempotencyKey: string }).idempotencyKey, first.idempotencyKey);
  assert.equal(service.applications.value.length, 1);
  respond(options => options.fail({ errMsg: 'synthetic failure for another request' }));
  await service.createApplication({ ...input, resumeRevision: 2 });
  assert.notEqual((requests.at(-1)?.data as { idempotencyKey: string }).idempotencyKey, first.idempotencyKey);
});

test('a disposed workbench ignores a late successful mutation and never claims it updated the visible account', async t => {
  const { respond } = fixture(t);
  const service = useCareerWorkspace({ autoLoad: false });
  await service.load();
  let pending!: RequestOptions;
  respond(options => { pending = options; });
  const saving = service.favorite(job.id, true);
  service.dispose();
  pending.success({ statusCode: 200, data: { data: { jobId: job.id, favorite: true } } });
  assert.equal(await saving, undefined);
  assert.deepEqual(service.favoriteJobIds.value, []);
  assert.equal(service.notice.value, '');
});

test('a second create click while a request is running cannot issue a duplicate request', async t => {
  const { requests, respond } = fixture(t);
  const service = useCareerWorkspace({ autoLoad: false }); t.after(service.dispose);
  await service.load();
  let pending!: RequestOptions;
  respond(options => { pending = options; });
  const input = { jobId: job.id, resumeId: resume.id, resumeRevision: resume.revision };
  const creating = service.createApplication(input);
  assert.equal(await service.createApplication(input), undefined);
  assert.equal(requests.filter(item => item.url.endsWith('/career/applications')).length, 1);
  pending.success({ statusCode: 201, data: { data: application() } });
  await creating;
  assert.equal(service.applications.value.length, 1);
});

test('job deadline display uses the inclusive Shanghai calendar date', () => {
  const dated = { ...job, deadline: '2026-10-25' };
  assert.equal(jobAcceptingPlans(dated, Date.parse('2026-10-25T15:59:59.999Z')), true);
  assert.equal(jobAcceptingPlans(dated, Date.parse('2026-10-25T16:00:00.000Z')), false);
  assert.equal(jobAcceptingPlans({ ...dated, availability: 'closed' }, Date.parse('2026-10-24T00:00:00.000Z')), false);
});
