import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AuthCapabilities, AuthSession, AuthUser, EmailCodePurpose, EmailPasswordInput } from '../shared/auth.js';
import type { WechatBindResult } from '../shared/payment.js';
import type { WechatIdentityProvider } from './wechat-identity.js';
import { PASSWORD_PATTERN, PASSWORD_RULE_MESSAGE } from '../shared/auth.js';
import { HttpError, invalid } from './errors.js';
import { JsonStore, type Database, type StoredUser } from './store.js';
import { EmailCodeService, validateEmail, validateProof } from './email-codes.js';

const ttl = 7 * 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashOptions = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };
const dummySalt = Buffer.from('youfang-dummy-password-check');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function publicUser(user: StoredUser): AuthUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt, emailVerified: user.emailVerified === true };
}

function object(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求体必须是 JSON 对象。');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) invalid('请求体含不支持的字段。');
  return record;
}

export function validateCredentials(body: unknown, allowProof = false, passwordPolicy: 'new' | 'login' = 'new'): EmailPasswordInput {
  const record = object(body, allowProof ? ['email', 'password', 'code', 'challengeId'] : ['email', 'password']);
  const email = validateEmail(record.email);
  const passwordText = record.password;
  if (typeof passwordText !== 'string') invalid(passwordPolicy === 'new' ? PASSWORD_RULE_MESSAGE : '邮箱或密码不正确。');
  const passwordValid = passwordPolicy === 'new'
    ? PASSWORD_PATTERN.test(passwordText)
    : passwordText.length >= 6 && passwordText.length <= 128 && !/[\u0000-\u001f\u007f]/.test(passwordText);
  if (!passwordValid) invalid(passwordPolicy === 'new' ? PASSWORD_RULE_MESSAGE : '邮箱或密码不正确。');
  // Password whitespace is significant and is never trimmed or normalized.
  if (allowProof && (Object.hasOwn(record, 'code') || Object.hasOwn(record, 'challengeId'))) {
    return { email, password: passwordText, ...validateProof(record) };
  }
  return { email, password: passwordText };
}

