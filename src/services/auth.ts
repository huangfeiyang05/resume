import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { AuthCapabilities, AuthSession, AuthUser, EmailPasswordInput, WechatLoginInput, PhoneLoginInput, EmailCodePurpose, SendEmailCodeInput, EmailCodeChallenge, ResetPasswordInput, VerifyEmailInput, PhoneCodePurpose, PhoneCodeChallenge, SendPhoneCodeInput, BindPhoneInput, BindEmailInput } from '../../shared/auth';
import { PASSWORD_PATTERN, PASSWORD_RULE_MESSAGE } from '../../shared/auth';
import { ApiError, isMiniProgramClient, onUnauthorized, request, setAuthToken } from './api';

const miniProgramSessionKey = 'youfang-auth-session-v1';
export type AuthMode = 'login' | 'register' | 'reset';
export const authApi = {
  providers: () => request<AuthCapabilities>('/auth/providers', 'GET', undefined, { notifyUnauthorized: false }),
  me: () => request<AuthSession>('/auth/me', 'GET', undefined, { notifyUnauthorized: false }),
  login: (input: EmailPasswordInput) => request<AuthSession>('/auth/login', 'POST', input, { notifyUnauthorized: false }),
  register: (input: EmailPasswordInput) => request<AuthSession>('/auth/register', 'POST', input, { notifyUnauthorized: false }),
  logout: () => request<{ signedOut: true }>('/auth/logout', 'POST'),
  sendEmailCode: (input: SendEmailCodeInput) => request<EmailCodeChallenge>('/auth/email/code', 'POST', input, { notifyUnauthorized: ['verify-email', 'bind-email'].includes(input.purpose) }),
  resetPassword: (input: ResetPasswordInput) => request<{ passwordReset: true }>('/auth/password/reset', 'POST', input, { notifyUnauthorized: false }),
  verifyEmail: (input: VerifyEmailInput) => request<AuthUser>('/auth/email/verify', 'POST', input),
  sendPhoneCode: (input: SendPhoneCodeInput) => request<PhoneCodeChallenge>('/auth/phone/code', 'POST', input, { notifyUnauthorized: input.purpose !== 'login' }),
  bindPhone: (input: BindPhoneInput) => request<AuthUser>('/auth/phone/bind', 'POST', input, { notifyUnauthorized: false }),
  bindEmail: (input: BindEmailInput) => request<AuthUser>('/auth/email/bind', 'POST', input, { notifyUnauthorized: false }),
  // Capabilities and server responses determine whether a provider is available.
  wechat: (input: WechatLoginInput) => request<AuthSession>('/auth/wechat', 'POST', input, { notifyUnauthorized: false }),
  phone: (input: PhoneLoginInput) => request<AuthSession>('/auth/phone', 'POST', input, { notifyUnauthorized: false }),
};

export function validateAuthForm(mode: AuthMode, email: string, password: string, confirmation = ''): string {
  const normalized = email.trim();
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return '请输入有效的邮箱地址。';
  if (mode === 'login') {
    if (password.length < 6 || password.length > 128) return '密码长度需要在 6 到 128 个字符之间。';
  } else if (!PASSWORD_PATTERN.test(password)) return PASSWORD_RULE_MESSAGE;
  if (mode !== 'login' && password !== confirmation) return '两次输入的密码不一致，请重新确认。';
  return '';
}

