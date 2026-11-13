import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationStatus, CareerApplication, CareerJob, CareerWorkspace, Resume } from '../shared/types.js';
import { careerJobIsStale } from '../shared/career.js';
import { hasUnresolvedPlaceholders } from './analysis.js';
import { careerCatalogLocation, loadCareerCatalog, publishedCareerCatalog, type CareerCatalog } from './career-catalog.js';
import { careerMedia } from './career-content-storage.js';
import { careerId, careerObject, careerRevision, validateApplicationCreate, validateApplicationUpdate, validateCareerJobInput, type StoredCareerApplication, type StoredCareerJob } from './career-validation.js';
import { HttpError, invalid, notFound } from './errors.js';
import { JsonStore, type Database, type StoredResume } from './store.js';

function publicJob({ userId: _userId, ...job }: StoredCareerJob): CareerJob { return job; }
function publicApplication({ userId: _userId, ...application }: StoredCareerApplication): CareerApplication { return application; }
function snapshot({ userId: _userId, ...resume }: StoredResume): Resume { return resume; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const transitions: Record<ApplicationStatus, ApplicationStatus[]> = {
  planned: ['applied', 'withdrawn'], applied: ['interview', 'offer', 'rejected', 'withdrawn'],
  interview: ['offer', 'rejected', 'withdrawn'], offer: ['withdrawn'], rejected: [], withdrawn: [],
};

export class CareerService {
  readonly catalogPath: string;
  private readonly fallbackPath?: string;
  constructor(readonly store: JsonStore, readonly userId: string, catalogPath?: string) {
    const location = careerCatalogLocation(store.path, catalogPath);
    this.catalogPath = location.path;
    this.fallbackPath = location.fallback;
  }
  private catalog() { return loadCareerCatalog(this.catalogPath, this.fallbackPath); }
  private findJob(database: Database, catalog: CareerCatalog, id: string): CareerJob {
    const ownJob = database.careerJobs.find(item => item.id === id && item.userId === this.userId);
    if (ownJob) return publicJob(ownJob);
    return catalog.jobs.find(item => item.id === id) ?? notFound('岗位');
  }
  private findResume(database: Database, id: string, revision: number): Resume {
    const resume = database.resumes.find(item => item.id === id && item.userId === this.userId) ?? notFound('简历');
    if (resume.revision !== revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历版本已变化，请重新加载并审核。');
    return snapshot(resume);
  }
  private ensureOpen(job: CareerJob) {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    if (job.availability !== 'open' || (job.deadline && job.deadline < today)) throw new HttpError(409, 'JOB_UNAVAILABLE', '该岗位已关闭或超过截止日期，不能继续建立或确认投递。');
  }
  async catalogJobs() { return (await this.catalog()).jobs; }
  private async publishedCatalog() {
    const [database, base] = await Promise.all([this.store.read(), this.catalog()]);
    return { database, catalog: publishedCareerCatalog(base, database.careerContent, careerMedia(database)) };
  }
  async materialFile(id: string, fileId: string) {
    const { catalog } = await this.publishedCatalog();
    const attachment = catalog.materials.find(item => item.id === id)?.attachment;
    if (!attachment || attachment.id !== fileId) return notFound('当前资料文件');
    return attachment;
  }
  async workspace(): Promise<CareerWorkspace> {
    const { database, catalog } = await this.publishedCatalog();
    const personal = database.careerJobs.filter(item => item.userId === this.userId).map(publicJob);
    const jobIds = new Set(personal.map(item => item.id));
    const jobs = [...personal, ...catalog.jobs.filter(item => !jobIds.has(item.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      mode: 'preview', externalDeliveryAvailable: false, catalogState: catalog.state, catalogMessage: catalog.message,
      jobs, materials: catalog.materials, portals: catalog.portals,
      favoriteJobIds: database.careerFavorites.filter(item => item.userId === this.userId && jobs.some(job => job.id === item.jobId)).map(item => item.jobId),
      applications: database.careerApplications.filter(item => item.userId === this.userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicApplication),
    };
  }
  async createJob(body: unknown): Promise<CareerJob> {
    const input = validateCareerJobInput(body);
    return this.store.mutate(database => {
      const job: StoredCareerJob = {
        ...input, companyOverview: input.companyOverview ?? '', id: `personal-${randomUUID()}`, userId: this.userId,
        origin: 'personal', sourceLabel: '本人添加，信息待自行核实', availability: 'open', updatedAt: new Date().toISOString(),
      };
      database.careerJobs.push(job);
      return publicJob(job);
    });
  }
  async deleteJob(id: string) {
    careerId(id);
    return this.store.mutate(database => {
      const index = database.careerJobs.findIndex(item => item.id === id && item.userId === this.userId);
      if (index < 0) notFound('岗位');
      if (database.careerApplications.some(item => item.userId === this.userId && item.jobId === id)) throw new HttpError(409, 'JOB_HAS_APPLICATIONS', '该岗位还有投递记录，请先删除相关记录。');
      database.careerJobs.splice(index, 1);
      database.careerFavorites = database.careerFavorites.filter(item => item.userId !== this.userId || item.jobId !== id);
      return { deleted: true, id };
    });
  }
  async favorite(id: string, body: unknown) {
    careerId(id);
    const input = careerObject(body, ['favorite']);
    if (typeof input.favorite !== 'boolean') invalid('favorite 必须是布尔值。');
    const favorite = input.favorite;
    const catalog = await this.catalog();
    return this.store.mutate(database => {
      this.findJob(database, catalog, id);
      const exists = database.careerFavorites.some(item => item.userId === this.userId && item.jobId === id);
      if (favorite && !exists) database.careerFavorites.push({ userId: this.userId, jobId: id });
      if (!favorite) database.careerFavorites = database.careerFavorites.filter(item => item.userId !== this.userId || item.jobId !== id);
      return { jobId: id, favorite };
    });
  }
  async createApplication(body: unknown): Promise<CareerApplication> {
    const input = validateApplicationCreate(body);
    const inputHash = hash({ jobId: input.jobId, resumeId: input.resumeId, resumeRevision: input.resumeRevision });
    const catalog = await this.catalog();
    return this.store.mutate(database => {
      const key = database.careerKeys.find(item => item.userId === this.userId && item.key === input.idempotencyKey);
      if (key) {
        if (key.inputHash !== inputHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的投递计划。');
        if (key.deleted) throw new HttpError(409, 'APPLICATION_DELETED', '该请求对应的投递计划已删除，请使用新的请求标识。');
        return publicApplication(database.careerApplications.find(item => item.id === key.applicationId && item.userId === this.userId) ?? notFound('投递记录'));
      }
      const job = this.findJob(database, catalog, input.jobId); this.ensureOpen(job);
      if (careerJobIsStale(job)) throw new HttpError(409, 'JOB_RECHECK_REQUIRED', '岗位来源超过 30 天未复核。请查看官网，确认后可添加为个人目标岗位并建立计划。');
      const resume = this.findResume(database, input.resumeId, input.resumeRevision);
      if (database.careerApplications.some(item => item.userId === this.userId && item.jobId === input.jobId
        && item.resumeSnapshot.id === resume.id && item.resumeSnapshot.revision === resume.revision && !['withdrawn', 'rejected'].includes(item.status))) {
        throw new HttpError(409, 'APPLICATION_EXISTS', '该岗位和简历版本已有投递计划，请查看现有记录。');
      }
      const now = new Date().toISOString();
      // Keep the persisted snapshot readable by older releases during rollback.
      const { audience: _audience, checkedAt: _checkedAt, ...jobSnapshot } = job;
      const application: StoredCareerApplication = {
        id: randomUUID(), userId: this.userId, jobId: job.id, jobSnapshot, resumeSnapshot: resume,
        resumeHash: hash(resume), status: 'planned', note: '', revision: 1, createdAt: now, updatedAt: now,
        history: [{ status: 'planned', at: now, source: 'user' }], submissionMode: 'manual',
      };
      database.careerApplications.push(application);
      database.careerKeys.push({ userId: this.userId, key: input.idempotencyKey, inputHash, applicationId: application.id, deleted: false });
      return publicApplication(application);
    });
  }
  async updateApplication(id: string, body: unknown): Promise<CareerApplication> {
    careerId(id);
    const input = validateApplicationUpdate(body);
    const catalog = await this.catalog();
    return this.store.mutate(database => {
      const application = database.careerApplications.find(item => item.id === id && item.userId === this.userId) ?? notFound('投递记录');
      const unchanged = (input.status === undefined || input.status === application.status) && (input.note === undefined || input.note === application.note)
        && (input.resumeId === undefined || (input.resumeId === application.resumeSnapshot.id && input.resumeRevision === application.resumeSnapshot.revision));
      if (unchanged) return publicApplication(application);
      if (input.revision !== application.revision) throw new HttpError(409, 'REVISION_CONFLICT', '投递记录已变化，请重新加载后再修改。');
      if (input.resumeId !== undefined) {
        if (application.status !== 'planned' || (input.status !== undefined && input.status !== 'planned')) throw new HttpError(409, 'INVALID_TRANSITION', '只有待投递计划可以更换简历，请保存审核后再记录投递。');
        const resume = this.findResume(database, input.resumeId, input.resumeRevision!);
        if (database.careerApplications.some(item => item.id !== application.id && item.userId === this.userId && item.jobId === application.jobId
          && item.resumeSnapshot.id === resume.id && item.resumeSnapshot.revision === resume.revision && !['withdrawn', 'rejected'].includes(item.status))) {
          throw new HttpError(409, 'APPLICATION_EXISTS', '该岗位和简历版本已有投递计划，请查看现有记录。');
        }
        application.resumeSnapshot = resume; application.resumeHash = hash(resume);
      }
      if (input.status !== undefined && input.status !== application.status) {
        if (!transitions[application.status].includes(input.status)) throw new HttpError(409, 'INVALID_TRANSITION', '不能从当前状态变更为该状态。');
        if (input.status === 'applied') {
          if (input.confirmedManualSubmission !== true) throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请确认已在实际渠道完成投递，此操作仅记录进度。');
          const current = database.resumes.find(item => item.id === application.resumeSnapshot.id && item.userId === this.userId) ?? notFound('简历');
          if (current.revision !== application.resumeSnapshot.revision || hash(snapshot(current)) !== application.resumeHash) throw new HttpError(409, 'SOURCE_CONFLICT', '简历在计划创建后已修改，请先更新计划中的简历并重新审核。');
          if (hasUnresolvedPlaceholders(current.text)) throw new HttpError(400, 'PLACEHOLDERS_UNRESOLVED', '简历仍有待填写的真实信息，请补充并审核后再记录投递。');
          this.ensureOpen(this.findJob(database, catalog, application.jobId));
        }
        application.status = input.status;
        application.history.push({ status: input.status, at: new Date().toISOString(), source: 'user' });
      }
      if (input.note !== undefined) application.note = input.note;
      application.revision += 1; application.updatedAt = new Date().toISOString();
      return publicApplication(application);
    });
  }
  async deleteApplication(id: string, body: unknown) {
    careerId(id);
    const input = careerObject(body, ['revision']); const revision = careerRevision(input.revision);
    return this.store.mutate(database => {
      const index = database.careerApplications.findIndex(item => item.id === id && item.userId === this.userId);
      if (index < 0) notFound('投递记录');
      if (database.careerApplications[index].revision !== revision) throw new HttpError(409, 'REVISION_CONFLICT', '投递记录已变化，请重新加载后再删除。');
      database.careerApplications.splice(index, 1);
      for (const key of database.careerKeys) if (key.userId === this.userId && key.applicationId === id) key.deleted = true;
      return { deleted: true, id };
    });
  }
}