export interface AuthOptions { now?: () => number; sessionTtlMs?: number; emailCodes?: EmailCodeService; requireEmailVerification?: boolean; wechat?: WechatIdentityProvider }
export class AuthService {
  private hashing = 0;
  private attempts = new Map<string, { count: number; until: number }>();
  private now: () => number;
  readonly sessionTtlMs: number;
  readonly emailCodes?: EmailCodeService;
  private requireEmailVerification: boolean;
  private wechat?: WechatIdentityProvider;
  constructor(readonly store: JsonStore, options: AuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.emailCodes = options.emailCodes;
    this.requireEmailVerification = options.requireEmailVerification ?? options.emailCodes?.enabled ?? false;
    this.sessionTtlMs = options.sessionTtlMs ?? ttl;
    this.wechat = options.wechat;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1) throw new Error('Invalid session lifetime.');
  }

  capabilities(): AuthCapabilities {
    const configured = this.emailCodes?.enabled === true;
    return { emailPassword: true, wechat: false, phone: false, emailVerification: configured, passwordReset: configured };
  }

  private configuredCodes(): EmailCodeService {
    if (!this.emailCodes) throw new HttpError(503, 'MAIL_NOT_CONFIGURED', '邮件验证服务暂不可用，请稍后重试。');
    this.emailCodes.assertEnabled();
    return this.emailCodes;
  }

  async requestEmailCode(body: unknown, client = 'local', userId?: string) {
    const input = object(body, ['email', 'purpose']);
    const email = validateEmail(input.email);
    if (!['register', 'reset-password', 'verify-email'].includes(input.purpose as string)) invalid('验证码用途无效。');
    const purpose = input.purpose as EmailCodePurpose;
    const codes = this.configuredCodes();
    if (purpose === 'verify-email') {
      const user = userId && (await this.store.read()).users.find(candidate => candidate.id === userId);
      if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录后验证邮箱。');
      if (user.email !== email) throw new HttpError(403, 'EMAIL_MISMATCH', '只能验证当前账号的邮箱。');
    }
    this.checkRateLimit(client, email);
    // Registration/reset requests send the same message for known and unknown addresses.
    return codes.request(email, purpose, client, purpose === 'verify-email' ? userId : undefined);
  }

  /** Bounded, process-local abuse limits; not a distributed security service. */
  checkRateLimit(client: string, email?: string) {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const consume = (key: string, limit: number, windowMs: number) => {
      const existing = this.attempts.get(key);
      if (existing && existing.count >= limit) throw new HttpError(429, 'AUTH_RATE_LIMITED', '尝试次数较多，请稍后再试。');
      if (existing) existing.count++;
      else {
        if (this.attempts.size >= 5000) this.attempts.delete(this.attempts.keys().next().value!);
        this.attempts.set(key, { count: 1, until: now + windowMs });
      }
    };
    consume(`ip:${digest(client)}`, 30, 60_000);
    if (email) consume(`account:${digest(`${client}\n${email}`)}`, 12, 10 * 60_000);
  }

  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    if (this.hashing >= 2) throw new HttpError(429, 'AUTH_BUSY', '登录服务正忙，请稍后重试。');
    this.hashing++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, hashOptions, (error, key) => error ? reject(error) : resolve(key));
      });
    } finally { this.hashing--; }
  }

  private newSession(database: Database, user: StoredUser): { session: AuthSession; token: string } {
    const now = this.now();
    database.sessions = database.sessions.filter(session => Date.parse(session.expiresAt) > now);
    const userSessions = database.sessions.filter(session => session.userId === user.id);
    if (userSessions.length >= 20) {
      const remove = new Set(userSessions.slice(0, userSessions.length - 19).map(session => session.tokenHash));
      database.sessions = database.sessions.filter(session => !remove.has(session.tokenHash));
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + this.sessionTtlMs).toISOString();
    database.sessions.push({ tokenHash: digest(token), userId: user.id, createdAt: new Date(now).toISOString(), expiresAt });
    return { session: { user: publicUser(user), expiresAt }, token };
  }

  async register(body: unknown, client = 'local') {
    const credentials = validateCredentials(body, true);
    const { email, password } = credentials;
    this.checkRateLimit(client, email);
    const codes = this.requireEmailVerification ? this.configuredCodes() : undefined;
    if (codes && (!credentials.code || !credentials.challengeId)) throw new HttpError(400, 'EMAIL_VERIFICATION_REQUIRED', '请先获取并填写邮箱验证码。');
    if ((await this.store.read()).users.some(user => user.email === email)) throw new HttpError(409, 'EMAIL_ALREADY_REGISTERED', '该邮箱已注册，请直接登录。');
    const salt = randomBytes(16);
    const key = await this.derive(password, salt);
    const passwordHash = `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`;
    let codeError: HttpError | undefined;
    const result = await this.store.mutate(database => {
      if (database.users.some(user => user.email === email)) throw new HttpError(409, 'EMAIL_ALREADY_REGISTERED', '该邮箱已注册，请直接登录。');
      if (codes) {
        codeError = codes.consume(database, email, 'register', { code: credentials.code!, challengeId: credentials.challengeId! });
        if (codeError) return undefined;
      }
      const user: StoredUser = { id: randomUUID(), email, emailVerified: !!codes, passwordHash, createdAt: new Date(this.now()).toISOString() };
      database.users.push(user);
      return this.newSession(database, user);
    });
    if (codeError) throw codeError;
    return result!;
  }

  async resetPassword(body: unknown, client = 'local') {
    const input = validateCredentials(body, true);
    const proof = validateProof(input as unknown as Record<string, unknown>);
    this.checkRateLimit(client, input.email);
    const codes = this.configuredCodes();
    const salt = randomBytes(16);
    const key = await this.derive(input.password, salt);
    const passwordHash = `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`;
    let codeError: HttpError | undefined;
    await this.store.mutate(database => {
      codeError = codes.consume(database, input.email, 'reset-password', proof);
      if (codeError) return;
      const user = database.users.find(candidate => candidate.email === input.email && candidate.emailVerified === true);
      if (!user) { codeError = new HttpError(400, 'CODE_INVALID_OR_EXPIRED', '验证码无效或已过期，请重新获取后再试。'); return; }
      user.passwordHash = passwordHash;
      user.emailVerified = true;
      database.sessions = database.sessions.filter(session => session.userId !== user.id);
      codes.invalidateEmail(database, user.email);
    });
    if (codeError) throw codeError;
    return { passwordReset: true as const };
  }

  async verifyEmail(userId: string, body: unknown): Promise<AuthUser> {
    const input = object(body, ['code', 'challengeId']);
    const proof = validateProof(input);
    const codes = this.configuredCodes();
    let codeError: HttpError | undefined;
    const user = await this.store.mutate(database => {
      const current = database.users.find(candidate => candidate.id === userId);
      if (!current) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
      codeError = codes.consume(database, current.email, 'verify-email', proof, userId);
      if (codeError) return undefined;
      current.emailVerified = true;
      return publicUser(current);
    });
    if (codeError) throw codeError;
    return user!;
  }

  async login(body: unknown, client = 'local') {
    const { email, password } = validateCredentials(body, false, 'login');
    this.checkRateLimit(client, email);
    const user = (await this.store.read()).users.find(user => user.email === email);
    const parts = user?.passwordHash.split('$');
    const validHash = parts?.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$65536$8$2' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
    const actual = await this.derive(password, validHash ? Buffer.from(parts![4], 'hex') : dummySalt);
    const expected = validHash ? Buffer.from(parts![5], 'hex') : Buffer.alloc(64);
    if (!user || !validHash || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确。');
    return this.store.mutate(database => {
      const current = database.users.find(candidate => candidate.id === user.id && candidate.passwordHash === user.passwordHash);
      if (!current) throw new HttpError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确。');
      return this.newSession(database, current);
    });
  }

  /** Binds a mini-program openid to an already-authenticated account. Never accepts a client openid. */
  async bindWechat(userId: string, body: unknown, client = 'local'): Promise<WechatBindResult> {
    if (!this.wechat) throw new HttpError(503, 'WECHAT_NOT_CONFIGURED', '微信绑定暂未开放，请稍后再试。');
    const input = object(body, ['code']);
    if (typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.code)) invalid('微信登录凭证无效。');
    this.checkRateLimit(client);
    const identity = await this.wechat.exchange(input.code);
    const masked = `${identity.openid.slice(0, 6)}***${identity.openid.slice(-4)}`;
    const result = await this.store.mutate(database => {
      const current = database.users.find(user => user.id === userId);
      if (!current) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
      const owner = database.users.find(user => user.id !== userId && user.wechatOpenid === identity.openid);
      if (owner) throw new HttpError(409, 'WECHAT_ALREADY_BOUND', '该微信已绑定其他账号。');
      if (current.wechatOpenid && current.wechatOpenid !== identity.openid) {
        throw new HttpError(409, 'WECHAT_ALREADY_BOUND', '当前账号已绑定其他微信。');
      }
      current.wechatOpenid = identity.openid;
      return { bound: true as const, openidMasked: masked };
    });
    return result;
  }

  async authenticate(token: string | undefined): Promise<AuthSession> {
    if (!token || !tokenPattern.test(token)) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录，或重新登录后继续。');
    const database = await this.store.read();
    const session = database.sessions.find(session => session.tokenHash === digest(token) && Date.parse(session.expiresAt) > this.now());
    const user = session && database.users.find(user => user.id === session.userId);
    if (!session || !user) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    return { user: publicUser(user), expiresAt: session.expiresAt };
  }

  async logout(token: string | undefined) {
    if (token && tokenPattern.test(token)) {
      const tokenHash = digest(token);
      if ((await this.store.read()).sessions.some(session => session.tokenHash === tokenHash)) {
        await this.store.mutate(database => {
          database.sessions = database.sessions.filter(session => session.tokenHash !== tokenHash);
        });
      }
    }
    return { signedOut: true as const };
  }
}
