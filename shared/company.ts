/** Shared company reference data, kept separate from job openings and user resumes. */
export interface CompanySource {
  title: string;
  url?: string;
  sheet: string;
  rows: number[];
  snapshotHash: string;
  importedAt: string;
}

export interface CompanyRecord {
  id: string;
  name: string;
  aliases: string[];
  industries: string[];
  nature: string;
  locations: string[];
  directions: string[];
  educationLevels: string[];
  recruitmentTypes: string[];
  cohorts: string[];
  summary: string;
  recruitmentUrl?: string;
  /** Source supplied information, not an independently verified recruitment claim. */
  verification: 'source-provided';
  updatedAt: string;
  sources: CompanySource[];
}

export const companyFilterKeys = ['industries', 'natures', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts'] as const;
export type CompanyFilterKey = typeof companyFilterKeys[number];
export type CompanyFilters = Record<CompanyFilterKey, string[]>;
export type CompanySort = 'relevance' | 'name' | 'updated';
export interface CompanySearchInput {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: CompanySort;
  filters?: Partial<CompanyFilters>;
}
export type CompanyMatchField = 'name' | 'aliases' | 'industries' | 'nature' | 'locations' | 'directions' | 'educationLevels' | 'recruitmentTypes' | 'cohorts' | 'summary';
export interface CompanySearchHit extends CompanyRecord { matchedFields: CompanyMatchField[] }
export interface CompanyFacet { value: string; count: number }
export interface CompanySearchResult {
  access: 'authenticated-test';
  catalogState: 'empty' | 'ready' | 'unavailable';
  catalogMessage: string;
  catalogRevision: string;
  total: number;
  page: number;
  pageSize: number;
  items: CompanySearchHit[];
  facets: Record<CompanyFilterKey, CompanyFacet[]>;
}
export interface CompanyCatalogFile {
  version: 1;
  records: CompanyRecord[];
}
