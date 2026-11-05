import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BailianAnalysisProvider } from '../server/bailian.js';
import { HttpError } from '../server/errors.js';
import { AnalysisJobs } from '../server/jobs.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import type { AnalysisJob } from '../shared/types.js';

const config = { enabled: true, apiKey: 'sk-synthetic-testing-only', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus-2025-12-01' };
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function response(usage: unknown = { prompt_tokens: 4000, completion_tokens: 2000, total_tokens: 6000 }, valid = true) {
  return new Response(JSON.stringify({
    ...(usage === null ? {} : { usage }),
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid ? { summary: '请核对实际交付与验证依据。', issues: [], suggestions: [] } : { summary: 'invalid' }) } }],
  }), { headers: { 'Content-Type': 'application/json' } });
}
async function fixture(t: TestContext, fetcher: typeof fetch = async () => response(), paid = true) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-actual-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(join(directory, 'resumes.json'));
  const service = new ResumeService(store, new BailianAnalysisProvider(config, fetcher), 'quota-owner');
  const quota = new QuotaService(store);
  if (paid) await quota.activateMembership({ userId: service.userId, planId: 'basic', verifiedPaymentAt: new Date().toISOString(), verifiedEventId: 'verified-fixture-payment', idempotencyKey: 'activation-fixture' });
  const resume = await service.createResume({ title: '合成额度测试', targetRole: '软件开发', text: '项目经历\n负责真实业务接口开发，并整理实际项目的测试验收记录。' });
  const jobs = new AnalysisJobs(service, quota);
  const input = { resumeId: resume.id, resumeRevision: 1, aiConsent: true, idempotencyKey: 'diagnosis-fixture-once' };
  return { store, service, quota, resume, jobs, input };
}
async function completed(jobs: AnalysisJobs, id: string, service?: ResumeService): Promise<AnalysisJob> {
  let result = await jobs.get(id, service);
  for (let i = 0; i < 100 && ['queued', 'running'].includes(result.status); ++i) { await turn(); result = await jobs.get(id, service); }
  assert.ok(!['queued', 'running'].includes(result.status));
  return result;
}

test('actual input+output tokens settle once across concurrent submission, result replay and process reload', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  const [first, duplicate] = await Promise.all([f.jobs.start(f.input), f.jobs.start(f.input)]);
  assert.equal(first.id, duplicate.id);
  assert.equal((await completed(f.jobs, first.id)).status, 'completed');
  assert.equal(calls, 1);
  assert.equal((await f.quota.current(f.service.userId)).remainingPercent, 97);
  const rows = (await f.store.read()).aiUsage;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage?.totalTokens, 6000);
  await assert.rejects(f.jobs.start({ ...f.input, targetRole: '另一个岗位' }), hasCode('IDEMPOTENCY_CONFLICT'));
  const freshService = new ResumeService(new JsonStore(f.store.path), f.service.provider, f.service.userId);
  const restarted = new AnalysisJobs(freshService);
  assert.equal((await restarted.start(f.input)).id, first.id);
  assert.equal((await restarted.get(first.id)).status, 'completed');
  assert.equal(calls, 1);
  assert.equal((await restarted.quota.current(f.service.userId)).remainingPercent, 97);
  await assert.rejects(restarted.get(first.id, freshService.forUser('other-owner')), hasCode('NOT_FOUND'));
});

test('invalid model results are charged from actual supplier usage before validation fails', async t => {
  const f = await fixture(t, async () => response(undefined, false));
  const job = await f.jobs.start(f.input);
  assert.equal((await completed(f.jobs, job.id)).error?.code, 'MODEL_INVALID_OUTPUT');
  assert.equal((await f.service.listAnalyses(f.resume.id)).length, 0);
  assert.equal((await f.quota.current(f.service.userId)).remainingPercent, 97);
  assert.equal((await f.store.read()).aiUsage[0].status, 'settled');
});

test('one failed terminal-state write is retried locally without repeating a model call or leaving global capacity occupied', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(undefined, false); });
  const mutate = f.store.mutate.bind(f.store);
  let failedOnce = false;
  f.store.mutate = operation => mutate(async data => {
    const result = await operation(data);
    if (!failedOnce && data.analysisTasks.some(task => task.job.status === 'failed')) {
      failedOnce = true;
      throw new Error('Synthetic temporary disk failure');
    }
    return result;
  });
  const first = await f.jobs.start(f.input);
  assert.equal((await completed(f.jobs, first.id)).status, 'failed');
  const second = await f.jobs.start({ ...f.input, idempotencyKey: 'retry-after-known-failure' });
  assert.equal((await completed(f.jobs, second.id)).status, 'failed');
  assert.equal(calls, 2, 'two explicit user submissions; no automatic provider retry');
  assert.equal((await f.quota.current(f.service.userId)).remainingPercent, 94);
});

