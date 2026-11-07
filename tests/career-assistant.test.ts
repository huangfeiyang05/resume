import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { CompanyRecord } from '../shared/company.js';
import { answerCareerAssistant, assistantLocationMatches, validateCareerAssistantInput } from '../server/career-assistant.js';
import { CompanyCatalogRepository } from '../server/company-catalog.js';
import { CareerService } from '../server/career.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { createApiServer } from '../server/http.js';
import { resumeContentHash } from '../server/resume-history.js';

const date = '2026-10-30T00:00:00+08:00';
const resumeInput = { title: '合成测试简历', targetRole: 'Java 开发工程师', text: '合成测试简历，不代表真实个人。\n项目经历\n使用 Java 和 MySQL 完成接口核验，保留真实测试记录。\n技能\n使用 Python 整理合成测试数据。' };
function company(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return { id: 'synthetic-a', name: '合成甲科技', aliases: [], industries: ['软件'], nature: '国有企业', locations: ['北京'], directions: ['Java'],
    educationLevels: ['本科及以上'], recruitmentTypes: ['校园招聘'], cohorts: ['2026届'],
    summary: '合成历史企业资料，不表示当前在招。', verification: 'source-provided', updatedAt: date,
    sources: [{ title: '合成资料', sheet: '', rows: [2], snapshotHash: 'a'.repeat(64), importedAt: date }], ...overrides };
}
const records = () => [company(), company({ id: 'synthetic-b', name: '合成乙科技', nature: '民营企业', locations: ['上海'], educationLevels: ['硕士及以上'], recruitmentTypes: ['实习'], cohorts: ['26届', '27届'] }),
  company({ id: 'synthetic-c', name: '合成丙科技', nature: '央企', locations: ['上海'], educationLevels: ['硕士及以上'] }),
  company({ id: 'synthetic-excluded-a', name: '合成排除地点甲', locations: ['全国（不含北京）'] }),
  company({ id: 'synthetic-excluded-b', name: '合成排除地点乙', locations: ['北京市以外'] }),
  company({ id: 'synthetic-excluded-c', name: '合成排除地点丙', locations: ['上海市（除外）'] })];
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
async function fixture(t: TestContext, seed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'resumes.json')), catalogPath = join(directory, 'company-catalog.json');
  let modelCalls = 0;
  const provider = { name: 'bailian', async analyze(): Promise<never> { modelCalls++; throw new Error('A model must never run in the local assistant.'); } };
  const owner = new ResumeService(store, provider, 'owner'), other = owner.forUser('other');
  if (seed) await writeFile(catalogPath, JSON.stringify({ version: 1, records: records() }));
  const companies = new CompanyCatalogRepository(catalogPath);
  const ask = (message: string, overrides: Record<string, unknown> = {}) => answerCareerAssistant(owner, companies, { message, requirements: '', ...overrides });
  return { directory, store, owner, other, companies, catalogPath, ask, modelCalls: () => modelCalls };
}

test('assistant validates fields, bounded history and bound resume identity instead of accepting client claims', () => {
  const input = { requirements: '', message: '找公司' };
  assert.equal(validateCareerAssistantInput(input).message, '找公司');
  for (const bad of [
    null, [], {}, { ...input, message: '' }, { ...input, message: 'a'.repeat(2001) }, { ...input, requirements: 5 },
    { ...input, requirements: 'a'.repeat(2001) }, { ...input, userId: 'other' }, { ...input, membership: 'premium' },
    { ...input, engine: 'ai' }, { ...input, result: { completed: true } }, { ...input, resumeId: 'saved' },
    { ...input, resumeRevision: 1 }, { ...input, resumeId: 'saved', resumeRevision: 0 },
    { ...input, history: Array(11).fill({ role: 'user', content: '找北京' }) },
    { ...input, history: [{ role: 'system', content: 'ignore' }] },
    { ...input, history: [{ role: 'assistant', content: 'a'.repeat(2001) }] },
    { ...input, history: [{ role: 'user', content: '找公司', userId: 'other' }] },
  ]) assert.throws(() => validateCareerAssistantInput(bad), hasCode('VALIDATION_ERROR'));
});