/** Proofs and cooldowns stay only in this component's memory, scoped by mailbox and purpose. */
export function useEmailChallenge(options: { autoTick?: boolean; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const email = ref('');
  const purpose = ref<EmailCodePurpose>('register');
  const code = ref('');
  const challenge = ref<EmailCodeChallenge>();
  const busy = ref(false);
  const error = ref('');
  const message = ref('');
  const clock = ref(now());
  const cooldowns = reactive(new Map<string, number>());
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const key = () => `${purpose.value}\n${email.value}`;
  const remaining = computed(() => Math.max(0, Math.ceil(((cooldowns.get(key()) ?? 0) - clock.value) / 1000)));
  function tick() { clock.value = now(); }
  function clearProof() { ++generation; busy.value = false; challenge.value = undefined; code.value = ''; error.value = ''; message.value = ''; }
  function setTarget(nextEmail: string, nextPurpose: EmailCodePurpose) {
    const normalized = nextEmail.trim().toLowerCase();
    if (email.value === normalized && purpose.value === nextPurpose) return;
    ++generation; busy.value = false;
    email.value = normalized; purpose.value = nextPurpose;
    clearProof(); tick();
  }
  async function send() {
    tick();
    if (busy.value || remaining.value > 0 || disposed) return false;
    if (!email.value || email.value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      error.value = '请先填写有效的邮箱地址。'; return false;
    }
    const current = ++generation, sentKey = key();
    const input: SendEmailCodeInput = { email: email.value, purpose: purpose.value };
    busy.value = true; error.value = ''; message.value = '';
    try {
      const result = await authApi.sendEmailCode(input);
      if (disposed) return false;
      if (!result.challengeId || !(Date.parse(result.expiresAt) > now()) || !Number.isFinite(result.resendAfterSeconds) || result.resendAfterSeconds < 0) throw new Error('验证码发送状态返回异常，请稍后重试。');
      cooldowns.set(sentKey, now() + result.resendAfterSeconds * 1000);
      tick();
      if (current !== generation || sentKey !== key()) return false;
      challenge.value = result; code.value = ''; message.value = result.message;
      return true;
    } catch (reason) {
      if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : '验证码未能发送，请稍后重试。';
      return false;
    } finally { if (!disposed && current === generation) busy.value = false; }
  }
  function proof(): VerifyEmailInput | undefined {
    tick(); error.value = '';
    if (!challenge.value || !(Date.parse(challenge.value.expiresAt) > now())) {
      error.value = '请先获取当前邮箱的验证码，过期后需要重新发送。'; return;
    }
    if (!/^\d{6}$/.test(code.value)) { error.value = '请输入邮件中的 6 位数字验证码。'; return; }
    return { challengeId: challenge.value.challengeId, code: code.value };
  }
  function dispose() { disposed = true; ++generation; if (timer) clearInterval(timer); cooldowns.clear(); clearProof(); }
  if (options.autoTick !== false) {
    onMounted(() => { timer = setInterval(tick, 1000); });
    onUnmounted(dispose);
  }
  return { email, purpose, code, challenge, busy, error, message, remaining, setTarget, send, proof, clearProof, tick, dispose };
}


export function normalizedPhone(value: string): string {
  return value.trim().replace(/^\+86[ -]?/, '').replace(/[ -]/g, '');
}
export function validAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const user = value as AuthUser;
  if (typeof user.id !== 'string' || !user.id || typeof user.createdAt !== 'string' || !Number.isFinite(Date.parse(user.createdAt))
    || typeof user.emailVerified !== 'boolean'
    || (user.email !== undefined && (typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)))
    || (user.phone !== undefined && (typeof user.phone !== 'string' || !/^1[3-9]\d{9}$/.test(user.phone)))
    || (user.phoneVerified !== undefined && typeof user.phoneVerified !== 'boolean')
    || (user.hasPassword !== undefined && typeof user.hasPassword !== 'boolean')) return false;
  if ((!user.email && user.emailVerified) || (!user.phone && user.phoneVerified === true)) return false;
  return !!user.email || (!!user.phone && user.phoneVerified === true);
}

