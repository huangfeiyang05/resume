import { createHash, randomUUID } from 'node:crypto';
import type { AnalysisInput, AnalysisJob } from '../shared/types.js';
import type { AnalysisContext } from './analysis.js';
import type { TokenUsage } from './quota-storage.js';
import { HttpError, notFound } from './errors.js';
import type { ResumeService } from './service.js';
import type { StoredAnalysisTask } from './job-storage.js';
import { QuotaService } from './quota.js';
import { validateAnalysisInput } from './validation.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestHash = (input: AnalysisInput) => hash({
  resumeId: input.resumeId, resumeRevision: input.resumeRevision ?? null,
  targetRole: input.targetRole ?? null, jobDescription: input.jobDescription ?? '', aiConsent: input.aiConsent === true,
});

/** Durable single-process jobs. Dispatch intent and usage survive restarts; no automatic model replay. */
export class AnalysisJobs {
  private controllers = new Map<string, AbortController>();
  private submissions: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  readonly quota: QuotaService;

  constructor(private service: ResumeService, quota = new QuotaService(service.store)) {
    this.quota = quota;
    this.ready = this.recover();
    // A malformed store remains rejected when an operation awaits ready.
    this.ready.catch(() => undefined);
  }

  private async recover() {
    await this.quota.recover();
    const database = await this.service.store.read();
    if (!database.analysisTasks.some(task => ['queued', 'running'].includes(task.job.status))) return;
    await this.service.store.mutate(data => {
      for (const task of data.analysisTasks) {
        if (task.job.status !== 'queued' && task.job.status !== 'running') continue;
        task.job.status = 'failed';
        task.job.error = { code: 'JOB_INTERRUPTED', message: '服务重启中断了任务，未自动重复调用；已发生的模型用量仍计入额度，未知用量待核对。' };
        task.job.updatedAt = new Date().toISOString();
      }
    });
  }

  start(body: unknown, service = this.service): Promise<AnalysisJob> {
    const submission = this.submissions.then(() => this.submit(body, service));
    this.submissions = submission.catch(() => undefined);
    return submission;
  }

