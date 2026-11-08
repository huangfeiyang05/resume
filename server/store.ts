import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Analysis, Resume } from '../shared/types.js';
import type { AuthUser } from '../shared/auth.js';
import type { EmailCodePurpose, PhoneCodePurpose } from '../shared/auth.js';
import { normalizeCareerStorage, type CareerStorage } from './career-validation.js';
import { normalizeCareerAttachments, normalizeCareerContent, type CareerAttachmentIndex, type StoredCareerContent } from './career-content-storage.js';
import { normalizeResumeHistory, type StoredResumeVersion, type StoredResumeRestore } from './resume-history.js';
import { normalizeAnalysisTasks, type AnalysisTaskStorage } from './job-storage.js';
import { normalizeQuotaStorage, type QuotaStorage } from './quota-storage.js';
import { normalizePaymentStorage, type PaymentStorage } from './payment-storage.js';

export const legacyWorkspaceId = 'legacy-local-workspace';
export interface StoredUser extends AuthUser { passwordHash?: string; wechatOpenid?: string }
export interface StoredSession { tokenHash: string; userId: string; createdAt: string; expiresAt: string; scope?: 'admin' }
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
export interface StoredPhoneChallenge extends Omit<StoredEmailChallenge, 'email' | 'purpose'> {
  phone: string;
  purpose: PhoneCodePurpose;
}