/** SMS proof remains in memory, keyed by normalized phone and purpose. */
export function usePhoneChallenge(options: { autoTick?: boolean; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const phone = ref(''), purpose = ref<PhoneCodePurpose>('login'), code = ref('');
  const challenge = ref<PhoneCodeChallenge>();
  const busy = ref(false), error = ref(''), message = ref(''), clock = ref(now());
  const cooldowns = reactive(new Map<string, number>());
  let generation = 0, disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const key = () => `${purpose.value}\n${phone.value}`;
  const remaining = computed(() => Math.max(0, Math.ceil(((cooldowns.get(key()) ?? 0) - clock.value) / 1000)));
  function tick() { clock.value = now(); }
  function clearProof() { ++generation; busy.value = false; challenge.value = undefined; code.value = ''; error.value = ''; message.value = ''; }
  function setTarget(nextPhone: string, nextPurpose: PhoneCodePurpose) {
    const normalized = normalizedPhone(nextPhone);
    if (phone.value === normalized && purpose.value === nextPurpose) return;
    ++generation; busy.value = false;
    phone.value = normalized; purpose.value = nextPurpose; clearProof(); tick();
  }
  async function send() {
    tick();
    if (busy.value || remaining.value > 0 || disposed) return false;
    if (!/^1[3-9]\d{9}$/.test(phone.value)) { error.value = '请填写有效的中国大陆手机号。'; return false; }
    const current = ++generation, sentKey = key();
    busy.value = true; error.value = ''; message.value = '';
    try {
      const result = await authApi.sendPhoneCode({ phone: phone.value, purpose: purpose.value });
      if (disposed) return false;
      if (!result.challengeId || !(Date.parse(result.expiresAt) > now()) || !Number.isFinite(result.resendAfterSeconds) || result.resendAfterSeconds < 0) throw new Error('验证码发送状态返回异常，请稍后重试。');
      cooldowns.set(sentKey, now() + result.resendAfterSeconds * 1000); tick();
      if (current !== generation || sentKey !== key()) return false;
      challenge.value = result; code.value = ''; message.value = result.message; return true;
    } catch (reason) {
      if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : '短信验证码未能发送，请稍后重试。';
      return false;
    } finally { if (!disposed && current === generation) busy.value = false; }
  }
  function proof(): VerifyEmailInput | undefined {
    tick(); error.value = '';
    if (!challenge.value || !(Date.parse(challenge.value.expiresAt) > now())) { error.value = '请先获取当前手机号的验证码。'; return; }
    if (!/^\d{6}$/.test(code.value)) { error.value = '请输入短信中的 6 位数字验证码。'; return; }
    return { challengeId: challenge.value.challengeId, code: code.value };
  }
  function dispose() { disposed = true; ++generation; if (timer) clearInterval(timer); cooldowns.clear(); clearProof(); }
  if (options.autoTick !== false) { onMounted(() => { timer = setInterval(tick, 1000); }); onUnmounted(dispose); }
  return { phone, purpose, code, challenge, busy, error, message, remaining, setTarget, send, proof, clearProof, tick, dispose };
}

/** H5 uses the HttpOnly cookie. Only the native mini-program keeps an opaque bearer token. */
export function useAuth(options: { autoRestore?: boolean } = {}) {
  const user = ref<AuthUser>();
  const status = ref<'checking' | 'authenticated' | 'anonymous' | 'unavailable'>('checking');
  const busy = ref(false);
  const operation = ref<'authenticate' | 'logout' | 'reset' | 'verify' | 'bind'>();
  const error = ref('');
  const notice = ref('');
  const capabilities = ref<AuthCapabilities>();
  const signedIn = computed(() => status.value === 'authenticated' && !!user.value);
  let generation = 0;
  let disposed = false;
  let activeToken = '';

  function clearSession(message = '') {
    ++generation;
    activeToken = '';
    setAuthToken('');
    if (isMiniProgramClient()) uni.removeStorageSync(miniProgramSessionKey);
    user.value = undefined;
    status.value = 'anonymous';
    error.value = message; notice.value = '';
  }
  const stopListening = onUnauthorized(() => clearSession('登录已过期，请重新登录。'));

  function acceptSession(session: AuthSession, token = session.token) {
    if (!validAuthUser(session.user) || !(Date.parse(session.expiresAt) > Date.now())) {
      throw new Error('登录状态返回异常，请重新登录。');
    }
    if (isMiniProgramClient()) {
      if (!token) throw new Error('暂时无法保存登录状态，请重新登录。');
      activeToken = token;
      uni.setStorageSync(miniProgramSessionKey, { token, expiresAt: session.expiresAt });
      setAuthToken(token);
    } else {
      // Never copy a server session token into browser storage.
      setAuthToken('');
    }
    user.value = session.user;
    status.value = 'authenticated';
    error.value = ''; notice.value = '';
  }

  async function restore() {
    const current = ++generation;
    status.value = 'checking'; error.value = '';
    if (isMiniProgramClient()) {
      const saved = uni.getStorageSync(miniProgramSessionKey) as { token?: unknown; expiresAt?: unknown } | undefined;
      if (!saved || typeof saved.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(saved.token)
        || typeof saved.expiresAt !== 'string' || !(Date.parse(saved.expiresAt) > Date.now())) {
        clearSession();
        void loadCapabilities();
        return;
      }
      activeToken = saved.token;
      setAuthToken(activeToken);
    } else setAuthToken('');
    void loadCapabilities();
    try {
      const session = await authApi.me();
      if (!disposed && current === generation) acceptSession(session, activeToken);
    } catch (reason) {
      if (disposed || current !== generation) return;
      if (reason instanceof ApiError && reason.status === 401) clearSession();
      else {
        user.value = undefined;
        status.value = 'unavailable';
        error.value = reason instanceof Error ? reason.message : '暂时无法确认登录状态，请稍后重试。';
      }
    }
  }
  async function loadCapabilities() {
    try {
      const result = await authApi.providers();
      if (!result || result.emailPassword !== true || !['wechat', 'phone', 'emailVerification', 'passwordReset'].every(key => typeof result[key as keyof AuthCapabilities] === 'boolean')) return;
      if (!disposed) capabilities.value = result;
    }
    catch { /* A real login request can still show a recoverable service error. */ }
  }
  async function authenticate(mode: 'login' | 'register', input: EmailPasswordInput) {
    if (busy.value) return false;
    const validation = validateAuthForm(mode, input.email, input.password, input.password);
    if (validation) { error.value = validation; return false; }
    if (mode === 'register' && capabilities.value?.emailVerification && (!/^\d{6}$/.test(input.code ?? '') || !input.challengeId)) {
      error.value = '请先获取并填写邮箱验证码。'; return false;
    }
    const current = ++generation;
    busy.value = true; operation.value = 'authenticate'; error.value = ''; notice.value = '';
    try {
      const session = await authApi[mode]({ email: input.email.trim(), password: input.password, ...(mode === 'register' && input.code !== undefined ? { code: input.code, challengeId: input.challengeId } : {}) });
      if (disposed || current !== generation) return false;
      acceptSession(session);
      return true;
    } catch (reason) {
      if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : '登录未完成，请重试。';
      return false;
    } finally { if (!disposed) { busy.value = false; operation.value = undefined; } }
  }
  async function authenticatePhone(input: PhoneLoginInput) {
    if (busy.value) return false;
    const phone = normalizedPhone(input.phone);
    if (!capabilities.value?.phone) { error.value = '短信登录暂未开放，请使用邮箱登录。'; return false; }
    if (!/^1[3-9]\d{9}$/.test(phone) || !/^\d{6}$/.test(input.code) || !input.challengeId) {
      error.value = '请填写手机号并获取有效的短信验证码。'; return false;
    }
    const current = ++generation;
    busy.value = true; operation.value = 'authenticate'; error.value = ''; notice.value = '';
    try {
      const session = await authApi.phone({ phone, code: input.code, challengeId: input.challengeId });
      if (disposed || current !== generation) return false;
      acceptSession(session); return true;
    } catch (reason) {
      if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : '手机登录未完成，请重试。';
      return false;
    } finally { if (!disposed) { busy.value = false; operation.value = undefined; } }
  }
  async function bindIdentity(kind: 'phone', input: BindPhoneInput): Promise<boolean>;
  async function bindIdentity(kind: 'email', input: BindEmailInput): Promise<boolean>;
  async function bindIdentity(kind: 'phone' | 'email', input: BindPhoneInput | BindEmailInput): Promise<boolean> {
    if (busy.value || !user.value) return false;
    if (kind === 'phone' ? !capabilities.value?.phone : !capabilities.value?.emailVerification) {
      error.value = kind === 'phone' ? '短信绑定暂未开放。' : '邮箱绑定暂未开放。'; return false;
    }
    const current = ++generation, expectedUser = user.value;
    busy.value = true; operation.value = 'bind'; error.value = ''; notice.value = '';
    try {
      const result = kind === 'phone' ? await authApi.bindPhone(input as BindPhoneInput) : await authApi.bindEmail(input as BindEmailInput);
      if (disposed || current !== generation || user.value?.id !== expectedUser.id) return false;
      const targetMatches = kind === 'phone'
        ? result.phone === normalizedPhone((input as BindPhoneInput).phone) && result.phoneVerified === true && result.email === expectedUser.email
        : result.email === (input as BindEmailInput).email.trim().toLowerCase() && result.emailVerified === true && result.phone === expectedUser.phone;
      if (!validAuthUser(result) || result.id !== expectedUser.id || !targetMatches) throw new Error('绑定结果尚未确认，请重新读取账号信息。');
      user.value = result; notice.value = kind === 'phone' ? '手机号已绑定，可用短信验证码登录同一账号。' : '邮箱已绑定，可用邮箱和密码登录同一账号。';
      return true;
    } catch (reason) {
      if (!disposed && current === generation) {
        if (reason instanceof ApiError && reason.code === 'AUTH_REQUIRED') clearSession('登录已失效，请重新登录。');
        else error.value = reason instanceof Error ? reason.message : '绑定未完成，请重试。';
      }
      return false;
    } finally { if (!disposed) { busy.value = false; operation.value = undefined; } }
  }
  const bindPhone = (input: BindPhoneInput) => bindIdentity('phone', input);
  const bindEmail = (input: BindEmailInput) => bindIdentity('email', input);
  async function resetPassword(input: ResetPasswordInput) {
    if (busy.value) return false;
    const validation = validateAuthForm('reset', input.email, input.password, input.password);
    if (validation || !/^\d{6}$/.test(input.code) || !input.challengeId) {
      error.value = validation || '请先获取并填写邮箱验证码。'; return false;
    }
    if (!capabilities.value?.passwordReset) { error.value = '邮件找回暂未启用，请稍后再试。'; return false; }
    const current = ++generation;
    busy.value = true; operation.value = 'reset'; error.value = ''; notice.value = '';
    try {
      const result = await authApi.resetPassword({ ...input, email: input.email.trim() });
      if (disposed || current !== generation) return false;
      if (result.passwordReset !== true) throw new Error('密码重置尚未完成，请重试。');
      clearSession();
      notice.value = '密码已更新，原登录会话已退出，请使用新密码登录。';
      return true;
    } catch (reason) {
      if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : '密码重置未完成，请重试。';
      return false;
    } finally { if (!disposed) { busy.value = false; operation.value = undefined; } }
  }
  async function verifyEmail(input: VerifyEmailInput) {
    if (busy.value || !user.value) return false;
    if (!capabilities.value?.emailVerification) { error.value = '邮箱验证暂未启用，请稍后再试。'; return false; }
    const current = ++generation, expectedUser = user.value;
    busy.value = true; operation.value = 'verify'; error.value = '';
    try {
      const result = await authApi.verifyEmail(input);
      if (disposed || current !== generation || user.value?.id !== expectedUser.id) return false;
      if (result.id !== expectedUser.id || result.email !== expectedUser.email || result.emailVerified !== true) throw new Error('邮箱验证尚未完成，请重试。');
      user.value = result;
      return true;
    } catch (reason) {
      if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : '邮箱验证未完成，请重试。';
      return false;
    } finally { if (!disposed) { busy.value = false; operation.value = undefined; } }
  }
  async function signOut() {
    if (busy.value) return;
    busy.value = true; operation.value = 'logout'; error.value = ''; notice.value = '';
    const current = ++generation;
    try {
      await authApi.logout();
      if (!disposed && current === generation) clearSession();
    } catch (reason) {
      if (disposed) return;
      if (reason instanceof ApiError && reason.status === 401) clearSession();
      else if (current === generation) error.value = '退出未完成，请检查网络后重试。';
    } finally { if (!disposed) { busy.value = false; operation.value = undefined; } }
  }
  function dispose() { disposed = true; ++generation; stopListening(); }
  if (options.autoRestore !== false) {
    onMounted(restore);
    onUnmounted(dispose);
  }
  return { user, signedIn, status, busy, operation, error, notice, capabilities, restore, authenticate, authenticatePhone, bindPhone, bindEmail, resetPassword, verifyEmail, signOut, loadCapabilities, dispose };
}
