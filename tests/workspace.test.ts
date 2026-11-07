import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Analysis, AnalysisInput, ApplySuggestionResult, Resume, ResumeUpdateInput } from '../shared/types.js';
import { api, ApiError } from '../src/services/api.js';
import { useWorkspace } from '../src/services/workspace.js';
import { blankResumeText } from '../src/utils/example.js';
import type { ImportedResume } from '../src/utils/importResume.js';
import type { ImportSignal } from '../src/utils/importCancellation.js';

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
function imported(fileName = '已识别简历.docx', text = '工作经历\n文件中的真实岗位经历、实际职责与项目贡献，需由用户核对后保存。'): ImportedResume {
  return { fileName, text, format: fileName.endsWith('.pdf') ? 'pdf' : 'docx' };
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

test('an imported file fills only default new-editor content, preserves the chosen role and remains a local draft', async t => {
  const { w, storage } = fixture(t, []);
  let writes = 0;
  api.createResume = async () => { writes++; return resume('unexpected'); };
  api.analyze = async () => { writes++; return report(resume('unexpected')); };
  w.openEditor();
  w.editorRole.value = '后端工程师';
  const result = imported();
  assert.equal(await w.importEditorFile(async (_signal, onParsing) => { onParsing(); return result; }), true);
  assert.equal(w.editorText.value, result.text);
  assert.equal(w.editorTitle.value, '已识别简历');
  assert.equal(w.editorRole.value, '后端工程师');
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorImportBusy.value, false);
  assert.equal(w.editorImportPreview.value, undefined);
  assert.equal(writes, 0, 'file extraction never saves or diagnoses automatically');
  assert.deepEqual(storage.get('resume-draft-new'), { title: '已识别简历', role: '后端工程师', text: result.text, baseRevision: undefined });
  w.openEditor(undefined, '', '用户自定名称');
  await w.importEditorFile(async () => imported('a'.repeat(140) + '.pdf'));
  assert.equal(w.editorTitle.value, '用户自定名称');
  w.openEditor(undefined, '', '我的第一份简历');
  await w.importEditorFile(async () => imported('a'.repeat(140) + '.pdf'));
  assert.equal(w.editorTitle.value, 'a'.repeat(100));
});

test('importing over an existing resume requires preview confirmation and retains its revision and identity', async t => {
  const { w, storage } = fixture(t);
  const existing = resume('A', 3), result = imported('新文件.pdf');
  let submissions = 0;
  api.updateResume = async (id, input) => {
    submissions++;
    assert.equal(id, existing.id); assert.equal(input.revision, 3); assert.equal(input.text, result.text);
    return { ...existing, ...input, revision: 4 };
  };
  w.openEditor(existing);
  assert.equal(await w.importEditorFile(async () => result), true);
  assert.equal(w.editorText.value, existing.text);
  assert.deepEqual(w.editorImportPreview.value, result);
  await w.saveEditor(true);
  assert.equal(submissions, 0, 'unreviewed import blocks both save modes');
  assert.equal(w.confirmEditorImport(), true);
  assert.equal(w.editorId.value, existing.id);
  assert.equal(w.editorBaseRevision.value, 3);
  assert.equal(w.editorTitle.value, existing.title);
  assert.equal(w.editorRole.value, existing.targetRole);
  assert.equal(w.editorText.value, result.text);
  assert.equal(w.editorImportPreview.value, undefined);
  assert.equal((storage.get('resume-draft-A') as { baseRevision: number }).baseRevision, 3);
  await w.saveEditor();
  assert.equal(submissions, 1);
});

test('typing during file parsing keeps the text and requests explicit review; later typing invalidates that review', async t => {
  const { w, storage } = fixture(t, []);
  w.openEditor();
  const pending = deferred<ImportedResume>();
  const parsing = w.importEditorFile((_signal, onParsing) => { onParsing(); return pending.promise; });
  const typed = '选择文件后补充的实际经历：维护业务接口，整理需求和验收资料。';
  w.editorText.value = typed; w.saveDraft();
  pending.resolve(imported());
  assert.equal(await parsing, true);
  assert.equal(w.editorText.value, typed);
  assert.ok(w.editorImportPreview.value);
  const newer = typed + '\n预览期间继续补充的真实项目职责。';
  w.editorText.value = newer; w.saveDraft();
  assert.equal(w.confirmEditorImport(), false);
  assert.equal(w.editorText.value, newer);
  assert.equal(w.editorImportPreview.value, undefined);
  assert.match(w.editorImportError.value, /正文已更新.*重新选择/);
  assert.equal((storage.get('resume-draft-new') as { text: string }).text, newer);
});

