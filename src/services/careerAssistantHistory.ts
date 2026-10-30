import type { CareerAssistantResult, CareerJob, CompanyFilters, CompanySearchHit } from '../../shared/types';
import type { CareerChatMessage } from './careerAssistant';

/** 历史对话只保存在当前浏览器或小程序本机，按账号隔离；不写入服务端，也不进入共享企业资料库。 */
export interface CareerConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}
export interface CareerConversationRecord extends CareerConversationSummary {
  requirements: string;
  resumeId?: string;
  resumeRevision?: number;
  messages: CareerChatMessage[];
}
export interface CareerHistoryStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const MAX_CAREER_HISTORY_CONVERSATIONS = 12;
export const MAX_CAREER_HISTORY_MESSAGES = 30;
const MAX_RECORD_LENGTH = 300_000;
const MAX_TITLE_LENGTH = 80;
const conversationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const filterKeys = ['industries', 'natures', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts'] as const;

const uniStorage: CareerHistoryStorage = {
  get(key) {
    try {
      const value = uni.getStorageSync(key);
      return typeof value === 'string' ? value : undefined;
    } catch { return undefined; }
  },
  set(key, value) { uni.setStorageSync(key, value); },
  remove(key) { try { uni.removeStorageSync(key); } catch { /* 本机缓存清理失败不阻断当前操作 */ } },
};

function ownerKey(owner: string): string {
  try { return encodeURIComponent((owner || 'anonymous').trim().slice(0, 120) || 'anonymous'); } catch { return 'anonymous'; }
}

const recordValue = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integerValue = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const timeValue = (value: unknown): value is number => integerValue(value, 1, 9_999_999_999_999);
function valueText(value: unknown, max: number, empty = false): string | undefined {
  return typeof value === 'string' && value.length <= max && (empty || !!value.trim()) ? value : undefined;
}
function listValue(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value) ? value.map(item => valueText(item, maxLength)).filter((item): item is string => item !== undefined).slice(0, maxItems) : [];
}
function urlValue(value: unknown): string | undefined {
  const raw = valueText(value, 2000);
  return raw && /^https?:\/\/[^\s\\]+$/.test(raw) ? raw : undefined;
}
const sliceText = (value: string, max: number): string => value.slice(0, max);

interface StoredCompany { id: string; name: string; nature: string; industries: string[]; locations: string[]; directions: string[]; summary: string; recruitmentUrl?: string }
interface StoredJob { id: string; company: string; title: string; major: string; location: string; description: string; sourceUrl?: string }
interface StoredResume { id: string; title: string; revision: number; inputHash: string }
interface StoredResult {
  engine: 'local-rules'; reply: string; resume?: StoredResume;
  criteria: { query: string; filters: Partial<CompanyFilters>; unverifiedRequirements: string[] };
  companies: StoredCompany[]; companyTotal: number; personalJobs: StoredJob[];
  evidence: Array<{ term: string; excerpt: string }>;
  catalogState: 'empty' | 'ready' | 'unavailable';
  action?: { type: 'analyze-resume'; resumeId: string; revision: number; targetRole: string };
}
interface StoredMessage { id: number; role: 'user' | 'assistant'; content: string; result?: StoredResult }

function compactResult(result: CareerAssistantResult): StoredResult {
  const filters: Partial<CompanyFilters> = {};
  for (const key of filterKeys) {
    const values = result.criteria.filters[key];
    if (values?.length) filters[key] = values.slice(0, 30).map(item => sliceText(item, 100));
  }
  return {
    engine: 'local-rules',
    reply: sliceText(result.reply, 10_000),
    resume: result.resume ? { id: sliceText(result.resume.id, 100), title: sliceText(result.resume.title, 200), revision: result.resume.revision, inputHash: result.resume.inputHash } : undefined,
    criteria: { query: sliceText(result.criteria.query, 200), filters, unverifiedRequirements: result.criteria.unverifiedRequirements.slice(0, 10).map(item => sliceText(item, 240)) },
    companies: result.companies.map(company => ({
      id: sliceText(company.id, 100), name: sliceText(company.name, 200), nature: sliceText(company.nature, 100),
      industries: company.industries.slice(0, 50).map(item => sliceText(item, 100)), locations: company.locations.slice(0, 200).map(item => sliceText(item, 100)),
      directions: company.directions.slice(0, 100).map(item => sliceText(item, 100)), summary: sliceText(company.summary, 1200),
      ...(company.recruitmentUrl ? { recruitmentUrl: sliceText(company.recruitmentUrl, 2000) } : {}),
    })),
    companyTotal: result.companyTotal,
    personalJobs: result.personalJobs.map(job => ({
      id: sliceText(job.id, 100), company: sliceText(job.company, 200), title: sliceText(job.title, 200), major: sliceText(job.major, 200),
      location: sliceText(job.location, 200), description: sliceText(job.description, 1200), ...(job.sourceUrl ? { sourceUrl: sliceText(job.sourceUrl, 2000) } : {}),
    })),
    evidence: result.evidence.slice(0, 3).map(item => ({ term: sliceText(item.term, 60), excerpt: sliceText(item.excerpt, 320) })),
    catalogState: result.catalogState,
    ...(result.action ? { action: { ...result.action } } : {}),
  };
}

