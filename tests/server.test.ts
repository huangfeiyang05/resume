import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Resume } from '../shared/types.js';
import { inputLimits } from '../shared/limits.js';
import { RuleAnalysisProvider } from '../server/analysis.js';
import { HttpError } from '../server/errors.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const weakText = '个人简介\n拥有后端开发经验，热爱技术与学习。\n工作经历\n负责日常业务的接口维护和需求跟进工作。\n参与业务系统相关文档的整理和部门沟通。';
const strongText = `个人简介\n后端工程师，关注业务系统可靠性与复杂问题定位，参与过完整的软件交付流程。\n教育背景\n计算机科学与技术本科，完成数据库、操作系统与软件工程课程。\n专业技能\nJava、Spring Boot、MySQL、Redis、微服务、接口设计、数据库与性能优化。\n项目经历\n设计并实现订单接口缓存方案，通过压测验证接口响应时间降低 35%，记录测试环境和测量方法。\n重构数据库慢查询与索引，将核心查询耗时从 300 ms 降低至 80 ms，保留监控记录作为验证。\n协作方式\n与产品和测试同事确认验收标准，维护发布记录并复盘线上问题。`;

function resume(text: string): Resume {
  return { id: 'test-resume', title: '测试简历', targetRole: 'Java 后端工程师', text, revision: 1, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'resumes.json');
  return { path, service: new ResumeService(new JsonStore(path)) };
}

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test('rule diagnosis reflects real content, role evidence and supplied JD', async () => {
  const provider = new RuleAnalysisProvider();
  const weak = await provider.analyze({ resume: resume(weakText) });
  const strong = await provider.analyze({ resume: resume(strongText) });
  assert.ok(strong.score > weak.score + 25);
  assert.ok(weak.issues.some(({ category }) => category === 'impact'));
  assert.ok(weak.issues.some(({ category }) => category === 'structure'));
  assert.ok(weak.issues.some(({ category }) => category === 'clarity'));
  assert.ok(weak.keywords.missing.includes('Redis'));
  assert.ok(strong.keywords.matched.includes('Redis'));
  assert.equal(strong.issues.some(({ category }) => category === 'impact'), false);
  assert.equal(weak.engine, 'rules');
  assert.equal(weak.inputSnapshot.text, weakText);
  assert.notEqual(weak.inputHash, strong.inputHash);
  for (const suggestion of weak.suggestions) {
    assert.equal(suggestion.needsConfirmation, true);
    assert.ok(suggestion.replacement.includes('[请填写真实'));
    assert.equal(/\d/.test(suggestion.replacement), false, 'rules must not invent achievement numbers');
  }
  const jd = await provider.analyze({ resume: resume(strongText), jobDescription: '要求 Python、Docker、Kubernetes，负责模型部署。' });
  assert.ok(jd.keywords.missing.includes('Docker'));
  assert.equal(jd.keywords.missing.includes('React'), false);
  assert.equal(jd.keywords.matched.includes('Java'), false, 'JD takes precedence over generic role defaults');
});

test('concurrent initial reads and writes share one disk load without losing a mutation', async (t) => {
  const { path, service } = await fixture(t);
  const saved = await service.createResume({ title: '首次加载', targetRole: '', text: weakText });
  class ObservedStore extends JsonStore {
    loads = 0;
    protected async loadFile() {
      this.loads += 1;
      // Keep the first load pending while all independent callers reach it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return super.loadFile();
    }
  }
  const store = new ObservedStore(path);
  await Promise.all([
    store.read(), store.read(),
    store.mutate((database) => { database.resumes[0].title = '并发修改已保存'; }),
  ]);
  assert.equal(store.loads, 1);
  assert.equal((await store.read()).resumes[0].title, '并发修改已保存');
  assert.equal((await new ResumeService(new JsonStore(path)).getResume(saved.id)).title, '并发修改已保存');
});

