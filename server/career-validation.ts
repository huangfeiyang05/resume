import type { ApplicationCreateInput, ApplicationStatus, ApplicationUpdateInput, CareerApplication, CareerJob, CareerJobInput, CareerMaterial, CareerRecruitmentPortal, Resume } from '../shared/types.js';
import { invalid } from './errors.js';
import { inputLimits } from '../shared/limits.js';

export const applicationStatuses: ApplicationStatus[] = ['planned', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
export interface StoredCareerJob extends CareerJob { userId: string }
export interface StoredCareerApplication extends CareerApplication { userId: string }
export interface CareerKey { userId: string; key: string; inputHash: string; applicationId: string; deleted: boolean }
export interface CareerStorage {
  careerJobs: StoredCareerJob[];
  careerFavorites: Array<{ userId: string; jobId: string }>;
  careerApplications: StoredCareerApplication[];
  careerKeys: CareerKey[];
}

export function careerObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求体必须是 JSON 对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key))) invalid('请求体含不支持的字段。');
  return input;
}
export function careerText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须是文本。`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if ((!allowEmpty && !normalized) || normalized.length > max || normalized.includes('\0')) invalid(`${label}为空、过长或含无效字符。`);
  return normalized;
}
export function careerId(value: unknown): string {
  const id = careerText(value, 'ID', 100);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid('ID 格式无效。');
  return id;
}
export function careerRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('revision 必须是正整数。');
  return value as number;
}
export function careerDate(value: unknown): string {
  const date = careerText(value, '截止日期', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) invalid('截止日期必须是有效的 YYYY-MM-DD 日期。');
  return date;
}
function timestamp(value: unknown): string {
  const text = careerText(value, '更新时间', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) invalid('更新时间无效。');
  careerDate(text.slice(0, 10));
  return text;
}
export function careerUrl(value: unknown): string {
  const text = careerText(value, '来源链接', 2000);
  let url: URL;
  try { url = new URL(text); } catch { invalid('来源链接必须是 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) invalid('来源链接必须是 HTTP 或 HTTPS 地址，且不能包含账号密码。');
  return url.href;
}

export function validateCareerJobInput(body: unknown): CareerJobInput {
  const input = careerObject(body, ['company', 'title', 'major', 'location', 'description', 'companyOverview', 'sourceUrl', 'deadline']);
  return {
    company: careerText(input.company, '公司', 120), title: careerText(input.title, '岗位', 120),
    major: careerText(input.major, '专业', 100), location: careerText(input.location, '地点', 100),
    description: careerText(input.description, '岗位描述', inputLimits.jobDescription),
    companyOverview: careerText(input.companyOverview ?? '', '公司介绍', 5000, true),
    ...(input.sourceUrl === undefined || input.sourceUrl === '' ? {} : { sourceUrl: careerUrl(input.sourceUrl) }),
    ...(input.deadline === undefined || input.deadline === '' ? {} : { deadline: careerDate(input.deadline) }),
  };
}
export function validateApplicationCreate(body: unknown): ApplicationCreateInput {
  const input = careerObject(body, ['jobId', 'resumeId', 'resumeRevision', 'idempotencyKey']);
  return { jobId: careerId(input.jobId), resumeId: careerId(input.resumeId), resumeRevision: careerRevision(input.resumeRevision), idempotencyKey: careerId(input.idempotencyKey) };
}
export function validateApplicationUpdate(body: unknown): ApplicationUpdateInput {
  const input = careerObject(body, ['revision', 'status', 'note', 'resumeId', 'resumeRevision', 'confirmedManualSubmission']);
  if (!['status', 'note', 'resumeId'].some(key => Object.hasOwn(input, key))) invalid('至少提供一个要修改的字段。');
  if (input.status !== undefined && !applicationStatuses.includes(input.status as ApplicationStatus)) invalid('投递状态无效。');
  if (input.confirmedManualSubmission !== undefined && typeof input.confirmedManualSubmission !== 'boolean') invalid('投递确认必须为布尔值。');
  if (Object.hasOwn(input, 'resumeId') !== Object.hasOwn(input, 'resumeRevision')) invalid('更换简历时必须同时提供简历和修订号。');
  return {
    revision: careerRevision(input.revision),
    ...(input.status !== undefined ? { status: input.status as ApplicationStatus } : {}),
    ...(input.note !== undefined ? { note: careerText(input.note, '备注', 2000, true) } : {}),
    ...(input.resumeId !== undefined ? { resumeId: careerId(input.resumeId), resumeRevision: careerRevision(input.resumeRevision) } : {}),
    ...(input.confirmedManualSubmission !== undefined ? { confirmedManualSubmission: input.confirmedManualSubmission as boolean } : {}),
  };
}

export function validateCatalogJob(value: unknown, expectedOrigin: 'catalog' | 'personal' = 'catalog'): CareerJob {
  const job = careerObject(value, ['id', 'origin', 'company', 'title', 'major', 'location', 'description', 'companyOverview', 'sourceLabel', 'sourceUrl', 'deadline', 'availability', 'updatedAt', 'audience', 'checkedAt']);
  if (!['catalog', 'personal'].includes(job.origin as string) || job.origin !== expectedOrigin || !['open', 'closed'].includes(job.availability as string)) invalid('岗位类型或开放状态无效。');
  if (job.audience !== undefined && !['campus', 'internship', 'experienced', 'early-career'].includes(job.audience as string)) invalid('岗位招聘类型无效。');
  const input = validateCareerJobInput(Object.fromEntries(['company', 'title', 'major', 'location', 'description', 'companyOverview', 'sourceUrl', 'deadline'].filter(key => Object.hasOwn(job, key)).map(key => [key, job[key]])));
  return { ...input, companyOverview: input.companyOverview ?? '', id: careerId(job.id), origin: expectedOrigin, sourceLabel: careerText(job.sourceLabel, '资料来源', 200), availability: job.availability as 'open' | 'closed', updatedAt: timestamp(job.updatedAt),
    ...(job.audience === undefined ? {} : { audience: job.audience as CareerJob['audience'] }),
    ...(job.checkedAt === undefined ? {} : { checkedAt: timestamp(job.checkedAt) }) };
}
export function validateCatalogMaterial(value: unknown): CareerMaterial {
  const item = careerObject(value, ['id', 'title', 'major', 'role', 'summary', 'content', 'sourceLabel', 'sourceUrl', 'updatedAt']);
  return {
    id: careerId(item.id), title: careerText(item.title, '资料标题', 160), major: careerText(item.major, '专业', 100),
    role: careerText(item.role, '对应岗位', 120, true), summary: careerText(item.summary, '资料摘要', 1000, true),
    content: careerText(item.content, '资料正文', 100000), sourceLabel: careerText(item.sourceLabel, '资料来源', 200),
    ...(item.sourceUrl === undefined ? {} : { sourceUrl: careerUrl(item.sourceUrl) }), updatedAt: timestamp(item.updatedAt),
  };
}

export function validateRecruitmentPortal(value: unknown): CareerRecruitmentPortal {
  const item = careerObject(value, ['id', 'organization', 'majors', 'audience', 'description', 'sourceUrl', 'checkedAt']);
  if (!Array.isArray(item.majors) || !item.majors.length || item.majors.length > 30) invalid('招聘入口须提供适用专业。');
  const majors = item.majors.map(value => careerText(value, '专业', 100));
  if (new Set(majors).size !== majors.length) invalid('招聘入口的专业不能重复。');
  const sourceUrl = careerUrl(item.sourceUrl);
  if (!sourceUrl.startsWith('https://')) invalid('官方招聘入口必须使用 HTTPS。');
  return {
    id: careerId(item.id), organization: careerText(item.organization, '机构名称', 160), majors,
    audience: careerText(item.audience, '适用人群', 120), description: careerText(item.description, '入口说明', 2000),
    sourceUrl, checkedAt: timestamp(item.checkedAt),
  };
}

function validateStoredResume(value: unknown): Resume {
  const resume = careerObject(value, ['id', 'title', 'targetRole', 'text', 'createdAt', 'updatedAt', 'revision']);
  careerId(resume.id); careerText(resume.title, '简历名称', inputLimits.title); careerText(resume.targetRole, '目标岗位', inputLimits.targetRole, true);
  careerText(resume.text, '简历正文', inputLimits.resumeText); careerRevision(resume.revision); timestamp(resume.createdAt); timestamp(resume.updatedAt);
  return resume as unknown as Resume;
}
export function normalizeCareerStorage(value: Record<string, unknown>): CareerStorage {
  const data: Record<string, unknown[]> = {};
  for (const key of ['careerJobs', 'careerFavorites', 'careerApplications', 'careerKeys']) {
    if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error('Malformed career database.');
    data[key] = value[key] as unknown[] ?? [];
  }
  try {
    const careerJobs = data.careerJobs.map(value => {
      const { userId, ...job } = careerObject(value, ['userId', 'id', 'origin', 'company', 'title', 'major', 'location', 'description', 'companyOverview', 'sourceLabel', 'sourceUrl', 'deadline', 'availability', 'updatedAt']);
      return { ...validateCatalogJob(job, 'personal'), userId: careerId(userId) };
    });
    const careerFavorites = data.careerFavorites.map(value => {
      const item = careerObject(value, ['userId', 'jobId']); return { userId: careerId(item.userId), jobId: careerId(item.jobId) };
    });
    const careerKeys = data.careerKeys.map(value => {
      const item = careerObject(value, ['userId', 'key', 'inputHash', 'applicationId', 'deleted']);
      if (typeof item.deleted !== 'boolean' || typeof item.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.inputHash)) invalid('幂等记录无效。');
      return { userId: careerId(item.userId), key: careerId(item.key), applicationId: careerId(item.applicationId), inputHash: item.inputHash, deleted: item.deleted };
    });
    const careerApplications = data.careerApplications.map(value => {
      const item = careerObject(value, ['id', 'userId', 'jobId', 'jobSnapshot', 'resumeSnapshot', 'resumeHash', 'status', 'note', 'revision', 'createdAt', 'updatedAt', 'history', 'submissionMode']);
      if (!applicationStatuses.includes(item.status as ApplicationStatus) || item.submissionMode !== 'manual' || typeof item.resumeHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.resumeHash) || !Array.isArray(item.history) || !item.history.length) invalid('投递记录无效。');
      const jobOrigin = (item.jobSnapshot as CareerJob)?.origin;
      const jobSnapshot = validateCatalogJob(item.jobSnapshot, jobOrigin);
      if (jobSnapshot.id !== item.jobId) invalid('岗位快照无效。');
      const history = item.history.map(value => {
        const event = careerObject(value, ['status', 'at', 'source']);
        if (!applicationStatuses.includes(event.status as ApplicationStatus) || event.source !== 'user') invalid('状态历史无效。');
        return { status: event.status as ApplicationStatus, at: timestamp(event.at), source: 'user' as const };
      });
      if (history.at(-1)!.status !== item.status) invalid('状态历史不一致。');
      return {
        id: careerId(item.id), userId: careerId(item.userId), jobId: careerId(item.jobId), jobSnapshot,
        resumeSnapshot: validateStoredResume(item.resumeSnapshot), resumeHash: item.resumeHash, status: item.status as ApplicationStatus,
        note: careerText(item.note, '备注', 2000, true), revision: careerRevision(item.revision), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt),
        history, submissionMode: 'manual' as const,
      };
    });
    for (const [records, identity] of [
      [careerJobs, (item: StoredCareerJob) => item.id], [careerApplications, (item: StoredCareerApplication) => item.id],
      [careerFavorites, (item: { userId: string; jobId: string }) => `${item.userId}:${item.jobId}`],
      [careerKeys, (item: CareerKey) => `${item.userId}:${item.key}`],
    ] as const) {
      const keys = (records as unknown[]).map(item => (identity as (item: unknown) => string)(item));
      if (new Set(keys).size !== keys.length) invalid('重复的数据标识。');
    }
    return { careerJobs, careerFavorites, careerApplications, careerKeys };
  } catch { throw new Error('Malformed career database.'); }
}
