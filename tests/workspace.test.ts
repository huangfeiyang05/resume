import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Analysis, AnalysisInput, ApplySuggestionResult, Resume, ResumeUpdateInput } from '../shared/types.js';
import { api, ApiError } from '../src/services/api.js';
import { useWorkspace } from '../src/services/workspace.js';

const originalText = '工作经历\n负责业务系统的接口维护、需求分析与日常问题处理，协作完成项目相关文档。';
function resume(id: string, revision = 1): Resume {
  return { id, title: `简历 ${id}`, targetRole: 'Java 开发', text: originalText, revision, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
}
function report(owner: Resume, id = `report-${owner.id}`): Analysis {
  return {
    id, resumeId: owner.id, resumeRevision: owner.revision,
    inputHash: 'test-input-hash', inputSnapshot: { text: owner.text, targetRole: owner.targetRole, jobDescription: '' },
    engine: 'rules', score: 60, summary: '检查表达', dimensions: [], issues: [], keywords: { matched: [], missing: [] },
    suggestions: [{ id: `suggestion-${owner.id}`, title: '补充真实贡献', original: owner.text, replacement: '描述经过核实的个人行动、真实业务背景和验证结果。', reason: '需要真实事实', needsConfirmation: true, applied: false }],
    createdAt: '2026-10-10T00:00:00.000Z', status: 'completed',
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t: TestContext, seeds = [resume('A'), resume('B')]) {
  const originalApi = { ...api };
  const globals = globalThis as typeof globalThis & { uni?: unknown };
  const originalUni = globals.uni;
  const storage = new Map<string, unknown>();
  const removed: string[] = [];
  globals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => { removed.push(key); storage.delete(key); },
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  api.resumes = async () => structuredClone(seeds);
  api.health = async () => ({ status: 'ok', analysisEngine: 'rules', aiConfigured: false, persistence: 'local-json' });
  api.analyses = async id => seeds.some(item => item.id === id) ? [report(seeds.find(item => item.id === id)!)] : [];
  api.deleteResume = async id => ({ id });
  t.after(() => { Object.assign(api, originalApi); globals.uni = originalUni; });
  return { w: useWorkspace({ autoLoad: false }), storage, removed };
}

test('restoring saved content preserves an unsaved editor and account scoped local draft', async t => {
  const { w, storage, removed } = fixture(t, [resume('A', 2)]);
  await w.refresh();
  w.openEditor(w.selected.value);
  w.editorText.value = '还没有保存的真实草稿：保留用户正在补充的实际经历和个人贡献。';
  w.saveDraft();
  const draft = structuredClone(storage.get('resume-draft-A'));
  api.resume = async () => ({ ...resume('A', 3), text: '历史内容已经恢复为新版本。' });
  await w.acceptRestoredResume({ ...resume('A', 3), text: '历史内容已经恢复为新版本。' });
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorBaseRevision.value, 2);
  assert.match(w.editorText.value, /还没有保存/);
  assert.deepEqual(storage.get('resume-draft-A'), draft);
  assert.equal(removed.includes('resume-draft-A'), false);
  assert.equal(w.selected.value?.revision, 3);
  api.resume = async () => resume('A', 2);
  await w.acceptRestoredResume(resume('A', 2));
  assert.equal(w.selected.value?.revision, 3, 'an idempotent replay cannot replace a newer locally known revision');
});

test('a replayed restore commit fetches the newer remotely saved revision before updating the workspace', async t => {
  const { w, storage } = fixture(t, [resume('A', 2)]);
  await w.refresh();
  w.openEditor(w.selected.value);
  w.editorText.value = '用户还没保存的实际项目草稿，不能被历史恢复或同步请求覆盖。';
  w.saveDraft();
  const draft = structuredClone(storage.get('resume-draft-A'));
  const remote = { ...resume('A', 4), text: '另一窗口在恢复后已保存第四版真实经历。' };
  let requestedId = '';
  api.resume = async id => { requestedId = id; return remote; };
  assert.equal(await w.acceptRestoredResume({ ...resume('A', 3), text: '幂等回执里的第三版历史内容。' }), true);
  assert.equal(requestedId, 'A');
  assert.equal(w.selected.value?.revision, 4);
  assert.equal(w.selected.value?.text, remote.text);
  assert.deepEqual(storage.get('resume-draft-A'), draft);
  assert.match(w.editorText.value, /用户还没保存/);
  assert.equal(w.editorBaseRevision.value, 2);
  assert.match(w.notice.value, /已同步最新简历/);
});

test('a restore followed by a failed latest GET keeps drafts and exposes stale state until a successful reload', async t => {
  const { w, storage } = fixture(t, [resume('A', 2)]);
  await w.refresh();
  w.openEditor(w.selected.value);
  w.editorText.value = '当前设备未保存的真实草稿，断网后的重新读取也要完整保留。';
  w.saveDraft();
  const draft = structuredClone(storage.get('resume-draft-A'));
  api.resume = async () => { throw new ApiError('网络断开', 'NETWORK_ERROR', 0); };
  assert.equal(await w.acceptRestoredResume(resume('A', 3)), false);
  assert.equal(w.selected.value?.revision, 2, 'the original commit must not be presented as a freshly loaded current snapshot');
  assert.match(w.loadError.value, /恢复已保存.*最新简历状态未同步/);
  assert.match(w.notice.value, /未保存草稿已保留/);
  assert.deepEqual(storage.get('resume-draft-A'), draft);
  assert.equal(w.editorBaseRevision.value, 2);
  api.resumes = async () => [{ ...resume('A', 4), text: '恢复后由另一窗口保存的最新简历。' }];
  await w.refresh();
  assert.equal(w.selected.value?.revision, 4);
  assert.equal(w.loadError.value, '');
  assert.deepEqual(storage.get('resume-draft-A'), draft);
  assert.match(w.editorText.value, /当前设备未保存/);
});

test('restoring an unselected resume refreshes its list entry without replacing the active resume or report', async t => {
  const { w } = fixture(t, [resume('A', 2), resume('B', 1)]);
  await w.refresh();
  await w.select('B');
  api.resume = async id => ({ ...resume(id, 4), text: '服务端第四版真实内容。' });
  assert.equal(await w.acceptRestoredResume(resume('A', 3)), true);
  assert.equal(w.resumes.value.find(item => item.id === 'A')?.revision, 4);
  assert.equal(w.selectedId.value, 'B');
  assert.equal(w.analysis.value?.resumeId, 'B');
});

test('a delayed latest GET after restoration cannot downgrade a newer local save or resurrect a deletion', async t => {
  const { w } = fixture(t, [resume('A', 2)]);
  await w.refresh();
  const pending = deferred<Resume>();
  api.resume = () => pending.promise;
  const synchronizing = w.acceptRestoredResume(resume('A', 3));
  w.resumes.value = [resume('A', 5)];
  pending.resolve(resume('A', 4));
  assert.equal(await synchronizing, true);
  assert.equal(w.selected.value?.revision, 5);
  const deleted = deferred<Resume>();
  api.resume = () => deleted.promise;
  const afterDelete = w.acceptRestoredResume(resume('A', 3));
  await w.remove(w.selected.value!);
  deleted.resolve(resume('A', 5));
  assert.equal(await afterDelete, false);
  assert.deepEqual(w.resumes.value, []);
});

test('a late history GET cannot overwrite a newly completed diagnosis', async t => {
  const { w } = fixture(t);
  await w.refresh();
  const pendingHistory = deferred<Analysis[]>();
  api.analyses = () => pendingHistory.promise;
  const selecting = w.select('A');
  const freshReport = report(resume('A'), 'new-diagnosis');
  api.analyze = async () => freshReport;
  assert.equal((await w.diagnoseResume())?.id, freshReport.id);
  pendingHistory.resolve([]);
  await selecting;
  assert.equal(w.analysis.value?.id, freshReport.id);
  assert.deepEqual(w.history.value.map(item => item.id), [freshReport.id]);
});

test('selection and diagnosis responses cannot put A reports under B', async t => {
  const { w } = fixture(t);
  await w.refresh();
  const oldHistory = deferred<Analysis[]>();
  api.analyses = id => id === 'A' ? oldHistory.promise : Promise.resolve([report(resume('B'))]);
  const selectA = w.select('A');
  await w.select('B');
  oldHistory.resolve([report(resume('A'))]);
  await selectA;
  assert.equal(w.selectedId.value, 'B');
  assert.equal(w.analysis.value?.resumeId, 'B');

  api.analyses = async id => [report(resume(id))];
  await w.select('A');
  const oldDiagnosis = deferred<Analysis>();
  api.analyze = () => oldDiagnosis.promise;
  const diagnosing = w.diagnoseResume();
  await w.select('B');
  oldDiagnosis.resolve(report(resume('A'), 'late-A'));
  assert.equal(await diagnosing, undefined);
  assert.equal(w.analysis.value?.resumeId, 'B');
});

test('a delayed apply updates its saved resume without replacing another selection report', async t => {
  const { w } = fixture(t);
  await w.refresh();
  const originalReport = report(resume('A'));
  w.activeSuggestion.value = originalReport.suggestions[0];
  const pending = deferred<ApplySuggestionResult>();
  api.apply = () => pending.promise;
  const applying = w.applySuggestion('真实业务描述，补充经过核实的个人行动与验收证据。', true);
  await w.select('B');
  const applied = report(resume('A'));
  applied.suggestions[0].applied = true;
  pending.resolve({ resume: { ...resume('A', 2), text: '已确认保存的实际经历。' }, analysis: applied, alreadyApplied: false });
  await applying;
  assert.equal(w.selectedId.value, 'B');
  assert.equal(w.analysis.value?.resumeId, 'B');
  assert.equal(w.resumes.value.find(item => item.id === 'A')?.revision, 2);
  assert.equal(w.activeSuggestion.value, undefined);
});

test('restored drafts submit their original revision and keep content when the server rejects a conflict', async t => {
  const { w, storage } = fixture(t, [resume('A', 2)]);
  await w.refresh();
  const draft = '旧版未保存草稿：负责原有业务系统开发维护，整理日常需求与问题处理记录。';
  storage.set('resume-draft-A', { title: '旧草稿', role: 'Java 开发', text: draft, baseRevision: 1 });
  w.openEditor(w.selected.value);
  let submitted: ResumeUpdateInput | undefined;
  api.updateResume = async (_id, body) => { submitted = body; throw new ApiError('简历已发生变化，请重新加载后再修改。', 'REVISION_CONFLICT', 409); };
  await w.saveEditor();
  assert.equal(submitted?.revision, 1);
  assert.equal(submitted?.text, draft);
  assert.equal(w.selected.value?.revision, 2);
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorText.value, draft);
  assert.ok(storage.has('resume-draft-A'));
  assert.match(w.notice.value, /重新加载/);
});

