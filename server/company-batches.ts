import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { careerFileLimits } from '../shared/career-attachment.js';
import { companyBatchFileLimit, type CompanyBatchEvent, type CompanyBatchPreview, type CompanyBatchState } from '../shared/company-batch.js';
import type { CompanyRecord } from '../shared/company.js';
import { careerObject } from './career-validation.js';
import { CompanyImportError, companySourceLabelHasPrivateData, prepareCompanyImport, type CompanyImportMapping } from './company-import.js';
import { companyCatalogLimits, validateCompanyCatalog } from './company-validation.js';
import { CompanyCatalogRepository } from './company-catalog.js';
import { HttpError, invalid, notFound } from './errors.js';

const lifetime = 20 * 60_000;
const maxSnapshots = 32;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Journal = { events: CompanyBatchEvent[]; pending?: CompanyBatchEvent };
type Pending = { actorId: string; expires: number; event: CompanyBatchEvent; next: Buffer | null };
type Upload = { id: string; actorId: string; chunks: Buffer[]; size: number; expires: number };

function validId(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid('批次标识无效。');
  return value;
}

function validateEvent(value: unknown): value is CompanyBatchEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const revision = (item: unknown) => typeof item === 'string' && (item === '' || hashPattern.test(item));
  const count = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= companyCatalogLimits.records;
  return typeof row.id === 'string' && uuid.test(row.id) && (row.action === 'publish' || row.action === 'rollback')
    && typeof row.actorId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.actorId)
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    && typeof row.sourceTitle === 'string' && row.sourceTitle.length <= 200
    && typeof row.sourceHash === 'string' && hashPattern.test(row.sourceHash)
    && revision(row.before) && revision(row.after) && row.before !== row.after && count(row.beforeCount) && count(row.afterCount);
}

async function privateFile(path: string, maximum: number): Promise<Buffer | undefined> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.size > maximum) throw new HttpError(503, 'COMPANY_BATCH_STORAGE_INVALID', '企业批次文件不可读取，请联系维护人员。');
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new HttpError(503, 'COMPANY_BATCH_STORAGE_INVALID', '企业批次文件超过容量限制。');
  return bytes;
}

async function replaceFile(path: string, bytes: Buffer | string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

const nameKey = (value: string) => value.normalize('NFKC').trim().toLowerCase();
function contentKey({ id: _id, sources: _sources, updatedAt: _updatedAt, ...record }: CompanyRecord) {
  return JSON.stringify(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]));
}

export class CompanyBatches {
  private readonly directory: string;
  private readonly journalPath: string;
  private upload?: Upload;
  private pending?: Pending;
  private report?: { id: string; actorId: string; expires: number; value: object };

  constructor(private readonly catalog: CompanyCatalogRepository) {
    this.directory = join(dirname(catalog.path), 'company-batches');
    this.journalPath = join(this.directory, 'journal.json');
  }

