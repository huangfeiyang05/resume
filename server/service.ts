import { randomUUID } from 'node:crypto';
import type { ApplySuggestionResult, Resume, ResumeVersionSummary, RestoreResumeResult } from '../shared/types.js';
import { hasUnresolvedPlaceholders, RuleAnalysisProvider, type AnalysisProvider } from './analysis.js';
import { HttpError, notFound } from './errors.js';
import { JsonStore, legacyWorkspaceId, type StoredResume, type StoredAnalysis } from './store.js';
import { limits, validateAnalysisInput, validateApplyInput, validateResumeInput, validateResumeUpdate, validateRestoreInput } from './validation.js';
import { createResumeVersion, resumeContentHash, type StoredResumeVersion } from './resume-history.js';

function publicResume({ userId: _owner, ...resume }: StoredResume): Resume { return resume; }
function publicAnalysis({ userId: _owner, ...analysis }: StoredAnalysis) { return analysis; }
function publicVersion({ userId: _owner, ...version }: StoredResumeVersion) { return version; }
function versionSummary({ userId: _owner, snapshot: _snapshot, ...summary }: StoredResumeVersion): ResumeVersionSummary { return summary; }

export class ResumeService {
  constructor(readonly store: JsonStore, readonly provider: AnalysisProvider = new RuleAnalysisProvider(), readonly userId = legacyWorkspaceId) {}

  forUser(userId: string) { return new ResumeService(this.store, this.provider, userId); }

  async listResumes() {
    return (await this.store.read()).resumes.filter(resume => resume.userId === this.userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicResume);
  }

  async getResume(id: string) {
    return publicResume((await this.store.read()).resumes.find(resume => resume.id === id && resume.userId === this.userId) ?? notFound('简历'));
  }

  async createResume(body: unknown) {
    const input = validateResumeInput(body);
    const now = new Date().toISOString();
    const resume: StoredResume = { ...input, userId: this.userId, id: randomUUID(), createdAt: now, updatedAt: now, revision: 1 };
    return this.store.mutate((database) => {
      database.resumes.push(resume);
      database.resumeVersions.push(createResumeVersion(resume, 'created'));
      return publicResume(resume);
    });
  }