test('a save response does not close a subsequently opened editor or remove its draft', async t => {
  const { w, storage, removed } = fixture(t);
  await w.refresh();
  w.openEditor(w.selected.value);
  const pending = deferred<Resume>();
  api.updateResume = () => pending.promise;
  const saving = w.saveEditor();
  w.editorOpen.value = false;
  w.openEditor(w.resumes.value.find(item => item.id === 'B'));
  w.editorText.value = '新的 B 简历草稿：设计真实业务系统，记录实际贡献并保留项目验收的依据。';
  w.saveDraft();
  pending.resolve(resume('A', 2));
  await saving;
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorId.value, 'B');
  assert.ok(storage.has('resume-draft-B'));
  assert.equal(removed.includes('resume-draft-B'), false);
  assert.match(w.editorText.value, /新的 B/);
});

test('separate new-editor sessions sharing the new draft key remain isolated from a pending create', async t => {
  const { w, storage, removed } = fixture(t, []);
  w.openEditor(undefined, originalText, '第一次导入');
  const pending = deferred<Resume>();
  api.createResume = () => pending.promise;
  const saving = w.saveEditor(true);
  w.editorOpen.value = false;
  w.openEditor(undefined, '第二次导入的真实经历：负责另一项业务系统维护，独立整理问题与验收记录。', '第二次导入');
  w.saveDraft();
  pending.resolve(resume('saved-first-import'));
  await saving;
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorTitle.value, '第二次导入');
  assert.ok(storage.has('resume-draft-new'));
  assert.equal(removed.includes('resume-draft-new'), false);
  assert.equal(w.resumes.value.length, 1);
  assert.equal(w.analysis.value, undefined);
});

