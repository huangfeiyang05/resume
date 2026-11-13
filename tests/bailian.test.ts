import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BailianAnalysisProvider, redactContacts, validateModelOutput } from '../server/bailian.js';
import { loadModelConfig, defaultModel } from '../server/model-config.js';
import { ResumeService } from '../server/service.js';
import { AnalysisJobs } from '../server/jobs.js';
import { JsonStore } from '../server/store.js';
import { HttpError } from '../server/errors.js';
import type { Resume } from '../shared/types.js';

const original = '负责订单系统接口开发，参与数据库查询优化，编写接口文档与测试用例。';
const sample: Resume = { id: 'sample', title: '测试', targetRole: 'Java 后端开发', text: `专业技能\nJava、MySQL。\n项目经历\n${original}`, revision: 1, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' };
const config = { enabled: true, apiKey: 'sk-test-only', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: defaultModel };
const output = () => ({ summary: '先补充实际交付范围与验证依据。', issues: [{ title: '贡献依据不足', severity: 'high', category: 'impact', description: '描述了职责，缺少可核实的成果。', evidence: original, suggestion: '说明真实的验收依据。' }], suggestions: [{ title: '补充真实结果', original, missingInformation: ['验证方式'], reason: '需要用户补充并核实。' }] });
const response = (value = output()) => new Response(JSON.stringify({ id: randomUUID(), usage: { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });
const hasCode = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function store(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'bailian-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return new JsonStore(join(path, 'data.json'));
}

test('server-only config is opt-in, validates endpoint and never uses AccessKey as model key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'local.yaml');
  assert.equal((await loadModelConfig(path, {})).enabled, false);
  await writeFile(path, 'bailian:\n  enabled: true\naliyun:\n  access-key-id: LTAI-test\n  access-key-secret: not-a-model-key\n');
  await assert.rejects(loadModelConfig(path, {}), /API Key/);
  await writeFile(path, 'bailian:\n  enabled: true\n  api-key: sk-test\n');
  assert.equal((await loadModelConfig(path, {})).model, defaultModel);
  await assert.rejects(loadModelConfig(path, { DASHSCOPE_BASE_URL: 'https://example.com/compatible-mode/v1' }), /官方/);
  await writeFile(path, 'bailian: [');
  await assert.rejects(loadModelConfig(path, {}), e => e instanceof Error && !e.message.includes('bailian: ['));
});

test('model uses redacted input, bounded JSON output and confirmed suggestions; rule scores remain explainable', async () => {
  let sent: any;
  const fakeFetch: typeof fetch = async (_url, options) => { sent = JSON.parse(options!.body as string); return response(); };
  const text = `${sample.text}\n联系方式：13800138000，synthetic@example.com，110101199001011234`;
  const report = await new BailianAnalysisProvider(config, fakeFetch).analyze({ resume: { ...sample, text } });
  assert.equal(report.engine, 'bailian');
  assert.equal(report.inputSnapshot.text, text);
  assert.equal(report.modelRun?.model, defaultModel);
  assert.equal(report.modelRun?.knowledgeScope, 'public-role-guides');
  const userMessage = JSON.parse(sent.messages[1].content);
  assert.equal(userMessage.roleGuide.reference, `cs-software@${report.roleGuide?.version}`);
  assert.deepEqual(report.modelRun?.knowledgeReferences, [userMessage.roleGuide.reference]);
  assert.equal(report.suggestions[0].needsConfirmation, true);
  assert.equal(report.suggestions[0].applied, false);
  assert.equal(report.modelRun?.maxTokens, sent.max_tokens);
  const payload = JSON.stringify(sent.messages);
  for (const privateValue of ['13800138000', 'synthetic@example.com', '110101199001011234']) assert.equal(payload.includes(privateValue), false);
  assert.equal(sent.enable_thinking, false);
  assert.equal(sent.response_format.type, 'json_object');
  assert.match(redactContacts(text), /已隐藏手机号/);
  assert.equal(redactContacts('手机：+86 138 0000 0000 / 138-0000-0000').includes('138'), false);
});

test('only the retrieved project guide may be cited and resume evidence still comes from the original', async () => {
  const fakeFetch: typeof fetch = async (_url, options) => {
    const sent = JSON.parse(JSON.parse(options!.body as string).messages[1].content);
    const report = output();
    return response({ ...report, suggestions: report.suggestions.map(item => ({ ...item, guideReference: sent.roleGuide.reference })) });
  };
  const result = await new BailianAnalysisProvider(config, fakeFetch).analyze({ resume: sample });
  assert.equal(result.suggestions[0].guideReference, result.modelRun?.knowledgeReferences?.[0]);
  assert.equal(result.suggestions[0].original, original);
  assert.equal(result.suggestions[0].needsConfirmation, true);
  const fakeCitation = new BailianAnalysisProvider(config, async () => {
    const report = output();
    return response({ ...report, suggestions: report.suggestions.map(item => ({ ...item, guideReference: 'fake@v1' })) });
  });
  await assert.rejects(fakeCitation.analyze({ resume: sample }), hasCode('MODEL_INVALID_OUTPUT'));
  const withoutGuide = await new BailianAnalysisProvider(config, async () => response()).analyze({ resume: sample, targetRole: '其他', jobDescription: '需要 Excel' });
  assert.equal(withoutGuide.modelRun?.knowledgeScope, 'none');
  assert.equal(withoutGuide.roleGuide, undefined);
});

test('invalid sources, fabricated numbers, overlapping rewrites and malformed outputs are rejected', () => {
  const badEvidence = output(); badEvidence.issues[0].evidence = '不存在的原文';
  const invented = output(); invented.suggestions[0].missingInformation = ['优化接口响应速度提升 70%。'];
  const overlapping = output(); overlapping.suggestions.push({ ...overlapping.suggestions[0] });
  for (const bad of [badEvidence, invented, overlapping, { ...output(), secret: 'unexpected' }, { ...output(), suggestions: 'not-array' }]) assert.throws(() => validateModelOutput(bad, sample.text), hasCode('MODEL_INVALID_OUTPUT'));
});

test('auth errors do not leak upstream text and are never retried or disguised as rules', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response('secret upstream data', { status: 401 }); };
  await assert.rejects(new BailianAnalysisProvider(config, fakeFetch).analyze({ resume: sample }), e => hasCode('MODEL_AUTH_FAILED')(e) && !(e as Error).message.includes('secret'));
  assert.equal(calls, 1);
});

