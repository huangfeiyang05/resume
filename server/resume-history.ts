import { createHash } from 'node:crypto';
import type { Resume } from '../shared/types.js';
import type { ResumeVersion, ResumeVersionSource, RestoreResumeResult } from '../shared/resume-history.js';

export interface StoredResumeVersion extends ResumeVersion { userId: string }
export interface StoredResumeRestore {
  userId: string;
  resumeId: string;
  idempotencyKey: string;
  sourceRevision: number;
  baseRevision: number;
  confirmedAt: string;
  result: RestoreResumeResult;
}

export function resumeContentHash(resume: Resume) {
  return createHash('sha256').update(JSON.stringify({ title: resume.title, targetRole: resume.targetRole, text: resume.text })).digest('hex');
}

export function createResumeVersion(resume: Resume & { userId: string }, source: ResumeVersionSource, restoredFromRevision?: number): StoredResumeVersion {
  const { userId, ...snapshot } = resume;
  return {
    userId, resumeId: resume.id, revision: resume.revision, title: resume.title, targetRole: resume.targetRole,
    recordedAt: resume.updatedAt, contentHash: resumeContentHash(resume), source, snapshot: structuredClone(snapshot),
    ...(restoredFromRevision === undefined ? {} : { restoredFromRevision }),
  };
}

/** Missing history means only the current known revision can be retained. */
export function normalizeResumeHistory(value: Record<string, unknown>, resumes: Array<Resume & { userId: string }>) {
  const versions = value.resumeVersions === undefined ? resumes.map(resume => createResumeVersion(resume, 'baseline')) : value.resumeVersions;
  const restores = value.resumeRestores === undefined ? [] : value.resumeRestores;
  const fail = (): never => { throw new Error('Unsupported or malformed resume history.'); };
  if (!Array.isArray(versions) || !Array.isArray(restores)) return fail();
  const identities = new Set<string>();
  for (const item of versions as StoredResumeVersion[]) {
    if (!item || typeof item.userId !== 'string' || typeof item.resumeId !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !['created', 'edited', 'suggestion', 'restored', 'baseline'].includes(item.source)
      || !Number.isFinite(Date.parse(item.recordedAt)) || !item.snapshot
      || item.snapshot.id !== item.resumeId || item.snapshot.revision !== item.revision
      || typeof item.snapshot.title !== 'string' || typeof item.snapshot.targetRole !== 'string' || typeof item.snapshot.text !== 'string'
      || !Number.isFinite(Date.parse(item.snapshot.createdAt)) || !Number.isFinite(Date.parse(item.snapshot.updatedAt))
      || item.title !== item.snapshot.title || item.targetRole !== item.snapshot.targetRole || item.contentHash !== resumeContentHash(item.snapshot)
      || !resumes.some(resume => resume.id === item.resumeId && resume.userId === item.userId)
      || (item.restoredFromRevision !== undefined && (!Number.isSafeInteger(item.restoredFromRevision) || item.restoredFromRevision < 1))) return fail();
    const identity = JSON.stringify([item.userId, item.resumeId, item.revision]);
    if (identities.has(identity)) return fail();
    identities.add(identity);
  }
  const keys = new Set<string>();
  for (const item of restores as StoredResumeRestore[]) {
    if (!item || typeof item.userId !== 'string' || typeof item.resumeId !== 'string' || typeof item.idempotencyKey !== 'string'
      || !Number.isSafeInteger(item.sourceRevision) || item.sourceRevision < 1 || !Number.isSafeInteger(item.baseRevision) || item.baseRevision < 1
      || !Number.isFinite(Date.parse(item.confirmedAt))
      || !item.result || typeof item.result.noChange !== 'boolean' || item.result.alreadyRestored !== false
      || item.result.restoredFromRevision !== item.sourceRevision || item.result.resume?.id !== item.resumeId
      || !versions.some(version => version.userId === item.userId && version.resumeId === item.resumeId && version.revision === item.result.resume.revision
        && (['id', 'revision', 'title', 'targetRole', 'text', 'createdAt', 'updatedAt'] as const).every(key => version.snapshot[key] === item.result.resume[key]))) return fail();
    const key = JSON.stringify([item.userId, item.resumeId, item.idempotencyKey]);
    if (keys.has(key)) return fail();
    keys.add(key);
  }
  return { resumeVersions: versions as StoredResumeVersion[], resumeRestores: restores as StoredResumeRestore[] };
}