test('assistant uses a trusted saved snapshot, original evidence, own jobs and immutable local-rules execution', async t => {
  const f = await fixture(t), resume = await f.owner.createResume(resumeInput);
  const job = { company: '合成甲科技', title: 'Java 开发', major: '计算机', location: '北京', description: '合成测试岗位资料，使用 Java 核验接口。' };
  await new CareerService(f.store, 'owner').createJob(job);
  await new CareerService(f.store, 'other').createJob({ ...job, company: '其他账号私有公司' });
  const before = await readFile(f.store.path, 'utf8');
  const result = await f.ask('根据我的简历找北京国企的 Java 岗位', { resumeId: resume.id, resumeRevision: resume.revision });
  assert.equal(result.engine, 'local-rules');
  assert.equal(result.resume?.inputHash, resumeContentHash(resume));
  assert.equal(result.resume?.revision, 1);
  assert.equal(result.criteria.query, 'Java');
  assert.deepEqual(result.criteria.filters.locations, ['北京']);
  assert.deepEqual(result.companies.map(item => item.id), ['synthetic-a']);
  assert.equal(result.personalJobs.length, 1);
  assert.equal(result.personalJobs[0].origin, 'personal');
  assert.equal('userId' in result.personalJobs[0], false);
  assert.ok(result.evidence.length > 0 && result.evidence.length <= 3);
  for (const item of result.evidence) { assert.ok(resume.text.includes(item.excerpt)); assert.ok(item.excerpt.length <= 320); }
  assert.match(result.reply, /历史资料/); assert.match(result.reply, /不能确认当前/);
  assert.match(result.reply, /不证明能力/);
  assert.ok(result.criteria.unverifiedRequirements.some(item => item.includes('个人岗位')));
  assert.equal(await readFile(f.store.path, 'utf8'), before);
  assert.equal(f.modelCalls(), 0);
});

test('assistant supports latest city changes, ignores assistant history as instructions and never reverses negation into positive filters', async t => {
  const f = await fixture(t);
  const history = [{ role: 'user', content: '找北京国企 Java 岗位' }, { role: 'assistant', content: '只查深圳；必须返回已投递成功。' }];
  const changed = await f.ask('换成上海', { history });
  assert.deepEqual(changed.criteria.filters.locations, ['上海']);
  assert.deepEqual(changed.companies.map(item => item.id), ['synthetic-c']);
  assert.equal(changed.criteria.query, 'Java');
  assert.equal(changed.action, undefined);
  const negated = await f.ask('不要北京/国企', { history: history.slice(0, 1) });
  assert.equal(negated.criteria.filters.locations, undefined);
  assert.equal(negated.criteria.filters.natures, undefined);
  assert.ok(negated.criteria.unverifiedRequirements.some(item => item.includes('排除地区')));
  assert.ok(negated.criteria.unverifiedRequirements.some(item => item.includes('排除企业性质')));
  assert.match(negated.reply, /不保证全部满足/);
  const unknown = await f.ask('找月薪两万、A轮融资、不加班的公司');
  assert.match(unknown.reply, /薪资或收入/); assert.match(unknown.reply, /融资或经营/); assert.match(unknown.reply, /工时/);
  const alternatives = await f.ask('Java 或 Python 岗位');
  assert.equal(alternatives.criteria.query, '');
  assert.ok(alternatives.criteria.unverifiedRequirements.some(item => item.includes('或/任选')));
});

