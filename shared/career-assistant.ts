import type { CompanyFilters, CompanySearchHit } from './company.js';
import type { CareerJob } from './career.js';

export interface CareerAssistantInput {
  resumeId?: string;
  resumeRevision?: number;
  requirements: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}
export interface CareerAssistantResult {
  engine: 'local-rules';
  reply: string;
  resume?: { id: string; title: string; revision: number; inputHash: string };
  criteria: { query: string; filters: Partial<CompanyFilters>; unverifiedRequirements: string[] };
  companies: CompanySearchHit[];
  companyTotal: number;
  personalJobs: CareerJob[];
  officialJobs?: CareerJob[];
  evidence: Array<{ term: string; excerpt: string }>;
  catalogState: 'empty' | 'ready' | 'unavailable';
  action?: { type: 'analyze-resume'; resumeId: string; revision: number; targetRole: string };
}
