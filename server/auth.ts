import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AuthCapabilities, AuthSession, AuthUser, EmailCodePurpose, EmailPasswordInput, PhoneCodePurpose } from '../shared/auth.js';
import type { WechatBindResult } from '../shared/payment.js';
import { wechatLoginCode, type WechatIdentity, type WechatIdentityProvider } from './wechat-identity.js';
import type { WechatPhoneProvider } from './wechat-api.js';
import { AccountProfiles } from './account-profile.js';
import { PASSWORD_PATTERN, PASSWORD_RULE_MESSAGE } from '../shared/auth.js';
import { HttpError, invalid } from './errors.js';
import { JsonStore, type Database, type StoredUser } from './store.js';
import { EmailCodeService, validateEmail, validateProof } from './email-codes.js';
import { PhoneCodeService, validatePhone } from './phone-codes.js';

const ttl = 7 * 24 * 60 * 60 * 1000;
export const adminSessionTtlMs = 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashOptions = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };
const dummySalt = Buffer.from('youfang-dummy-password-check');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// Old releases hash the raw token, so a rollback cannot turn an admin session into a user session.
const sessionDigest = (token: string, scope?: 'admin') => digest(scope === 'admin' ? `admin:${token}` : token);
function publicUser(user: StoredUser): AuthUser {
  return { id: user.id, ...(user.email ? { email: user.email } : {}), ...(user.phone ? { phone: user.phone } : {}),
    createdAt: user.createdAt, emailVerified: user.emailVerified === true, phoneVerified: user.phoneVerified === true,
    hasPassword: !!user.passwordHash, ...(user.wechatOpenid ? { wechat: true } : {}),
    ...(user.nickname ? { nickname: user.nickname } : {}), ...(user.avatarId ? { avatarId: user.avatarId } : {}) };
}

function object(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求体必须是 JSON 对象。');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) invalid('请求体含不支持的字段。');
  return record;
}

interface TestLoginAlias { username: string; email: string }

export function validateCredentials(body: unknown, allowProof = false, passwordPolicy: 'new' | 'login' = 'new', testLoginAlias?: TestLoginAlias): EmailPasswordInput {
  const record = object(body, allowProof ? ['email', 'password', 'code', 'challengeId'] : ['email', 'password']);
  const alias = passwordPolicy === 'login' && typeof record.email === 'string' && record.email.trim() === testLoginAlias?.username
    ? testLoginAlias : undefined;
  const email = alias?.email ?? validateEmail(record.email);
  const passwordText = record.password;
  if (typeof passwordText !== 'string') invalid(passwordPolicy === 'new' ? PASSWORD_RULE_MESSAGE : '邮箱或密码不正确。');
  const passwordValid = passwordPolicy === 'new'
    ? PASSWORD_PATTERN.test(passwordText)
    : passwordText.length >= (alias ? 1 : 6) && passwordText.length <= 128 && !/[\u0000-\u001f\u007f]/.test(passwordText);
  if (!passwordValid) invalid(passwordPolicy === 'new' ? PASSWORD_RULE_MESSAGE : '邮箱或密码不正确。');
  // Password whitespace is significant and is never trimmed or normalized.
  if (allowProof && (Object.hasOwn(record, 'code') || Object.hasOwn(record, 'challengeId'))) {
    return { email, password: passwordText, ...validateProof(record) };
  }
  return { email, password: passwordText };
}