test('typing while a save is pending preserves newer edits with the newly saved base revision', async t => {
  const { w, storage } = fixture(t);
  await w.refresh();
  w.openEditor(w.selected.value);
  const pending = deferred<Resume>();
  api.updateResume = () => pending.promise;
  const saving = w.saveEditor();
  const nextText = `${originalText}\n提交后继续补充的真实教育背景与项目职责。`;
  w.editorText.value = nextText;
  pending.resolve(resume('A', 2));
  await saving;
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorText.value, nextText);
  assert.equal(w.editorBaseRevision.value, 2);
  assert.deepEqual(storage.get('resume-draft-A'), { title: '简历 A', role: 'Java 开发', text: nextText, baseRevision: 2 });
});

test('a late list refresh cannot resurrect a deleted resume and another resume stays selected', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.activeSuggestion.value = w.analysis.value!.suggestions[0];
  const pending = deferred<Resume[]>();
  api.resumes = () => pending.promise;
  const refreshing = w.refresh();
  await w.remove(w.selected.value!);
  pending.resolve([resume('A'), resume('B')]);
  await refreshing;
  assert.deepEqual(w.resumes.value.map(item => item.id), ['B']);
  assert.equal(w.selectedId.value, 'B');
  assert.equal(w.analysis.value?.resumeId, 'B');
  assert.equal(w.activeSuggestion.value, undefined);
});

