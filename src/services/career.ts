import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ApplicationCreateInput, ApplicationStatus, ApplicationUpdateInput, CareerApplication, CareerJob, CareerJobInput, CareerMaterial, CareerRecruitmentPortal, CareerWorkspace, Resume } from '../../shared/types';
import { ApiError, request } from './api';

export const applicationStatusLabels: Record<ApplicationStatus, string> = {
  planned: '待投递', applied: '已投递', interview: '面试中', offer: '收到录用', rejected: '未通过', withdrawn: '已撤回',
};
export const applicationTransitions: Record<ApplicationStatus, ApplicationStatus[]> = {
  planned: ['applied', 'withdrawn'], applied: ['interview', 'offer', 'rejected', 'withdrawn'],
  interview: ['offer', 'rejected', 'withdrawn'], offer: ['withdrawn'], rejected: [], withdrawn: [],
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 50_000): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const instant = (value: unknown): value is string => text(value, 50) && Number.isFinite(Date.parse(value));
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const status = (value: unknown): value is ApplicationStatus => typeof value === 'string' && Object.hasOwn(applicationStatusLabels, value);
const sourceUrl = (value: unknown) => value === undefined || (text(value, 2000) && /^https?:\/\/[^/\s@?#]+(?:[/?#][^\s]*)?$/.test(value));

function job(value: unknown): value is CareerJob {
  return record(value) && text(value.id, 100) && !!value.id && ['catalog', 'personal'].includes(value.origin as string)
    && ['company', 'title', 'major', 'location', 'description', 'companyOverview', 'sourceLabel'].every(key => text(value[key]))
    && ['open', 'closed'].includes(value.availability as string) && instant(value.updatedAt) && sourceUrl(value.sourceUrl)
    && (value.deadline === undefined || (text(value.deadline, 10) && /^\d{4}-\d{2}-\d{2}$/.test(value.deadline)));
}
function material(value: unknown): value is CareerMaterial {
  return record(value) && text(value.id, 100) && !!value.id
    && ['title', 'major', 'role', 'summary', 'content', 'sourceLabel'].every(key => text(value[key], key === 'content' ? 200_000 : 50_000))
    && instant(value.updatedAt) && sourceUrl(value.sourceUrl);
}
function portal(value: unknown): value is CareerRecruitmentPortal {
  return record(value) && text(value.id, 100) && !!value.id
    && ['organization', 'audience', 'description'].every(key => text(value[key], 2000) && !!value[key])
    && Array.isArray(value.majors) && value.majors.length > 0 && value.majors.length <= 30
    && value.majors.every(item => text(item, 100) && !!item) && new Set(value.majors).size === value.majors.length
    && text(value.sourceUrl, 2000) && value.sourceUrl.startsWith('https://') && sourceUrl(value.sourceUrl) && instant(value.checkedAt);
}
function resume(value: unknown): value is Resume {
  return record(value) && ['id', 'title', 'targetRole', 'text'].every(key => text(value[key]))
    && revision(value.revision) && instant(value.createdAt) && instant(value.updatedAt);
}
function application(value: unknown): value is CareerApplication {
  return record(value) && text(value.id, 100) && !!value.id && text(value.jobId, 100)
    && job(value.jobSnapshot) && value.jobSnapshot.id === value.jobId && resume(value.resumeSnapshot)
    && text(value.resumeHash, 64) && /^[a-f0-9]{64}$/.test(value.resumeHash) && status(value.status)
    && text(value.note, 2000) && revision(value.revision) && instant(value.createdAt) && instant(value.updatedAt)
    && value.submissionMode === 'manual' && Array.isArray(value.history) && value.history.length > 0
    && value.history.every(event => record(event) && status(event.status) && instant(event.at) && event.source === 'user');
}
function invalidResponse(): never { throw new ApiError('求职工作台数据暂时不可用，请重新读取。', 'INVALID_CAREER_RESPONSE', 502); }
function checked<T>(value: unknown, validate: (value: unknown) => value is T): T { if (!validate(value)) invalidResponse(); return value; }

export const careerApi = {
  async workspace(): Promise<CareerWorkspace> {
    const value = await request<unknown>('/career');
    if (!record(value) || value.mode !== 'preview' || value.externalDeliveryAvailable !== false
      || !['empty', 'ready', 'unavailable'].includes(value.catalogState as string) || !text(value.catalogMessage, 2000)
      || !Array.isArray(value.jobs) || !value.jobs.every(job) || new Set(value.jobs.map(item => item.id)).size !== value.jobs.length
      || !Array.isArray(value.materials) || !value.materials.every(material)
      || new Set(value.materials.map(item => item.id)).size !== value.materials.length
      || !Array.isArray(value.portals) || !value.portals.every(portal) || new Set(value.portals.map(item => item.id)).size !== value.portals.length
      || !Array.isArray(value.favoriteJobIds) || !value.favoriteJobIds.every(id => text(id, 100))
      || !Array.isArray(value.applications) || !value.applications.every(application)) invalidResponse();
    return value as unknown as CareerWorkspace;
  },
  async createJob(input: CareerJobInput) { return checked(await request<unknown>('/career/jobs', 'POST', input), job); },
  async removeJob(id: string) {
    const result = await request<unknown>(`/career/jobs/${encodeURIComponent(id)}`, 'DELETE');
    if (!record(result) || result.id !== id) invalidResponse();
    return { id };
  },
  async favorite(jobId: string, favorite: boolean) {
    const value = await request<unknown>(`/career/favorites/${encodeURIComponent(jobId)}`, 'PUT', { favorite });
    if (!record(value) || value.jobId !== jobId || value.favorite !== favorite) invalidResponse();
    return { jobId, favorite };
  },
  async createApplication(input: ApplicationCreateInput) {
    const result = checked(await request<unknown>('/career/applications', 'POST', input), application);
    if (result.jobId !== input.jobId || result.resumeSnapshot.id !== input.resumeId || result.resumeSnapshot.revision !== input.resumeRevision) invalidResponse();
    return result;
  },
  async updateApplication(id: string, input: ApplicationUpdateInput) {
    const result = checked(await request<unknown>(`/career/applications/${encodeURIComponent(id)}`, 'PUT', input), application);
    if (result.id !== id || (input.status !== undefined && result.status !== input.status)
      || (input.resumeId !== undefined && (result.resumeSnapshot.id !== input.resumeId || result.resumeSnapshot.revision !== input.resumeRevision))
      || (input.note !== undefined && result.note !== input.note.replace(/\r\n?/g, '\n').trim())) invalidResponse();
    return result;
  },
  async removeApplication(id: string, expectedRevision: number) {
    const result = await request<unknown>(`/career/applications/${encodeURIComponent(id)}`, 'DELETE', { revision: expectedRevision });
    if (!record(result) || result.id !== id) invalidResponse();
    return { id };
  },
};

/** End dates are inclusive Shanghai dates; this is a display aid, not authorization. */
export function jobAcceptingPlans(value: CareerJob, now = Date.now()): boolean {
  return value.availability === 'open' && (!value.deadline || now < Date.parse(`${value.deadline}T23:59:59.999+08:00`) + 1);
}
export function newCareerRequestKey(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => {
    const digit = Math.floor(Math.random() * 16);
    return (value === 'x' ? digit : (digit & 3) | 8).toString(16);
  });
}

export function useCareerWorkspace(options: { autoLoad?: boolean } = {}) {
  const state = ref<CareerWorkspace>();
  const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('');
  let disposed = false, loadRequest = 0, mutationRevision = 0;
  let pendingCreate: { signature: string; key: string } | undefined;
  const jobs = computed(() => state.value?.jobs ?? []);
  const materials = computed(() => state.value?.materials ?? []);
  const portals = computed(() => state.value?.portals ?? []);
  const applications = computed(() => state.value?.applications ?? []);
  const favoriteJobIds = computed(() => state.value?.favoriteJobIds ?? []);
  function message(cause: unknown) { return cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'; }
  async function load() {
    if (busy.value) return;
    const requestId = ++loadRequest, version = mutationRevision;
    loading.value = true; error.value = '';
    try {
      const result = await careerApi.workspace();
      if (disposed || requestId !== loadRequest || version !== mutationRevision) return;
      state.value = result;
    } catch (cause) { if (!disposed && requestId === loadRequest) error.value = message(cause); }
    finally { if (!disposed && requestId === loadRequest) loading.value = false; }
  }
  async function mutate<T>(operation: () => Promise<T>, apply: (result: T, current: CareerWorkspace) => void, successMessage: string): Promise<T | undefined> {
    if (busy.value || disposed) return undefined;
    busy.value = true; error.value = ''; notice.value = '';
    ++loadRequest; ++mutationRevision; loading.value = false;
    try {
      const result = await operation();
      if (disposed) return undefined;
      if (state.value) apply(result, state.value);
      notice.value = successMessage;
      return result;
    } catch (cause) { if (!disposed) error.value = message(cause); return undefined; }
    finally { if (!disposed) busy.value = false; }
  }
  function upsertApplication(result: CareerApplication, current: CareerWorkspace) {
    current.applications = [result, ...current.applications.filter(item => item.id !== result.id)];
  }
  const createJob = (input: CareerJobInput) => mutate(() => careerApi.createJob(input), (result, current) => {
    current.jobs = [result, ...current.jobs.filter(item => item.id !== result.id)];
  }, '个人目标岗位已保存。');
  const removeJob = (id: string) => mutate(() => careerApi.removeJob(id), (_, current) => {
    current.jobs = current.jobs.filter(item => item.id !== id); current.favoriteJobIds = current.favoriteJobIds.filter(item => item !== id);
  }, '个人目标岗位已删除。');
  const favorite = (jobId: string, wanted: boolean) => mutate(() => careerApi.favorite(jobId, wanted), (result, current) => {
    current.favoriteJobIds = current.favoriteJobIds.filter(id => id !== result.jobId);
    if (result.favorite) current.favoriteJobIds.push(result.jobId);
  }, wanted ? '岗位已收藏。' : '岗位已取消收藏。');
  async function createApplication(input: Omit<ApplicationCreateInput, 'idempotencyKey'>) {
    const signature = JSON.stringify(input);
    if (!pendingCreate || pendingCreate.signature !== signature) pendingCreate = { signature, key: newCareerRequestKey() };
    const result = await mutate(() => careerApi.createApplication({ ...input, idempotencyKey: pendingCreate!.key }), upsertApplication, '投递计划已保存，尚未向外发送简历。');
    if (result) pendingCreate = undefined;
    return result;
  }
  const updateApplication = (id: string, input: ApplicationUpdateInput) => mutate(() => careerApi.updateApplication(id, input), upsertApplication,
    input.status ? `进度已记录为“${applicationStatusLabels[input.status]}”，由你手动更新。` : input.resumeId ? '计划已绑定所选简历版本，请重新核对正文。' : '备注已保存。');
  const removeApplication = (id: string, expectedRevision: number) => mutate(() => careerApi.removeApplication(id, expectedRevision), (_, current) => {
    current.applications = current.applications.filter(item => item.id !== id);
  }, '投递记录及关联简历快照已删除。');
  function dispose() { disposed = true; ++loadRequest; }
  if (options.autoLoad !== false) { onMounted(load); onUnmounted(dispose); }
  return { state, jobs, materials, portals, applications, favoriteJobIds, loading, busy, error, notice, load, createJob, removeJob, favorite, createApplication, updateApplication, removeApplication, dispose };
}
