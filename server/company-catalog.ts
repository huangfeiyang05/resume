import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import type { BigIntStats } from 'node:fs';
import type { CompanyDetail, CompanyRecord } from '../shared/company.js';
import { companyDirectoryRecord } from './company-labels.js';
import { companySourceReview } from './company-source-reviews.js';
import { companyCatalogLimits, validateCompanyCatalog, validateCompanyId } from './company-validation.js';
import { HttpError, notFound } from './errors.js';

export interface CompanyCatalogSnapshot {
  readonly state: 'empty' | 'ready' | 'unavailable';
  readonly message: string;
  readonly revision: string;
  readonly records: readonly CompanyRecord[];
}
const empty = (): CompanyCatalogSnapshot => Object.freeze({ state: 'empty', message: '企业资料尚未导入，请稍后查阅。', revision: '', records: Object.freeze([]) });
const unavailable = (): CompanyCatalogSnapshot => Object.freeze({ state: 'unavailable', message: '企业资料暂时无法读取，请稍后重新查询。', revision: '', records: Object.freeze([]) });
const signature = (path: string, info: BigIntStats) => `${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Shared reference data only. The trusted server path cannot be selected by a request. */
export class CompanyCatalogRepository {
  readonly path: string;
  private cached?: { signature: string; snapshot: CompanyCatalogSnapshot };
  private pending?: { signature: string; promise: Promise<CompanyCatalogSnapshot> };
  constructor(path: string) { this.path = resolve(path); }

  private async readSnapshot(path: string, expected: string): Promise<CompanyCatalogSnapshot> {
    const handle = await open(path, 'r');
    try {
      const initial = await handle.stat({ bigint: true });
      if (!initial.isFile() || initial.size > BigInt(companyCatalogLimits.bytes) || signature(path, initial) !== expected) throw new Error('Company catalogue changed.');
      const chunks: Buffer[] = [];
      let total = 0;
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, companyCatalogLimits.bytes + 1 - total), total);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > companyCatalogLimits.bytes) throw new Error('Company catalogue too large.');
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const final = await handle.stat({ bigint: true });
      if (signature(path, final) !== expected) throw new Error('Company catalogue changed.');
      const bytes = Buffer.concat(chunks);
      const catalog = validateCompanyCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      return freeze({
        state: catalog.records.length ? 'ready' : 'empty',
        message: catalog.records.length ? '企业资料由来源提供，供求职准备参考；当前招聘条件以最新官方公告为准。' : '企业资料目录暂无记录，请稍后查阅。',
        revision: createHash('sha256').update(bytes).digest('hex'), records: catalog.records,
      });
    } finally { await handle.close(); }
  }

  async load(): Promise<CompanyCatalogSnapshot> {
    try {
      const path = await realpath(this.path);
      const info = await stat(path, { bigint: true });
      if (!info.isFile() || info.size > BigInt(companyCatalogLimits.bytes)) throw new Error('Invalid company catalogue file.');
      const key = signature(path, info);
      if (this.cached?.signature === key) return this.cached.snapshot;
      if (this.pending?.signature === key) return await this.pending.promise;
      const promise = this.readSnapshot(path, key);
      this.pending = { signature: key, promise };
      try {
        const snapshot = await promise;
        if (this.pending?.promise === promise) this.cached = { signature: key, snapshot };
        return snapshot;
      } finally { if (this.pending?.promise === promise) this.pending = undefined; }
    } catch (error) {
      this.cached = undefined;
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? empty() : unavailable();
    }
  }

  async get(id: string): Promise<CompanyDetail> {
    validateCompanyId(id);
    const snapshot = await this.load();
    if (snapshot.state === 'unavailable') throw new HttpError(503, 'COMPANY_CATALOG_UNAVAILABLE', snapshot.message);
    const record = snapshot.records.find(item => item.id === id) ?? notFound('企业资料');
    const detail = companyDirectoryRecord(record);
    const sourceReview = companySourceReview(record);
    return sourceReview ? { ...detail, sourceReview } : detail;
  }
}
