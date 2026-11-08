export const companyBatchFileLimit = 10 * 1024 * 1024;

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
}