export interface Database extends CareerStorage, AnalysisTaskStorage, QuotaStorage, PaymentStorage {
  version: 3;
  users: StoredUser[];
  sessions: StoredSession[];
  emailChallenges: StoredEmailChallenge[];
  phoneChallenges: StoredPhoneChallenge[];
  resumes: StoredResume[];
  analyses: StoredAnalysis[];
  resumeVersions: StoredResumeVersion[];
  resumeRestores: StoredResumeRestore[];
  careerContent: StoredCareerContent[];
  careerAttachments: CareerAttachmentIndex;
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
        version: 3, users: [], sessions: [], emailChallenges: [], phoneChallenges: [], careerContent: [], careerAttachments: {},
        ...normalizeCareerStorage({}),
        ...normalizeAnalysisTasks({}), ...normalizeQuotaStorage({}), ...normalizePaymentStorage({}),
        ...normalizeResumeHistory({}, resumes),
        resumes,
        analyses: parsed.analyses.map((analysis: Analysis) => ({ ...analysis, userId: legacyWorkspaceId })),
        };
      }
      if (!Array.isArray(parsed.users) || !Array.isArray(parsed.sessions)
        || parsed.users.some((user: StoredUser) => !user || typeof user.id !== 'string'
          || (user.email !== undefined && (typeof user.email !== 'string' || !user.email))
          || (user.passwordHash !== undefined && typeof user.passwordHash !== 'string')
          || (user.phone !== undefined && (typeof user.phone !== 'string' || !/^1[3-9]\d{9}$/.test(user.phone) || user.phoneVerified !== true))
          || (user.wechatOpenid !== undefined && (typeof user.wechatOpenid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(user.wechatOpenid)))
          || (!user.email && !user.phone && !user.wechatOpenid) || (!user.phone && !user.passwordHash && !user.wechatOpenid)
          || (user.phoneVerified !== undefined && typeof user.phoneVerified !== 'boolean')
          || (user.emailVerified === true && !user.email))
        || parsed.sessions.some((session: StoredSession) => !session || typeof session.tokenHash !== 'string' || typeof session.userId !== 'string'
          || !Number.isFinite(Date.parse(session.expiresAt)) || (session.scope !== undefined && session.scope !== 'admin'))
        || [...parsed.resumes, ...parsed.analyses].some((record: { userId?: string }) => !record || typeof record.userId !== 'string')) {
        throw new Error('Unsupported or malformed account database.');
      }
      if (parsed.version === 2) {
        return { ...parsed, ...normalizeCareerStorage(parsed), ...normalizeResumeHistory(parsed, parsed.resumes), ...normalizeAnalysisTasks(parsed), ...normalizeQuotaStorage(parsed), ...normalizePaymentStorage(parsed), version: 3, users: parsed.users.map((user: StoredUser) => ({ ...user, emailVerified: user.emailVerified === true })), emailChallenges: [], phoneChallenges: [], careerContent: [], careerAttachments: {} };
      }
      if (!Array.isArray(parsed.emailChallenges)
        || parsed.users.some((user: StoredUser) => typeof user.emailVerified !== 'boolean')
        || parsed.emailChallenges.some((challenge: StoredEmailChallenge) => !challenge
          || typeof challenge.id !== 'string' || typeof challenge.email !== 'string'
          || !['register', 'reset-password', 'verify-email', 'bind-email'].includes(challenge.purpose)
          || (['verify-email', 'bind-email'].includes(challenge.purpose) && typeof challenge.userId !== 'string')
          || (challenge.userId !== undefined && typeof challenge.userId !== 'string')
          || typeof challenge.clientHash !== 'string' || typeof challenge.codeHash !== 'string'
          || !Number.isFinite(Date.parse(challenge.createdAt)) || !Number.isFinite(Date.parse(challenge.expiresAt))
          || !Number.isInteger(challenge.attempts) || challenge.attempts < 0
          || !['pending', 'sent', 'failed', 'consumed', 'expired', 'locked', 'superseded'].includes(challenge.status))) {
        throw new Error('Unsupported or malformed email challenge database.');
      }
      const phoneChallenges = parsed.phoneChallenges === undefined ? [] : parsed.phoneChallenges;
      if (!Array.isArray(phoneChallenges) || phoneChallenges.some((challenge: StoredPhoneChallenge) => !challenge
        || typeof challenge.id !== 'string' || !/^1[3-9]\d{9}$/.test(challenge.phone)
        || !['login', 'bind-phone', 'verify-account'].includes(challenge.purpose)
        || (challenge.purpose !== 'login' && typeof challenge.userId !== 'string')
        || (challenge.userId !== undefined && typeof challenge.userId !== 'string')
        || typeof challenge.clientHash !== 'string' || typeof challenge.codeHash !== 'string'
        || !Number.isFinite(Date.parse(challenge.createdAt)) || !Number.isFinite(Date.parse(challenge.expiresAt))
        || !Number.isInteger(challenge.attempts) || challenge.attempts < 0
        || !['pending', 'sent', 'failed', 'consumed', 'expired', 'locked', 'superseded'].includes(challenge.status))) {
        throw new Error('Unsupported or malformed phone challenge database.');
      }
      if (new Set(parsed.users.flatMap((user: StoredUser) => user.email ? [user.email] : [])).size !== parsed.users.filter((user: StoredUser) => user.email).length
        || new Set(parsed.users.flatMap((user: StoredUser) => user.phone ? [user.phone] : [])).size !== parsed.users.filter((user: StoredUser) => user.phone).length
        || new Set(parsed.users.flatMap((user: StoredUser) => user.wechatOpenid ? [user.wechatOpenid] : [])).size !== parsed.users.filter((user: StoredUser) => user.wechatOpenid).length
        || new Set(parsed.users.map((user: StoredUser) => user.id)).size !== parsed.users.length
        || new Set(phoneChallenges.map((challenge: StoredPhoneChallenge) => challenge.id)).size !== phoneChallenges.length) throw new Error('Duplicate account identifiers.');
      const careerContent = normalizeCareerContent(parsed.careerContent);
      return { ...parsed, phoneChallenges, ...normalizeCareerStorage(parsed), ...normalizeResumeHistory(parsed, parsed.resumes), ...normalizeAnalysisTasks(parsed), ...normalizeQuotaStorage(parsed), ...normalizePaymentStorage(parsed), careerContent, careerAttachments: normalizeCareerAttachments(parsed.careerAttachments, careerContent) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 3, users: [], sessions: [], emailChallenges: [], phoneChallenges: [], resumes: [], analyses: [], careerContent: [], careerAttachments: {}, ...normalizeCareerStorage({}), ...normalizeResumeHistory({}, []), ...normalizeAnalysisTasks({}), ...normalizeQuotaStorage({}), ...normalizePaymentStorage({}) };
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
