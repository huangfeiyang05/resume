import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { CompanyCatalogFile, CompanyRecord } from '../shared/company.js';
import { validateCompanyCatalog, validateCompanyRecord } from './company-validation.js';
import { companyUrlContainsPrivateData } from './company-privacy.js';

const maxBytes = 20 * 1024 * 1024;
const maxRows = 25_000;
export const companyImportFields = ['name', 'aliases', 'industries', 'nature', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts', 'summary', 'recruitmentUrl'] as const;
export type CompanyImportField = typeof companyImportFields[number];
export type CompanyImportMapping = Partial<Record<CompanyImportField, string>>;
export class CompanyImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CompanyImportError'; }
}
const fail = (code: string, message: string): never => { throw new CompanyImportError(code, message); };
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const clean = (value: string) => value.replace(/\r\n?/g, '\n').trim();
const headerKey = (value: string) => clean(value).normalize('NFKC').toLowerCase().replace(/[\s_\-（）()：:]/g, '');
const aliases: Record<CompanyImportField, string[]> = {
  name: ['公司名称', '企业名称', '企业全称', '公司全称', '单位名称', '用人单位', '公司', '企业', 'name', 'company', 'companyname'],
  aliases: ['企业简称', '公司简称', '简称', '别名', 'aliases'],
  industries: ['行业', '所属行业', '企业行业', '行业分类', 'industries', 'industry'],
  nature: ['企业性质', '公司性质', '单位性质', '性质', 'nature', 'ownership'],
  locations: ['工作地点', '招聘地区', '招聘地点', '地区', '城市', '所在地', 'locations', 'location'],
  directions: ['招聘方向', '岗位方向', '专业方向', '招聘专业', '需求专业', '专业要求', '专业', 'directions', 'majors'],
  educationLevels: ['学历', '学历要求', '招聘学历', 'educationlevels', 'education'],
  recruitmentTypes: ['招聘类型', '招聘批次', '招聘类别', '招聘季', 'recruitmenttypes'],
  cohorts: ['届别', '毕业年份', '毕业届次', '毕业年级', '面向届别', 'cohorts'],
  summary: ['企业简介', '公司简介', '单位简介', '企业介绍', '公司介绍', 'summary', 'description'],
  recruitmentUrl: ['招聘链接', '网申链接', '申请链接', '招聘网址', '网申地址', '招聘官网', '招聘地址', 'recruitmenturl'],
};
const contactHeader = /联系人|联系方式|联系电话|手机|电话|邮箱|邮件|微信|微信群|qq群|群号|qq号|个人联系|contact|e-?mail|phone|mobile|wechat|weixin/i;
const contactContent = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[\t -]?\d){8}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)|(?:联系电话|联系方式|联系人|微信号|微信群|群号|QQ号)\s*[:：]?\s*\S+/i;

function urlHasContact(value: string): boolean {
  return companyUrlContainsPrivateData(value);
}