  chunk(body: unknown, actorId: string) {
    const input = careerObject(body, ['id', 'index', 'data']);
    const id = validId(input.id), index = input.index, data = input.data;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0
      || typeof data !== 'string' || !data || data.length > careerFileLimits.chunkBytes * 4 / 3
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) invalid('文件分片无效。');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) invalid('文件分片编码无效。');
    const now = Date.now();
    if (this.upload && this.upload.expires <= now) this.upload = undefined;
    if (!this.upload || this.upload.id !== id) {
      if (index !== 0) notFound('上传批次');
      if (this.upload && this.upload.actorId !== actorId) throw new HttpError(409, 'COMPANY_BATCH_BUSY', '已有管理员正在导入，请稍后重试。');
      this.upload = { id, actorId, chunks: [], size: 0, expires: now + lifetime };
    }
    const upload = this.upload;
    if (upload.actorId !== actorId) notFound('上传批次');
    if (index < upload.chunks.length && upload.chunks[index].equals(bytes)) return { receivedBytes: upload.size };
    if (index !== upload.chunks.length || (index > 0 && upload.chunks[index - 1].length !== careerFileLimits.chunkBytes)) {
      throw new HttpError(409, 'COMPANY_BATCH_CHUNK_CONFLICT', '文件分片顺序或内容不一致，请重新上传。');
    }
    if (upload.size + bytes.length > companyBatchFileLimit) throw new HttpError(413, 'COMPANY_BATCH_TOO_LARGE', '文件不能超过 10 MB。');
    upload.chunks.push(bytes);
    upload.size += bytes.length;
    upload.expires = now + lifetime;
    return { receivedBytes: upload.size };
  }

  private async current() {
    const snapshot = await this.catalog.load();
    if (snapshot.state === 'unavailable') throw new HttpError(503, 'COMPANY_CATALOG_UNAVAILABLE', snapshot.message);
    return snapshot;
  }

  private async history(revision: string): Promise<CompanyBatchEvent[]> {
    const bytes = await privateFile(this.journalPath, 1024 * 1024);
    if (!bytes) return [];
    let journal: Journal;
    try {
      journal = JSON.parse(bytes.toString('utf8'));
      if (!journal || !Array.isArray(journal.events) || journal.events.length > 200 || !journal.events.every(validateEvent)
        || (journal.pending !== undefined && !validateEvent(journal.pending))
        || new Set([...journal.events, ...(journal.pending ? [journal.pending] : [])].map(event => event.id)).size
          !== journal.events.length + Number(!!journal.pending)) throw new Error();
    } catch {
      throw new HttpError(503, 'COMPANY_BATCH_STORAGE_INVALID', '企业批次历史不可读取，请联系维护人员。');
    }
    if (!journal.pending) return journal.events;
    if (journal.pending.after === revision) return [...journal.events, journal.pending];
    if (journal.pending.before === revision) return journal.events;
    throw new HttpError(409, 'COMPANY_BATCH_RECOVERY_REQUIRED', '目录与未完成的批次记录不一致，请先核对备份。');
  }

  async state(): Promise<CompanyBatchState> {
    const current = await this.current();
    const events = await this.history(current.revision);
    return { count: current.records.length, history: [...events].reverse(), canRollback: events.at(-1)?.after === current.revision };
  }

  async preview(body: unknown, actorId: string): Promise<CompanyBatchPreview> {
    const input = careerObject(body, ['id', 'bytes', 'format', 'sourceTitle', 'sheet', 'headerRow', 'mapping']);
    const id = validId(input.id), upload = this.upload;
    if (!upload || upload.id !== id || upload.actorId !== actorId || upload.expires <= Date.now()) notFound('上传批次');
    if (input.bytes !== upload.size || (input.format !== 'csv' && input.format !== 'json')) invalid('文件长度或格式无效。');
    if (typeof input.sourceTitle !== 'string' || (input.sheet !== undefined && typeof input.sheet !== 'string')
      || (input.headerRow !== undefined && typeof input.headerRow !== 'number')) invalid('资料来源或表头设置无效。');
    if (companySourceLabelHasPrivateData(input.sourceTitle) || companySourceLabelHasPrivateData(input.sheet ?? '')) {
      invalid('来源名称和工作表只填写通用标签，请移除网址和联系方式。');
    }
    const bytes = Buffer.concat(upload.chunks, upload.size);
    this.upload = undefined;
    let prepared;
    try {
      prepared = prepareCompanyImport({ bytes, format: input.format, sourceTitle: input.sourceTitle,
        sheet: input.sheet, headerRow: input.headerRow, mapping: input.mapping as CompanyImportMapping | undefined });
    } catch (error) {
      if (error instanceof CompanyImportError) throw new HttpError(400, error.code, error.message);
      throw error;
    }
    const current = await this.current();
    const { report, catalog } = prepared;
    const known = new Set(current.records.map(contentKey));
    const ids = new Set(current.records.map(record => record.id));
    const names = new Set(current.records.map(record => nameKey(record.name)));
    const conflicts = new Set(report.sameNameCandidates.flatMap(group => group.recordIds));
    const skipped: CompanyRecord[] = [];
    let normalizedDuplicates = 0;
    const incoming = new Set<string>();
    const added = catalog.records.filter(record => {
      const key = contentKey(record);
      if (known.has(key)) { skipped.push(record); return false; }
      if (incoming.has(key)) { normalizedDuplicates++; return false; }
      incoming.add(key);
      return true;
    });
    if (added.some(record => ids.has(record.id))) throw new HttpError(409, 'COMPANY_BATCH_ID_CONFLICT', '目录存在标识冲突，请核对原始资料。');
    const sameName = (record: CompanyRecord) => names.has(nameKey(record.name)) || conflicts.has(record.id);
    const describe = (record: CompanyRecord) => ({
      name: record.name, rows: record.sources.flatMap(source => source.rows), recruitmentTypes: record.recruitmentTypes, sameName: sameName(record),
    });
    const reportId = randomUUID();
    const summary: CompanyBatchPreview = { id: null, reportId, action: 'publish', sourceTitle: report.sourceTitle,
      beforeCount: current.records.length, afterCount: current.records.length + added.length, inputRows: report.totalRows,
      duplicateRows: report.duplicateRowsMerged + normalizedDuplicates, existingRecords: skipped.length,
      sameNameRecords: added.filter(sameName).length, unmappedColumns: report.unmappedColumns.length,
      excludedContactColumns: report.excludedContactColumns.length, reviewCount: report.reviewRows.length,
      reviewRows: report.reviewRows.slice(0, 30), sample: added.slice(0, 30).map(record => {
        const row = describe(record);
        return { ...row, rows: row.rows.slice(0, 8) };
      }) };
    this.report = { id: reportId, actorId, expires: Date.now() + lifetime, value: {
      sourceTitle: report.sourceTitle, sourceHash: report.snapshotHash, rowNumberBasis: report.rowNumberBasis,
      added: added.map(item => {
        const { sources: _sources, updatedAt: _updatedAt, ...record } = item;
        return { ...record, ...describe(item) };
      }),
      existing: skipped.map(describe), reviewRows: report.reviewRows, blankRows: report.blankRows, mappedFields: Object.keys(report.mapping),
      duplicateRows: summary.duplicateRows, unmappedColumns: summary.unmappedColumns, excludedContactColumns: summary.excludedContactColumns,
    } };
    if (report.reviewRows.length || !added.length) return summary;
    const next = this.encode([...current.records, ...added]);
    return this.stage(actorId, current.revision, report.snapshotHash, next, summary);
  }

  reviewReport(body: unknown, actorId: string) {
    const id = validId(careerObject(body, ['id']).id);
    const report = this.report;
    if (!report || report.id !== id || report.actorId !== actorId || report.expires <= Date.now()) notFound('批次审核报告');
    return report.value;
  }

  async previewRollback(body: unknown, actorId: string): Promise<CompanyBatchPreview> {
    careerObject(body, []);
    const current = await this.current(), latest = (await this.history(current.revision)).at(-1);
    if (!latest || latest.after !== current.revision) throw new HttpError(409, 'COMPANY_BATCH_ROLLBACK_UNAVAILABLE', '当前目录没有可回滚的最新批次。');
    const previous = latest.before ? await privateFile(join(this.directory, `${latest.before}.json`), companyCatalogLimits.bytes) : null;
    if (latest.before && (!previous || hash(previous) !== latest.before)) {
      throw new HttpError(503, 'COMPANY_BATCH_SNAPSHOT_INVALID', '无法读取回滚所需的上一版目录。');
    }
    const restoredCount = previous ? validateCompanyCatalog(JSON.parse(previous.toString('utf8'))).records.length : 0;
    return this.stage(actorId, current.revision, latest.sourceHash, previous ?? null, { id: null, action: 'rollback',
      sourceTitle: latest.sourceTitle, beforeCount: current.records.length, afterCount: restoredCount,
      inputRows: 0, duplicateRows: 0, existingRecords: 0, sameNameRecords: 0, unmappedColumns: 0,
      excludedContactColumns: 0, reviewCount: 0, reviewRows: [], sample: [] });
  }

  private encode(records: CompanyRecord[]) {
    if (records.length > companyCatalogLimits.records) invalid('发布后的企业目录超出记录数量上限。');
    const next = Buffer.from(JSON.stringify({ version: 1, records }));
    if (next.length > companyCatalogLimits.bytes) invalid('发布后的企业目录超出 20 MiB 容量限制。');
    return next;
  }

  private stage(actorId: string, before: string, sourceHash: string, next: Buffer | null, summary: CompanyBatchPreview) {
    const now = Date.now(), id = randomUUID();
    this.pending = { actorId, expires: now + lifetime, next, event: {
      id, action: summary.action, actorId, at: new Date(now).toISOString(), sourceTitle: summary.sourceTitle,
      sourceHash, before, after: next ? hash(next) : '', beforeCount: summary.beforeCount, afterCount: summary.afterCount,
    } };
    return { ...summary, id };
  }

  async apply(body: unknown, actorId: string): Promise<CompanyBatchEvent> {
    const input = careerObject(body, ['id', 'confirmed']);
    const id = validId(input.id);
    if (input.confirmed !== true) invalid('请核对差异预览并确认。');
    await mkdir(dirname(this.catalog.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.catalog.path}.import.lock`;
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'COMPANY_BATCH_BUSY', '企业目录有写入操作正在进行，请稍后重试。');
      throw error;
    }
    try {
      const current = await this.current();
      const events = await this.history(current.revision);
      const existing = events.find(event => event.id === id);
      if (existing) {
        if (existing.actorId !== actorId) notFound('批次预览');
        return existing;
      }
      const pending = this.pending;
      if (!pending || pending.event.id !== id || pending.actorId !== actorId || pending.expires <= Date.now()) notFound('批次预览');
      if (pending.event.before !== current.revision) throw new HttpError(409, 'COMPANY_BATCH_STALE', '企业目录已变化，请重新预览。');
      if (events.length >= 200) throw new HttpError(409, 'COMPANY_BATCH_HISTORY_FULL', '企业批次历史已达上限，请联系维护人员。');
      const previous = await privateFile(this.catalog.path, companyCatalogLimits.bytes);
      if ((previous ? hash(previous) : '') !== current.revision) throw new HttpError(409, 'COMPANY_BATCH_STALE', '企业目录已变化，请重新预览。');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (previous) {
        const path = join(this.directory, `${current.revision}.json`);
        const saved = await privateFile(path, companyCatalogLimits.bytes);
        if (saved && hash(saved) !== current.revision) throw new HttpError(503, 'COMPANY_BATCH_SNAPSHOT_INVALID', '企业历史快照校验失败。');
        if (!saved) {
          const snapshots = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
          if (snapshots.length >= maxSnapshots && pending.event.action !== 'rollback') {
            throw new HttpError(409, 'COMPANY_BATCH_HISTORY_FULL', '企业目录快照已达上限，请联系维护人员。');
          }
          await replaceFile(path, previous);
        }
      }
      const event = { ...pending.event, at: new Date().toISOString() };
      // The catalogue switch commits the intent. After interruption its exact hash distinguishes the two outcomes.
      await replaceFile(this.journalPath, JSON.stringify({ events, pending: event }));
      if (pending.next) await replaceFile(this.catalog.path, pending.next);
      else await unlink(this.catalog.path);
      if (this.pending === pending) this.pending = undefined;
      await replaceFile(this.journalPath, JSON.stringify({ events: [...events, event] }));
      return event;
    } finally {
      try { await lock.close(); } finally { await unlink(lockPath); }
    }
  }
}
