import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PhoneCodeChallenge, PhoneCodePurpose } from '../shared/auth.js';
import { HttpError, invalid } from './errors.js';
import type { CodeProof } from './email-codes.js';
import type { SmsSender } from './sms.js';
import { JsonStore, type Database, type StoredPhoneChallenge } from './store.js';

export function validatePhone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 24) invalid('请填写有效的中国大陆手机号。');
  const phone = value.trim().replace(/^(?:\+86|0086)/, '');
  if (!/^1[3-9]\d{9}$/.test(phone)) invalid('请填写有效的中国大陆手机号。');
  return phone;
}
export interface PhoneCodeOptions { secret: string; now?: () => number; ttlMs?: number; dailyLimit?: number }
const invalidCode = () => new HttpError(400, 'CODE_INVALID_OR_EXPIRED', '验证码无效或已过期，请重新获取后再试。');
const dayMs = 24 * 60 * 60_000;

/** Local durable challenges. Only a supplier-accepted send enables a proof; no plaintext codes in storage. */
export class PhoneCodeService {
  readonly enabled: boolean;
  private now: () => number;
  private ttlMs: number;
  private dailyLimit: number;
  private active = 0;
  constructor(readonly store: JsonStore, private sender: SmsSender, private options: PhoneCodeOptions) {
    this.enabled = sender.enabled;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.dailyLimit = options.dailyLimit ?? 100;
    if (this.enabled && (typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < 32)) throw new Error('SMS code secret must contain at least 32 bytes.');
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 10 * 60_000
      || !Number.isSafeInteger(this.dailyLimit) || this.dailyLimit < 1 || this.dailyLimit > 10000) throw new Error('Invalid SMS challenge limits.');
  }
  private hash(value: string) { return createHmac('sha256', this.options.secret).update(value).digest('hex'); }
  private codeHash(challenge: Pick<StoredPhoneChallenge, 'id' | 'phone' | 'purpose' | 'userId'>, code: string) {
    return this.hash(JSON.stringify([challenge.id, challenge.phone, challenge.purpose, challenge.userId ?? '', code]));
  }
  assertEnabled() {
    if (!this.enabled) throw new HttpError(503, 'SMS_NOT_CONFIGURED', '短信验证码暂未开放，请使用邮箱登录。');
  }
  async request(phoneInput: string, purpose: PhoneCodePurpose, client: string, userId?: string): Promise<PhoneCodeChallenge> {
    this.assertEnabled();
    const phone = validatePhone(phoneInput);
    if (!['login', 'bind-phone', 'verify-account'].includes(purpose)) invalid('验证码用途无效。');
    if (purpose !== 'login' && !userId) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录后绑定或验证手机号。');
    if (this.active >= 2) throw new HttpError(429, 'SMS_BUSY', '短信服务正忙，请稍后重试。');
    this.active++;
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0'), now = this.now();
    const challenge: StoredPhoneChallenge = {
      id: randomUUID(), phone, purpose, ...(userId ? { userId } : {}), clientHash: this.hash(`client:${client}`), codeHash: '',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(), attempts: 0, status: 'pending',
    };
    challenge.codeHash = this.codeHash(challenge, code);
    try {
      await this.store.mutate(database => {
        database.phoneChallenges = database.phoneChallenges.filter(item => Date.parse(item.createdAt) > now - dayMs);
        const samePhone = database.phoneChallenges.filter(item => item.phone === phone);
        const sameClient = database.phoneChallenges.filter(item => item.clientHash === challenge.clientHash);
        if (samePhone.some(item => Date.parse(item.createdAt) > now - 60_000)) throw new HttpError(429, 'CODE_RESEND_TOO_SOON', '请稍等 60 秒后再获取验证码。');
        if (samePhone.filter(item => Date.parse(item.createdAt) > now - 60 * 60_000).length >= 5 || samePhone.length >= 10
          || sameClient.filter(item => Date.parse(item.createdAt) > now - 60 * 60_000).length >= 10 || sameClient.length >= 30
          || database.phoneChallenges.length >= this.dailyLimit) throw new HttpError(429, 'SMS_RATE_LIMITED', '短信验证码请求较多，请稍后再试。');
        database.phoneChallenges.push(challenge);
      });
      try { await this.sender.sendCode({ phone, code, purpose, expiresAt: challenge.expiresAt }); }
      catch {
        await this.store.mutate(database => {
          const current = database.phoneChallenges.find(item => item.id === challenge.id);
          if (current) { current.status = 'failed'; current.codeHash = ''; }
        });
        throw new HttpError(503, 'SMS_DELIVERY_FAILED', '验证码短信未能确认提交发送，请稍后重试。');
      }
      const activated = await this.store.mutate(database => {
        const current = database.phoneChallenges.find(item => item.id === challenge.id);
        if (!current || current.status !== 'pending' || Date.parse(current.expiresAt) <= this.now()) {
          if (current) { current.status = 'expired'; current.codeHash = ''; }
          return false;
        }
        for (const older of database.phoneChallenges) {
          if (older.id !== current.id && older.phone === current.phone && older.purpose === current.purpose
            && (older.userId ?? '') === (current.userId ?? '') && older.status === 'sent') { older.status = 'superseded'; older.codeHash = ''; }
        }
        current.status = 'sent';
        return true;
      });
      if (!activated) throw new HttpError(503, 'SMS_DELIVERY_FAILED', '验证码已失效，请重新获取。');
      return { challengeId: challenge.id, expiresAt: challenge.expiresAt, resendAfterSeconds: 60, message: '验证码已提交发送，请查收短信。' };
    } finally { this.active--; }
  }
  /** Errors are returned so failed-guess counters commit with the caller's transaction. */
  consume(database: Database, phone: string, purpose: PhoneCodePurpose, proof: CodeProof, userId?: string): HttpError | undefined {
    const challenge = database.phoneChallenges.find(item => item.id === proof.challengeId && item.phone === phone && item.purpose === purpose
      && (item.userId ?? '') === (userId ?? ''));
    if (!challenge || challenge.status !== 'sent') return invalidCode();
    if (Date.parse(challenge.expiresAt) <= this.now()) { challenge.status = 'expired'; challenge.codeHash = ''; return invalidCode(); }
    if (challenge.attempts >= 5) { challenge.status = 'locked'; challenge.codeHash = ''; return invalidCode(); }
    const expected = Buffer.from(challenge.codeHash, 'hex'), actual = Buffer.from(this.codeHash(challenge, proof.code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      challenge.attempts++;
      if (challenge.attempts >= 5) { challenge.status = 'locked'; challenge.codeHash = ''; }
      return invalidCode();
    }
    challenge.status = 'consumed'; challenge.codeHash = ''; challenge.consumedAt = new Date(this.now()).toISOString();
    return undefined;
  }
}