test('editing during generation prevents a stale report but does not refund already metered tokens', async t => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return response(); });
  const job = await f.jobs.start(f.input);
  await began;
  await f.service.updateResume(f.resume.id, { title: '生成期间的更新', revision: 1 });
  release();
  assert.equal((await completed(f.jobs, job.id)).error?.code, 'REVISION_CONFLICT');
  assert.equal((await f.quota.current(f.service.userId)).remainingPercent, 97);
  assert.equal((await f.service.listAnalyses(f.resume.id)).length, 0);
});

test('unknown usage stays pending across restart and blocks repeat model spend until trusted reconciliation', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(null); });
  const job = await f.jobs.start(f.input);
  assert.equal((await completed(f.jobs, job.id)).status, 'completed');
  // Completion persists with the report; allow the ledger finalizer to run too.
  for (let i = 0; i < 30 && (await f.store.read()).aiUsage[0].status === 'dispatched'; ++i) await turn();
  assert.equal((await f.store.read()).aiUsage[0].status, 'pending');
  const before = await f.quota.current(f.service.userId);
  assert.equal(before.remainingPercent, 100, 'unknown usage is not an invented actual charge');
  assert.equal(before.pending, true);
  const restarted = new AnalysisJobs(new ResumeService(new JsonStore(f.store.path), f.service.provider, f.service.userId));
  await restarted.get(job.id);
  await assert.rejects(restarted.start({ ...f.input, idempotencyKey: 'another-real-request' }), hasCode('QUOTA_TASK_PENDING'));
  assert.equal(calls, 1);
  await restarted.quota.reconcile(f.service.userId, job.id, { usage: { inputTokens: 4000, outputTokens: 2000, totalTokens: 6000, requestId: 'supplier-evidence-fixture' }, reason: '合成供应商账单核对', idempotencyKey: 'trusted-reconciliation' });
  assert.equal((await restarted.quota.current(f.service.userId)).remainingPercent, 97);
  assert.equal((await restarted.quota.current(f.service.userId)).pending, false);
});

test('queued cancellation never calls the provider and releases the unspent reservation', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  const job = await f.jobs.start(f.input);
  const cancelled = await f.jobs.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  await turn();
  assert.equal(calls, 0);
  assert.equal((await f.store.read()).aiUsage[0].status, 'released');
  assert.equal((await f.quota.current(f.service.userId)).remainingPercent, 100);
});

test('running cancellation still settles supplier-reported tokens and never writes a report', async t => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return response(); });
  const job = await f.jobs.start(f.input);
  await began;
  await f.jobs.cancel(job.id);
  release();
  assert.equal((await completed(f.jobs, job.id)).status, 'cancelled');
  assert.equal((await f.quota.current(f.service.userId)).remainingPercent, 97);
  assert.equal((await f.service.listAnalyses(f.resume.id)).length, 0);
});

test('paid requests require server revision+idempotency guards and cannot forge quota inputs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.jobs.start({ resumeId: f.resume.id, aiConsent: true }), hasCode('ANALYSIS_REQUEST_GUARD_REQUIRED'));
  for (const forged of [{ remainingPercent: 100 }, { userId: 'other-owner' }, { planId: 'premium' }, { usage: { totalTokens: 0 } }]) {
    await assert.rejects(f.jobs.start({ ...f.input, ...forged }), hasCode('VALIDATION_ERROR'));
  }
  assert.equal((await f.store.read()).aiUsage.length, 0);
});

test('preview can record supplier usage without inventing or enforcing a paid balance', async t => {
  const f = await fixture(t, async () => response(), false);
  const job = await f.jobs.start(f.input);
  assert.equal((await completed(f.jobs, job.id)).status, 'completed');
  const state = await f.quota.current(f.service.userId);
  assert.equal(state.status, 'preview');
  assert.equal(state.remainingPercent, null);
  assert.equal((await f.store.read()).aiUsage[0].usage?.totalTokens, 6000);
});

test('restart marks an interrupted dispatched task failed without replaying its model call or releasing unknown usage', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  const job = await f.jobs.start(f.input);
  await completed(f.jobs, job.id);
  // A crash snapshot: dispatch was durable, but neither the response nor report commit reached disk.
  await f.store.mutate(data => {
    data.analyses = [];
    const task = data.analysisTasks[0];
    task.job.status = 'running';
    delete task.job.analysisId;
    const row = data.aiUsage[0];
    row.status = 'dispatched';
    delete row.usage;
  });
  const fresh = new ResumeService(new JsonStore(f.store.path), f.service.provider, f.service.userId);
  const restarted = new AnalysisJobs(fresh);
  assert.equal((await restarted.get(job.id)).error?.code, 'JOB_INTERRUPTED');
  assert.equal((await restarted.start(f.input)).id, job.id);
  assert.equal((await fresh.store.read()).aiUsage[0].status, 'pending');
  assert.equal((await restarted.quota.current(f.service.userId)).pending, true);
  assert.equal(calls, 1, 'restart never replays a possibly billed provider request');
});