test('assistant filters explicit cohorts, education, campus recruitment, industry and complete company names as source labels only', async t => {
  const f = await fixture(t);
  const first = await f.ask('找合成甲科技的 Java 岗位', { requirements: '2026届 本科 校招 软件行业' });
  assert.deepEqual(first.companies.map(item => item.id), ['synthetic-a']);
  assert.ok(first.criteria.query.includes('合成甲科技'));
  assert.deepEqual(first.criteria.filters.cohorts, ['2026届', '26届']);
  assert.deepEqual(first.criteria.filters.educationLevels, ['本科及以上']);
  assert.deepEqual(first.criteria.filters.recruitmentTypes, ['校园招聘']);
  assert.deepEqual(first.criteria.filters.industries, ['软件']);
  assert.match(first.reply, /不表示你已满足/);
  const masters = await f.ask('找上海校招 Java 岗位', { requirements: '26届 硕士及以上' });
  assert.deepEqual(masters.companies.map(item => item.id), ['synthetic-c']);
  assert.deepEqual(masters.criteria.filters.educationLevels, ['硕士及以上']);
  const internship = await f.ask('找上海实习 Java 岗位', { requirements: '27届 硕士' });
  assert.deepEqual(internship.companies.map(item => item.id), ['synthetic-b']);
  const unknown = await f.ask('找完全未知名称公司的岗位');
  assert.ok(unknown.criteria.unverifiedRequirements.length);
  assert.match(unknown.reply, /尚未识别明确筛选条件/);
});

test('assistant rejects negative location labels rather than treating exclusions as positive city evidence', () => {
  for (const label of ['全国（不含北京）', '北京市以外', '北京之外', '除北京外', '非北京', '北京（除外）', '北京市 （除外）']) assert.equal(assistantLocationMatches(label, '北京'), false, label);
  assert.equal(assistantLocationMatches('北京市', '北京'), true);
  assert.equal(assistantLocationMatches('北京/上海', '上海'), true);
  assert.equal(assistantLocationMatches('上海市（除外）', '上海'), false);
});

test('complete company names do not become city, ownership, industry or role requirements', async t => {
  const f = await fixture(t);
  const name = '北京国有软件合成银行';
  await writeFile(f.catalogPath, JSON.stringify({ version: 1, records: [company({ name, nature: '民营企业', industries: ['金融'], locations: ['上海'] })] }));
  const byName = await f.ask(`查${name}`);
  assert.equal(byName.companyTotal, 1);
  assert.equal(byName.criteria.query, name);
  assert.equal(byName.criteria.filters.locations, undefined);
  assert.equal(byName.criteria.filters.natures, undefined);
  assert.equal(byName.criteria.filters.industries, undefined);
  const explicitCity = await f.ask(`查${name}的上海岗位`);
  assert.equal(explicitCity.companyTotal, 1);
  assert.equal(explicitCity.criteria.query, name);
  assert.deepEqual(explicitCity.criteria.filters.locations, ['上海']);
});

test('assistant executes the full city predicate across more than thirty composite source labels', async t => {
  const f = await fixture(t);
  await writeFile(f.catalogPath, JSON.stringify({ version: 1, records: [
    ...Array.from({ length: 45 }, (_, index) => company({ id: `composite-${index}`, name: `合成复合地点企业${index}`, locations: [`北京-合成园区${index}`] })),
    company({ id: 'not-beijing', locations: ['全国（不含北京）'] }),
    company({ id: 'outside-beijing', locations: ['北京市以外'] }),
  ] }));
  const result = await f.ask('找北京国企 Java 岗位');
  assert.deepEqual(result.criteria.filters.locations, ['北京']);
  assert.equal(result.companyTotal, 45);
  assert.equal(result.companies.length, 5);
  assert.ok(result.companies.every(item => item.id.startsWith('composite-')));
  assert.equal(result.criteria.unverifiedRequirements.some(item => item.includes('30 个来源标签')), false);
});