test('dates, phone numbers and technology versions are not treated as results', async () => {
  const result = await new RuleAnalysisProvider().analyze({ resume: resume('项目经历\n2023-2024 年负责 Java 17 项目的需求维护，联系电话 13800138000。\n教育背景\n计算机本科\n专业技能\nJava') });
  assert.ok(result.issues.some(({ category }) => category === 'impact'));
});

test('applying reviewed facts is idempotent, serialized and persisted', async (t) => {
  const { path, service } = await fixture(t);
  const saved = await service.createResume({ title: '后端简历', targetRole: 'Java 后端工程师', text: weakText });
  const analysis = await service.analyze({ resumeId: saved.id });
  const first = analysis.suggestions[0];
  const replacement = '设计接口维护检查清单，整理真实故障原因与验收记录，并与团队共同完成回归验证。';
  const [one, two] = await Promise.all([
    service.applySuggestion(analysis.id, first.id, { confirmed: true, replacement, revision: 1 }),
    service.applySuggestion(analysis.id, first.id, { confirmed: true, replacement, revision: 1 }),
  ]);
  assert.equal(one.alreadyApplied, false);
  assert.equal(two.alreadyApplied, true);
  assert.equal(two.resume.revision, 2);
  assert.equal(two.resume.text.split(replacement).length - 1, 1);
  const fresh = new ResumeService(new JsonStore(path));
  assert.equal((await fresh.getResume(saved.id)).revision, 2);
  assert.equal((await fresh.getAnalysis(analysis.id)).suggestions[0].applied, true);
  await assert.rejects(() => service.applySuggestion(analysis.id, first.id, { confirmed: true, replacement: '另一段不同的内容。', revision: 1 }), hasCode('ALREADY_APPLIED'));
  // Another suggestion from the original snapshot remains safe after the first reviewed application.
  const next = await service.applySuggestion(analysis.id, analysis.suggestions[1].id, { confirmed: true, replacement: '整理业务文档与接口约定，在团队评审中逐项确认需求范围和实际验收结果。', revision: 2 });
  assert.equal(next.resume.revision, 3);
});

