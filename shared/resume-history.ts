import type { Resume } from './types.js';

export type ResumeVersionSource = 'created' | 'edited' | 'suggestion' | 'restored' | 'baseline';

export interface ResumeVersionSummary {
  resumeId: string;
  revision: number;
  title: string;
  targetRole: string;
  recordedAt: string;
  contentHash: string;
  source: ResumeVersionSource;
  restoredFromRevision?: number;
}

export interface ResumeVersion extends ResumeVersionSummary {
  snapshot: Resume;
}

export interface RestoreResumeInput {
  /** Current saved revision, reviewed alongside the historical snapshot. */
  revision: number;
  confirmed: boolean;
  idempotencyKey: string;
}

export interface RestoreResumeResult {
  resume: Resume;
  restoredFromRevision: number;
  alreadyRestored: boolean;
  noChange: boolean;
}