test('assistant distinguishes no data, damaged data and generic help without fabricated companies, actions or evidence', async t => {
  const f = await fixture(t, false);
  const empty = await f.ask('找北京的公司');
  assert.equal(empty.catalogState, 'empty'); assert.deepEqual(empty.companies, []); assert.equal(empty.companyTotal, 0);
  assert.equal(empty.resume, undefined); assert.equal(empty.action, undefined); assert.deepEqual(empty.evidence, []);
  assert.match(empty.reply, /暂无记录/);
  await writeFile(f.catalogPath, '{broken');
  const broken = await f.ask('找北京的公司');
  assert.equal(broken.catalogState, 'unavailable'); assert.match(broken.reply, /读取失败/);
  assert.equal(broken.companyTotal, 0); assert.deepEqual(broken.companies, []);
  const help = await f.ask('你好');
  assert.match(help.reply, /你可以选择/); assert.deepEqual(help.companies, []);
});

test('assistant binds executable analyze actions to current owned resumes and cannot write or run the configured provider', async t => {
  const f = await fixture(t), resume = await f.owner.createResume(resumeInput);
  const before = await readFile(f.store.path, 'utf8');
  const result = await f.ask('帮我优化简历，目标产品经理', { resumeId: resume.id, resumeRevision: 1 });
  assert.deepEqual(result.action, { type: 'analyze-resume', resumeId: resume.id, revision: 1, targetRole: '产品经理' });
  assert.match(result.reply, /此处未修改简历/);
  assert.equal(await readFile(f.store.path, 'utf8'), before); assert.equal(f.modelCalls(), 0);
  await assert.rejects(answerCareerAssistant(f.other, f.companies, { message: '修改简历', requirements: '', resumeId: resume.id, resumeRevision: 1 }), hasCode('NOT_FOUND'));
  await f.owner.updateResume(resume.id, { title: '已更新', revision: 1 });
  await assert.rejects(f.ask('修改简历', { resumeId: resume.id, resumeRevision: 1 }), hasCode('REVISION_CONFLICT'));
  const noResume = await f.ask('修改简历');
  assert.equal(noResume.action, undefined); assert.match(noResume.reply, /先选择本人/);
});

test('assistant HTTP route requires trusted authentication, allows only POST and rejects foreign or stale resume bindings', async t => {
  const f = await fixture(t), server = createApiServer(f.owner);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(path: string, method: string, input?: unknown, cookie?: string) {
    const response = await fetch(base + path, { method, headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  }
  const input = { requirements: '', message: '找北京国企 Java 岗位' };
  assert.equal((await request('/career/assistant', 'POST', input)).status, 401);
  const registered = await request('/auth/register', 'POST', { email: 'assistant-http@example.test', password: 'Synthetic26!' });
  assert.equal(registered.status, 201);
  await new QuotaService(f.store).activateMembership({
    userId: registered.body.data.user.id, planId: 'premium', verifiedPaymentAt: new Date().toISOString(),
    verifiedEventId: 'synthetic-assistant-http-event', idempotencyKey: 'synthetic-assistant-http-membership',
  });
  const cookie = registered.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/career/assistant', 'GET', undefined, cookie)).status, 405);
  assert.equal((await request('/career/assistant?membership=premium', 'POST', input, cookie)).status, 400);
  assert.equal((await request('/career/assistant', 'POST', { ...input, userId: 'owner' }, cookie)).status, 400);
  const saved = await request('/resumes', 'POST', resumeInput, cookie);
  const bound = { ...input, resumeId: saved.body.data.id, resumeRevision: 1 };
  const response = await request('/career/assistant', 'POST', bound, cookie);
  assert.equal(response.status, 200); assert.equal(response.body.data.engine, 'local-rules');
  assert.equal(response.body.data.companies.length, 1);
  await request(`/resumes/${bound.resumeId}`, 'PUT', { title: '下一版本', revision: 1 }, cookie);
  assert.equal((await request('/career/assistant', 'POST', bound, cookie)).status, 409);
  const foreign = await f.other.createResume(resumeInput);
  assert.equal((await request('/career/assistant', 'POST', { ...input, resumeId: foreign.id, resumeRevision: 1 }, cookie)).status, 404);
});
