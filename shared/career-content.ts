import type { CareerMaterial, CareerRecruitmentPortal } from './career.js';

export const careerContentKinds = ['material', 'portal'] as const;
export type CareerContentKind = typeof careerContentKinds[number];
export type CareerContentValue = CareerMaterial | CareerRecruitmentPortal;
export type CareerContentAction = 'publish' | 'withdraw' | 'restore';

export interface CareerContentSummary {
  kind: CareerContentKind;
  id: string;
  title: string;
  live: boolean;
  hasDraft: boolean;
}

export interface CareerContentHistory {
  version: number;
  action: CareerContentAction | 'draft';
  actorId: string;
  at: string;
  sourceVersion?: number;
}

export interface CareerContentDetail {
  kind: CareerContentKind;
  id: string;
  revision: string;
  live: CareerContentValue | null;
  draft: CareerContentValue | null;
  activeVersion: number | null;
  baselineAvailable: boolean;
  history: CareerContentHistory[];
}

export type CareerContentDraft = Omit<CareerMaterial, 'id' | 'updatedAt'> | Omit<CareerRecruitmentPortal, 'id'>;
export interface SaveCareerContentDraft {
  revision: string | null;
  operationId: string;
  content: CareerContentDraft;
}

export interface ReviewCareerContent {
  revision: string;
  action: CareerContentAction;
  sourceVersion?: number;
}

export interface CareerContentReview {
  live: CareerContentValue | null;
  proposed: CareerContentValue | null;
  token: string;
}

export interface ApplyCareerContent extends ReviewCareerContent {
  token: string;
  operationId: string;
  confirmed: true;
}

export interface CareerContentReceipt { version: number }