test('the home diagnosis can return a report without navigating away', async t => {
  const { w } = fixture(t);
  await w.refresh();
  const result = report(resume('A'), 'home-report');
  api.analyze = async () => result;
  w.page.value = 'overview';
  assert.equal((await w.diagnoseResume(false, true))?.id, result.id);
  assert.equal(w.page.value, 'overview');
  assert.equal(w.analysis.value?.id, result.id);
  await w.diagnoseResume();
  assert.equal(w.page.value, 'diagnosis');
});

test('a home diagnosis without a JD uses the independently edited target role', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.targetRole.value = '  Python 算法工程师  ';
  w.jobDescription.value = '';
  let submitted: AnalysisInput | undefined;
  api.analyze = async input => { submitted = input; return report(resume('A'), 'role-only-report'); };
  await w.diagnoseResume(false, true);
  assert.deepEqual(submitted, { resumeId: 'A', targetRole: 'Python 算法工程师' });
  assert.equal(w.selected.value?.targetRole, 'Java 开发', 'analysis context does not silently rewrite the saved resume');
  assert.equal(w.analysis.value?.id, 'role-only-report');
});

test('stayOnPage saving does not replace a tab chosen while the save was pending', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.openEditor(w.selected.value);
  const pending = deferred<Resume>();
  api.updateResume = () => pending.promise;
  const saving = w.saveEditor(false, true);
  w.page.value = 'benefits';
  pending.resolve(resume('A', 2));
  await saving;
  assert.equal(w.page.value, 'benefits');
  assert.equal(w.editorOpen.value, false);
  assert.equal(w.selected.value?.revision, 2);
});

test('stayOnPage saving and diagnosis preserve a tab selected during diagnosis', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.openEditor(w.selected.value);
  api.updateResume = async () => resume('A', 2);
  const pending = deferred<Analysis>();
  const started = deferred<void>();
  api.analyze = () => { started.resolve(); return pending.promise; };
  const saving = w.saveEditor(true, true);
  await started.promise;
  w.page.value = 'benefits';
  pending.resolve(report(resume('A', 2), 'saved-home-report'));
  await saving;
  assert.equal(w.page.value, 'benefits');
  assert.equal(w.analysis.value?.id, 'saved-home-report');
  assert.equal(w.editorOpen.value, false);
});

