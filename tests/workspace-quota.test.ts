import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Analysis, AnalysisInput, AnalysisJob, Resume } from '../shared/types.js';
import { api, ApiError } from '../src/services/api.js';
import { useWorkspace } from '../src/services/workspace.js';

const saved: Resume = { id: 'resume-a', title: '真实简历', targetRole: '后端工程师', text: '项目经历\n负责真实业务的接口维护与测试，整理验收资料。', revision: 1, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' };
const report: Analysis = { id: 'report-a', resumeId: saved.id, resumeRevision: 1, inputHash: 'input-hash', inputSnapshot: { text: saved.text, targetRole: saved.targetRole, jobDescription: '' }, engine: 'bailian', score: 60, summary: '待核实的模型建议', dimensions: [], issues: [], suggestions: [], keywords: { matched: [], missing: [] }, createdAt: '2026-11-05T00:00:00Z', status: 'completed' };
const job = (status: AnalysisJob['status']): AnalysisJob => ({ id: 'job-a', resumeId: saved.id, status, createdAt: '', updatedAt: '', ...(status === 'completed' ? { analysisId: report.id } : {}) });

function fixture(t: TestContext) {
  const originalApi = { ...api };
  const globals = globalThis as typeof globalThis & { uni?: unknown };
  const originalUni = globals.uni;
  const storage = new Map<string, unknown>();
  globals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => storage.delete(key),
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  api.resumes = async () => [structuredClone(saved)];
  api.health = async () => ({ status: 'ok', analysisEngine: 'bailian', aiConfigured: true, persistence: 'local-json' });
  api.analyses = async () => [];
  api.analysis = async () => structuredClone(report);
  api.job = async () => job('completed');
  api.cancelJob = async () => job('running');
  t.after(() => { Object.assign(api, originalApi); globals.uni = originalUni; });
  async function workspace(userId = 'account-a') {
    const w = useWorkspace({ autoLoad: false, userId });
    await w.refresh();
    w.aiConsent.value = true;
    return w;
  }
  return { storage, workspace };
}

test('an uncertain submission reuses its persisted identity after reconnect and workspace recreation', async t => {
  const { storage, workspace } = fixture(t);
  const inputs: AnalysisInput[] = [];
  api.startAnalysis = async input => {
    inputs.push(input);
    if (inputs.length === 1) throw new ApiError('连接中断', 'NETWORK_ERROR', 0);
    return job('queued');
  };
  const first = await workspace();
  assert.equal(await first.diagnoseResume(), undefined);
  assert.equal(inputs[0].resumeRevision, 1);
  assert.match(inputs[0].idempotencyKey!, /^[A-Za-z0-9_-]{8,100}$/);
  assert.ok(storage.has('resume-user-account-a-analysis-requests'));
  assert.equal(JSON.stringify(storage.get('resume-user-account-a-analysis-requests')).includes(saved.text), false, 'request identity does not duplicate the resume body');
  const reconnected = await workspace();
  assert.equal((await reconnected.diagnoseResume())?.id, report.id);
  assert.equal(inputs[1].idempotencyKey, inputs[0].idempotencyKey);
  assert.deepEqual(storage.get('resume-user-account-a-analysis-requests'), []);
});

test('a known job with an uncertain polling result is recovered without submitting a second model task', async t => {
  const { workspace } = fixture(t);
  let submissions = 0, unavailable = true;
  api.startAnalysis = async () => { ++submissions; return job('queued'); };
  api.job = async () => {
    if (unavailable) throw new ApiError('连接中断', 'NETWORK_ERROR', 0);
    return job('completed');
  };
  const w = await workspace();
  assert.equal(await w.diagnoseResume(), undefined);
  unavailable = false;
  assert.equal((await w.diagnoseResume())?.id, report.id);
  assert.equal(submissions, 1);
});

test('changed revisions, role or JD and a different account receive distinct request identities', async t => {
  const { workspace } = fixture(t);
  const inputs: AnalysisInput[] = [];
  api.startAnalysis = async input => { inputs.push(input); throw new ApiError('连接中断', 'NETWORK_ERROR', 0); };
  const w = await workspace();
  await w.diagnoseResume();
  w.targetRole.value = '数据分析师';
  await w.diagnoseResume();
  w.jobDescription.value = '岗位职责包括真实业务的数据分析、报表整理和结果核对。';
  await w.diagnoseResume(true);
  w.resumes.value = [{ ...saved, revision: 2 }];
  await w.diagnoseResume(true);
  const other = await workspace('account-b');
  await other.diagnoseResume();
  assert.equal(new Set(inputs.map(input => input.idempotencyKey)).size, inputs.length);
  assert.equal(inputs[3].resumeRevision, 2);
});

test('a confirmed terminal failure permits a deliberate new attempt with a fresh identity', async t => {
  const { workspace, storage } = fixture(t);
  const keys: string[] = [];
  api.startAnalysis = async input => { keys.push(input.idempotencyKey!); return job('queued'); };
  api.job = async () => ({ ...job('failed'), error: { code: 'MODEL_INVALID_OUTPUT', message: '结果未通过校验。' } });
  const w = await workspace();
  await w.diagnoseResume();
  assert.deepEqual(storage.get('resume-user-account-a-analysis-requests'), []);
  await w.diagnoseResume();
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('an inability to persist the request identity prevents dispatching a billable call', async t => {
  const { workspace } = fixture(t);
  const w = await workspace();
  let submissions = 0;
  api.startAnalysis = async () => { ++submissions; return job('queued'); };
  Object.assign(uni, { setStorageSync: () => { throw new Error('storage unavailable'); } });
  await w.diagnoseResume();
  assert.equal(submissions, 0);
  assert.match(w.notice.value, /无法保存诊断请求标识/);
});