test('cancelling an import preview preserves the current draft and allows explicitly saving that original content', async t => {
  const { w, storage } = fixture(t, []);
  w.openEditor(undefined, originalText, '手动草稿'); w.saveDraft();
  const before = structuredClone(storage.get('resume-draft-new'));
  let submissions = 0;
  api.createResume = async input => { submissions++; assert.equal(input.text, originalText); return { ...resume('saved-original'), ...input }; };
  await w.importEditorFile(async () => imported());
  await w.saveEditor();
  assert.equal(submissions, 0);
  assert.deepEqual(storage.get('resume-draft-new'), before);
  w.cancelEditorImport();
  assert.equal(w.editorImportPreview.value, undefined);
  assert.equal(w.editorText.value, originalText);
  await w.saveEditor();
  assert.equal(submissions, 1);
});

test('closing an editor aborts file work, keeps its draft and cannot be undone by a late parse result', async t => {
  const { w, storage } = fixture(t, []);
  w.openEditor(undefined, originalText, '等待解析的草稿');
  const pending = deferred<ImportedResume>();
  let signal!: ImportSignal;
  const parsing = w.importEditorFile((current, onParsing) => { signal = current; onParsing(); return pending.promise; });
  assert.equal(w.editorImportBusy.value, true);
  w.closeEditor();
  assert.equal(signal.aborted, true);
  assert.equal(await parsing, false, 'cancellation finishes even if a parser never acknowledges it');
  assert.equal(w.editorImportBusy.value, false);
  assert.equal(w.editorOpen.value, false);
  const draft = structuredClone(storage.get('resume-draft-new'));
  pending.resolve(imported()); await Promise.resolve();
  assert.equal(w.editorOpen.value, false);
  assert.equal(w.editorImportPreview.value, undefined);
  assert.equal(w.editorImportError.value, '');
  assert.deepEqual(storage.get('resume-draft-new'), draft);
  assert.equal((draft as { text: string }).text, originalText);
});

test('opening another new-editor session invalidates an earlier file choice even when both use the same draft key', async t => {
  const { w } = fixture(t, []);
  w.openEditor();
  const pending = deferred<ImportedResume>();
  let signal!: ImportSignal;
  const first = w.importEditorFile(current => { signal = current; return pending.promise; });
  w.openEditor(undefined, blankResumeText, '第二次新建');
  assert.equal(signal.aborted, true);
  assert.equal(await first, false);
  pending.resolve(imported()); await Promise.resolve();
  assert.equal(w.editorOpen.value, true);
  assert.equal(w.editorId.value, '');
  assert.equal(w.editorTitle.value, '第二次新建');
  assert.equal(w.editorText.value, blankResumeText);
  assert.equal(w.editorImportPreview.value, undefined);
});

test('an old import cannot clear a later request busy state or overwrite the later file', async t => {
  const { w } = fixture(t, []);
  w.openEditor();
  const firstResult = deferred<ImportedResume>(), secondResult = deferred<ImportedResume>();
  const first = w.importEditorFile((_signal, onParsing) => { onParsing(); return firstResult.promise; });
  const second = w.importEditorFile((_signal, onParsing) => { onParsing(); return secondResult.promise; });
  assert.equal(await first, false);
  assert.equal(w.editorImportBusy.value, true);
  firstResult.resolve(imported('过时文件.docx')); await Promise.resolve();
  assert.equal(w.editorImportBusy.value, true);
  secondResult.resolve(imported('当前文件.docx', '当前文件中明确记录的真实经历与项目职责，需要在保存之前进行核对。'));
  assert.equal(await second, true);
  assert.equal(w.editorTitle.value, '当前文件');
  assert.match(w.editorText.value, /^当前文件/);
  assert.equal(w.editorImportBusy.value, false);
});

