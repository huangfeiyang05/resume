import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { EmailCodeChallenge, EmailCodePurpose } from '../shared/auth.js';
import { HttpError, invalid } from './errors.js';
import { JsonStore, type Database, type StoredEmailChallenge } from './store.js';

export interface CodeMail {
  email: string;
  code: string;
  purpose: EmailCodePurpose;
  expiresAt: string;
}
export interface MailSender { readonly enabled: boolean; sendCode(input: CodeMail): Promise<void> }
export interface EmailCodeOptions { secret: string; now?: () => number; ttlMs?: number }
export interface CodeProof { challengeId: string; code: string }

export function validateEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254) invalid('请填写有效邮箱地址。');
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)
    || email.startsWith('.') || email.includes('..') || email.split('@')[0].endsWith('.')) invalid('请填写有效邮箱地址。');
  return email;
}
export function validateProof(input: Record<string, unknown>): CodeProof {
  if (typeof input.challengeId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.challengeId)
    || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) invalid('请先获取验证码，并填写收到的 6 位数字。');
  return { challengeId: input.challengeId, code: input.code };
}
const invalidCode = () => new HttpError(400, 'CODE_INVALID_OR_EXPIRED', '验证码无效或已过期，请重新获取后再试。');

/** Single-process durable challenges. Secret, code and SMTP errors never enter logs or responses. */
export class EmailCodeService {
  readonly enabled: boolean;
  private now: () => number;
  private ttlMs: number;
  private active = 0;
  constructor(readonly store: JsonStore, private mailer: MailSender, private options: EmailCodeOptions) {
    this.enabled = mailer.enabled;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    if (this.enabled && (typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < 32)) throw new Error('Mail code secret must contain at least 32 bytes.');
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error('Invalid email challenge lifetime.');
  }
  private hash(value: string): string { return createHmac('sha256', this.options.secret).update(value).digest('hex'); }
  private codeHash(challenge: Pick<StoredEmailChallenge, 'id' | 'email' | 'purpose' | 'userId'>, code: string) {
    return this.hash(JSON.stringify([challenge.id, challenge.email, challenge.purpose, challenge.userId ?? '', code]));
  }
  assertEnabled() {
    if (!this.enabled) throw new HttpError(503, 'MAIL_NOT_CONFIGURED', '邮件验证服务暂不可用，请稍后重试。');
  }

  async request(emailInput: string, purpose: EmailCodePurpose, client: string, userId?: string): Promise<EmailCodeChallenge> {
    this.assertEnabled();
    const email = validateEmail(emailInput);
    if (!['register', 'reset-password', 'verify-email', 'bind-email'].includes(purpose)) invalid('验证码用途无效。');
    if (['verify-email', 'bind-email'].includes(purpose) && !userId) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录后验证邮箱。');
    if (this.active >= 2) throw new HttpError(429, 'MAIL_BUSY', '邮件服务正忙，请稍后重试。');
    this.active++;
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = this.now();
    const challenge: StoredEmailChallenge = {
      id: randomUUID(), email, purpose, ...(userId ? { userId } : {}), clientHash: this.hash(`client:${client}`),
      codeHash: '', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(), attempts: 0, status: 'pending',
    };
    challenge.codeHash = this.codeHash(challenge, code);
    try {
      await this.store.mutate(database => {
        // One day of reservations is enough to enforce all counters while bounding retained metadata.
        database.emailChallenges = database.emailChallenges.filter(item => Date.parse(item.createdAt) > now - 24 * 60 * 60_000);
        const emailReservations = database.emailChallenges.filter(item => item.email === email);
        if (emailReservations.some(item => Date.parse(item.createdAt) > now - 60_000)) {
          throw new HttpError(429, 'CODE_RESEND_TOO_SOON', '请稍等 60 秒后再获取验证码。');
        }
        if (emailReservations.filter(item => Date.parse(item.createdAt) > now - 60 * 60_000).length >= 5
          || database.emailChallenges.filter(item => item.clientHash === challenge.clientHash && Date.parse(item.createdAt) > now - 60 * 60_000).length >= 20
          || database.emailChallenges.length >= 100) {
          throw new HttpError(429, 'MAIL_RATE_LIMITED', '验证码请求较多，请稍后再试。');
        }
        database.emailChallenges.push(challenge);
      });
      try {
        await this.mailer.sendCode({ email, code, purpose, expiresAt: challenge.expiresAt });
      } catch {
        await this.store.mutate(database => {
          const current = database.emailChallenges.find(item => item.id === challenge.id);
          if (current) { current.status = 'failed'; current.codeHash = ''; }
        });
        throw new HttpError(503, 'MAIL_DELIVERY_FAILED', '验证码邮件未能提交发送，请稍后重试。');
      }
      const activated = await this.store.mutate(database => {
        const current = database.emailChallenges.find(item => item.id === challenge.id);
        if (!current || current.status !== 'pending' || Date.parse(current.expiresAt) <= this.now()) {
          if (current) { current.status = 'expired'; current.codeHash = ''; }
          return false;
        }
        for (const older of database.emailChallenges) {
          if (older.id !== current.id && older.email === current.email && older.purpose === current.purpose
            && (older.userId ?? '') === (current.userId ?? '') && older.status === 'sent') {
            older.status = 'superseded'; older.codeHash = '';
          }
        }
        current.status = 'sent';
        return true;
      });
      if (!activated) throw new HttpError(503, 'MAIL_DELIVERY_FAILED', '验证码已失效，请重新获取。');
      return { challengeId: challenge.id, expiresAt: challenge.expiresAt, resendAfterSeconds: 60, message: '验证码已提交发送，请查收邮箱。' };
    } finally { this.active--; }
  }

  /** Return an error rather than throw so a failed guess can be committed by the caller's transaction. */
  consume(database: Database, email: string, purpose: EmailCodePurpose, proof: CodeProof, userId?: string): HttpError | undefined {
    const challenge = database.emailChallenges.find(item => item.id === proof.challengeId && item.email === email && item.purpose === purpose && (item.userId ?? '') === (userId ?? ''));
    if (!challenge || challenge.status !== 'sent') return invalidCode();
    if (Date.parse(challenge.expiresAt) <= this.now()) {
      challenge.status = 'expired'; challenge.codeHash = ''; return invalidCode();
    }
    if (challenge.attempts >= 5) { challenge.status = 'locked'; challenge.codeHash = ''; return invalidCode(); }
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const actual = Buffer.from(this.codeHash(challenge, proof.code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      challenge.attempts++;
      if (challenge.attempts >= 5) { challenge.status = 'locked'; challenge.codeHash = ''; }
      return invalidCode();
    }
    challenge.status = 'consumed'; challenge.codeHash = ''; challenge.consumedAt = new Date(this.now()).toISOString();
    return undefined;
  }

  invalidateEmail(database: Database, email: string) {
    for (const challenge of database.emailChallenges) if (challenge.email === email && ['pending', 'sent'].includes(challenge.status)) {
      challenge.status = 'superseded'; challenge.codeHash = '';
    }
  }
}