  private async submit(body: unknown, service: ResumeService): Promise<AnalysisJob> {
    await this.ready;
    const input = validateAnalysisInput(body);
    const realModel = service.provider.name === 'bailian';
    if (realModel && input.aiConsent !== true) throw new HttpError(400, 'AI_CONSENT_REQUIRED', '请先确认百炼个人信息处理告知。');
    const snapshot = await service.getResume(input.resumeId);
    const fingerprint = requestHash(input);
    const database = await service.store.read();
    const previous = input.idempotencyKey && database.analysisTasks.find(task => task.userId === service.userId && task.input.idempotencyKey === input.idempotencyKey);
    if (previous) {
      if (previous.requestHash !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一诊断请求标识不能用于不同输入，请重新提交。');
      return structuredClone(previous.job);
    }
    if (input.resumeRevision !== undefined && input.resumeRevision !== snapshot.revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历版本已变化，请重新核对后再诊断。');
    if (realModel && (await this.quota.current(service.userId)).status === 'active' && (!input.idempotencyKey || input.resumeRevision === undefined)) {
      throw new HttpError(400, 'ANALYSIS_REQUEST_GUARD_REQUIRED', '请更新客户端后携带简历修订号和诊断请求标识。');
    }
    if (database.analysisTasks.some(task => ['queued', 'running'].includes(task.job.status))) throw new HttpError(429, 'MODEL_BUSY', '已有诊断进行中，请完成或取消后再试。');
    const context: AnalysisContext = { resume: snapshot, targetRole: input.targetRole ?? snapshot.targetRole, jobDescription: input.jobDescription };
    const reserveTokens = realModel ? (service.provider.estimateReservation?.(context) ?? 80_000) : 0;
    if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0) throw new HttpError(500, 'INVALID_RESERVATION', '模型用量预占配置不可用。');
    const now = new Date().toISOString();
    const job: AnalysisJob = { id: randomUUID(), resumeId: snapshot.id, status: 'queued', createdAt: now, updatedAt: now };
    const task: StoredAnalysisTask = {
      userId: service.userId, job, input, requestHash: fingerprint, snapshot,
      inputHash: hash({ snapshot, targetRole: context.targetRole, jobDescription: context.jobDescription ?? '', engine: service.provider.name, model: service.provider.model ?? null, workflowVersion: 'rules-and-model-v1' }),
      engine: realModel ? 'bailian' : 'rules', ...(service.provider.model ? { model: service.provider.model } : {}), workflowVersion: 'rules-and-model-v1',
    };
    await service.store.mutate(data => { data.analysisTasks.push(task); });
    try {
      if (realModel) await this.quota.reserve(service.userId, job.id, task.inputHash, reserveTokens);
    } catch (error) {
      await this.failed(task, error, false, service);
      throw error;
    }
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    setImmediate(() => {
      void this.execute(task, service, controller).catch(() => {
        // Persisted dispatch intent keeps an uncertain charge pending after a storage failure.
        console.error('[analysis-job] persistence failure');
      });
    });
    return structuredClone(job);
  }

  private async failed(task: StoredAnalysisTask, error: unknown, cancelled: boolean, service: ResumeService) {
    const write = () => service.store.mutate(data => {
      const entry = data.analysisTasks.find(item => item.job.id === task.job.id && item.userId === service.userId);
      if (!entry || entry.job.status === 'completed') return;
      entry.job.status = cancelled ? 'cancelled' : 'failed';
      entry.job.error = error instanceof HttpError ? { code: error.code, message: error.message }
        : { code: 'ANALYSIS_FAILED', message: '诊断未完成；已发生的模型用量仍计入额度，未知用量待核对。' };
      entry.job.updatedAt = new Date().toISOString();
    });
    // Only retry the local terminal-state write. Never retry model execution here.
    try { await write(); }
    catch { await write(); }
  }

  private async execute(task: StoredAnalysisTask, service: ResumeService, controller: AbortController) {
    const realModel = task.engine === 'bailian';
    let observedUsage: TokenUsage | undefined;
    try {
      if (controller.signal.aborted) return;
      await service.store.mutate(data => {
        const entry = data.analysisTasks.find(item => item.job.id === task.job.id && item.userId === service.userId) ?? notFound('诊断任务');
        if (controller.signal.aborted || entry.job.status !== 'queued') throw new HttpError(409, 'ANALYSIS_CANCELLED', '诊断已取消。');
        entry.job.status = 'running'; entry.job.updatedAt = new Date().toISOString();
      });
      await service.analyze(task.input, controller.signal, task.snapshot, realModel ? {
        onDispatch: async () => { await this.quota.dispatch(service.userId, task.job.id); },
        onUsage: async usage => {
          observedUsage = usage;
          await this.quota.settle(service.userId, task.job.id, usage);
        },
      } : undefined, task.job.id);
    } catch (error) {
      await this.failed(task, error, controller.signal.aborted, service);
    } finally {
      this.controllers.delete(task.job.id);
      if (realModel) {
        // Retry only an idempotent local ledger write, never the provider request.
        if (observedUsage) await this.quota.settle(service.userId, task.job.id, observedUsage);
        await this.quota.finish(service.userId, task.job.id);
      }
    }
  }

  async get(id: string, service = this.service): Promise<AnalysisJob> {
    await this.ready;
    const entry = (await service.store.read()).analysisTasks.find(task => task.job.id === id && task.userId === service.userId) ?? notFound('诊断任务');
    await service.getResume(entry.job.resumeId);
    return structuredClone(entry.job);
  }

  async cancel(id: string, service = this.service): Promise<AnalysisJob> {
    const job = await this.get(id, service);
    if (job.status === 'queued' || job.status === 'running') {
      this.controllers.get(id)?.abort();
      if (job.status === 'queued') {
        await service.store.mutate(data => {
          const entry = data.analysisTasks.find(task => task.job.id === id && task.userId === service.userId) ?? notFound('诊断任务');
          if (entry.job.status === 'queued') { entry.job.status = 'cancelled'; entry.job.updatedAt = new Date().toISOString(); }
        });
        if (service.provider.name === 'bailian') await this.quota.finish(service.userId, id);
      }
    }
    return this.get(id, service);
  }
}
