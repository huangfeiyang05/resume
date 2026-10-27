import type { Resume } from './types.js';

export type ApplicationStatus = 'planned' | 'applied' | 'interview' | 'offer' | 'rejected' | 'withdrawn';

export interface CareerJob {
  id: string;
  origin: 'catalog' | 'personal';
  company: string;
  title: string;
  major: string;
  location: string;
  description: string;
  companyOverview: string;
  sourceLabel: string;
  sourceUrl?: string;
  deadline?: string;
  availability: 'open' | 'closed';
  updatedAt: string;
}

export interface CareerMaterial {
  id: string;
  title: string;
  major: string;
  role: string;
  summary: string;
  /** Plain text: never execute uploaded text or render it as trusted HTML. */
  content: string;
  sourceLabel: string;
  sourceUrl?: string;
  updatedAt: string;
}

/** An official recruitment entry point, never a claim that a particular job is open. */
export interface CareerRecruitmentPortal {
  id: string;
  organization: string;
  majors: string[];
  audience: string;
  description: string;
  sourceUrl: string;
  /** Date this project checked the entry point, not the publisher's update time. */
  checkedAt: string;
}

export interface CareerJobInput {
  company: string;
  title: string;
  major: string;
  location: string;
  description: string;
  companyOverview?: string;
  sourceUrl?: string;
  deadline?: string;
}

export interface ApplicationEvent {
  status: ApplicationStatus;
  at: string;
  /** All submission and outcome updates in this version are user-reported. */
  source: 'user';
}

export interface CareerApplication {
  id: string;
  jobId: string;
  jobSnapshot: CareerJob;
  resumeSnapshot: Resume;
  resumeHash: string;
  status: ApplicationStatus;
  note: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  history: ApplicationEvent[];
  submissionMode: 'manual';
}

export interface ApplicationCreateInput {
  jobId: string;
  resumeId: string;
  resumeRevision: number;
  idempotencyKey: string;
}

export interface ApplicationUpdateInput {
  revision: number;
  status?: ApplicationStatus;
  note?: string;
  /** Rebind only a planned application to a reviewed, current saved resume. */
  resumeId?: string;
  resumeRevision?: number;
  confirmedManualSubmission?: boolean;
}

export interface CareerWorkspace {
  mode: 'preview';
  externalDeliveryAvailable: false;
  catalogState: 'empty' | 'ready' | 'unavailable';
  catalogMessage: string;
  jobs: CareerJob[];
  materials: CareerMaterial[];
  portals: CareerRecruitmentPortal[];
  favoriteJobIds: string[];
  applications: CareerApplication[];
}
