/** Client-safe account contracts. Password and session hashes are server-only. */
export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
  emailVerified: boolean;
}

export interface EmailPasswordInput { email: string; password: string; code?: string; challengeId?: string }
export type EmailCodePurpose = 'register' | 'reset-password' | 'verify-email';
export interface SendEmailCodeInput { email: string; purpose: EmailCodePurpose }
export interface EmailCodeChallenge { challengeId: string; expiresAt: string; resendAfterSeconds: number; message: string }
export interface ResetPasswordInput { email: string; password: string; code: string; challengeId: string }
export interface VerifyEmailInput { code: string; challengeId: string }
export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
  /** Returned only for a mini-program client; H5 uses an HttpOnly cookie. */
  token?: string;
}
export interface AuthCapabilities {
  emailPassword: true; wechat: boolean; phone: false;
  emailVerification: boolean; passwordReset: boolean;
}
/** Future server-side exchange, never a client-provided openId or phone as proof. */
export interface WechatLoginInput { code: string }
export interface PhoneLoginInput { phone: string; code: string }

/** New passwords use 6-16 visible ASCII characters: letters, digits and symbols only. */
export const PASSWORD_PATTERN = /^[\x21-\x7e]{6,16}$/;
export const PASSWORD_RULE_MESSAGE = '密码需为 6 至 16 位，只能使用字母、数字和符号，不能包含空格或中文。';
export const PASSWORD_MAX_LENGTH = 16;
