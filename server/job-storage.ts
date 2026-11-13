import type { AnalysisInput, AnalysisJob, Resume, RoleGuide } from '../shared/types.js';
import { analysisWorkflowVersion, type AnalysisProvider } from './analysis.js';
import { validateAnalysisInput, validateResumeInput } from './validation.js';

export interface StoredAnalysisTask {
  userId: string;
  job: AnalysisJob;
  input: AnalysisInput;
  requestHash: string;
  inputHash: string;
  snapshot: Resume;
  engine: 'rules' | 'bailian';
  model?: string;
  /** Legacy queue format identifier, retained for release rollback. */
  workflowVersion: 'rules-and-model-v1';
  /** Compatibility marker understood by the preceding release. */
  analysisVersion?: 'jd-evidence-v1';
  diagnosisWorkflowVersion?: typeof analysisWorkflowVersion;
  modelSettings?: AnalysisProvider['modelSettings'];
  roleGuide?: RoleGuide | null;
}

export interface AnalysisTaskStorage { analysisTasks: StoredAnalysisTask[] }

function validGuide(guide: RoleGuide) {
  const boundedList = (value: unknown, limit: number) => Array.isArray(value) && value.length <= limit
    && value.every(item => typeof item === 'string' && item.trim() && item.length <= 200);
  return typeof guide.id === 'string' && /^[a-z-]{1,100}$/.test(guide.id)
    && typeof guide.version === 'string' && /^\d{4}-\d{2}-\d{2}\.v\d+$/.test(guide.version)
    && typeof guide.title === 'string' && guide.title.trim() && guide.title.length <= 160
    && boundedList(guide.terms, 10) && boundedList(guide.questions, 3) && guide.questions.length === 3;
}

/** Older JSON files have no tasks. Present but invalid task data must fail closed. */
export function normalizeAnalysisTasks(source: Record<string, unknown>): AnalysisTaskStorage {
  if (source.analysisTasks === undefined) return { analysisTasks: [] };
  if (!Array.isArray(source.analysisTasks)) throw new Error('Malformed analysis task storage.');
  const keys = new Set<string>(), ids = new Set<string>();
  for (const value of source.analysisTasks) {
    const task = value as StoredAnalysisTask;
    if (!task || typeof task.userId !== 'string' || !task.userId || !task.job || !task.snapshot
      || !['rules', 'bailian'].includes(task.engine) || task.workflowVersion !== 'rules-and-model-v1'
      || (task.analysisVersion !== undefined && (task.analysisVersion !== 'jd-evidence-v1' || task.roleGuide === undefined))
      || (task.diagnosisWorkflowVersion !== undefined && (task.diagnosisWorkflowVersion !== analysisWorkflowVersion || task.roleGuide === undefined))
      || (task.roleGuide != null && !validGuide(task.roleGuide))
      || (task.modelSettings !== undefined && (!task.modelSettings || typeof task.modelSettings.promptVersion !== 'string'
        || !Number.isFinite(task.modelSettings.temperature) || !Number.isSafeInteger(task.modelSettings.maxTokens) || task.modelSettings.maxTokens < 1))
      || (task.model !== undefined && (typeof task.model !== 'string' || task.model.length > 100))
      || !/^[a-f0-9]{64}$/.test(task.requestHash) || !/^[a-f0-9]{64}$/.test(task.inputHash)
      || typeof task.job.id !== 'string' || !task.job.id || typeof task.job.resumeId !== 'string'
      || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(task.job.status)
      || !Number.isFinite(Date.parse(task.job.createdAt)) || !Number.isFinite(Date.parse(task.job.updatedAt))
      || (task.job.analysisId !== undefined && typeof task.job.analysisId !== 'string')
      || (task.job.error !== undefined && (!task.job.error || typeof task.job.error.code !== 'string' || typeof task.job.error.message !== 'string'))
      || task.job.resumeId !== task.snapshot.id || !Number.isSafeInteger(task.snapshot.revision) || task.snapshot.revision < 1
      || !Number.isFinite(Date.parse(task.snapshot.createdAt)) || !Number.isFinite(Date.parse(task.snapshot.updatedAt))) {
      throw new Error('Malformed analysis task storage.');
    }
    try {
      validateAnalysisInput(task.input);
      validateResumeInput({ title: task.snapshot.title, targetRole: task.snapshot.targetRole, text: task.snapshot.text });
    } catch { throw new Error('Malformed analysis task storage.'); }
    if (task.input.resumeId !== task.job.resumeId || (task.input.resumeRevision !== undefined && task.input.resumeRevision !== task.snapshot.revision)) throw new Error('Malformed analysis task storage.');
    if (ids.has(task.job.id)) throw new Error('Duplicate analysis task ID.');
    ids.add(task.job.id);
    if (task.input.idempotencyKey) {
      const key = JSON.stringify([task.userId, task.input.idempotencyKey]);
      if (keys.has(key)) throw new Error('Duplicate analysis idempotency key.');
      keys.add(key);
    }
  }
  return { analysisTasks: structuredClone(source.analysisTasks) as StoredAnalysisTask[] };
}