function hydrateCompany(value: unknown): CompanySearchHit | undefined {
  if (!recordValue(value)) return undefined;
  const id = valueText(value.id, 100, true), name = valueText(value.name, 200, true);
  if (!id || !name) return undefined;
  const recruitmentUrl = urlValue(value.recruitmentUrl);
  return {
    id, name, aliases: [], industries: listValue(value.industries, 50, 100), nature: valueText(value.nature, 100, true) ?? '',
    locations: listValue(value.locations, 200, 100), directions: listValue(value.directions, 100, 100), educationLevels: [], recruitmentTypes: [], cohorts: [],
    summary: valueText(value.summary, 1200, true) ?? '', verification: 'source-provided', updatedAt: '', matchedFields: [], sources: [],
    ...(recruitmentUrl ? { recruitmentUrl } : {}),
  };
}
function hydrateJob(value: unknown): CareerJob | undefined {
  if (!recordValue(value)) return undefined;
  const id = valueText(value.id, 100, true), company = valueText(value.company, 200, true), title = valueText(value.title, 200, true);
  if (!id || !company || !title) return undefined;
  const sourceUrl = urlValue(value.sourceUrl);
  return {
    id, origin: 'personal', company, title, major: valueText(value.major, 200) ?? '', location: valueText(value.location, 200) ?? '',
    description: valueText(value.description, 1200) ?? '', companyOverview: '', sourceLabel: '', availability: 'open', updatedAt: '',
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}
function hydrateResult(value: unknown): CareerAssistantResult | undefined {
  if (!recordValue(value)) return undefined;
  const reply = valueText(value.reply, 10_000), catalogState = value.catalogState, companyTotal = value.companyTotal, criteriaValue = value.criteria;
  if (!reply || !['empty', 'ready', 'unavailable'].includes(catalogState as string) || !integerValue(companyTotal, 0, 25_000) || !recordValue(criteriaValue)) return undefined;
  const query = valueText(criteriaValue.query, 200, true), filtersValue = criteriaValue.filters;
  if (query === undefined || !recordValue(filtersValue)) return undefined;
  const filters: Partial<CompanyFilters> = {};
  for (const key of filterKeys) if (key in filtersValue) filters[key] = listValue(filtersValue[key], 30, 100);
  let resume: StoredResume | undefined;
  const resumeValue = value.resume;
  if (recordValue(resumeValue)) {
    const id = valueText(resumeValue.id, 100, true), title = valueText(resumeValue.title, 200, true), revision = resumeValue.revision, inputHash = valueText(resumeValue.inputHash, 64, true);
    if (id && title && integerValue(revision, 1) && inputHash) resume = { id, title, revision, inputHash };
  }
  let action: CareerAssistantResult['action'];
  const actionValue = value.action;
  if (recordValue(actionValue) && actionValue.type === 'analyze-resume') {
    const resumeId = valueText(actionValue.resumeId, 100, true), revision = actionValue.revision, targetRole = valueText(actionValue.targetRole, 120, true);
    if (resumeId && integerValue(revision, 1) && targetRole) action = { type: 'analyze-resume', resumeId, revision, targetRole };
  }
  const companies = Array.isArray(value.companies) ? value.companies.map(hydrateCompany).filter((item): item is CompanySearchHit => !!item).slice(0, 5) : [];
  const personalJobs = Array.isArray(value.personalJobs) ? value.personalJobs.map(hydrateJob).filter((item): item is CareerJob => !!item).slice(0, 5) : [];
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(item => {
    if (!recordValue(item)) return undefined;
    const term = valueText(item.term, 60, true), excerpt = valueText(item.excerpt, 320, true);
    return term && excerpt ? { term, excerpt } : undefined;
  }).filter((item): item is { term: string; excerpt: string } => !!item).slice(0, 3) : [];
  return {
    engine: 'local-rules', reply, ...(resume ? { resume } : {}),
    criteria: { query, filters, unverifiedRequirements: listValue(criteriaValue.unverifiedRequirements, 10, 240) },
    companies, companyTotal, personalJobs, evidence, catalogState: catalogState as 'empty' | 'ready' | 'unavailable', ...(action ? { action } : {}),
  };
}

function compactMessage(message: CareerChatMessage): StoredMessage {
  return { id: message.id, role: message.role, content: sliceText(message.content, 10_000), ...(message.result ? { result: compactResult(message.result) } : {}) };
}
function hydrateMessage(value: unknown, index: number): CareerChatMessage | undefined {
  if (!recordValue(value) || !['user', 'assistant'].includes(value.role as string)) return undefined;
  const content = valueText(value.content, 10_000, true);
  if (!content) return undefined;
  return { id: index + 1, role: value.role as 'user' | 'assistant', content, ...(value.result ? { result: hydrateResult(value.result) } : {}) };
}

export function createCareerHistory(owner: string, storage: CareerHistoryStorage = uniStorage) {
  const keyBase = `resume-youfang:career-assistant:v1:${ownerKey(owner)}`;
  const indexKey = `${keyBase}:index`;
  const chatKey = (id: string) => `${keyBase}:chat:${id}`;

  function readIndex(): CareerConversationSummary[] {
    const raw = storage.get(indexKey);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const seen = new Set<string>(), items: CareerConversationSummary[] = [];
      for (const item of parsed) {
        if (!recordValue(item)) continue;
        const id = valueText(item.id, 40, true), title = valueText(item.title, MAX_TITLE_LENGTH, true), updatedAt = item.updatedAt;
        const messageCount = item.messageCount;
        if (!id || !conversationIdPattern.test(id) || !title || !timeValue(updatedAt) || !integerValue(messageCount, 0) || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, title, updatedAt, messageCount });
      }
      return items.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_CAREER_HISTORY_CONVERSATIONS);
    } catch { return []; }
  }
  function writeIndex(items: CareerConversationSummary[]): boolean {
    try { storage.set(indexKey, JSON.stringify(items)); return true; } catch { return false; }
  }
  function list(): CareerConversationSummary[] { return readIndex(); }
  function load(id: string): CareerConversationRecord | undefined {
    if (!conversationIdPattern.test(id)) return undefined;
    const raw = storage.get(chatKey(id));
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!recordValue(parsed) || parsed.id !== id || !Array.isArray(parsed.messages)) return undefined;
      const title = valueText(parsed.title, MAX_TITLE_LENGTH, true), updatedAt = parsed.updatedAt, requirements = valueText(parsed.requirements, 2000, true);
      if (!title || !timeValue(updatedAt) || requirements === undefined) return undefined;
      const messages = parsed.messages.map(hydrateMessage).filter((item): item is CareerChatMessage => !!item).slice(-MAX_CAREER_HISTORY_MESSAGES);
      if (!messages.length) return undefined;
      const resumeId = valueText(parsed.resumeId, 100, true), rawRevision = parsed.resumeRevision;
      const resumeRevision = integerValue(rawRevision, 1) ? rawRevision : undefined;
      return {
        id, title, updatedAt, messageCount: messages.length, requirements,
        ...(resumeId && resumeRevision ? { resumeId, resumeRevision } : {}), messages,
      };
    } catch { return undefined; }
  }
  function save(record: CareerConversationRecord): boolean {
    if (!conversationIdPattern.test(record.id)) return false;
    const title = valueText(record.title, MAX_TITLE_LENGTH, true);
    if (!title) return false;
    const updatedAt = timeValue(record.updatedAt) ? record.updatedAt : Date.now();
    let storedMessages = record.messages.slice(-MAX_CAREER_HISTORY_MESSAGES).map(compactMessage);
    if (!storedMessages.length) return false;
    const build = () => JSON.stringify({
      version: 1, id: record.id, title, updatedAt, requirements: sliceText(record.requirements, 2000),
      ...(record.resumeId && record.resumeRevision ? { resumeId: sliceText(record.resumeId, 100), resumeRevision: record.resumeRevision } : {}),
      messages: storedMessages,
    });
    let payload = build();
    while (payload.length > MAX_RECORD_LENGTH && storedMessages.length > 2) { storedMessages = storedMessages.slice(1); payload = build(); }
    if (payload.length > MAX_RECORD_LENGTH) {
      storedMessages = storedMessages.map(message => message.result ? { id: message.id, role: message.role, content: message.content } : message);
      payload = build();
    }
    if (payload.length > MAX_RECORD_LENGTH) return false;
    try { storage.set(chatKey(record.id), payload); } catch { return false; }
    const items = readIndex().filter(item => item.id !== record.id);
    items.unshift({ id: record.id, title, updatedAt, messageCount: storedMessages.length });
    items.sort((left, right) => right.updatedAt - left.updatedAt);
    const kept = items.slice(0, MAX_CAREER_HISTORY_CONVERSATIONS), dropped = items.slice(MAX_CAREER_HISTORY_CONVERSATIONS);
    for (const item of dropped) storage.remove(chatKey(item.id));
    if (!writeIndex(kept)) { try { storage.remove(chatKey(record.id)); } catch { /* 清理失败不阻断 */ } return false; }
    return true;
  }
  function remove(id: string): void {
    if (!conversationIdPattern.test(id)) return;
    storage.remove(chatKey(id));
    writeIndex(readIndex().filter(item => item.id !== id));
  }
  function clear(): void {
    for (const item of readIndex()) storage.remove(chatKey(item.id));
    storage.remove(indexKey);
  }
  return { list, load, save, remove, clear };
}
