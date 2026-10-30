import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AnalysisJob } from '../shared/types.js';
import { RuleAnalysisProvider, type AnalysisProvider } from '../server/analysis.js';
import { HttpError } from '../server/errors.js';
import { AnalysisJobs } from '../server/jobs.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { validateAnalysisInput } from '../server/validation.js';

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-analysis-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const baseline = new RuleAnalysisProvider();
  const provider: AnalysisProvider = { name: 'bailian', async analyze(context) { calls++; return baseline.analyze(context); } };
  const store = new JsonStore(join(directory, 'data.json'));
  const service = new ResumeService(store, provider, 'synthetic-owner');
  const saved = await service.createResume({ title: '合成修订号验收简历', targetRole: '软件开发', text: '项目经历\n围绕实际需求整理接口约定，负责真实业务维护并记录团队验收依据。' });
  return { store, service, saved, calls: () => calls };
}
async function completedJob(jobs: AnalysisJobs, id: string): Promise<AnalysisJob> {
  let job = await jobs.get(id);
  for (let attempt = 0; attempt < 50 && ['queued', 'running'].includes(job.status); attempt++) {
    await turn(); job = await jobs.get(id);
  }
  assert.ok(!['queued', 'running'].includes(job.status), 'a synthetic diagnosis must finish');
  return job;
}

test('analysis revision guard is optional for old clients but any supplied value must be a positive safe integer', () => {
  assert.deepEqual(validateAnalysisInput({ resumeId: 'synthetic-resume' }), { resumeId: 'synthetic-resume' });
  assert.equal(validateAnalysisInput({ resumeId: 'synthetic-resume', resumeRevision: 3 }).resumeRevision, 3);
  for (const resumeRevision of [undefined, null, '1', 0, -1, 1.5, false, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateAnalysisInput({ resumeId: 'synthetic-resume', resumeRevision }), hasCode('VALIDATION_ERROR'));
  }
  assert.throws(() => validateAnalysisInput({ resumeId: 'synthetic-resume', resumeRevision: 1, userId: 'other' }), hasCode('VALIDATION_ERROR'));
});

test('a stale expected analysis revision is rejected before the provider runs or any report is written', async t => {
  const f = await fixture(t);
  const current = await f.service.updateResume(f.saved.id, { title: '已保存的第二版', revision: 1 });
  await assert.rejects(f.service.analyze({ resumeId: f.saved.id, resumeRevision: 1, aiConsent: true }), hasCode('REVISION_CONFLICT'));
  assert.equal(f.calls(), 0);
  assert.deepEqual(await f.service.listAnalyses(f.saved.id), []);
  assert.deepEqual((await f.store.read()).analyses, []);
  const guarded = await f.service.analyze({ resumeId: current.id, resumeRevision: current.revision, aiConsent: true });
  assert.equal(guarded.resumeRevision, 2);
  const legacy = await f.service.analyze({ resumeId: current.id, aiConsent: true });
  assert.equal(legacy.resumeRevision, 2, 'old clients still analyze the latest saved snapshot');
  assert.equal(f.calls(), 2);
});

test('stale revision cannot enter the task queue or occupy its capacity, while matching and legacy requests still work', async t => {
  const f = await fixture(t), jobs = new AnalysisJobs(f.service);
  await f.service.updateResume(f.saved.id, { title: '任务提交前已更新', revision: 1 });
  await assert.rejects(jobs.start({ resumeId: f.saved.id, resumeRevision: 1, aiConsent: true }), hasCode('REVISION_CONFLICT'));
  await turn();
  assert.equal(f.calls(), 0);
  assert.deepEqual((await f.store.read()).analyses, []);
  const guarded = await jobs.start({ resumeId: f.saved.id, resumeRevision: 2, aiConsent: true });
  const result = await completedJob(jobs, guarded.id);
  assert.equal(result.status, 'completed');
  assert.equal((await f.service.getAnalysis(result.analysisId!)).resumeRevision, 2);
  const legacy = await jobs.start({ resumeId: f.saved.id, aiConsent: true });
  assert.equal((await completedJob(jobs, legacy.id)).status, 'completed');
  assert.equal(f.calls(), 2);
});

test('an edit after queue acceptance rejects the expected revision before execution rather than analyzing a different saved version', async t => {
  const f = await fixture(t), jobs = new AnalysisJobs(f.service);
  const queued = await jobs.start({ resumeId: f.saved.id, resumeRevision: 1, aiConsent: true });
  await f.service.updateResume(f.saved.id, { title: '排队期间已更新', revision: 1 });
  const rejected = await completedJob(jobs, queued.id);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error?.code, 'REVISION_CONFLICT');
  assert.equal(f.calls(), 0);
  assert.deepEqual((await f.store.read()).analyses, []);
});

test('revision checking never reveals another users current resume revision or calls a provider for that resource', async t => {
  const f = await fixture(t), jobs = new AnalysisJobs(f.service);
  await f.service.updateResume(f.saved.id, { title: '所有者的第二版', revision: 1 });
  const other = f.service.forUser('synthetic-other');
  for (const resumeRevision of [1, 2, 3]) {
    const input = { resumeId: f.saved.id, resumeRevision, aiConsent: true };
    await assert.rejects(other.analyze(input), error => hasCode('NOT_FOUND')(error) && (error as HttpError).status === 404);
    await assert.rejects(jobs.start(input, other), error => hasCode('NOT_FOUND')(error) && (error as HttpError).status === 404);
  }
  assert.equal(f.calls(), 0);
  assert.deepEqual((await f.store.read()).analyses, []);
  const ownJob = await jobs.start({ resumeId: f.saved.id, resumeRevision: 2, aiConsent: true });
  assert.equal((await completedJob(jobs, ownJob.id)).status, 'completed');
});