  async updateResume(id: string, body: unknown) {
    const input = validateResumeUpdate(body);
    return this.store.mutate((database) => {
      const resume = database.resumes.find(item => item.id === id && item.userId === this.userId) ?? notFound('简历');
      if (input.revision !== resume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历已发生变化，请重新加载后再修改。');
      const { revision: _revision, ...fields } = input;
      if (Object.entries(fields).some(([key, value]) => resume[key as keyof Resume] !== value)) {
        Object.assign(resume, fields);
        resume.revision += 1;
        resume.updatedAt = new Date().toISOString();
        database.resumeVersions.push(createResumeVersion(resume, 'edited'));
      }
      return publicResume(resume);
    });
  }

  async deleteResume(id: string) {
    return this.store.mutate((database) => {
      const index = database.resumes.findIndex(item => item.id === id && item.userId === this.userId);
      if (index < 0) notFound('简历');
      database.resumes.splice(index, 1);
      database.resumeVersions = database.resumeVersions.filter(item => item.resumeId !== id || item.userId !== this.userId);
      database.resumeRestores = database.resumeRestores.filter(item => item.resumeId !== id || item.userId !== this.userId);
      database.analyses = database.analyses.filter(analysis => analysis.resumeId !== id || analysis.userId !== this.userId);
      const applicationIds = new Set(database.careerApplications.filter(item => item.userId === this.userId && item.resumeSnapshot.id === id).map(item => item.id));
      database.careerApplications = database.careerApplications.filter(item => !applicationIds.has(item.id));
      for (const key of database.careerKeys) if (key.userId === this.userId && applicationIds.has(key.applicationId)) key.deleted = true;
      return { deleted: true, id };
    });
  }

  async listVersions(resumeId: string) {
    const database = await this.store.read();
    if (!database.resumes.some(item => item.id === resumeId && item.userId === this.userId)) notFound('简历');
    return database.resumeVersions.filter(item => item.resumeId === resumeId && item.userId === this.userId)
      .sort((a, b) => b.revision - a.revision).map(versionSummary);
  }

  async getVersion(resumeId: string, revision: number) {
    const database = await this.store.read();
    if (!database.resumes.some(item => item.id === resumeId && item.userId === this.userId)) notFound('简历');
    return publicVersion(database.resumeVersions.find(item => item.resumeId === resumeId && item.userId === this.userId && item.revision === revision) ?? notFound('历史版本'));
  }

  async restoreVersion(resumeId: string, sourceRevision: number, body: unknown): Promise<RestoreResumeResult> {
    const input = validateRestoreInput(body);
    return this.store.mutate(database => {
      const resume = database.resumes.find(item => item.id === resumeId && item.userId === this.userId) ?? notFound('简历');
      const source = database.resumeVersions.find(item => item.resumeId === resumeId && item.userId === this.userId && item.revision === sourceRevision) ?? notFound('历史版本');
      if (!input.confirmed) throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请先对照当前版本并确认历史内容真实、完整，再恢复。');
      const previous = database.resumeRestores.find(item => item.userId === this.userId && item.resumeId === resumeId && item.idempotencyKey === input.idempotencyKey);
      if (previous) {
        if (previous.sourceRevision !== sourceRevision || previous.baseRevision !== input.revision) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一恢复请求标识不能用于不同版本，请重新审核后再试。');
        return { ...previous.result, alreadyRestored: true };
      }
      if (input.revision !== resume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历已发生变化，请重新对照最新版本后再恢复。');
      const content = validateResumeInput({ title: source.snapshot.title, targetRole: source.snapshot.targetRole, text: source.snapshot.text });
      if (hasUnresolvedPlaceholders(content.text)) throw new HttpError(400, 'PLACEHOLDERS_UNRESOLVED', '历史版本含待补充事实，请先在编辑器中填写真实内容后保存。');
      const noChange = source.contentHash === resumeContentHash(resume);
      if (!noChange) {
        Object.assign(resume, content);
        resume.revision += 1;
        resume.updatedAt = new Date().toISOString();
        database.resumeVersions.push(createResumeVersion(resume, 'restored', sourceRevision));
      }
      const result: RestoreResumeResult = { resume: publicResume(resume), restoredFromRevision: sourceRevision, alreadyRestored: false, noChange };
      database.resumeRestores.push({ userId: this.userId, resumeId, idempotencyKey: input.idempotencyKey, sourceRevision, baseRevision: input.revision, confirmedAt: new Date().toISOString(), result });
      return result;
    });
  }

  async analyze(body: unknown, signal?: AbortSignal, snapshot?: Resume) {
    const input = validateAnalysisInput(body);
    if (this.provider.name === 'bailian' && input.aiConsent !== true) throw new HttpError(400, 'AI_CONSENT_REQUIRED', '请先确认将脱敏后的简历及岗位要求发送至阿里云百炼进行分析。');
    const currentResume = await this.getResume(input.resumeId);
    if (input.resumeRevision !== undefined && input.resumeRevision !== currentResume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历版本已变化，请重新核对后再诊断。');
    const resume = snapshot ?? currentResume;
    if (resume.id !== input.resumeId || currentResume.revision !== resume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '任务提交后简历已变化，请重新诊断。');
    const analysis = await this.provider.analyze({ resume, jobDescription: input.jobDescription, targetRole: input.targetRole ?? resume.targetRole, signal });
    return this.store.mutate((database) => {
      if (signal?.aborted) throw new HttpError(409, 'ANALYSIS_CANCELLED', '诊断已取消，未保存报告。');
      const current = database.resumes.find(item => item.id === resume.id && item.userId === this.userId) ?? notFound('简历');
      if (current.revision !== resume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '分析期间简历已发生变化，请重新诊断。');
      database.analyses.push({ ...analysis, userId: this.userId });
      return analysis;
    });
  }

  async getAnalysis(id: string) {
    const database = await this.store.read();
    const analysis = database.analyses.find(analysis => analysis.id === id && analysis.userId === this.userId) ?? notFound('诊断报告');
    if (!database.resumes.some(resume => resume.id === analysis.resumeId && resume.userId === this.userId)) notFound('诊断报告');
    return publicAnalysis(analysis);
  }

  async listAnalyses(resumeId: string) {
    const database = await this.store.read();
    if (!database.resumes.some(resume => resume.id === resumeId && resume.userId === this.userId)) notFound('简历');
    return database.analyses.filter(analysis => analysis.resumeId === resumeId && analysis.userId === this.userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicAnalysis);
  }

  async applySuggestion(analysisId: string, suggestionId: string, body: unknown): Promise<ApplySuggestionResult> {
    const input = validateApplyInput(body);
    return this.store.mutate((database) => {
      const analysis = database.analyses.find(analysis => analysis.id === analysisId && analysis.userId === this.userId) ?? notFound('诊断报告');
      const suggestion = analysis.suggestions.find(({ id }) => id === suggestionId) ?? notFound('修改建议');
      const resume = database.resumes.find(resume => resume.id === analysis.resumeId && resume.userId === this.userId) ?? notFound('简历');
      if (suggestion.applied) {
        if (input.replacement !== undefined && input.replacement !== suggestion.replacement) throw new HttpError(409, 'ALREADY_APPLIED', '该建议已采用，不能通过重复请求改成另一段内容。请在编辑器中修改。');
        return { resume: publicResume(resume), analysis: publicAnalysis(analysis), alreadyApplied: true };
      }
      if (input.revision !== resume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历已发生变化，请重新加载后再修改。');
      // Multiple suggestions from the same report may be applied sequentially. Any other edit invalidates its snapshot.
      const expectedRevision = analysis.resumeRevision + analysis.suggestions.filter(({ applied }) => applied).length;
      if (resume.revision !== expectedRevision) throw new HttpError(409, 'SOURCE_CONFLICT', '简历已在诊断后被修改，请重新诊断后采用建议。');
      if (suggestion.needsConfirmation && input.confirmed !== true) throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请先填写并确认建议中的真实经历信息，再采用修改。');
      const replacement = input.replacement ?? suggestion.replacement;
      if (hasUnresolvedPlaceholders(replacement)) throw new HttpError(400, 'PLACEHOLDERS_UNRESOLVED', '请填写所有“请填写真实…”占位内容，确认事实后再采用。');
      if (replacement === suggestion.original) throw new HttpError(400, 'NO_CHANGE', '修改后文本与原文相同。');
      const first = resume.text.indexOf(suggestion.original);
      if (!suggestion.original || first < 0) throw new HttpError(409, 'SOURCE_MISMATCH', '建议对应的原文已不存在，请重新诊断。');
      if (resume.text.indexOf(suggestion.original, first + suggestion.original.length) >= 0) throw new HttpError(409, 'AMBIGUOUS_SOURCE', '简历中存在多处相同原文，请在编辑器中选择具体段落修改。');
      const nextText = resume.text.slice(0, first) + replacement + resume.text.slice(first + suggestion.original.length);
      if (nextText.length > limits.resumeText) throw new HttpError(400, 'RESUME_TOO_LARGE', `修改后的简历不能超过 ${limits.resumeText} 个字符。`);
      resume.text = nextText;
      resume.revision += 1;
      resume.updatedAt = new Date().toISOString();
      suggestion.replacement = replacement;
      suggestion.applied = true;
      suggestion.appliedAt = resume.updatedAt;
      suggestion.appliedRevision = resume.revision;
      database.resumeVersions.push(createResumeVersion(resume, 'suggestion'));
      return { resume: publicResume(resume), analysis: publicAnalysis(analysis), alreadyApplied: false };
    });
  }
}