test('file errors and a cancelled chooser leave existing text and local drafts unchanged', async t => {
  const { w, storage } = fixture(t);
  w.openEditor(resume('A')); w.saveDraft();
  const draft = structuredClone(storage.get('resume-draft-A'));
  assert.equal(await w.importEditorFile(async (_signal, onParsing) => { onParsing(); throw new Error('合成损坏文件'); }), false);
  assert.match(w.editorImportError.value, /合成损坏文件/);
  assert.equal(w.editorImportBusy.value, false);
  assert.equal(w.editorText.value, originalText);
  assert.deepEqual(storage.get('resume-draft-A'), draft);
  assert.equal(await w.importEditorFile(async () => undefined), false);
  assert.equal(w.editorImportError.value, '');
  assert.equal(w.editorImportPreview.value, undefined);
  assert.deepEqual(storage.get('resume-draft-A'), draft);
});

test('file timeout starts when parsing begins, aborts work and discards its late output', async t => {
  const { w } = fixture(t, []);
  w.openEditor();
  const pending = deferred<ImportedResume>();
  let beginParsing!: () => void, signal!: ImportSignal;
  const parsing = w.importEditorFile((current, onParsing) => { signal = current; beginParsing = onParsing; return pending.promise; });
  t.mock.timers.tick(45_000);
  assert.equal(w.editorImportBusy.value, true, 'time spent using a native file chooser is not parsing time');
  assert.equal(signal.aborted, false);
  beginParsing();
  t.mock.timers.tick(10_000); beginParsing();
  t.mock.timers.tick(19_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.equal(await parsing, false);
  assert.equal(w.editorImportBusy.value, false);
  assert.match(w.editorImportError.value, /解析超时/);
  pending.resolve(imported()); await Promise.resolve();
  assert.equal(w.editorText.value, blankResumeText);
  assert.equal(w.editorImportPreview.value, undefined);
});

test('saving during an active file selection is blocked and closed or saving editors never start new file work', async t => {
  const { w } = fixture(t, []);
  let started = 0, submitted = 0;
  assert.equal(await w.importEditorFile(async () => { started++; return imported(); }), false);
  w.openEditor(undefined, originalText);
  const pending = deferred<ImportedResume>();
  const parsing = w.importEditorFile(() => { started++; return pending.promise; });
  api.createResume = async () => { submitted++; return resume('unexpected'); };
  await w.saveEditor(true);
  assert.equal(submitted, 0);
  w.cancelEditorImport(); await parsing;
  w.busy.value = '正在保存简历';
  assert.equal(await w.importEditorFile(async () => { started++; return imported(); }), false);
  assert.equal(started, 1);
  assert.match(w.editorImportError.value, /等待当前操作完成/);
  assert.equal(w.editorText.value, originalText);
});

test('clipboard-style imports and cancellation work without a native AbortController and retain a default title', async t => {
  const { w } = fixture(t, []);
  const globals = globalThis as typeof globalThis & { AbortController?: typeof AbortController };
  const originalController = globals.AbortController;
  Object.defineProperty(globals, 'AbortController', { value: undefined, writable: true, configurable: true });
  t.after(() => { Object.defineProperty(globals, 'AbortController', { value: originalController, writable: true, configurable: true }); });
  w.openEditor();
  assert.equal(await w.importEditorFile(async (_signal, onParsing) => { onParsing(); return imported(''); }), true);
  assert.equal(w.editorTitle.value, '我的第一份简历');
  assert.equal(w.editorText.value, imported('').text);
  const pending = deferred<ImportedResume>();
  let signal!: ImportSignal;
  const importing = w.importEditorFile((current, onParsing) => { signal = current; onParsing(); return pending.promise; });
  w.cancelEditorImport();
  assert.equal(signal.aborted, true);
  assert.equal(await importing, false);
  assert.equal(w.editorText.value, imported('').text);
  assert.equal(w.editorImportError.value, '');
});
