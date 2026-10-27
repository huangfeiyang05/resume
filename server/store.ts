import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Analysis, Resume } from '../shared/types.js';
import type { AuthUser } from '../shared/auth.js';
import type { EmailCodePurpose } from '../shared/auth.js';
import { normalizeCareerStorage, type CareerStorage } from './career-validation.js';
import { normalizeResumeHistory, type StoredResumeVersion, type StoredResumeRestore } from './resume-history.js';

export const legacyWorkspaceId = 'legacy-local-workspace';
export interface StoredUser extends AuthUser { passwordHash: string }
export interface StoredSession { tokenHash: string; userId: string; createdAt: string; expiresAt: string }
export interface StoredResume extends Resume { userId: string }
export interface StoredAnalysis extends Analysis { userId: string }
export interface StoredEmailChallenge {
  id: string;
  email: string;
  purpose: EmailCodePurpose;
  userId?: string;
  clientHash: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  status: 'pending' | 'sent' | 'failed' | 'consumed' | 'expired' | 'locked' | 'superseded';
  consumedAt?: string;
}

export interface Database extends CareerStorage {
  version: 3;
  users: StoredUser[];
  sessions: StoredSession[];
  emailChallenges: StoredEmailChallenge[];
  resumes: StoredResume[];
  analyses: StoredAnalysis[];
  resumeVersions: StoredResumeVersion[];
  resumeRestores: StoredResumeRestore[];
}

/** One process owns this file. Mutations are serialized and committed atomically. */
export class JsonStore {
  private database?: Database;
  private loading?: Promise<Database>;
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;

  constructor(path = resolve(process.cwd(), '.data/resumes.json')) {
    this.path = path;
  }

  private load(): Promise<Database> {
    if (this.database) return Promise.resolve(this.database);
    if (!this.loading) {
      this.loading = this.loadFile().then((database) => {
        this.database = database;
        return database;
      }).finally(() => { this.loading = undefined; });
    }
    return this.loading;
  }

  protected async loadFile(): Promise<Database> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || ![1, 2, 3].includes(parsed.version) || !Array.isArray(parsed.resumes) || !Array.isArray(parsed.analyses)) {
        throw new Error('Unsupported or malformed local database.');
      }
      // Old shared data is retained in a quarantined workspace, never claimed by the first signup.
      if (parsed.version === 1) {
        const resumes = parsed.resumes.map((resume: Resume) => ({ ...resume, userId: legacyWorkspaceId }));
        return {
        version: 3, users: [], sessions: [], emailChallenges: [],
        ...normalizeCareerStorage({}),
        ...normalizeResumeHistory({}, resumes),
        resumes,
        analyses: parsed.analyses.map((analysis: Analysis) => ({ ...analysis, userId: legacyWorkspaceId })),
        };
      }
      if (!Array.isArray(parsed.users) || !Array.isArray(parsed.sessions)
        || parsed.users.some((user: StoredUser) => !user || typeof user.id !== 'string' || typeof user.email !== 'string' || typeof user.passwordHash !== 'string')
        || parsed.sessions.some((session: StoredSession) => !session || typeof session.tokenHash !== 'string' || typeof session.userId !== 'string' || !Number.isFinite(Date.parse(session.expiresAt)))
        || [...parsed.resumes, ...parsed.analyses].some((record: { userId?: string }) => !record || typeof record.userId !== 'string')) {
        throw new Error('Unsupported or malformed account database.');
      }
      if (parsed.version === 2) {
        return { ...parsed, ...normalizeCareerStorage(parsed), ...normalizeResumeHistory(parsed, parsed.resumes), version: 3, users: parsed.users.map((user: StoredUser) => ({ ...user, emailVerified: user.emailVerified === true })), emailChallenges: [] };
      }
      if (!Array.isArray(parsed.emailChallenges)
        || parsed.users.some((user: StoredUser) => typeof user.emailVerified !== 'boolean')
        || parsed.emailChallenges.some((challenge: StoredEmailChallenge) => !challenge
          || typeof challenge.id !== 'string' || typeof challenge.email !== 'string'
          || !['register', 'reset-password', 'verify-email'].includes(challenge.purpose)
          || (challenge.userId !== undefined && typeof challenge.userId !== 'string')
          || typeof challenge.clientHash !== 'string' || typeof challenge.codeHash !== 'string'
          || !Number.isFinite(Date.parse(challenge.createdAt)) || !Number.isFinite(Date.parse(challenge.expiresAt))
          || !Number.isInteger(challenge.attempts) || challenge.attempts < 0
          || !['pending', 'sent', 'failed', 'consumed', 'expired', 'locked', 'superseded'].includes(challenge.status))) {
        throw new Error('Unsupported or malformed email challenge database.');
      }
      return { ...parsed, ...normalizeCareerStorage(parsed), ...normalizeResumeHistory(parsed, parsed.resumes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 3, users: [], sessions: [], emailChallenges: [], resumes: [], analyses: [], ...normalizeCareerStorage({}), ...normalizeResumeHistory({}, []) };
    }
  }

  async read(): Promise<Database> {
    await this.queue;
    return structuredClone(await this.load());
  }

  async mutate<T>(operation: (database: Database) => T | Promise<T>): Promise<T> {
    const mutation = this.queue.then(async () => {
      const next = structuredClone(await this.load());
      const result = await operation(next);
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
      this.database = next;
      return structuredClone(result);
    });
    this.queue = mutation.catch(() => undefined);
    return mutation;
  }
}
