/** Client-safe account contracts. Password and session hashes are server-only. */
export interface AuthUser {
  id: string;
  email?: string;
  phone?: string;
  phoneVerified?: boolean;
  hasPassword?: boolean;
  createdAt: string;
  emailVerified: boolean;
  /** A mini-program account signed in silently through a server-verified WeChat openid. */
  wechat?: boolean;
  nickname?: string;
  avatarId?: string;
}

export interface EmailPasswordInput { email: string; password: string; code?: string; challengeId?: string }
export type EmailCodePurpose = 'register' | 'reset-password' | 'verify-email' | 'bind-email';
export interface SendEmailCodeInput { email: string; purpose: EmailCodePurpose; replace?: true }
export interface EmailCodeChallenge { challengeId: string; expiresAt: string; resendAfterSeconds: number; message: string }
export interface ResetPasswordInput { email: string; password: string; code: string; challengeId: string }
export interface ChangePasswordInput { currentPassword: string; newPassword: string }
export interface VerifyEmailInput { code: string; challengeId: string }
export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
  /** Returned only for a mini-program client; H5 uses an HttpOnly cookie. */
  token?: string;
}
export interface AuthCapabilities {
  emailPassword: true; wechat: boolean; phone: boolean;
  emailVerification: boolean; passwordReset: boolean;
  wechatPhone?: true;
  smsLoginOnly?: true;
}
export interface WechatLoginInput { code: string }
export interface BindWechatPhoneInput { wechatCode: string; phoneCode: string }
export interface AccountProfileInput {
  nickname: string | null;
  /** Base64 JPEG/PNG. Omit to keep the current avatar, or pass null to remove it. */
  avatar?: string | null;
}
export const accountAvatarMaxBytes = 128 * 1024;
export const accountAvatarMaxSide = 512;
export const accountNicknameMaxLength = 24;
export const accountAvatarIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isAccountNickname(value: unknown): value is string {
  return typeof value === 'string' && value.length <= accountNicknameMaxLength * 2
    && value === value.trim() && value === value.normalize('NFC')
    && [...value].length >= 1 && [...value].length <= accountNicknameMaxLength
    && !/[\p{Cc}\uD800-\uDFFF\u2028-\u202E\u2066-\u2069]/u.test(value);
}
export type PhoneCodePurpose = 'login' | 'bind-phone' | 'verify-account';
export interface SendPhoneCodeInput { phone: string; purpose: PhoneCodePurpose; replace?: true }
export interface PhoneCodeChallenge { challengeId: string; expiresAt: string; resendAfterSeconds: number; message: string }
export interface PhoneLoginInput { phone: string; code: string; challengeId: string }
export interface CurrentIdentityProof { currentPassword?: string; currentCode?: string; currentChallengeId?: string; wechatCode?: string }
/** A password account can use its authenticated session without resending its password. */
export interface BindPhoneInput extends PhoneLoginInput, CurrentIdentityProof {}
export interface BindEmailInput extends CurrentIdentityProof { email: string; code: string; challengeId: string; password?: string }
export type ChangePhoneInput = PhoneLoginInput;
export interface ChangeEmailInput extends VerifyEmailInput { email: string }

/** New passwords use 6-16 visible ASCII characters: letters, digits and symbols only. */
export const PASSWORD_PATTERN = /^[\x21-\x7e]{6,16}$/;
export const PASSWORD_RULE_MESSAGE = '密码需为 6 至 16 位，只能使用字母、数字和符号，不能包含空格或中文。';
export const PASSWORD_MAX_LENGTH = 16;