function textHasContact(value: string): boolean {
  const urls = value.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  if (urls.some(urlHasContact)) return true;
  // Numeric vacancy IDs inside a valid web address are not phone numbers.
  return contactContent.test(value.replace(/https?:\/\/[^\s<>"']+/g, ' '));
}

export function companySourceLabelHasPrivateData(value: string): boolean {
  return textHasContact(value) || /https?:\/\//i.test(value);
}

interface ImportTable { headers: string[]; rows: Array<{ row: number; cells: string[] }>; rowNumberBasis: 'table-row' | 'json-array-index' | 'explicit-row-number' }
export interface CompanyImportIssue { row: number; code: string; fields: string[] }
export interface CompanyImportReport {
  version: 1;
  signature: string;
  snapshotHash: string;
  importedAt: string;
  sourceTitle: string;
  sourceUrl?: string;
  sheet: string;
  rowNumberBasis: ImportTable['rowNumberBasis'];
  mapping: CompanyImportMapping;
  unmappedColumns: string[];
  excludedContactColumns: string[];
  totalRows: number;
  acceptedRows: number;
  records: number;
  duplicateRowsMerged: number;
  blankRows: number[];
  reviewRows: CompanyImportIssue[];
  sameNameCandidates: Array<{ rows: number[]; recordIds: string[] }>;
  /** Restricted audit material only. Never return this from a business API or log it. */
  rawRows: Array<{ row: number; cells: string[] }>;
}
export interface PrepareCompanyImportInput {
  bytes: Uint8Array;
  format: 'csv' | 'json';
  sourceTitle: string;
  sourceUrl?: string;
  sheet?: string;
  headerRow?: number;
  mapping?: CompanyImportMapping;
  importedAt?: string;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join('\n');
  return fail('INVALID_CELL', '单元格只能是文本、有限数字、布尔值或文本数组。');
}

/** RFC 4180-style CSV. Formula-like text is kept as text and later quarantined. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closedQuote = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || closedQuote) fail('INVALID_CSV', 'CSV 引号位置无效，请重新导出。');
      quoted = true;
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(cell); cell = ''; closedQuote = false;
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rows.push(row); row = [];
        if (rows.length > maxRows + 1000) fail('TOO_MANY_ROWS', '导入最多支持 25,000 条数据行。');
      }
    } else {
      if (closedQuote) fail('INVALID_CSV', 'CSV 引号后含无效内容，请重新导出。');
      cell += c;
    }
    if (cell.length > 100_000 || row.length > 200) fail('INVALID_CELL', '单元格过长或列数超过 200。');
  }
  if (quoted) fail('INVALID_CSV', 'CSV 引号未闭合，请重新导出。');
  if (cell || row.length || closedQuote) { row.push(cell); rows.push(row); }
  return rows;
}

function parseTable(text: string, format: 'csv' | 'json', headerRow: number): ImportTable {
  let matrix: string[][];
  if (format === 'csv') matrix = csvRows(text);
  else {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return fail('INVALID_JSON', 'JSON 无法解析，请检查输入文件。'); }
    if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      if (headerRow !== 1) fail('INVALID_HEADER_ROW', 'JSON 对象数组没有表头行，请不要设置 header-row。');
      const objects = value as Record<string, unknown>[];
      const headers = [...new Set(objects.flatMap(item => Object.keys(item)))];
      return { headers, rows: objects.map((item, index) => ({ row: index + 1, cells: headers.map(key => scalar(item[key])) })), rowNumberBasis: 'json-array-index' };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const table = value as Record<string, unknown>;
      if (Object.keys(table).some(key => !['headers', 'rows', 'rowNumbers'].includes(key)) || !Array.isArray(table.headers) || !table.headers.every(item => typeof item === 'string') || !Array.isArray(table.rows)) fail('INVALID_JSON_TABLE', 'JSON 表格须包含 headers 和 rows，可选 rowNumbers。');
      const sourceRows = table.rows as unknown[];
      if (table.rowNumbers !== undefined && (!Array.isArray(table.rowNumbers) || table.rowNumbers.length !== sourceRows.length || table.rowNumbers.some(item => !Number.isSafeInteger(item) || item < 1) || new Set(table.rowNumbers).size !== table.rowNumbers.length)) fail('INVALID_ROW_NUMBERS', '显式行号必须逐行对应、不重复且为正整数。');
      const numbers = table.rowNumbers as number[] | undefined;
      const rows = sourceRows.map((item, index) => {
        if (!Array.isArray(item)) return fail('INVALID_JSON_TABLE', 'JSON rows 每一行必须是数组。');
        return { row: numbers?.[index] ?? headerRow + index + 1, cells: item.map(scalar) };
      });
      return { headers: table.headers as string[], rows, rowNumberBasis: numbers ? 'explicit-row-number' : 'table-row' };
    }
    if (!Array.isArray(value) || !value.every(Array.isArray)) fail('INVALID_JSON_TABLE', 'JSON 须为对象数组、二维表格或 headers/rows 对象。');
    matrix = (value as unknown[][]).map(row => row.map(scalar));
  }
  if (headerRow > matrix.length) fail('INVALID_HEADER_ROW', '指定表头行不存在。');
  return { headers: matrix[headerRow - 1], rows: matrix.slice(headerRow).map((cells, index) => ({ row: headerRow + index + 1, cells })), rowNumberBasis: 'table-row' };
}

function resolveMapping(headers: string[], explicit: CompanyImportMapping = {}) {
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit) || Object.keys(explicit).some(key => !companyImportFields.includes(key as CompanyImportField)) || Object.values(explicit).some(value => typeof value !== 'string' || !value.trim())) fail('INVALID_MAPPING', '映射须为已支持字段到原始列名的 JSON 对象。');
  const normalized = headers.map(headerKey);
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_HEADERS', '表头存在重复列名，请先整理或明确区分原始列。');
  const excluded = headers.filter(header => contactHeader.test(header));
  const mapping: CompanyImportMapping = {};
  const indexes = new Map<CompanyImportField, number>();
  for (const field of companyImportFields) {
    let candidates: number[];
    if (explicit[field] !== undefined) candidates = headers.flatMap((header, i) => header === explicit[field] ? [i] : []);
    else candidates = normalized.flatMap((header, i) => aliases[field].map(headerKey).includes(header) && !excluded.includes(headers[i]) ? [i] : []);
    if (explicit[field] !== undefined && candidates.length !== 1) fail('MAPPING_COLUMN_MISSING', '映射指向不存在的列，请核对原始表头。');
    if (candidates.length > 1) fail('AMBIGUOUS_COLUMN', '多个原始列可映射到同一字段，请提供明确 mapping。');
    if (candidates.length === 1) {
      const index = candidates[0];
      if (excluded.includes(headers[index])) fail('CONTACT_COLUMN_MAPPING', '联系方式列不能映射到共享企业资料。');
      if ([...indexes.values()].includes(index)) fail('DUPLICATE_MAPPING', '同一原始列不能重复映射到不同字段。');
      indexes.set(field, index); mapping[field] = headers[index];
    }
  }
  if (!indexes.has('name')) fail('NAME_COLUMN_REQUIRED', '未找到企业名称列，请设置 mapping.name 或修正表头。');
  return { mapping, indexes, excluded, unmapped: headers.filter((header, index) => !indexesHasValue(indexes, index) && !excluded.includes(header)) };
}
function indexesHasValue(indexes: Map<CompanyImportField, number>, index: number) { return [...indexes.values()].includes(index); }
function splitLabels(value: string) { return [...new Set(value.split(/[\n、,，;；|]+/).map(clean).filter(Boolean))]; }
function canonicalContent(value: Omit<CompanyRecord, 'id' | 'sources' | 'updatedAt'>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? [...item].sort() : item])));
}

export function prepareCompanyImport(input: PrepareCompanyImportInput): { catalog: CompanyCatalogFile; report: CompanyImportReport; signature: string } {
  if (!['csv', 'json'].includes(input.format)) fail('UNSUPPORTED_FORMAT', '目前导入器支持 UTF-8 CSV 或 JSON。');
  if (input.bytes.byteLength > maxBytes) fail('INPUT_TOO_LARGE', '输入文件超过 20 MiB。');
  const title = clean(input.sourceTitle ?? '');
  if (!title || title.length > 200 || /\0/.test(title)) fail('INVALID_SOURCE', '须提供不超过 200 字的来源标题。');
  const sheet = clean(input.sheet ?? '');
  if (sheet.length > 160 || /\0/.test(sheet)) fail('INVALID_SOURCE', '工作表名称无效。');
  let sourceUrl: string | undefined;
  if (input.sourceUrl) {
    try { const url = new URL(input.sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); sourceUrl = url.href; }
    catch { return fail('INVALID_SOURCE_URL', '来源链接必须为无账号密码的 HTTP 或 HTTPS 地址。'); }
  }
  const headerRow = input.headerRow ?? 1;
  if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > 1000) fail('INVALID_HEADER_ROW', 'header-row 必须是 1 至 1,000 的整数。');
  const importedAt = input.importedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(importedAt))) fail('INVALID_IMPORT_TIME', '整理时间无效。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, ''); }
  catch { return fail('INVALID_ENCODING', '输入须为 UTF-8 编码，请从表格重新导出 UTF-8 CSV。'); }
  if (!text.trim() || text.includes('\0')) fail('EMPTY_OR_BINARY_INPUT', '输入为空或含二进制内容。');
  const table = parseTable(text, input.format, headerRow);
  if (!table.headers.length || table.headers.length > 200 || table.headers.some(header => !clean(header) || header.length > 500) || table.rows.length > maxRows || table.rows.some(row => row.cells.length > table.headers.length || row.cells.some(cell => cell.length > 100_000))) fail('INVALID_TABLE', '表格列、行或单元格超出边界，请整理原始文件。');
  const { mapping, indexes, excluded, unmapped } = resolveMapping(table.headers, input.mapping);
  const snapshotHash = hash(input.bytes);
  const signature = hash(JSON.stringify({ snapshotHash, format: input.format, sourceTitle: title, sourceUrl: sourceUrl ?? null, sheet, headerRow, mapping: Object.fromEntries(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))) }));
  const report: CompanyImportReport = {
    version: 1, signature, snapshotHash, importedAt, sourceTitle: title, ...(sourceUrl ? { sourceUrl } : {}), sheet,
    rowNumberBasis: table.rowNumberBasis, mapping, unmappedColumns: unmapped, excludedContactColumns: excluded,
    totalRows: table.rows.length, acceptedRows: 0, records: 0, duplicateRowsMerged: 0, blankRows: [], reviewRows: [], sameNameCandidates: [], rawRows: table.rows,
  };
  const records = new Map<string, CompanyRecord>();
  for (const row of table.rows) {
    if (row.cells.every(cell => !clean(cell))) { report.blankRows.push(row.row); continue; }
    const cells = Object.fromEntries(companyImportFields.map(field => [field, clean(row.cells[indexes.get(field) ?? -1] ?? '')])) as Record<CompanyImportField, string>;
    const contactFields = companyImportFields.filter(field => field === 'recruitmentUrl' ? urlHasContact(cells[field]) : textHasContact(cells[field]));
    if (contactFields.length) { report.reviewRows.push({ row: row.row, code: 'CONTACT_CONTENT', fields: contactFields }); continue; }
    const formulaFields = companyImportFields.filter(field => /^\s*[=]/.test(cells[field]));
    if (formulaFields.length) { report.reviewRows.push({ row: row.row, code: 'FORMULA_CONTENT', fields: formulaFields }); continue; }
    if (!cells.name) { report.reviewRows.push({ row: row.row, code: 'EMPTY_NAME', fields: ['name'] }); continue; }
    const content: Omit<CompanyRecord, 'id' | 'sources' | 'updatedAt'> = {
      name: cells.name, aliases: splitLabels(cells.aliases), industries: splitLabels(cells.industries), nature: cells.nature,
      locations: splitLabels(cells.locations), directions: splitLabels(cells.directions), educationLevels: splitLabels(cells.educationLevels),
      recruitmentTypes: splitLabels(cells.recruitmentTypes), cohorts: splitLabels(cells.cohorts), summary: cells.summary,
      ...(cells.recruitmentUrl ? { recruitmentUrl: cells.recruitmentUrl } : {}), verification: 'source-provided',
    };
    const identity = hash(canonicalContent(content));
    let record: CompanyRecord;
    try {
      // The shared catalog keeps a neutral source label for auditing; platform names and links stay in the restricted report only.
      record = validateCompanyRecord({ ...content, id: `company-${identity.slice(0, 24)}`, updatedAt: importedAt, sources: [{ title, sheet, rows: [row.row], snapshotHash, importedAt }] });
    } catch { report.reviewRows.push({ row: row.row, code: 'INVALID_RECORD', fields: [...indexes.keys()] }); continue; }
    report.acceptedRows++;
    const previous = records.get(identity);
    if (previous) {
      const latest = previous.sources.at(-1)!;
      if (latest.rows.length >= 10_000) previous.sources.push({ ...record.sources[0], rows: [row.row] });
      else latest.rows.push(row.row);
      report.duplicateRowsMerged++;
    }
    else records.set(identity, record);
  }
  const catalog = validateCompanyCatalog({ version: 1, records: [...records.values()] });
  if (Buffer.byteLength(`${JSON.stringify(catalog, null, 2)}\n`) > maxBytes) fail('OUTPUT_TOO_LARGE', '整理后目录超过 20 MiB，请拆分原始资料。');
  report.records = catalog.records.length;
  const names = new Map<string, CompanyRecord[]>();
  for (const record of catalog.records) { const key = record.name.normalize('NFKC').toLowerCase(); names.set(key, [...names.get(key) ?? [], record]); }
  for (const candidates of names.values()) if (candidates.length > 1) report.sameNameCandidates.push({ rows: candidates.flatMap(record => record.sources.flatMap(source => source.rows)), recordIds: candidates.map(record => record.id) });
  return { catalog, report, signature };
}

export interface RunCompanyImportInput extends Omit<PrepareCompanyImportInput, 'bytes' | 'format'> {
  inputPath: string;
  outputPath?: string;
  reportPath?: string;
  apply?: boolean;
  replace?: boolean;
  allowPartial?: boolean;
}
interface ImportState { version: 1; signature: string; outputHash: string; importedAt: string }
async function optionalBytes(file: string): Promise<Buffer | undefined> { try { return await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
async function rejectSymbolicLink(file: string) {
  try { if ((await lstat(file)).isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '目录、报告或导入状态不能是符号链接。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function atomicPrivateWrite(file: string, bytes: string | Uint8Array) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

/** Operator-only offline import. It never downloads a source or updates user/account data. */
export async function runCompanyImport(input: RunCompanyImportInput) {
  const inputPath = resolve(input.inputPath), outputPath = resolve(input.outputPath ?? '.data/company-catalog.json');
  const format = extname(inputPath).toLowerCase().slice(1);
  if (!['csv', 'json'].includes(format)) fail('UNSUPPORTED_FORMAT', '目前导入器支持 UTF-8 CSV 或 JSON；Excel 请先授权导出为 CSV。');
  if (inputPath === outputPath || input.reportPath && [inputPath, outputPath].includes(resolve(input.reportPath))) fail('PATH_CONFLICT', '输入、公司目录和报告必须使用不同文件。');
  if (!(await stat(inputPath)).isFile() || (await stat(inputPath)).size > maxBytes) fail('INPUT_TOO_LARGE', '输入须为不超过 20 MiB 的普通文件。');
  const bytes = await readFile(inputPath);
  await rejectSymbolicLink(outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const lockPath = `${outputPath}.import.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('IMPORT_LOCKED', '该公司目录已有导入进行中，请完成后重试。'); throw error; }
  try {
    const oldBytes = await optionalBytes(outputPath), statePath = `${outputPath}.import-state.json`;
    await rejectSymbolicLink(statePath);
    const stateBytes = await optionalBytes(statePath);
    let state: ImportState | undefined;
    if (stateBytes) {
      try { state = JSON.parse(stateBytes.toString('utf8')) as ImportState; if (state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.signature) || !/^[a-f0-9]{64}$/.test(state.outputHash) || !Number.isFinite(Date.parse(state.importedAt))) throw new Error(); }
      catch { return fail('INVALID_IMPORT_STATE', '导入状态记录损坏，请先核对受限备份，不会覆盖当前目录。'); }
    }
    let prepared = prepareCompanyImport({ ...input, bytes, format: format as 'csv' | 'json' });
    const alreadyImported = !!oldBytes && !!state && state.signature === prepared.signature && state.outputHash === hash(oldBytes);
    if (alreadyImported) prepared = prepareCompanyImport({ ...input, bytes, format: format as 'csv' | 'json', importedAt: state!.importedAt });
    const importDirectory = join(dirname(outputPath), 'company-imports', prepared.signature);
    const reportPath = resolve(input.reportPath ?? join(importDirectory, input.apply ? 'applied-report.json' : 'preview-report.json'));
    const rawPath = join(importDirectory, `input.${format}`);
    if ([inputPath, outputPath, lockPath, statePath, rawPath].includes(reportPath)) fail('PATH_CONFLICT', '报告不能覆盖原件、公司目录、导入锁或状态记录。');
    await rejectSymbolicLink(reportPath);
    await rejectSymbolicLink(rawPath);
    await mkdir(importDirectory, { recursive: true, mode: 0o700 });
    const existingRaw = await optionalBytes(rawPath);
    if (existingRaw && hash(existingRaw) !== hash(bytes)) fail('SOURCE_SNAPSHOT_CONFLICT', '同一导入记录的原件已变化，请先核对受限文件。');
    if (!existingRaw) await atomicPrivateWrite(rawPath, bytes);
    const previousReport = await optionalBytes(reportPath);
    if (previousReport) {
      try { if (JSON.parse(previousReport.toString('utf8')).signature !== prepared.signature) throw new Error(); }
      catch { return fail('REPORT_CONFLICT', '报告路径已有其他内容，请换用新报告路径，不会覆盖原文件。'); }
    }
    const report = { ...prepared.report, mode: input.apply ? 'apply-requested' : 'dry-run', alreadyImported, outputWritten: false, inputPath, outputPath };
    await atomicPrivateWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!input.apply) return { applied: false, alreadyImported, reportPath, outputPath, report: prepared.report };
    if (prepared.report.reviewRows.length && !input.allowPartial) fail('REVIEW_REQUIRED', '有待审核行，已生成受限报告；处理后重试，或明确 allow-partial 仅发布通过的行。');
    if (!prepared.catalog.records.length) fail('NO_RECORDS', '没有通过校验的企业记录，不会发布空目录。');
    if (alreadyImported) {
      await atomicPrivateWrite(reportPath, `${JSON.stringify({ ...report, mode: 'already-imported' }, null, 2)}\n`);
      return { applied: true, alreadyImported: true, reportPath, outputPath, report: prepared.report };
    }
    if (oldBytes && !input.replace) fail('REPLACE_REQUIRED', '目录已存在且不是同一导入结果；检查报告后显式使用 replace，替换前会备份。');
    let backupDirectory: string | undefined;
    if (oldBytes) {
      // Do not parse/rewrite the previous source. Preserve its exact bytes for recovery.
      backupDirectory = join(dirname(outputPath), 'company-imports', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await copyFile(outputPath, join(backupDirectory, basename(outputPath)), constants.COPYFILE_EXCL);
      await writeFile(join(backupDirectory, 'import-state.json'), stateBytes ?? 'null\n', { flag: 'wx', mode: 0o600 });
      // copyFile retains neither a safe mode nor a guarantee about source permissions.
      const backup = await open(join(backupDirectory, basename(outputPath)), 'r+'); try { await backup.chmod(0o600); } finally { await backup.close(); }
    }
    const output = `${JSON.stringify(prepared.catalog, null, 2)}\n`;
    await atomicPrivateWrite(outputPath, output);
    await atomicPrivateWrite(statePath, `${JSON.stringify({ version: 1, signature: prepared.signature, outputHash: hash(output), importedAt: prepared.report.importedAt } satisfies ImportState, null, 2)}\n`);
    await atomicPrivateWrite(reportPath, `${JSON.stringify({ ...report, mode: 'applied', outputWritten: true, ...(backupDirectory ? { backupDirectory } : {}) }, null, 2)}\n`);
    return { applied: true, alreadyImported: false, reportPath, outputPath, report: prepared.report, ...(backupDirectory ? { backupDirectory } : {}) };
  } finally { try { await lock.close(); } finally { await rm(lockPath, { force: true }); } }
}
