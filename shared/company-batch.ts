import type { CompanyEditableField, CompanyRecord } from './company.js';

export const companyBatchFileLimit = 10 * 1024 * 1024;

export interface CompanyEditSearchResult {
  total: number;
  page: number;
  pageSize: number;
  items: (Pick<CompanyRecord, 'id' | 'name' | 'locations' | 'recruitmentTypes' | 'cohorts'> & { sourceTitle: string })[];
}
export interface CompanyEditDetail {
  catalogRevision: string;
  record: CompanyRecord;
}
export interface CompanyEditInput {
  companyId: string;
  catalogRevision: string;
  sourceTitle: string;
  changes: Partial<Pick<CompanyRecord, Exclude<CompanyEditableField, 'recruitmentUrl'>>> & { recruitmentUrl?: string | null };
}

export interface CompanyBatchEvent {
  id: string;
  action: 'publish' | 'rollback';
  actorId: string;
  at: string;
  sourceTitle: string;
  sourceHash: string;
  before: string;
  after: string;
  beforeCount: number;
  afterCount: number;
  editedCompanyId?: string;
}
export interface CompanyBatchState {
  count: number;
  history: CompanyBatchEvent[];
  canRollback: boolean;
}
export interface CompanyBatchPreview {
  id: string | null;
  reportId?: string;
  action: 'publish' | 'rollback';
  sourceTitle: string;
  beforeCount: number;
  afterCount: number;
  inputRows: number;
  duplicateRows: number;
  existingRecords: number;
  sameNameRecords: number;
  unmappedColumns: number;
  excludedContactColumns: number;
  reviewCount: number;
  reviewRows: { row: number; code: string; fields: string[] }[];
  sample: { name: string; rows: number[]; recruitmentTypes: string[]; sameName: boolean }[];
  edit?: {
    companyId: string;
    name: string;
    fields: { key: CompanyEditableField; before: string | string[] | null; after: string | string[] | null }[];
  };
}