test('stayOnPage example loading does not return from a subsequently selected benefits tab', async t => {
  const { w } = fixture(t, []);
  const pending = deferred<Resume>();
  api.createResume = () => pending.promise;
  api.analyze = async input => report(resume(input.resumeId), 'example-report');
  const loadingExample = w.useExample(true);
  w.page.value = 'benefits';
  pending.resolve(resume('example'));
  await loadingExample;
  assert.equal(w.page.value, 'benefits');
  assert.equal(w.selectedId.value, 'example');
  assert.equal(w.analysis.value?.id, 'example-report');
});

test('real-model diagnosis requires session consent and retrieves the completed report through a job', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.health.value = { status: 'ok', analysisEngine: 'bailian', aiConfigured: true, model: 'test-model', persistence: 'local-json' };
  let calls = 0;
  const fresh = { ...report(resume('A'), 'model-report'), engine: 'bailian' as const };
  api.startAnalysis = async input => {
    calls++;
    assert.equal(input.aiConsent, true);
    return { id: 'job', resumeId: 'A', status: 'queued', createdAt: '', updatedAt: '' };
  };
  api.job = async () => ({ id: 'job', resumeId: 'A', status: 'completed', analysisId: fresh.id, createdAt: '', updatedAt: '' });
  api.analysis = async () => fresh;
  assert.equal(await w.diagnoseResume(false, true), undefined);
  assert.equal(calls, 0);
  w.aiConsent.value = true;
  assert.equal((await w.diagnoseResume(false, true))?.id, fresh.id);
  assert.equal(calls, 1);
  assert.equal(w.aiConsent.value, true);
  assert.equal(w.analysisRunning.value, false);
});

test('cancellation while a model job is being created cancels its eventual ID without overwriting history', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.health.value = { status: 'ok', analysisEngine: 'bailian', aiConfigured: true, persistence: 'local-json' };
  const pending = deferred<Awaited<ReturnType<typeof api.startAnalysis>>>();
  api.startAnalysis = () => pending.promise;
  let cancellations = 0;
  api.cancelJob = async id => { cancellations++; return { id, resumeId: 'A', status: 'cancelled', createdAt: '', updatedAt: '' }; };
  w.aiConsent.value = true;
  const diagnosing = w.diagnoseResume(false, true);
  await w.cancelAnalysis();
  pending.resolve({ id: 'late-job', resumeId: 'A', status: 'queued', createdAt: '', updatedAt: '' });
  assert.equal(await diagnosing, undefined);
  assert.ok(cancellations >= 1);
  assert.equal(w.analysis.value?.engine, 'rules');
  assert.equal(w.analysisRunning.value, false);
});

test('the compact AI notice can be declined and an accepted page session does not prompt again', async t => {
  const { w } = fixture(t);
  await w.refresh();
  w.health.value = { status: 'ok', analysisEngine: 'bailian', aiConfigured: true, persistence: 'local-json' };
  let notices = 0, calls = 0, accept = false;
  Object.assign(uni, { showModal: (options: { success: (result: { confirm: boolean; cancel: boolean }) => void }) => { notices++; options.success({ confirm: accept, cancel: !accept }); } });
  api.startAnalysis = async () => { calls++; return { id: 'job', resumeId: 'A', status: 'queued', createdAt: '', updatedAt: '' }; };
  api.job = async () => ({ id: 'job', resumeId: 'A', status: 'completed', analysisId: 'model-report', createdAt: '', updatedAt: '' });
  api.analysis = async () => ({ ...report(resume('A'), 'model-report'), engine: 'bailian' });
  await w.diagnoseResume(false, true);
  assert.equal(calls, 0);
  assert.equal(w.aiConsent.value, false);
  accept = true;
  await w.diagnoseResume(false, true);
  await w.diagnoseResume(false, true);
  assert.equal(calls, 2);
  assert.equal(notices, 2, 'one declined notice and one accepted notice; subsequent request reuses this page-session consent');
});

