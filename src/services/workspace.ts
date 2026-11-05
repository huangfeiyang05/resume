import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Analysis, AnalysisSuggestion, Resume, Health } from '../../shared/types';
import { api, ApiError } from './api';
import { blankResumeText, exampleResume } from '../utils/example';
import { inputLimits } from '../../shared/limits';

export type Page = 'overview' | 'benefits' | 'resumes' | 'diagnosis' | 'match' | 'templates' | 'career';
export function useWorkspace(options: { autoLoad?: boolean; userId?: string } = {}) {
  // Existing anonymous development drafts are never imported into a registered account.
  const draftKey = (id: string) => options.userId ? `resume-user-${options.userId}-draft-${id || 'new'}` : `resume-draft-${id || 'new'}`;
  const page = ref<Page>('overview');
  const resumes = ref<Resume[]>([]);
  const selectedId = ref('');
  const selected = computed(() => resumes.value.find(r => r.id === selectedId.value));
  const analysis = ref<Analysis>();
  const history = ref<Analysis[]>([]);
  const busy = ref('');
  const loading = ref(true);
  const loadError = ref('');
  const notice = ref('');
  const editorOpen = ref(false);
  const editorId = ref('');
  const editorTitle = ref('');
  const editorRole = ref('');
  const editorText = ref('');
  const editorBaseRevision = ref<number>();
  const jobDescription = ref('');
  const targetRole = ref('');
  const activeSuggestion = ref<AnalysisSuggestion>();
  const health = ref<Health>();
  const aiConsent = ref(false);
  let consentPrompt: Promise<boolean> | undefined;
  // Keep uncertain submissions across reconnects/reloads so a retry cannot create a second model call.
  const pendingAnalysisStorageKey = options.userId ? `resume-user-${options.userId}-analysis-requests` : 'resume-analysis-requests';
  type PendingAnalysis = { fingerprint: string; key: string; jobId?: string };
  let pendingAnalysisRequests: PendingAnalysis[] = [];
  try {
    const stored: unknown = uni.getStorageSync(pendingAnalysisStorageKey);
    if (Array.isArray(stored)) pendingAnalysisRequests = stored.filter((item): item is PendingAnalysis => !!item && typeof item === 'object'
      && typeof item.fingerprint === 'string' && item.fingerprint.length <= 30_000
      && typeof item.key === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(item.key)
      && (item.jobId === undefined || typeof item.jobId === 'string')).slice(0, 20);
  } catch { /* A new submission must successfully persist its identity below before dispatch. */ }
  function persistPendingAnalysis(required = false) {
    try { uni.setStorageSync(pendingAnalysisStorageKey, pendingAnalysisRequests.map(item => ({ ...item }))); }
    catch {
      if (required) throw new ApiError('无法保存诊断请求标识，请检查设备存储后重试。', 'REQUEST_ID_STORAGE_FAILED', 0);
    }
  }
  function pendingAnalysis(input: Parameters<typeof api.analyze>[0]): PendingAnalysis {
    const fingerprint = JSON.stringify([input.resumeId, input.resumeRevision, input.targetRole ?? '', input.jobDescription ?? '']);
    const existing = pendingAnalysisRequests.find(item => item.fingerprint === fingerprint);
    if (existing) return existing;
    if (pendingAnalysisRequests.length >= 20) throw new ApiError('尚有诊断请求状态未确认，请先查看诊断历史或稍后重试。', 'ANALYSIS_STATUS_PENDING', 409);
    const uuid = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID()
      : `analysis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const entry = { fingerprint, key: uuid };
    pendingAnalysisRequests.push(entry);
    try { persistPendingAnalysis(true); }
    catch (error) { pendingAnalysisRequests = pendingAnalysisRequests.filter(item => item !== entry); throw error; }
    return entry;
  }
  function finishPendingAnalysis(entry: PendingAnalysis) {
    pendingAnalysisRequests = pendingAnalysisRequests.filter(item => item.key !== entry.key);
    persistPendingAnalysis();
  }
  const analysisRunning = ref(false);
  let activeJob = '';
  let cancelRequested = false;
  let wakePoll: (() => void) | undefined;
  let disposed = false;
  let noticeTimeout: ReturnType<typeof setTimeout>;
  let selectionRequest = 0;
  let reportRequest = 0;
  let refreshRequest = 0;
  let listRevision = 0;
  let editorSession = 0;
  let restorationRequest = 0;
  let assistantRequest = 0;
  function toast(message: string) { notice.value = message; clearTimeout(noticeTimeout); noticeTimeout = setTimeout(() => notice.value = '', 5000); }
  function fail(error: unknown) { toast(error instanceof Error ? error.message : '操作失败，请重试。'); }
  async function refresh() {
    const requestId = ++refreshRequest, revision = listRevision;
    loading.value = true; loadError.value = '';
    try {
      const [result] = await Promise.all([api.resumes(), loadHealth()]);
      // An initial/reconnect GET must not undo a save or deletion completed while it was pending.
      if (requestId !== refreshRequest || revision !== listRevision) return;
      resumes.value = result;
      if (!resumes.value.some(r => r.id === selectedId.value)) {
        if (resumes.value.length) await select(resumes.value[0].id);
        else clearSelection();
      }
    }
    catch (error) { if (requestId === refreshRequest) loadError.value = error instanceof Error ? error.message : '加载失败'; }
    finally { if (requestId === refreshRequest) loading.value = false; }
  }
  async function loadHealth() {
    try { health.value = await api.health(); } catch { health.value = undefined; }
  }
  async function confirmModelProcessing(): Promise<boolean> {
    if (aiConsent.value) return true;
    if (typeof uni.showModal !== 'function') return false;
    if (!consentPrompt) {
      consentPrompt = new Promise<boolean>(resolve => {
        uni.showModal({
          title: 'AI 简历分析',
          content: '分析时会将简历与岗位要求发送至阿里云百炼（北京）。手机号、邮箱和身份证号会自动遮盖，姓名与其他经历仍可能包含个人信息。',
          confirmText: '同意分析', cancelText: '暂不分析',
          success: result => { aiConsent.value = result.confirm; resolve(result.confirm); },
          fail: () => resolve(false),
        });
      }).finally(() => { consentPrompt = undefined; });
    }
    return consentPrompt;
  }
  async function cancelAnalysis() {
    cancelRequested = true;
    wakePoll?.();
    if (activeJob) {
      try { await api.cancelJob(activeJob); }
      catch (error) { if (!disposed) fail(error); }
    }
  }
  async function modelAnalysis(input: Parameters<typeof api.analyze>[0]): Promise<Analysis> {
    cancelRequested = false;
    const savedRevision = input.resumeRevision ?? resumes.value.find(item => item.id === input.resumeId)?.revision;
    if (savedRevision === undefined) throw new ApiError('请先载入已保存的简历，再发起诊断。', 'REVISION_REQUIRED', 409);
    const submission = { ...input, resumeRevision: savedRevision };
    const pending = pendingAnalysis(submission);
    const job = pending.jobId ? await api.job(pending.jobId)
      : await api.startAnalysis({ ...submission, aiConsent: true, idempotencyKey: pending.key });
    pending.jobId = job.id;
    persistPendingAnalysis();
    activeJob = job.id;
    const deadline = Date.now() + 60_000;
    try {
      while (true) {
        if (cancelRequested || disposed) {
          const cancelled = await api.cancelJob(job.id);
          if (cancelled.status === 'completed' && cancelled.analysisId) {
            const result = await api.analysis(cancelled.analysisId);
            finishPendingAnalysis(pending);
            return result;
          }
          if (cancelled.status === 'cancelled' || cancelled.status === 'failed') finishPendingAnalysis(pending);
          throw new ApiError('诊断已请求取消，未应用任何修改。', 'ANALYSIS_CANCELLED', 409);
        }
        const current = await api.job(job.id);
        if (current.status === 'completed' && current.analysisId) {
          const result = await api.analysis(current.analysisId);
          finishPendingAnalysis(pending);
          return result;
        }
        if (current.status === 'failed' || current.status === 'cancelled') {
          finishPendingAnalysis(pending);
          throw new ApiError(current.error?.message || '诊断已取消。', current.error?.code || 'ANALYSIS_CANCELLED', 400);
        }
        if (Date.now() > deadline) { await api.cancelJob(job.id); throw new ApiError('等待报告超时，已请求取消；可在诊断历史中查看是否已完成。', 'MODEL_TIMEOUT', 504); }
        busy.value = current.status === 'queued' ? '诊断任务已提交' : '千问正在分析，可随时取消';
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wakePoll = undefined; resolve(); }, 800);
          wakePoll = () => { clearTimeout(timer); wakePoll = undefined; resolve(); };
        });
      }
    } catch (error) {
      // Cancel on a polling failure, but retain the identity until a terminal state is actually observed.
      await api.cancelJob(job.id).catch(() => undefined);
      throw error;
    } finally { activeJob = ''; }
  }
  function upsert(resume: Resume) { ++listRevision; resumes.value = [resume, ...resumes.value.filter(r => r.id !== resume.id)]; }
  function clearSelection() {
    ++selectionRequest; ++reportRequest;
    selectedId.value = ''; analysis.value = undefined; history.value = []; activeSuggestion.value = undefined; targetRole.value = '';
  }
  async function select(id: string) {
    const requestId = ++selectionRequest;
    const reportId = ++reportRequest;
    selectedId.value = id; analysis.value = undefined; history.value = [];
    activeSuggestion.value = undefined;
    targetRole.value = selected.value?.targetRole || '';
    try { const result = await api.analyses(id); if (requestId === selectionRequest && reportId === reportRequest) { history.value = result; analysis.value = result[0]; } }
    catch (error) { if (requestId === selectionRequest && reportId === reportRequest) fail(error); }
  }
  function openEditor(resume?: Resume, text?: string, title?: string) {
    ++editorSession;
    editorId.value = resume?.id || '';
    const key = draftKey(editorId.value);
    const draft = (text === undefined ? uni.getStorageSync(key) : undefined) as { title?: string; role?: string; text?: string; baseRevision?: number } | undefined;
    editorBaseRevision.value = resume ? (typeof draft?.text === 'string' ? draft.baseRevision ?? 0 : resume.revision) : undefined;
    editorTitle.value = title || draft?.title || resume?.title || '我的第一份简历';
    editorRole.value = draft?.role || resume?.targetRole || '';
    editorText.value = text ?? draft?.text ?? resume?.text ?? blankResumeText;
    editorOpen.value = true;
  }
  function saveDraft() {
    if (editorOpen.value) uni.setStorageSync(draftKey(editorId.value), { title: editorTitle.value, role: editorRole.value, text: editorText.value, baseRevision: editorBaseRevision.value });
  }
  async function reloadEditor() {
    if (!editorId.value || busy.value) return;
    const id = editorId.value, session = editorSession;
    busy.value = '正在载入最新简历';
    try {
      const resume = await api.resume(id); upsert(resume);
      if (session !== editorSession || !editorOpen.value) return;
      uni.removeStorageSync(draftKey(resume.id)); openEditor(resume);
      toast('已载入最新保存的简历。');
    } catch (error) { fail(error); } finally { busy.value = ''; }
  }
  async function saveEditor(diagnose = false, stayOnPage = false) {
    if (busy.value) return;
    if (!editorTitle.value.trim() || editorText.value.trim().length < 20) { toast('请填写简历名称，并输入至少 20 字的简历内容。'); return; }
    if (editorText.value.length > inputLimits.resumeText) { toast(`简历正文不能超过 ${inputLimits.resumeText} 个字符，请精简后保存。`); return; }
    const id = editorId.value, session = editorSession, revision = editorBaseRevision.value;
    const savingDraftKey = draftKey(id);
    const body = { title: editorTitle.value.trim(), targetRole: editorRole.value.trim(), text: editorText.value.trim() };
    busy.value = '正在保存简历';
    try {
      const resume = id ? await api.updateResume(id, { ...body, revision: revision ?? 0 }) : await api.createResume(body);
      upsert(resume);
      // Closing and reopening an editor starts a new session, even when both drafts use the "new" key.
      if (session !== editorSession) { toast('提交的简历已保存，当前编辑草稿已保留。'); return; }
      if (editorOpen.value && (editorTitle.value.trim() !== body.title || editorRole.value.trim() !== body.targetRole || editorText.value.trim() !== body.text)) {
        editorId.value = resume.id; editorBaseRevision.value = resume.revision;
        if (!id) uni.removeStorageSync(savingDraftKey);
        saveDraft(); toast('提交的内容已保存，后续修改仍保留在编辑器中。'); return;
      }
      uni.removeStorageSync(savingDraftKey);
      toast('简历已保存。每一份经历，都值得认真对待。');
      if (!editorOpen.value) return;
      editorOpen.value = false;
      const selecting = select(resume.id), selectionId = selectionRequest;
      await selecting;
      if (session !== editorSession || selectionId !== selectionRequest || selectedId.value !== resume.id) return;
      busy.value = '';
      if (diagnose) await diagnoseResume(false, stayOnPage); else if (!stayOnPage) page.value = 'resumes';
    } catch (error) { fail(error); } finally { busy.value = ''; }
  }
  async function useExample(stayOnPage = false) {
    if (busy.value) return;
    busy.value = '正在载入示例';
    try {
      let resume = resumes.value.find(r => r.title === exampleResume.title);
      if (!resume) { resume = await api.createResume(exampleResume); upsert(resume); }
      await select(resume.id); busy.value = ''; await diagnoseResume(false, stayOnPage);
    } catch (error) { fail(error); } finally { busy.value = ''; }
  }
  async function diagnoseResume(withJob = false, stayOnPage = false, resumeRevision?: number, isActive = () => true): Promise<Analysis | undefined> {
    if (busy.value || !isActive()) return;
    if (!selected.value) { openEditor(); return; }
    if (withJob && jobDescription.value.trim().length < 20) { toast('请粘贴至少 20 字的职位描述，包含职责和任职要求。'); return; }
    const id = selected.value.id;
    const requestId = selectionRequest;
    const reportId = ++reportRequest;
    const input = { resumeId: id, targetRole: targetRole.value.trim(), ...(resumeRevision !== undefined ? { resumeRevision } : {}), ...(withJob ? { jobDescription: jobDescription.value.trim() } : {}) };
    if (!health.value) await loadHealth();
    if (busy.value || !isActive() || requestId !== selectionRequest || reportId !== reportRequest || selectedId.value !== id) return;
    if (!health.value) { toast('无法确认诊断服务状态，请重试连接。'); return; }
    if (health.value.aiConfigured && !await confirmModelProcessing()) return;
    if (disposed || busy.value || !isActive() || requestId !== selectionRequest || reportId !== reportRequest || selectedId.value !== id) return;
    busy.value = withJob ? '正在对照岗位要求' : '正在梳理简历中的关键问题';
    analysisRunning.value = !!health.value?.aiConfigured;
    try {
      const result = health.value?.aiConfigured ? await modelAnalysis(input) : await api.analyze(input);
      if (!disposed && isActive() && selectedId.value === id && requestId === selectionRequest && reportId === reportRequest) {
        analysis.value = result; history.value = [result, ...history.value.filter(item => item.id !== result.id)];
        if (!stayOnPage) page.value = 'diagnosis';
        return result;
      }
    } catch (error) { if (!disposed) fail(error); } finally { busy.value = ''; analysisRunning.value = false; }
  }
  async function selectAssistantResume(action: { resumeId: string; revision: number }, stillActive = () => true): Promise<Resume | undefined> {
    if (busy.value || !stillActive()) return;
    if (!resumes.value.some(item => item.id === action.resumeId)) { toast('这份简历已不在当前列表中，请重新选择。'); return; }
    const requestId = ++assistantRequest, selection = selectionRequest;
    busy.value = '正在核对所选简历版本';
    try {
      const current = await api.resume(action.resumeId);
      if (disposed || requestId !== assistantRequest || selection !== selectionRequest || !stillActive()) return;
      const listed = resumes.value.find(item => item.id === action.resumeId);
      if (!listed || current.id !== action.resumeId) return;
      if (current.revision >= listed.revision) upsert(current);
      if (current.revision !== action.revision || listed.revision > action.revision) {
        toast('简历已更新，请回工作台重新选择最新版本后再诊断。'); return;
      }
      const selecting = select(current.id), expectedSelection = selectionRequest;
      await selecting;
      if (disposed || requestId !== assistantRequest || expectedSelection !== selectionRequest || !stillActive()) return;
      return current;
    } catch (error) { if (!disposed && requestId === assistantRequest) fail(error); }
    finally { if (requestId === assistantRequest && busy.value === '正在核对所选简历版本') busy.value = ''; }
  }
  async function analyzeFromAssistant(action: { resumeId: string; revision: number; targetRole: string }, stillActive = () => true): Promise<Analysis | undefined> {
    if (!await selectAssistantResume(action, stillActive) || !stillActive()) return;
    targetRole.value = action.targetRole.trim();
    // Free-form job preferences and historical company text are not a verified JD.
    jobDescription.value = '';
    return diagnoseResume(false, true, action.revision, stillActive);
  }
  async function applySuggestion(replacement: string, confirmed: boolean) {
    if (!analysis.value || !activeSuggestion.value || busy.value || !selected.value) return;
    if (analysis.value.resumeId !== selected.value.id || !analysis.value.suggestions.some(item => item.id === activeSuggestion.value?.id)) { toast('当前建议与所选简历不一致，请重新打开诊断报告。'); return; }
    const resumeId = selected.value.id, analysisId = analysis.value.id, suggestionId = activeSuggestion.value.id;
    const requestId = selectionRequest;
    const reportId = ++reportRequest;
    busy.value = '正在保存已确认的修改';
    try {
      const result = await api.apply(analysisId, suggestionId, { replacement, confirmed, revision: selected.value.revision });
      upsert(result.resume);
      if (selectedId.value === resumeId && requestId === selectionRequest && reportId === reportRequest) {
        analysis.value = result.analysis;
        history.value = [result.analysis, ...history.value.filter(item => item.id !== result.analysis.id)];
      }
      if (activeSuggestion.value?.id === suggestionId) activeSuggestion.value = undefined;
      toast('修改已采纳，简历已保存。可重新诊断查看变化。');
    } catch (error) { fail(error); } finally { busy.value = ''; }
  }
  async function remove(resume: Resume) {
    if (busy.value) return;
    busy.value = '正在删除简历';
    try {
      await api.deleteResume(resume.id);
      ++listRevision;
      resumes.value = resumes.value.filter(r => r.id !== resume.id);
      uni.removeStorageSync(draftKey(resume.id));
      if (editorId.value === resume.id) { ++editorSession; editorOpen.value = false; }
      if (selectedId.value === resume.id) {
        if (resumes.value.length) await select(resumes.value[0].id);
        else clearSelection();
      }
      toast('简历、关联诊断和绑定的投递计划已删除。');
    } catch (error) { fail(error); } finally { busy.value = ''; }
  }
  async function acceptRestoredResume(committed: Resume): Promise<boolean> {
    const requestId = ++restorationRequest;
    const wasListed = resumes.value.some(item => item.id === committed.id);
    const syncMessage = '历史恢复已保存，但最新简历状态未同步。请重新读取后再继续；未保存草稿已保留。';
    toast('历史恢复已保存，正在同步最新简历…');
    try {
      // An idempotent response describes its original commit. Another window may
      // have saved a newer revision while that response was interrupted.
      const latest = await api.resume(committed.id);
      if (disposed || requestId !== restorationRequest) return false;
      if (latest.id !== committed.id || latest.revision < committed.revision) throw new Error('The latest saved revision is not yet available.');
      const current = resumes.value.find(item => item.id === committed.id);
      if (wasListed && !current) return false; // A completed local deletion must not be undone by this GET.
      if (!current || current.revision <= latest.revision) upsert(latest);
      if (loadError.value === syncMessage) loadError.value = '';
      if (selectedId.value === committed.id) await select(committed.id);
      if (disposed || requestId !== restorationRequest) return false;
      toast('历史恢复已保存，已同步最新简历。请重新诊断后再采用建议。');
      return true;
    } catch {
      if (!disposed && requestId === restorationRequest) {
        // Keep the prior workspace and editor untouched, and make its stale
        // state explicit until the user successfully reloads the saved data.
        loadError.value = syncMessage;
        toast(syncMessage);
      }
      return false;
    }
  }
  if (options.autoLoad !== false) {
    onMounted(refresh);
    onUnmounted(() => { disposed = true; void cancelAnalysis(); clearTimeout(noticeTimeout); ++selectionRequest; ++reportRequest; ++refreshRequest; ++editorSession; ++restorationRequest; ++assistantRequest; });
  }
  return { health, aiConsent, analysisRunning, cancelAnalysis, loadHealth, page, resumes, selectedId, selected, analysis, history, busy, loading, loadError, notice, editorOpen, editorId, editorTitle, editorRole, editorText, editorBaseRevision, jobDescription, targetRole, activeSuggestion, refresh, select, openEditor, saveDraft, reloadEditor, saveEditor, useExample, diagnoseResume, selectAssistantResume, analyzeFromAssistant, applySuggestion, acceptRestoredResume, remove, toast, fail };
}