test('model times out, cancels and limits concurrent billable requests', async () => {
  const fakeFetch: typeof fetch = (_url, options) => new Promise((_resolve, reject) => {
    const abort = () => reject(new Error('private upstream content'));
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
  });
  const provider = new BailianAnalysisProvider(config, fakeFetch, 25);
  const pending = provider.analyze({ resume: sample });
  await assert.rejects(provider.analyze({ resume: sample }), hasCode('MODEL_BUSY'));
  await assert.rejects(pending, hasCode('MODEL_TIMEOUT'));
  const controller = new AbortController();
  const cancelled = provider.analyze({ resume: sample, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, hasCode('ANALYSIS_CANCELLED'));
});

test('AI jobs require consent, bind revisions and preserve confirmation/idempotence through persistence', async t => {
  const db = await store(t);
  const service = new ResumeService(db, new BailianAnalysisProvider(config, async () => response()));
  const saved = await service.createResume({ title: sample.title, targetRole: sample.targetRole, text: sample.text });
  const jobs = new AnalysisJobs(service);
  await assert.rejects(jobs.start({ resumeId: saved.id }), hasCode('AI_CONSENT_REQUIRED'));
  await assert.rejects(service.analyze({ resumeId: saved.id, aiConsent: 'true' }), hasCode('VALIDATION_ERROR'));
  const queued = await jobs.start({ resumeId: saved.id, aiConsent: true });
  assert.equal(queued.status, 'queued');
  await assert.rejects(jobs.start({ resumeId: saved.id, aiConsent: true }), hasCode('MODEL_BUSY'));
  let completed = queued;
  for (let i = 0; i < 20 && !completed.analysisId; i++) { await turn(); completed = await jobs.get(queued.id); }
  assert.equal(completed.status, 'completed');
  const report = await service.getAnalysis(completed.analysisId!);
  await assert.rejects(service.applySuggestion(report.id, report.suggestions[0].id, { revision: 1 }), hasCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(service.applySuggestion(report.id, report.suggestions[0].id, { confirmed: true, revision: 1 }), hasCode('PLACEHOLDERS_UNRESOLVED'));
  const body = { confirmed: true, replacement: `${original}验证依据为接口测试用例。`, revision: 1 };
  assert.equal((await service.applySuggestion(report.id, report.suggestions[0].id, body)).resume.revision, 2);
  assert.equal((await service.applySuggestion(report.id, report.suggestions[0].id, body)).alreadyApplied, true);
  assert.equal((await new ResumeService(new JsonStore(db.path)).getAnalysis(report.id)).engine, 'bailian');
});

test('queued cancellation and stale snapshots do not write reports', async t => {
  const db = await store(t);
  const service = new ResumeService(db, new BailianAnalysisProvider(config, async () => response()));
  const saved = await service.createResume({ title: sample.title, text: sample.text });
  const jobs = new AnalysisJobs(service);
  const cancelled = await jobs.start({ resumeId: saved.id, aiConsent: true });
  assert.equal((await jobs.cancel(cancelled.id)).status, 'cancelled');
  await turn();
  assert.equal((await service.listAnalyses(saved.id)).length, 0);
  await service.updateResume(saved.id, { title: '已编辑', revision: 1 });
  await assert.rejects(service.analyze({ resumeId: saved.id, aiConsent: true }, undefined, saved), hasCode('REVISION_CONFLICT'));
  assert.equal((await service.listAnalyses(saved.id)).length, 0);
});

test('a running model job cancelled or edited before commit cannot persist a stale report', async t => {
  const db = await store(t);
  let release!: () => void;
  let started!: () => void;
  let began = new Promise<void>(resolve => { started = resolve; });
  const fakeFetch: typeof fetch = async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return response();
  };
  const service = new ResumeService(db, new BailianAnalysisProvider(config, fakeFetch));
  const saved = await service.createResume({ title: sample.title, text: sample.text });
  const jobs = new AnalysisJobs(service);
  const running = await jobs.start({ resumeId: saved.id, aiConsent: true });
  await began;
  await service.updateResume(saved.id, { title: '新的修订', revision: 1 });
  release();
  for (let i = 0; i < 20 && (await jobs.get(running.id)).status === 'running'; i++) await turn();
  assert.equal((await jobs.get(running.id)).error?.code, 'REVISION_CONFLICT');
  assert.equal((await service.listAnalyses(saved.id)).length, 0);
  began = new Promise<void>(resolve => { started = resolve; });
  const cancel = await jobs.start({ resumeId: saved.id, aiConsent: true });
  await began;
  await jobs.cancel(cancel.id);
  release();
  for (let i = 0; i < 20 && (await jobs.get(cancel.id)).status === 'running'; i++) await turn();
  assert.equal((await jobs.get(cancel.id)).status, 'cancelled');
  assert.equal((await service.listAnalyses(saved.id)).length, 0);
});
