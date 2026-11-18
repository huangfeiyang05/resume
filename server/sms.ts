import { createHash, createHmac, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

export interface CodeSms {
  phone: string;
  code: string;
  purpose: 'login' | 'bind-phone' | 'verify-account';
  expiresAt: string;
}
export interface SmsSender { readonly enabled: boolean; sendCode(input: CodeSms): Promise<void> }
interface SmsCommonConfig { enabled: boolean; loginOnly: boolean; codeSecret: string }
export interface AliyunSmsConfig extends SmsCommonConfig {
  provider: 'aliyun';
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  securityToken?: string;
}
export interface TencentSmsConfig extends SmsCommonConfig {
  provider: 'tencent';
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  templateId: string;
  region: string;
  token?: string;
}
export type SmsConfig = AliyunSmsConfig | TencentSmsConfig;
const endpoint = 'https://dysmsapi.aliyuncs.com/';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const configError = () => new Error('SMS configuration is incomplete or invalid; verify the server-only credentials, approved signature, template and code secret.');
const failure = () => new HttpError(502, 'SMS_SEND_FAILED', '短信提交未能确认，请稍后重试；请勿连续重复发送。');
const safeText = (value: unknown, minimum: number, maximum: number) => typeof value === 'string' && value.length >= minimum && value.length <= maximum && !/[\x00-\x20\x7f]/.test(value);

/** Opt-in server configuration; no default key, approved identity, or successful send is invented. */
export function loadSmsConfig(env: NodeJS.ProcessEnv = process.env): SmsConfig {
  const flag = env.SMS_ENABLED ?? 'false';
  const loginOnly = env.SMS_LOGIN_ONLY ?? 'false';
  const provider = env.SMS_PROVIDER ?? 'tencent';
  if (!['true', 'false'].includes(flag) || !['true', 'false'].includes(loginOnly) || !['aliyun', 'tencent'].includes(provider)) throw configError();
  const common = { enabled: flag === 'true', loginOnly: loginOnly === 'true', codeSecret: env.SMS_CODE_SECRET ?? '' };
  if (common.enabled && (Buffer.byteLength(common.codeSecret, 'utf8') < 32 || Buffer.byteLength(common.codeSecret, 'utf8') > 4096)) throw configError();
  if (provider === 'tencent') {
    const config: TencentSmsConfig = { ...common, provider,
      secretId: env.TENCENT_SMS_SECRET_ID ?? '', secretKey: env.TENCENT_SMS_SECRET_KEY ?? '', sdkAppId: env.TENCENT_SMS_SDK_APP_ID ?? '',
      signName: env.TENCENT_SMS_SIGN_NAME ?? '', templateId: env.TENCENT_SMS_TEMPLATE_ID ?? '', region: env.TENCENT_SMS_REGION ?? 'ap-guangzhou',
      ...(env.TENCENT_SMS_TOKEN ? { token: env.TENCENT_SMS_TOKEN } : {}),
    };
    if (config.enabled && (!/^AKID[A-Za-z0-9]{8,124}$/.test(config.secretId) || !safeText(config.secretKey, 8, 256)
      || !/^\d{1,30}$/.test(config.sdkAppId) || !/^\d{1,30}$/.test(config.templateId)
      || !config.signName.trim() || config.signName !== config.signName.trim() || config.signName.length > 100 || /[\x00-\x1f\x7f]/.test(config.signName)
      || !['ap-beijing', 'ap-nanjing', 'ap-guangzhou'].includes(config.region)
      || (config.token !== undefined && !safeText(config.token, 1, 8192)))) throw configError();
    return config;
  }
  const config: AliyunSmsConfig = {
    ...common, provider: 'aliyun', accessKeyId: env.ALIYUN_SMS_ACCESS_KEY_ID ?? '', accessKeySecret: env.ALIYUN_SMS_ACCESS_KEY_SECRET ?? '',
    signName: env.ALIYUN_SMS_SIGN_NAME ?? '', templateCode: env.ALIYUN_SMS_TEMPLATE_CODE ?? '', codeSecret: env.SMS_CODE_SECRET ?? '',
    ...(env.ALIYUN_SMS_SECURITY_TOKEN ? { securityToken: env.ALIYUN_SMS_SECURITY_TOKEN } : {}),
  };
  if (config.enabled && (!/^[A-Za-z0-9]{8,128}$/.test(config.accessKeyId) || !safeText(config.accessKeySecret, 8, 256)
    || typeof config.signName !== 'string' || !config.signName.trim() || config.signName !== config.signName.trim() || config.signName.length > 100 || /[\x00-\x1f\x7f]/.test(config.signName)
    || !/^SMS_\d{1,30}$/.test(config.templateCode) || Buffer.byteLength(config.codeSecret, 'utf8') < 32 || Buffer.byteLength(config.codeSecret, 'utf8') > 4096
    || (config.securityToken !== undefined && !safeText(config.securityToken, 1, 8192)))) throw configError();
  return config;
}

/** RFC3986 encoding, not URLSearchParams' space-as-plus encoding, is used for the signed form. */
function encode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function form(values: Record<string, string>) { return Object.keys(values).sort().map(key => `${encode(key)}=${encode(values[key])}`).join('&'); }

/** The shared ACS3 construction is also checked against Alibaba Cloud's published fixed vector. */
export function createAcs3Authorization(input: {
  method: string; canonicalUri: string; canonicalQuery: string; headers: Record<string, string>;
  body: string; accessKeyId: string; accessKeySecret: string;
}): string {
  const names = Object.keys(input.headers).filter(name => name.startsWith('x-acs-') || name === 'host' || name === 'content-type').sort();
  const canonicalHeaders = names.map(name => `${name}:${input.headers[name].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = `${input.method}\n${input.canonicalUri}\n${input.canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${hash(input.body)}`;
  const signature = createHmac('sha256', input.accessKeySecret).update(`ACS3-HMAC-SHA256\n${hash(canonicalRequest)}`, 'utf8').digest('hex');
  return `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

/** ACS3 signs the exact body and every x-acs header. No credentials or payloads are logged. */
function signedRequest(config: AliyunSmsConfig, input: CodeSms) {
  const body = form({ PhoneNumbers: input.phone, RegionId: 'cn-hangzhou', SignName: config.signName,
    TemplateCode: config.templateCode, TemplateParam: JSON.stringify({ code: input.code }) });
  const payloadHash = hash(body);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded', host: 'dysmsapi.aliyuncs.com',
    'x-acs-action': 'SendSms', 'x-acs-version': '2017-05-25', 'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': randomUUID(), 'x-acs-content-sha256': payloadHash,
    ...(config.securityToken ? { 'x-acs-security-token': config.securityToken } : {}),
  };
  headers.Authorization = createAcs3Authorization({ method: 'POST', canonicalUri: '/', canonicalQuery: '', headers, body,
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret });
  headers.Accept = 'application/json';
  return { headers, body };
}

async function payload(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65_536)) { await response.body?.cancel(); throw failure(); }
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw failure(); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw failure(); }
  finally { reader.releaseLock(); }
}

