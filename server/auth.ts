import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AuthCapabilities, AuthSession, AuthUser, EmailCodePurpose, EmailPasswordInput } from '../shared/auth.js';
import type { WechatBindResult } from '../shared/payment.js';
import type { WechatIdentityProvider } from './wechat-identity.js';
import { PASSWORD_PATTERN, PASSWORD_RULE_MESSAGE } from '../shared/auth.js';
import { HttpError, invalid } from './errors.js';
import { JsonStore, type Database, type StoredUser } from './store.js';
import { EmailCodeService, validateEmail, validateProof } from './email-codes.js';
import { PhoneCodeService, validatePhone } from './phone-codes.js';

const ttl = 7 * 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashOptions = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };
const dummySalt = Buffer.from('youfang-dummy-password-check');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function publicUser(user: StoredUser): AuthUser {
  return { id: user.id, ...(user.email ? { email: user.email } : {}), ...(user.phone ? { phone: user.phone } : {}),
    createdAt: user.createdAt, emailVerified: user.emailVerified === true, phoneVerified: user.phoneVerified === true, hasPassword: !!user.passwordHash };
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

export interface AuthOptions { now?: () => number; sessionTtlMs?: number; emailCodes?: EmailCodeService; phoneCodes?: PhoneCodeService; requireEmailVerification?: boolean; wechat?: WechatIdentityProvider }
export class AuthService {
  private hashing = 0;
  private attempts = new Map<string, { count: number; until: number }>();
  private now: () => number;
  readonly sessionTtlMs: number;
  readonly emailCodes?: EmailCodeService;
  readonly phoneCodes?: PhoneCodeService;
  private requireEmailVerification: boolean;
  private wechat?: WechatIdentityProvider;
  constructor(readonly store: JsonStore, options: AuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.emailCodes = options.emailCodes;
    this.phoneCodes = options.phoneCodes;
    this.requireEmailVerification = options.requireEmailVerification ?? options.emailCodes?.enabled ?? false;
    this.sessionTtlMs = options.sessionTtlMs ?? ttl;
    this.wechat = options.wechat;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1) throw new Error('Invalid session lifetime.');
  }

  capabilities(): AuthCapabilities {
    const configured = this.emailCodes?.enabled === true;
    return { emailPassword: true, wechat: this.wechat !== undefined, phone: this.phoneCodes?.enabled === true, emailVerification: configured, passwordReset: configured };
  }

  private configuredCodes(): EmailCodeService {
    if (!this.emailCodes) throw new HttpError(503, 'MAIL_NOT_CONFIGURED', '邮件验证服务暂不可用，请稍后重试。');
    this.emailCodes.assertEnabled();
    return this.emailCodes;
  }

  async requestEmailCode(body: unknown, client = 'local', userId?: string) {
    const input = object(body, ['email', 'purpose']);
    const email = validateEmail(input.email);
    if (!['register', 'reset-password', 'verify-email', 'bind-email'].includes(input.purpose as string)) invalid('验证码用途无效。');
    const purpose = input.purpose as EmailCodePurpose;
    const codes = this.configuredCodes();
    if (purpose === 'verify-email' || purpose === 'bind-email') {
      const user = userId && (await this.store.read()).users.find(candidate => candidate.id === userId);
      if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录后验证邮箱。');
      if (purpose === 'verify-email' && user.email !== email) throw new HttpError(403, 'EMAIL_MISMATCH', '只能验证当前账号的邮箱。');
      if (purpose === 'bind-email' && user.email && user.email !== email) throw new HttpError(409, 'EMAIL_CHANGE_NOT_SUPPORTED', '当前账号已有邮箱，暂不支持直接更换。');
    }
    this.checkRateLimit(client, email);
    // Registration/reset requests send the same message for known and unknown addresses.
    return codes.request(email, purpose, client, ['verify-email', 'bind-email'].includes(purpose) ? userId : undefined);
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
      codes.invalidateEmail(database, user.email!);
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
      if (!current.email) throw new HttpError(400, 'EMAIL_NOT_BOUND', '请先绑定邮箱。');
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
    const parts = user?.passwordHash?.split('$');
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

  private configuredPhoneCodes(): PhoneCodeService {
    if (!this.phoneCodes) throw new HttpError(503, 'SMS_NOT_CONFIGURED', '短信验证服务暂未开放，请使用邮箱登录。');
    this.phoneCodes.assertEnabled();
    return this.phoneCodes;
  }

  async requestPhoneCode(body: unknown, client = 'local', userId?: string) {
    const input = object(body, ['phone', 'purpose']);
    const phone = validatePhone(input.phone);
    if (!['login', 'bind-phone', 'verify-account'].includes(input.purpose as string)) invalid('验证码用途无效。');
    const purpose = input.purpose as 'login' | 'bind-phone' | 'verify-account';
    const codes = this.configuredPhoneCodes();
    if (purpose !== 'login') {
      const user = userId && (await this.store.read()).users.find(candidate => candidate.id === userId);
      if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录后绑定或验证手机号。');
      if (purpose === 'verify-account' && (user.phone !== phone || user.phoneVerified !== true)) throw new HttpError(403, 'PHONE_MISMATCH', '只能向当前账号已验证的手机号发送身份验证码。');
      if (purpose === 'bind-phone' && user.phone && user.phone !== phone) throw new HttpError(409, 'PHONE_CHANGE_NOT_SUPPORTED', '当前账号已有手机号，暂不支持直接更换。');
    }
    this.checkRateLimit(client, phone);
    return codes.request(phone, purpose, client, purpose === 'login' ? undefined : userId);
  }

  /** Possession of a single-use SMS challenge either signs in or creates one phone-only account. */
  async phoneLogin(body: unknown, client = 'local') {
    const input = object(body, ['phone', 'code', 'challengeId']);
    const phone = validatePhone(input.phone), proof = validateProof(input);
    const codes = this.configuredPhoneCodes();
    this.checkRateLimit(client, phone);
    let codeError: HttpError | undefined;
    const result = await this.store.mutate(database => {
      codeError = codes.consume(database, phone, 'login', proof);
      if (codeError) return undefined;
      let user = database.users.find(candidate => candidate.phone === phone);
      if (!user) {
        user = { id: randomUUID(), phone, phoneVerified: true, emailVerified: false, createdAt: new Date(this.now()).toISOString() };
        database.users.push(user);
      } else if (user.phoneVerified !== true) {
        codeError = new HttpError(401, 'PHONE_NOT_VERIFIED', '手机号尚未完成绑定，请使用原登录方式验证。');
        return undefined;
      }
      return this.newSession(database, user);
    });
    if (codeError) throw codeError;
    return result!;
  }

  private async bindingIdentity(userId: string, input: Record<string, unknown>, client: string) {
    const snapshot = (await this.store.read()).users.find(user => user.id === userId);
    if (!snapshot) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    this.checkRateLimit(client, snapshot.email ?? snapshot.phone);
    if (snapshot.passwordHash) {
      if (input.currentCode !== undefined || input.currentChallengeId !== undefined) invalid('请使用当前账号密码验证身份。');
      const text = input.currentPassword;
      if (typeof text !== 'string' || text.length < 6 || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) throw new HttpError(401, 'CURRENT_IDENTITY_REQUIRED', '请填写当前账号密码以确认绑定。');
      const parts = snapshot.passwordHash.split('$');
      const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$65536$8$2' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
      const actual = await this.derive(text, valid ? Buffer.from(parts[4], 'hex') : dummySalt);
      if (!valid || !timingSafeEqual(actual, valid ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64))) throw new HttpError(401, 'CURRENT_IDENTITY_INVALID', '当前账号密码不正确。');
      return { snapshot, currentProof: undefined };
    }
    if (input.currentPassword !== undefined || !snapshot.phone || snapshot.phoneVerified !== true) throw new HttpError(401, 'CURRENT_IDENTITY_REQUIRED', '请验证当前账号已绑定的手机号。');
    const currentProof = validateProof({ code: input.currentCode, challengeId: input.currentChallengeId });
    this.configuredPhoneCodes();
    return { snapshot, currentProof };
  }

  private currentBindingUser(database: Database, snapshot: StoredUser): StoredUser {
    const current = database.users.find(user => user.id === snapshot.id);
    if (!current || current.passwordHash !== snapshot.passwordHash || current.email !== snapshot.email || current.phone !== snapshot.phone) {
      throw new HttpError(409, 'ACCOUNT_CHANGED', '账号登录信息已变化，请刷新后重新验证。');
    }
    return current;
  }

  async bindPhone(userId: string, body: unknown, client = 'local'): Promise<AuthUser> {
    const input = object(body, ['phone', 'code', 'challengeId', 'currentPassword', 'currentCode', 'currentChallengeId']);
    const phone = validatePhone(input.phone), proof = validateProof(input);
    const codes = this.configuredPhoneCodes();
    const existing = (await this.store.read()).users.find(user => user.id === userId);
    if (!existing) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    if (existing.phone === phone && existing.phoneVerified === true) return publicUser(existing);
    const identity = await this.bindingIdentity(userId, input, client);
    let codeError: HttpError | undefined;
    const result = await this.store.mutate(database => {
      const latest = database.users.find(user => user.id === userId);
      if (latest?.phone === phone && latest.phoneVerified === true) return publicUser(latest);
      const current = this.currentBindingUser(database, identity.snapshot);
      if (current.phone && current.phone !== phone) throw new HttpError(409, 'PHONE_CHANGE_NOT_SUPPORTED', '当前账号已有手机号，暂不支持直接更换。');
      if (database.users.some(user => user.id !== userId && user.phone === phone)) throw new HttpError(409, 'PHONE_ALREADY_BOUND', '该手机号已属于其他账号，请使用原账号登录；不会自动合并资料。');
      // A phone-only account already has a verified phone and cannot replace it through this method.
      if (identity.currentProof) {
        codeError = codes.consume(database, current.phone!, 'verify-account', identity.currentProof, userId);
        if (codeError) return undefined;
      }
      codeError = codes.consume(database, phone, 'bind-phone', proof, userId);
      if (codeError) return undefined;
      current.phone = phone; current.phoneVerified = true;
      return publicUser(current);
    });
    if (codeError) throw codeError;
    return result!;
  }

  async bindEmail(userId: string, body: unknown, client = 'local'): Promise<AuthUser> {
    const input = object(body, ['email', 'code', 'challengeId', 'password', 'currentPassword', 'currentCode', 'currentChallengeId']);
    const email = validateEmail(input.email), proof = validateProof(input);
    const codes = this.configuredCodes();
    const existing = (await this.store.read()).users.find(user => user.id === userId);
    if (!existing) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    if (existing.email === email && existing.emailVerified === true) return publicUser(existing);
    const identity = await this.bindingIdentity(userId, input, client);
    let passwordHash: string | undefined;
    if (!identity.snapshot.passwordHash) {
      if (typeof input.password !== 'string' || !PASSWORD_PATTERN.test(input.password)) invalid(PASSWORD_RULE_MESSAGE);
      const salt = randomBytes(16), key = await this.derive(input.password, salt);
      passwordHash = `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`;
    } else if (input.password !== undefined) invalid('已有密码的账号无需设置新密码，请填写当前账号密码。');
    let codeError: HttpError | undefined;
    const result = await this.store.mutate(database => {
      const latest = database.users.find(user => user.id === userId);
      if (latest?.email === email && latest.emailVerified === true) return publicUser(latest);
      const current = this.currentBindingUser(database, identity.snapshot);
      if (current.email && current.email !== email) throw new HttpError(409, 'EMAIL_CHANGE_NOT_SUPPORTED', '当前账号已有邮箱，暂不支持直接更换。');
      if (database.users.some(user => user.id !== userId && user.email === email)) throw new HttpError(409, 'EMAIL_ALREADY_BOUND', '该邮箱已属于其他账号，请使用原账号登录；不会自动合并资料。');
      const beforeCurrent = identity.currentProof && database.phoneChallenges.find(challenge => challenge.id === identity.currentProof!.challengeId);
      const originalCurrent = beforeCurrent ? structuredClone(beforeCurrent) : undefined;
      if (identity.currentProof) {
        codeError = this.configuredPhoneCodes().consume(database, current.phone!, 'verify-account', identity.currentProof, userId);
        if (codeError) return undefined;
      }
      codeError = codes.consume(database, email, 'bind-email', proof, userId);
      if (codeError) {
        // An incorrect target-email guess must persist its attempts without burning the valid current-phone proof.
        if (originalCurrent) database.phoneChallenges[database.phoneChallenges.findIndex(challenge => challenge.id === originalCurrent.id)] = originalCurrent;
        return undefined;
      }
      current.email = email; current.emailVerified = true;
      if (passwordHash) current.passwordHash = passwordHash;
      return publicUser(current);
    });
    if (codeError) throw codeError;
    return result!;
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
