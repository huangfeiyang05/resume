import { companyFilterKeys, type CompanyCatalogFile, type CompanyRecord, type CompanySearchInput, type CompanySource, type CompanySort } from '../shared/company.js';
import { invalid } from './errors.js';
import { companyUrlContainsPrivateData } from './company-privacy.js';

export const companyCatalogLimits = { bytes: 20 * 1024 * 1024, records: 25_000 } as const;

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('企业资料必须为 JSON 对象。');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) invalid('企业资料含不支持的字段。');
  return record;
}
function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须是文本。`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if ((!allowEmpty && !normalized) || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) invalid(`${label}为空、过长或含无效字符。`);
  return normalized;
}
function strings(value: unknown, label: string, count: number, length = 100): string[] {
  if (!Array.isArray(value) || value.length > count) invalid(`${label}必须是有效的文本列表。`);
  const result = value.map(item => text(item, label, length));
  if (new Set(result).size !== result.length) invalid(`${label}不能重复。`);
  return result;
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(`${label}无效。`);
  const date = result.slice(0, 10), parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) invalid(`${label}无效。`);
  return result;
}
function url(value: unknown, label: string): string {
  const result = text(value, label, 2000);
  if (/[\s\\]/.test(result)) invalid(`${label}必须为无账号密码的 HTTP 或 HTTPS 地址。`);
  let parsed: URL;
  try { parsed = new URL(result); } catch { invalid(`${label}必须为有效网址。`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) invalid(`${label}必须为无账号密码的 HTTP 或 HTTPS 地址。`);
  if (companyUrlContainsPrivateData(parsed.href)) invalid(`${label}不能包含联系参数或私密凭据。`);
  return parsed.href;
}
export function validateCompanyId(value: unknown): string {
  const result = text(value, '企业 ID', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) invalid('企业 ID 格式无效。');
  return result;
}
function source(value: unknown): CompanySource {
  const record = object(value, ['title', 'url', 'sheet', 'rows', 'snapshotHash', 'importedAt']);
  if (!Array.isArray(record.rows) || !record.rows.length || record.rows.length > 10_000
    || record.rows.some(row => !Number.isSafeInteger(row) || row < 1) || new Set(record.rows).size !== record.rows.length) invalid('资料来源行号无效。');
  const snapshotHash = text(record.snapshotHash, '来源快照哈希', 64);
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) invalid('来源快照哈希无效。');
  return {
    title: text(record.title, '资料来源名称', 200), sheet: text(record.sheet, '工作表名称', 160, true),
    rows: [...record.rows] as number[], snapshotHash, importedAt: timestamp(record.importedAt, '导入时间'),
    ...(record.url === undefined ? {} : { url: url(record.url, '资料来源链接') }),
  };
}

/** Validates supplied facts only; no ownership, industry or hiring status is inferred. */
export function validateCompanyRecord(value: unknown): CompanyRecord {
  const record = object(value, ['id', 'name', 'aliases', 'industries', 'nature', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts', 'summary', 'recruitmentUrl', 'verification', 'updatedAt', 'sources']);
  if (record.verification !== 'source-provided') invalid('企业资料须标明为来源提供的信息。');
  if (!Array.isArray(record.sources) || !record.sources.length || record.sources.length > 50) invalid('企业资料须保留有效来源。');
  return {
    id: validateCompanyId(record.id), name: text(record.name, '企业名称', 200),
    aliases: strings(record.aliases, '企业别名', 100, 200), industries: strings(record.industries, '企业行业', 50),
    nature: text(record.nature, '企业性质', 100, true), locations: strings(record.locations, '企业地区', 200),
    directions: strings(record.directions, '资料方向', 100), educationLevels: strings(record.educationLevels, '资料学历要求', 30),
    recruitmentTypes: strings(record.recruitmentTypes, '招聘类型', 30), cohorts: strings(record.cohorts, '资料届别', 30),
    summary: text(record.summary, '企业资料说明', 20_000, true), verification: 'source-provided',
    updatedAt: timestamp(record.updatedAt, '资料更新时间'), sources: record.sources.map(source),
    ...(record.recruitmentUrl === undefined ? {} : { recruitmentUrl: url(record.recruitmentUrl, '招聘来源链接') }),
  };
}
export function validateCompanyCatalog(value: unknown): CompanyCatalogFile {
  const record = object(value, ['version', 'records']);
  if (record.version !== 1 || !Array.isArray(record.records) || record.records.length > companyCatalogLimits.records) invalid('企业资料目录版本或记录数量无效。');
  const records = record.records.map(validateCompanyRecord);
  if (new Set(records.map(record => record.id)).size !== records.length) invalid('企业资料 ID 不能重复。');
  return { version: 1, records };
}

function integer(value: string, label: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value)) invalid(`${label}必须为正整数。`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) invalid(`${label}超出允许范围。`);
  return result;
}
/** Public query values never choose a file, a user identity or a membership tier. */
export function validateCompanySearchParams(params: URLSearchParams): CompanySearchInput {
  const scalarKeys = ['q', 'page', 'pageSize', 'sort'];
  const allowed: readonly string[] = [...scalarKeys, ...companyFilterKeys];
  for (const key of params.keys()) if (!allowed.includes(key)) invalid('企业查询含不支持的参数。');
  for (const key of scalarKeys) if (params.getAll(key).length > 1) invalid('企业查询参数不能重复。');
  const rawQuery = text(params.get('q') ?? '', '企业查询关键词', 200, true);
  const q = rawQuery.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (q.length > 200 || q.split(' ').filter(Boolean).length > 20) invalid('企业查询关键词过多或过长。');
  const sort = params.get('sort') ?? 'relevance';
  if (!['relevance', 'name', 'updated'].includes(sort)) invalid('企业排序方式无效。');
  const filters = Object.fromEntries(companyFilterKeys.map(key => [key, strings(params.getAll(key), '企业筛选条件', 30)]));
  return {
    q, sort: sort as CompanySort, page: integer(params.get('page') ?? '1', '页码', Number.MAX_SAFE_INTEGER),
    pageSize: integer(params.get('pageSize') ?? '20', '每页数量', 50), filters,
  };
}
