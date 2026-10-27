import { randomUUID } from 'node:crypto';
import type { AnalysisJob } from '../shared/types.js';
import { HttpError, notFound } from './errors.js';
import type { ResumeService } from './service.js';
import { validateAnalysisInput } from './validation.js';

/** Single-process development jobs, not a durable production queue. */
export class AnalysisJobs {
  private entries = new Map<string, { job: AnalysisJob; controller: AbortController; userId: string }>();
  constructor(private service: ResumeService) {}
  async start(body: unknown, service = this.service): Promise<AnalysisJob> {
    const input = validateAnalysisInput(body);
    if (service.provider.name === 'bailian' && input.aiConsent !== true) throw new HttpError(400, 'AI_CONSENT_REQUIRED', '请先确认百炼个人信息处理告知。');
    const snapshot = await service.getResume(input.resumeId);
    if ([...this.entries.values()].some(({ job }) => job.status === 'running' || job.status === 'queued')) throw new HttpError(429, 'MODEL_BUSY', '已有诊断进行中，请完成或取消后再试。');
    // Old job metadata expires; completed reports remain in the local store.
    for (const [id, { job }] of this.entries) if (Date.now() - Date.parse(job.updatedAt) > 3_600_000) this.entries.delete(id);
    if (this.entries.size >= 50) this.entries.delete(this.entries.keys().next().value!);
    const now = new Date().toISOString();
    const job: AnalysisJob = { id: randomUUID(), resumeId: input.resumeId, status: 'queued', createdAt: now, updatedAt: now };
    const controller = new AbortController();
    this.entries.set(job.id, { job, controller, userId: service.userId });
    setImmediate(async () => {
      if (controller.signal.aborted) return;
      job.status = 'running'; job.updatedAt = new Date().toISOString();
      try {
        const analysis = await service.analyze(input, controller.signal, snapshot);
        // Persistence is the commit point: cancellation after it returns completed.
        job.analysisId = analysis.id; job.status = 'completed';
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof HttpError ? { code: error.code, message: error.message } : { code: 'ANALYSIS_FAILED', message: '诊断未完成，请重新发起。' };
      } finally { job.updatedAt = new Date().toISOString(); }
    });
    return structuredClone(job);
  }
  async get(id: string, service = this.service): Promise<AnalysisJob> {
    const entry = this.entries.get(id) ?? notFound('诊断任务');
    if (entry.userId !== service.userId) notFound('诊断任务');
    // Deleting a resume also makes its task metadata unavailable.
    await service.getResume(entry.job.resumeId);
    return structuredClone(entry.job);
  }
  async cancel(id: string, service = this.service): Promise<AnalysisJob> {
    const job = await this.get(id, service);
    const entry = this.entries.get(id)!;
    if (job.status === 'queued' || job.status === 'running') {
      entry.controller.abort();
      // Running cancellation is acknowledged by execution after its commit check.
      if (job.status === 'queued') { entry.job.status = 'cancelled'; entry.job.updatedAt = new Date().toISOString(); }
    }
    return structuredClone(entry.job);
  }
}
