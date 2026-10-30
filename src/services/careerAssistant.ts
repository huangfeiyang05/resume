import { ref } from 'vue';
import { companyFilterKeys } from '../../shared/company';
import type { CareerAssistantInput, CareerAssistantResult, CompanyFilterKey, CompanyMatchField, Resume } from '../../shared/types';
import { ApiError, api, request } from './api';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, empty = true): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && (empty || !!value.trim());
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const strings = (value: unknown, count: number, length = 100): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => text(item, length, false)) && new Set(value).size === value.length;
const instant = (value: unknown): value is string => text(value, 50, false) && Number.isFinite(Date.parse(value));
const url = (value: unknown): value is string => text(value, 2000, false) && /^https?:\/\/[^/\s@?#\\]+(?:[/?#][^\s\\]*)?$/.test(value);
const hash = (value: unknown): value is string => text(value, 64) && /^[a-f0-9]{64}$/.test(value);
const matchFields: CompanyMatchField[] = ['name', 'aliases', 'industries', 'nature', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts', 'summary'];

function company(value: unknown): boolean {
  return record(value) && text(value.id, 100, false) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.id)
    && text(value.name, 200, false) && strings(value.aliases, 100, 200) && strings(value.industries, 50)
    && text(value.nature, 100) && strings(value.locations, 200) && strings(value.directions, 100)
    && strings(value.educationLevels, 30) && strings(value.recruitmentTypes, 30) && strings(value.cohorts, 30)
    && text(value.summary, 20_000) && value.verification === 'source-provided' && instant(value.updatedAt)
    && (value.recruitmentUrl === undefined || url(value.recruitmentUrl))
    && Array.isArray(value.matchedFields) && value.matchedFields.every(field => matchFields.includes(field as CompanyMatchField))
    && new Set(value.matchedFields).size === value.matchedFields.length
    && Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 50 && value.sources.every(source => record(source)
      && text(source.title, 200, false) && text(source.sheet, 160) && hash(source.snapshotHash) && instant(source.importedAt)
      && Array.isArray(source.rows) && source.rows.length > 0 && source.rows.length <= 10_000 && source.rows.every(row => integer(row, 1))
      && new Set(source.rows).size === source.rows.length && (source.url === undefined || url(source.url)));
}
function personalJob(value: unknown): boolean {
  return record(value) && text(value.id, 100, false) && value.origin === 'personal'
    && ['company', 'title', 'major', 'location', 'description', 'companyOverview', 'sourceLabel'].every(key => text(value[key], 50_000))
    && ['open', 'closed'].includes(value.availability as string) && instant(value.updatedAt)
    && (value.sourceUrl === undefined || url(value.sourceUrl))
    && (value.deadline === undefined || (text(value.deadline, 10) && /^\d{4}-\d{2}-\d{2}$/.test(value.deadline)));
}
function validResume(value: unknown, id: string): value is Resume {
  return record(value) && value.id === id && text(value.title, 200, false) && text(value.targetRole, 200)
    && text(value.text, 200_000) && integer(value.revision, 1) && instant(value.createdAt) && instant(value.updatedAt);
}
function invalidResponse(): never { throw new ApiError('助手返回的资料无法核对，请重试。', 'INVALID_ASSISTANT_RESPONSE', 502); }
function invalidInput(): never { throw new ApiError('请填写问题，求职要求和每条问题不超过 2000 字。', 'INVALID_ASSISTANT_INPUT', 400); }

function checkedInput(input: CareerAssistantInput): CareerAssistantInput {
  if (!record(input) || Object.keys(input).some(key => !['resumeId', 'resumeRevision', 'requirements', 'message', 'history'].includes(key))
    || !text(input.requirements, 2000) || !text(input.message, 2000, false)
    || ((input.resumeId === undefined) !== (input.resumeRevision === undefined))
    || (input.resumeId !== undefined && (!text(input.resumeId, 100, false) || !integer(input.resumeRevision, 1)))
    || (input.history !== undefined && (!Array.isArray(input.history) || input.history.length > 10 || !input.history.every(item => record(item)
      && Object.keys(item).every(key => ['role', 'content'].includes(key)) && ['user', 'assistant'].includes(item.role as string) && text(item.content, 2000, false))))) invalidInput();
  return { ...(input.resumeId ? { resumeId: input.resumeId, resumeRevision: input.resumeRevision } : {}), requirements: input.requirements.trim(), message: input.message.trim(),
    history: input.history?.map(item => ({ role: item.role, content: item.content })) ?? [] };
}

export const careerAssistantApi = {
  async ask(raw: CareerAssistantInput): Promise<CareerAssistantResult> {
    const input = checkedInput(raw), value = await request<unknown>('/career/assistant', 'POST', input);
    if (!record(value) || value.engine !== 'local-rules' || !text(value.reply, 10_000, false)
      || !['empty', 'ready', 'unavailable'].includes(value.catalogState as string) || !integer(value.companyTotal, 0, 25_000)
      || !Array.isArray(value.companies) || value.companies.length > 5 || value.companies.length > value.companyTotal || !value.companies.every(company)
      || new Set(value.companies.map(item => (item as Record<string, unknown>).id)).size !== value.companies.length
      || (value.catalogState !== 'ready' && (value.companyTotal !== 0 || value.companies.length !== 0))
      || !Array.isArray(value.personalJobs) || value.personalJobs.length > 5 || !value.personalJobs.every(personalJob)
      || new Set(value.personalJobs.map(item => (item as Record<string, unknown>).id)).size !== value.personalJobs.length
      || !Array.isArray(value.evidence) || value.evidence.length > 3 || !value.evidence.every(item => record(item) && text(item.term, 60, false) && text(item.excerpt, 320, false))
      || !record(value.criteria) || !text(value.criteria.query, 200) || !strings(value.criteria.unverifiedRequirements, 10, 240)
      || !record(value.criteria.filters) || Object.keys(value.criteria.filters).some(key => !companyFilterKeys.includes(key as CompanyFilterKey))
      || !Object.values(value.criteria.filters).every(items => strings(items, 30))) invalidResponse();
    if (input.resumeId) {
      if (!record(value.resume) || value.resume.id !== input.resumeId || value.resume.revision !== input.resumeRevision
        || !text(value.resume.title, 200, false) || !hash(value.resume.inputHash)) invalidResponse();
    } else if (value.resume !== undefined || value.action !== undefined || value.evidence.length) invalidResponse();
    if (value.action !== undefined && (!record(value.action) || value.action.type !== 'analyze-resume'
      || value.action.resumeId !== input.resumeId || value.action.revision !== input.resumeRevision || !text(value.action.targetRole, 120))) invalidResponse();
    return value as unknown as CareerAssistantResult;
  },
};

export interface CareerChatMessage { id: number; role: 'user' | 'assistant'; content: string; result?: CareerAssistantResult }
/** Conversation lives in the mounted workspace or in a locally saved history record. Responses from a previous context are discarded. */
export function useCareerAssistant() {
  const selectedResume = ref<Resume>(), updatedResume = ref<Resume>(), requirements = ref('');
  const messages = ref<CareerChatMessage[]>([]), pendingMessage = ref(''), loading = ref(false), error = ref(''), canRetry = ref(false);
  let disposed = false, requestId = 0, messageId = 0, retryInput: CareerAssistantInput | undefined;
  function reset() { ++requestId; messages.value = []; pendingMessage.value = ''; loading.value = false; error.value = ''; canRetry.value = false; retryInput = undefined; updatedResume.value = undefined; }
  /** 载入本机保存的对话：消息 id 按顺序重排，清空待处理与冲突状态，不发起网络请求。 */
  function restoreConversation(conversation: { messages: CareerChatMessage[]; requirements: string; resume?: Resume }) {
    ++requestId; loading.value = false; pendingMessage.value = ''; error.value = ''; canRetry.value = false; retryInput = undefined; updatedResume.value = undefined;
    selectedResume.value = conversation.resume ? { ...conversation.resume } : undefined;
    requirements.value = conversation.requirements.slice(0, 2000);
    messages.value = conversation.messages.slice(-30).map((message, index) => ({ ...message, id: index + 1 }));
    messageId = messages.value.length;
  }
  function selectResume(resume?: Resume) {
    if (selectedResume.value?.id === resume?.id && selectedResume.value?.revision === resume?.revision) return;
    reset(); selectedResume.value = resume ? { ...resume } : undefined;
  }
  function setRequirements(value: string) { if (requirements.value === value) return; reset(); requirements.value = value; }
  function noteResumeUpdate(resume: Resume) {
    if (!selectedResume.value || selectedResume.value.id !== resume.id || selectedResume.value.revision === resume.revision) return;
    reset(); updatedResume.value = { ...resume }; error.value = '这份简历已更新，请先核对新版本，再继续提问。';
  }
  function reviewUpdatedResume() { if (updatedResume.value) selectResume(updatedResume.value); }
  async function execute(input: CareerAssistantInput): Promise<boolean> {
    if (disposed || loading.value) return false;
    const currentRequest = ++requestId;
    loading.value = true; error.value = ''; pendingMessage.value = input.message; canRetry.value = false; retryInput = input;
    try {
      let checkedResume: Resume | undefined;
      if (input.resumeId) {
        const latest = await api.resume(input.resumeId);
        if (disposed || currentRequest !== requestId) return false;
        if (!validResume(latest, input.resumeId)) invalidResponse();
        if (latest.revision !== input.resumeRevision) {
          updatedResume.value = latest; retryInput = undefined;
          error.value = '这份简历已更新，请先核对新版本，再继续提问。'; return false;
        }
        checkedResume = latest;
      }
      const result = await careerAssistantApi.ask(input);
      if (disposed || currentRequest !== requestId) return false;
      if (checkedResume && result.evidence.some(item => !checkedResume.text.includes(item.excerpt))) invalidResponse();
      messages.value.push({ id: ++messageId, role: 'user', content: input.message }, { id: ++messageId, role: 'assistant', content: result.reply, result });
      pendingMessage.value = ''; retryInput = undefined; return true;
    } catch (cause) {
      if (!disposed && currentRequest === requestId) { error.value = cause instanceof Error ? cause.message : '提问未完成，请稍后重试。'; canRetry.value = true; }
      return false;
    } finally { if (!disposed && currentRequest === requestId) loading.value = false; }
  }
  async function send(message: string) {
    if (disposed || loading.value || updatedResume.value) return false;
    try {
      const resume = selectedResume.value;
      const input = checkedInput({ ...(resume ? { resumeId: resume.id, resumeRevision: resume.revision } : {}), requirements: requirements.value, message,
        history: messages.value.slice(-10).map(item => ({ role: item.role, content: item.content.slice(0, 2000) })) });
      return await execute(input);
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '请核对输入后重试。'; canRetry.value = false; return false; }
  }
  function retry() { return retryInput ? execute(retryInput) : Promise.resolve(false); }
  function dispose() { disposed = true; reset(); selectedResume.value = undefined; requirements.value = ''; }
  return { selectedResume, updatedResume, requirements, messages, pendingMessage, loading, error, canRetry, selectResume, setRequirements, noteResumeUpdate, reviewUpdatedResume, restoreConversation, send, retry, reset, dispose };
}