/** A successful API submission is not an operator delivery receipt. Never automatically retry SendSms. */
export class AliyunSmsSender implements SmsSender {
  readonly enabled: boolean;
  private config: AliyunSmsConfig;
  constructor(config: SmsConfig, private fetcher: typeof fetch = fetch, private timeoutMs = 10_000) {
    if (config.provider !== 'aliyun') throw configError();
    this.config = config;
    this.enabled = config.enabled;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw configError();
  }
  async sendCode(input: CodeSms): Promise<void> {
    if (!this.enabled) throw new HttpError(503, 'SMS_NOT_CONFIGURED', '短信验证暂未开放，请使用邮箱登录。');
    if (!input || !/^1[3-9]\d{9}$/.test(input.phone) || !/^\d{6}$/.test(input.code)
      || !['login', 'bind-phone', 'verify-account'].includes(input.purpose) || !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new HttpError(400, 'INVALID_SMS_INPUT', '短信验证码请求无效。');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request = signedRequest(this.config, input);
      const response = await this.fetcher(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: request.headers, body: request.body });
      const result = await payload(response);
      if (!response.ok || !result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>).Code !== 'OK') throw failure();
    } catch {
      throw failure();
    } finally { clearTimeout(timer); }
  }
}

/** TC3 uses the request timestamp's UTC date, including around Shanghai midnight. */
export function createTc3Authorization(input: {
  body: string; timestamp: number; host: string; service: string; action: string; secretId: string; secretKey: string;
}): string {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${input.host.toLowerCase()}\nx-tc-action:${input.action.toLowerCase()}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hash(input.body)}`;
  const scope = `${date}/${input.service}/tc3_request`;
  const signingText = `TC3-HMAC-SHA256\n${input.timestamp}\n${scope}\n${hash(canonicalRequest)}`;
  const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();
  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, input.service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(signingText, 'utf8').digest('hex');
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class TencentSmsSender implements SmsSender {
  readonly enabled: boolean;
  private config: TencentSmsConfig;
  constructor(config: SmsConfig, private fetcher: typeof fetch = fetch, private timeoutMs = 10_000) {
    if (config.provider !== 'tencent') throw configError();
    this.config = config;
    this.enabled = config.enabled;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw configError();
  }
  async sendCode(input: CodeSms): Promise<void> {
    if (!this.enabled) throw new HttpError(503, 'SMS_NOT_CONFIGURED', '短信验证暂未开放，请使用邮箱登录。');
    if (!input || !/^1[3-9]\d{9}$/.test(input.phone) || !/^\d{6}$/.test(input.code)
      || !['login', 'bind-phone', 'verify-account'].includes(input.purpose) || !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new HttpError(400, 'INVALID_SMS_INPUT', '短信验证码请求无效。');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = JSON.stringify({ PhoneNumberSet: [`+86${input.phone}`], SmsSdkAppId: this.config.sdkAppId, SignName: this.config.signName,
        TemplateId: this.config.templateId, TemplateParamSet: [input.code] });
      const timestamp = Math.floor(Date.now() / 1000);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8', Host: 'sms.tencentcloudapi.com', 'X-TC-Action': 'SendSms',
        'X-TC-Version': '2021-01-11', 'X-TC-Timestamp': String(timestamp), 'X-TC-Region': this.config.region,
        Authorization: createTc3Authorization({ body, timestamp, host: 'sms.tencentcloudapi.com', service: 'sms', action: 'SendSms', secretId: this.config.secretId, secretKey: this.config.secretKey }),
        ...(this.config.token ? { 'X-TC-Token': this.config.token } : {}),
      };
      const response = await this.fetcher('https://sms.tencentcloudapi.com/', { method: 'POST', redirect: 'error', signal: controller.signal, headers, body });
      const result = await payload(response);
      const envelope = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).Response : undefined;
      const details = envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope as Record<string, unknown> : undefined;
      const statuses = details?.SendStatusSet;
      if (!response.ok || !details || details.Error !== undefined || !Array.isArray(statuses) || statuses.length !== 1
        || !statuses[0] || typeof statuses[0] !== 'object' || statuses[0].Code !== 'Ok'
        || (statuses[0].PhoneNumber !== `+86${input.phone}` && statuses[0].PhoneNumber !== input.phone)) throw failure();
    } catch { throw failure(); }
    finally { clearTimeout(timer); }
  }
}

export function createSmsSender(config: SmsConfig, fetcher: typeof fetch = fetch, timeoutMs = 10_000): SmsSender {
  return config.provider === 'tencent' ? new TencentSmsSender(config, fetcher, timeoutMs) : new AliyunSmsSender(config, fetcher, timeoutMs);
}