export interface AuthOptions {
  now?: () => number;
  sessionTtlMs?: number;
  emailCodes?: EmailCodeService;
  phoneCodes?: PhoneCodeService;
  smsLoginOnly?: boolean;
  requireEmailVerification?: boolean;
  wechat?: WechatIdentityProvider;
  wechatPhone?: WechatPhoneProvider;
  testLoginAlias?: TestLoginAlias;
}
export class AuthService {
  private hashing = 0;
  private attempts = new Map<string, { count: number; until: number }>();
  private now: () => number;
  readonly sessionTtlMs: number;
  readonly emailCodes?: EmailCodeService;
  readonly phoneCodes?: PhoneCodeService;
  private readonly smsLoginOnly: boolean;
  private requireEmailVerification: boolean;
  private wechat?: WechatIdentityProvider;
  private wechatPhone?: WechatPhoneProvider;
  private profiles: AccountProfiles;
  private readonly testLoginAlias?: TestLoginAlias;
  constructor(readonly store: JsonStore, options: AuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.emailCodes = options.emailCodes;
    this.phoneCodes = options.phoneCodes;
    this.smsLoginOnly = options.smsLoginOnly === true;
    this.requireEmailVerification = options.requireEmailVerification ?? options.emailCodes?.enabled ?? false;
    this.sessionTtlMs = options.sessionTtlMs ?? ttl;
    this.wechat = options.wechat;
    this.wechatPhone = this.wechat && options.wechatPhone;
    this.profiles = new AccountProfiles(store);
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1) throw new Error('Invalid session lifetime.');
    if (options.testLoginAlias) {
      if (store.environment !== 'test' || !/^[a-z][a-z0-9_-]{0,31}$/.test(options.testLoginAlias.username)) {
        throw new Error('Login aliases require a test store and a valid username.');
      }
      this.testLoginAlias = { username: options.testLoginAlias.username, email: validateEmail(options.testLoginAlias.email) };
    }
  }

  capabilities(): AuthCapabilities {
    const configured = this.emailCodes?.enabled === true;
    const phone = this.phoneCodes?.enabled === true;
    return { emailPassword: true, wechat: this.wechat !== undefined, phone, emailVerification: configured, passwordReset: configured,
      ...(this.wechatPhone ? { wechatPhone: true as const } : {}),
      ...(phone && this.smsLoginOnly ? { smsLoginOnly: true as const } : {}) };
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

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await this.derive(password, salt);
    return `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  private async matchesPassword(password: string, hash?: string): Promise<boolean> {
    const parts = hash?.split('$');
    const validHash = parts?.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$65536$8$2' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
    const actual = await this.derive(password, validHash ? Buffer.from(parts![4], 'hex') : dummySalt);
    const expected = validHash ? Buffer.from(parts![5], 'hex') : Buffer.alloc(64);
    return validHash === true && timingSafeEqual(actual, expected);
  }

  async configureTestLogin(password: string): Promise<string> {
    const alias = this.testLoginAlias;
    if (!alias) throw new Error('Test login alias is not configured.');
    const { email } = validateCredentials({ email: alias.username, password }, false, 'login', alias);
    return this.store.mutate(async database => {
      const user = database.users.find(candidate => candidate.email === email);
      if (!user) {
        const id = randomUUID();
        database.users.push({ id, email, emailVerified: true, passwordHash: await this.hashPassword(password), createdAt: new Date(this.now()).toISOString() });
        return id;
      }
      if (!await this.matchesPassword(password, user.passwordHash)) {
        user.passwordHash = await this.hashPassword(password);
        database.sessions = database.sessions.filter(session => session.userId !== user.id);
      }
      user.emailVerified = true;
      return user.id;
    });
  }

  private newSession(database: Database, user: StoredUser, scope?: 'admin'): { session: AuthSession; token: string } {
    const now = this.now();
    database.sessions = database.sessions.filter(session => Date.parse(session.expiresAt) > now);
    const userSessions = database.sessions.filter(session => session.userId === user.id && session.scope === scope);
    if (userSessions.length >= 20) {
      const remove = new Set(userSessions.slice(0, userSessions.length - 19).map(session => session.tokenHash));
      database.sessions = database.sessions.filter(session => !remove.has(session.tokenHash));
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + (scope === 'admin' ? adminSessionTtlMs : this.sessionTtlMs)).toISOString();
    database.sessions.push({ tokenHash: sessionDigest(token, scope), userId: user.id, createdAt: new Date(now).toISOString(), expiresAt,
      ...(scope ? { scope } : {}) });
    return { session: { user: publicUser(user), expiresAt }, token };
  }

  async register(body: unknown, client = 'local') {
    const credentials = validateCredentials(body, true);
    const { email, password } = credentials;
    this.checkRateLimit(client, email);
    const codes = this.requireEmailVerification ? this.configuredCodes() : undefined;
    if (codes && (!credentials.code || !credentials.challengeId)) throw new HttpError(400, 'EMAIL_VERIFICATION_REQUIRED', '请先获取并填写邮箱验证码。');
    if ((await this.store.read()).users.some(user => user.email === email)) throw new HttpError(409, 'EMAIL_ALREADY_REGISTERED', '该邮箱已注册，请直接登录。');
    const passwordHash = await this.hashPassword(password);
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

  async login(body: unknown, client = 'local', adminUserIds?: ReadonlySet<string>) {
    const { email, password } = validateCredentials(body, false, 'login', this.testLoginAlias);
    this.checkRateLimit(client, email);
    const user = (await this.store.read()).users.find(user => user.email === email);
    if (!await this.matchesPassword(password, user?.passwordHash) || !user) throw new HttpError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确。');
    return this.store.mutate(database => {
      const current = database.users.find(candidate => candidate.id === user.id && candidate.passwordHash === user.passwordHash);
      if (!current) throw new HttpError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确。');
      if (adminUserIds && (!adminUserIds.has(current.id) || !current.emailVerified)) {
        throw new HttpError(403, 'ADMIN_FORBIDDEN', '此账号没有管理权限。');
      }
      return this.newSession(database, current, adminUserIds ? 'admin' : undefined);
    });
  }

  private configuredPhoneCodes(purpose: PhoneCodePurpose): PhoneCodeService {
    if (!this.phoneCodes) throw new HttpError(503, 'SMS_NOT_CONFIGURED', '短信验证服务暂未开放，请使用邮箱登录。');
    this.phoneCodes.assertEnabled();
    if (this.smsLoginOnly && purpose !== 'login') {
      throw new HttpError(503, 'SMS_LOGIN_ONLY', '短信验证码当前仅用于登录。');
    }
    return this.phoneCodes;
  }

  async requestPhoneCode(body: unknown, client = 'local', userId?: string) {
    const input = object(body, ['phone', 'purpose']);
    const phone = validatePhone(input.phone);
    if (!['login', 'bind-phone', 'verify-account'].includes(input.purpose as string)) invalid('验证码用途无效。');
    const purpose = input.purpose as PhoneCodePurpose;
    const codes = this.configuredPhoneCodes(purpose);
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
    const codes = this.configuredPhoneCodes('login');
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

  private async bindingIdentity(snapshot: StoredUser, input: Record<string, unknown>, client: string) {
    this.checkRateLimit(client, snapshot.email ?? snapshot.phone);
    if (snapshot.passwordHash) {
      if (input.currentCode !== undefined || input.currentChallengeId !== undefined || input.wechatCode !== undefined) invalid('请使用当前账号密码验证身份。');
      const text = input.currentPassword;
      if (typeof text !== 'string' || text.length < 6 || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) throw new HttpError(401, 'CURRENT_IDENTITY_REQUIRED', '请填写当前账号密码以确认绑定。');
      const parts = snapshot.passwordHash.split('$');
      const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$65536$8$2' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
      const actual = await this.derive(text, valid ? Buffer.from(parts[4], 'hex') : dummySalt);
      if (!valid || !timingSafeEqual(actual, valid ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64))) throw new HttpError(401, 'CURRENT_IDENTITY_INVALID', '当前账号密码不正确。');
      return { snapshot, currentProof: undefined };
    }
    if (input.wechatCode !== undefined) {
      if (input.currentPassword !== undefined || input.currentCode !== undefined || input.currentChallengeId !== undefined) invalid('请只使用一种当前账号的验证方式。');
      await this.verifyCurrentWechat(snapshot, input.wechatCode);
      return { snapshot, currentProof: undefined };
    }
    if (input.currentPassword !== undefined || !snapshot.phone || snapshot.phoneVerified !== true) throw new HttpError(401, 'CURRENT_IDENTITY_REQUIRED', '请验证当前账号已绑定的手机号。');
    const currentProof = validateProof({ code: input.currentCode, challengeId: input.currentChallengeId });
    this.configuredPhoneCodes('verify-account');
    return { snapshot, currentProof };
  }

  private currentBindingUser(database: Database, snapshot: StoredUser): StoredUser {
    const current = database.users.find(user => user.id === snapshot.id);
    if (!current || current.passwordHash !== snapshot.passwordHash || current.email !== snapshot.email
      || current.phone !== snapshot.phone || current.wechatOpenid !== snapshot.wechatOpenid) {
      throw new HttpError(409, 'ACCOUNT_CHANGED', '账号登录信息已变化，请刷新后重新验证。');
    }
    return current;
  }

  async bindPhone(token: string | undefined, body: unknown, client = 'local'): Promise<AuthUser> {
    const { user: existing } = this.requireSession(await this.store.read(), token);
    const userId = existing.id;
    const input = object(body, ['phone', 'code', 'challengeId', 'currentPassword', 'currentCode', 'currentChallengeId', 'wechatCode']);
    const phone = validatePhone(input.phone), proof = validateProof(input);
    const codes = this.configuredPhoneCodes('bind-phone');
    if (existing.phone === phone && existing.phoneVerified === true) return publicUser(existing);
    const suppliedProof = ['currentPassword', 'currentCode', 'currentChallengeId', 'wechatCode'].some(key => Object.hasOwn(input, key));
    const useSessionIdentity = !!existing.passwordHash && !suppliedProof;
    if (useSessionIdentity) this.checkRateLimit(client, existing.email ?? existing.phone);
    const identity = useSessionIdentity ? { snapshot: existing, currentProof: undefined } : await this.bindingIdentity(existing, input, client);
    let codeError: HttpError | undefined;
    const result = await this.store.mutate(database => {
      const { user: latest } = this.requireSession(database, token);
      if (latest.phone === phone && latest.phoneVerified === true) return publicUser(latest);
      const current = this.currentBindingUser(database, identity.snapshot);
      this.checkPhoneBinding(database, current, phone);
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
    const input = object(body, ['email', 'code', 'challengeId', 'password', 'currentPassword', 'currentCode', 'currentChallengeId', 'wechatCode']);
    const email = validateEmail(input.email), proof = validateProof(input);
    const codes = this.configuredCodes();
    const existing = (await this.store.read()).users.find(user => user.id === userId);
    if (!existing) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    if (existing.email === email && existing.emailVerified === true) return publicUser(existing);
    const identity = await this.bindingIdentity(existing, input, client);
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
        codeError = this.configuredPhoneCodes('verify-account').consume(database, current.phone!, 'verify-account', identity.currentProof, userId);
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

  private checkPhoneBinding(database: Database, user: StoredUser, phone: string) {
    if (user.phone && user.phone !== phone) throw new HttpError(409, 'PHONE_CHANGE_NOT_SUPPORTED', '当前账号已有手机号，暂不支持直接更换。');
    if (database.users.some(other => other.id !== user.id && other.phone === phone)) {
      throw new HttpError(409, 'PHONE_ALREADY_BOUND', '该手机号已属于其他账号，请使用原账号登录。');
    }
  }

  private async verifyCurrentWechat(user: StoredUser, code: unknown) {
    if (!this.wechat || !user.wechatOpenid) throw new HttpError(409, 'WECHAT_NOT_BOUND', '请先使用当前账号关联的微信登录。');
    const identity = await this.wechat.exchange(wechatLoginCode(code));
    if (identity.openid !== user.wechatOpenid) throw new HttpError(403, 'WECHAT_IDENTITY_MISMATCH', '当前微信与此账号关联的微信不一致。');
  }

  async bindWechatPhone(userId: string, body: unknown, client = 'local'): Promise<AuthUser> {
    if (!this.wechatPhone) throw new HttpError(503, 'WECHAT_PHONE_NOT_CONFIGURED', '微信手机号授权暂未开放。');
    const input = object(body, ['wechatCode', 'phoneCode']);
    if (typeof input.phoneCode !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.phoneCode)) invalid('微信手机号授权凭证无效。');
    const existing = (await this.store.read()).users.find(user => user.id === userId);
    if (!existing) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    this.checkRateLimit(client, userId);
    await this.verifyCurrentWechat(existing, input.wechatCode);
    const phone = validatePhone(await this.wechatPhone.redeem(input.phoneCode));
    return this.store.mutate(database => {
      const latest = database.users.find(user => user.id === userId);
      if (latest?.phone === phone && latest.phoneVerified === true && latest.wechatOpenid === existing.wechatOpenid) return publicUser(latest);
      const user = this.currentBindingUser(database, existing);
      this.checkPhoneBinding(database, user, phone);
      user.phone = phone;
      user.phoneVerified = true;
      return publicUser(user);
    });
  }

  async updateProfile(userId: string, body: unknown, client = 'local'): Promise<AuthUser> {
    this.checkRateLimit(client, userId);
    return publicUser(await this.profiles.update(userId, body));
  }

  profileAvatar(userId: string, avatarId: string) { return this.profiles.read(userId, avatarId); }

  /** Silent mini-program sign-in: the server exchanges a one-time code and keys the account by openid. */
  async wechatLogin(body: unknown, client = 'local') {
    if (!this.wechat) throw new HttpError(501, 'WECHAT_LOGIN_NOT_CONFIGURED', '微信小程序免登尚未接入，请先使用邮箱登录。');
    const input = object(body, ['code']);
    const code = wechatLoginCode(input.code);
    this.checkRateLimit(client);
    const identity = await this.wechat.exchange(code);
    return this.store.mutate(database => {
      let user = database.users.find(candidate => candidate.wechatOpenid === identity.openid);
      if (!user) {
        user = { id: randomUUID(), wechatOpenid: identity.openid, emailVerified: false, createdAt: new Date(this.now()).toISOString() };
        database.users.push(user);
      }
      return this.newSession(database, user);
    });
  }

  /** Binds a mini-program openid to an already-authenticated account. Never accepts a client openid. */
  async bindWechat(userId: string, body: unknown, client = 'local'): Promise<WechatBindResult> {
    const input = object(body, ['code']);
    const identity = await this.bindWechatIdentity(userId, input.code, client);
    return { bound: true, openidMasked: identity.openid.slice(0, 6) + '***' + identity.openid.slice(-4) };
  }

  /** A fresh WeChat session key can sign virtual checkout, but never leaves the server. */
  async bindWechatIdentity(userId: string, code: unknown, client: string, requireSessionKey = false): Promise<WechatIdentity> {
    if (!this.wechat) throw new HttpError(503, 'WECHAT_NOT_CONFIGURED', '微信绑定暂未开放，请稍后再试。');
    this.checkRateLimit(client, userId);
    const identity = await this.wechat.exchange(wechatLoginCode(code));
    if (requireSessionKey && !identity.sessionKey) throw new HttpError(502, 'WECHAT_SESSION_INVALID', '微信支付凭证暂不可用，请重试。');
    if ((await this.store.read()).users.some(user => user.id === userId && user.wechatOpenid === identity.openid)) return identity;
    await this.store.mutate(database => {
      const current = database.users.find(user => user.id === userId);
      if (!current) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
      const owner = database.users.find(user => user.id !== userId && user.wechatOpenid === identity.openid);
      if (owner) throw new HttpError(409, 'WECHAT_ALREADY_BOUND', '该微信已绑定其他账号。');
      if (current.wechatOpenid && current.wechatOpenid !== identity.openid) {
        throw new HttpError(409, 'WECHAT_ALREADY_BOUND', '当前账号已绑定其他微信。');
      }
      current.wechatOpenid = identity.openid;
    });
    return identity;
  }

  private requireSession(database: Database, token: string | undefined, scope?: 'admin') {
    if (!token || !tokenPattern.test(token)) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录，或重新登录后继续。');
    const tokenHash = sessionDigest(token, scope);
    const session = database.sessions.find(session => session.scope === scope && session.tokenHash === tokenHash && Date.parse(session.expiresAt) > this.now());
    const user = session && database.users.find(user => user.id === session.userId);
    if (!session || !user) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
    return { session, user };
  }

  async authenticate(token: string | undefined, scope?: 'admin'): Promise<AuthSession> {
    const { session, user } = this.requireSession(await this.store.read(), token, scope);
    return { user: publicUser(user), expiresAt: session.expiresAt };
  }

  async logout(token: string | undefined, scope?: 'admin') {
    if (token && tokenPattern.test(token)) {
      const tokenHash = sessionDigest(token, scope);
      if ((await this.store.read()).sessions.some(session => session.scope === scope && session.tokenHash === tokenHash)) {
        await this.store.mutate(database => {
          database.sessions = database.sessions.filter(session => session.scope !== scope || session.tokenHash !== tokenHash);
        });
      }
    }
    return { signedOut: true as const };
  }
}