test('apply requires factual confirmation and refuses edited or ambiguous sources', async (t) => {
  const { service } = await fixture(t);
  const saved = await service.createResume({ title: '简历', targetRole: '后端开发', text: weakText });
  const analysis = await service.analyze({ resumeId: saved.id });
  const suggestion = analysis.suggestions[0];
  await assert.rejects(() => service.applySuggestion(analysis.id, suggestion.id, { revision: 1 }), hasCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(() => service.applySuggestion(analysis.id, suggestion.id, { confirmed: true, revision: 1 }), hasCode('PLACEHOLDERS_UNRESOLVED'));
  await service.updateResume(saved.id, { text: `${weakText}\n补充真实的教育信息。`, revision: 1 });
  await assert.rejects(() => service.applySuggestion(analysis.id, suggestion.id, { confirmed: true, replacement: '经核实的项目描述。', revision: 2 }), hasCode('SOURCE_CONFLICT'));
  await assert.rejects(() => service.updateResume(saved.id, { title: '覆盖新版本', revision: 1 }), hasCode('REVISION_CONFLICT'));

  const duplicate = await service.createResume({ title: '重复段落', targetRole: '后端开发', text: '负责业务系统相关文档的整理和部门沟通。\n负责业务系统相关文档的整理和部门沟通。' });
  // A future/legacy provider can still return ambiguous sources. Keep the
  // service's independent guard even though current rules no longer emit them.
  const ambiguousService = new ResumeService(service.store, { name: 'rules', async analyze(context) {
    const report = await new RuleAnalysisProvider().analyze(context);
    return { ...report, suggestions: [{ id: 'synthetic-ambiguous-suggestion', title: '合成歧义来源',
      original: '负责业务系统相关文档的整理和部门沟通。', replacement: '请补充[请填写真实结果]。', reason: '合成测试', needsConfirmation: true, applied: false }] };
  } }, service.userId);
  const duplicatedReport = await ambiguousService.analyze({ resumeId: duplicate.id });
  await assert.rejects(() => ambiguousService.applySuggestion(duplicatedReport.id, duplicatedReport.suggestions[0].id, { confirmed: true, replacement: '新的真实经历。', revision: 1 }), hasCode('AMBIGUOUS_SOURCE'));
});

test('apply rejects unresolved reviewed facts and total resume overflow without mutating data', async (t) => {
  const { service } = await fixture(t);
  const saved = await service.createResume({ title: '边界简历', targetRole: '后端开发', text: `${'文'.repeat(inputLimits.resumeText - 50)}\n负责业务系统相关文档的整理和部门沟通。` });
  const analysis = await service.analyze({ resumeId: saved.id });
  const suggestion = analysis.suggestions[0];
  await assert.rejects(() => service.applySuggestion(analysis.id, suggestion.id, {
    confirmed: true, replacement: '优化实际流程，取得[请填写真实结果]。', revision: 1,
  }), hasCode('PLACEHOLDERS_UNRESOLVED'));
  await assert.rejects(() => service.applySuggestion(analysis.id, suggestion.id, {
    confirmed: true, replacement: '真实内容'.repeat(100), revision: 1,
  }), hasCode('RESUME_TOO_LARGE'));
  assert.deepEqual(await service.getResume(saved.id), saved);
  assert.equal((await service.getAnalysis(analysis.id)).suggestions[0].applied, false);
});

test('API validates input, statuses, CRUD history and PUT / PATCH concurrency', async (t) => {
  const { service } = await fixture(t);
  const server = createApiServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const registration = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'api-fixture@example.test', password: 'Fixture-pw-26!' }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  const request = async (path: string, method = 'GET', data?: unknown) => {
    const result = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: result.status, body: await result.json() as any };
  };
  assert.deepEqual((await request('/health')).body.data, { status: 'ok', analysisEngine: 'rules', aiConfigured: false, persistence: 'local-json' });
  assert.equal((await request('/resumes', 'POST', { title: '空白', text: '  ' })).status, 400);
  assert.equal((await request('/resumes', 'POST', { title: '超限', text: '字'.repeat(50_001) })).status, 400);
  assert.equal((await request('/resumes', 'POST', { title: '超限', text: '字'.repeat(100_000) })).status, 413);
  assert.equal((await request('/resumes', 'POST', { title: '非法字段', text: '正文', owner: 'other' })).status, 400);
  const malformed = await fetch(`${base}/resumes`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(`${base}/resumes`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  assert.equal((await request('/resumes/no-such-resume')).status, 404);
  assert.equal((await request('/health', 'POST', {})).status, 405);

  const created = await request('/resumes', 'POST', { title: '我的简历', targetRole: '后端开发', text: weakText });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal((await request('/resumes')).body.data.length, 1);
  const updated = await request(`/resumes/${id}`, 'PUT', { title: '更新后的简历', revision: 1 });
  assert.equal(updated.body.data.revision, 2);
  assert.equal((await request(`/resumes/${id}`, 'PATCH', { title: '旧版本', revision: 1 })).status, 409);
  const diagnosed = await request('/analyses', 'POST', { resumeId: id });
  assert.equal(diagnosed.status, 201);
  assert.equal((await request(`/resumes/${id}/analyses`)).body.data.length, 1);
  assert.equal((await request(`/analyses/${diagnosed.body.data.id}`)).body.data.resumeRevision, 2);
  assert.equal((await request('/analyses', 'POST', { resumeId: id, jobDescription: 123 })).status, 400);
  assert.equal((await request(`/resumes/${id}`, 'DELETE')).body.data.deleted, true);
  assert.equal((await request(`/analyses/${diagnosed.body.data.id}`)).status, 404);
  assert.equal((await request(`/resumes/${id}/analyses`)).status, 404);
});