test('assistant diagnosis binds the selected saved revision and preserves unsaved edits for review', async t => {
  const { w, storage } = fixture(t);
  await w.refresh();
  w.openEditor(w.selected.value);
  w.editorText.value = '用户还未保存的真实项目贡献，不应被助手或诊断覆盖。';
  w.saveDraft();
  const draft = structuredClone(storage.get('resume-draft-A'));
  api.resume = async id => resume(id);
  let submitted: AnalysisInput | undefined;
  api.analyze = async input => { submitted = input; return report(resume('B'), 'assistant-report'); };
  w.jobDescription.value = '上一岗位的职位要求，不能被当作本次助手诊断的JD。';
  const result = await w.analyzeFromAssistant({ resumeId: 'B', revision: 1, targetRole: '后端工程师' });
  assert.deepEqual(submitted, { resumeId: 'B', resumeRevision: 1, targetRole: '后端工程师' });
  assert.equal(result?.id, 'assistant-report');
  assert.equal(w.selectedId.value, 'B');
  assert.equal(w.jobDescription.value, '');
  assert.equal(w.editorOpen.value, true);
  assert.deepEqual(storage.get('resume-draft-A'), draft);
  assert.match(w.editorText.value, /还未保存/);
  assert.equal(w.selected.value?.revision, 1, 'diagnosis must not apply a change');
});

test('assistant diagnosis rejects a stale action before starting analysis and refreshes the listed revision', async t => {
  const { w } = fixture(t);
  await w.refresh();
  api.resume = async id => resume(id, 2);
  let calls = 0;
  api.analyze = async () => { calls++; return report(resume('A')); };
  assert.equal(await w.analyzeFromAssistant({ resumeId: 'A', revision: 1, targetRole: '后端工程师' }), undefined);
  assert.equal(calls, 0);
  assert.equal(w.selected.value?.revision, 2);
  assert.match(w.notice.value, /简历已更新/);
  assert.equal(w.busy.value, '');
});

test('leaving the assistant or changing resume while its version check is pending cannot start a diagnosis', async t => {
  const { w } = fixture(t);
  await w.refresh();
  const pending = deferred<Resume>();
  api.resume = () => pending.promise;
  let calls = 0;
  api.analyze = async () => { calls++; return report(resume('A')); };
  let active = true;
  const starting = w.analyzeFromAssistant({ resumeId: 'A', revision: 1, targetRole: '后端工程师' }, () => active);
  active = false;
  pending.resolve(resume('A'));
  assert.equal(await starting, undefined);
  const next = deferred<Resume>();
  api.resume = () => next.promise;
  const changing = w.analyzeFromAssistant({ resumeId: 'A', revision: 1, targetRole: '后端工程师' });
  await w.select('B');
  next.resolve(resume('A'));
  assert.equal(await changing, undefined);
  assert.equal(w.selectedId.value, 'B');
  assert.equal(calls, 0);
  assert.equal(w.busy.value, '');
});

test('leaving the assistant while health or model consent is pending cannot submit a later diagnosis', async t => {
  const { w } = fixture(t);
  await w.refresh();
  api.resume = async id => resume(id);
  let active = true, submissions = 0;
  const pendingHealth = deferred<NonNullable<typeof w.health.value>>(), healthStarted = deferred<void>();
  w.health.value = undefined;
  api.health = () => { healthStarted.resolve(); return pendingHealth.promise; };
  api.analyze = async () => { submissions++; return report(resume('A')); };
  api.startAnalysis = async () => { submissions++; throw new Error('No model job should be started after leaving.'); };
  const starting = w.analyzeFromAssistant({ resumeId: 'A', revision: 1, targetRole: '后端' }, () => active);
  await healthStarted.promise; active = false;
  pendingHealth.resolve({ status: 'ok', analysisEngine: 'rules', aiConfigured: false, persistence: 'local-json' });
  assert.equal(await starting, undefined); assert.equal(submissions, 0);
  active = true;
  w.health.value = { status: 'ok', analysisEngine: 'bailian', aiConfigured: true, persistence: 'local-json' };
  const consent = deferred<void>();
  let confirm!: () => void;
  (globalThis as any).uni.showModal = (options: any) => { confirm = () => options.success({ confirm: true }); consent.resolve(); };
  const consenting = w.analyzeFromAssistant({ resumeId: 'A', revision: 1, targetRole: '后端' }, () => active);
  await consent.promise; active = false; confirm();
  assert.equal(await consenting, undefined); assert.equal(submissions, 0);
});
