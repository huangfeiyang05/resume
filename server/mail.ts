import nodemailer, { type Transporter } from 'nodemailer';
import { HttpError } from './errors.js';
import type { MailSender } from './email-codes.js';
import type { EmailCodePurpose } from '../shared/auth.js';

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  codeSecret: string;
}

/** Server-only; neither credentials nor the code HMAC key can enter client configuration. */
export function loadMailConfig(env = process.env): MailConfig {
  if (env.MAIL_ENABLED !== undefined && !['true', 'false'].includes(env.MAIL_ENABLED)) throw new Error('MAIL_ENABLED must be true or false.');
  const enabled = env.MAIL_ENABLED === 'true';
  const config: MailConfig = {
    enabled, host: env.SMTP_HOST ?? '', port: Number(env.SMTP_PORT ?? 465), secure: env.SMTP_SECURE !== 'false',
    user: env.SMTP_USER ?? '', password: env.SMTP_PASSWORD ?? '', from: env.MAIL_FROM ?? env.SMTP_USER ?? '',
    codeSecret: env.MAIL_CODE_SECRET ?? '',
  };
  if (!enabled) return config;
  if ((env.MAIL_PROVIDER ?? 'smtp') !== 'smtp') throw new Error('MAIL_PROVIDER currently supports smtp only.');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(config.host)) throw new Error('SMTP_HOST must be a valid mail server hostname.');
  if (![465, 587].includes(config.port) || (config.port === 465 && !config.secure) || (config.port === 587 && config.secure)) throw new Error('Use SMTP port 465 with TLS or 587 with required STARTTLS.');
  if (env.SMTP_SECURE !== undefined && !['true', 'false'].includes(env.SMTP_SECURE)) throw new Error('SMTP_SECURE must be true or false.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.user) || !config.password || config.password.length > 512 || /[\r\n\0]/.test(config.password)) throw new Error('SMTP authentication configuration is incomplete.');
  if (!config.from || config.from.length > 254 || /[\r\n\0]/.test(config.from) || !(config.from === config.user || config.from.endsWith(`<${config.user}>`))) throw new Error('MAIL_FROM must use the configured SMTP account.');
  if (!/^[a-f0-9]{64,128}$/i.test(config.codeSecret)) throw new Error('MAIL_CODE_SECRET requires at least 32 random bytes encoded as hexadecimal.');
  return config;
}

const purposeNames: Record<EmailCodePurpose, string> = { register: '注册账号', 'reset-password': '找回密码', 'verify-email': '验证邮箱' };
type MailTransport = Pick<Transporter, 'sendMail' | 'verify' | 'close'>;

export class SmtpMailSender implements MailSender {
  readonly enabled: boolean;
  private active = 0;
  private transport?: MailTransport;
  constructor(private config: MailConfig, transport?: MailTransport) {
    this.enabled = config.enabled;
    if (config.enabled) this.transport = transport ?? nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: config.host },
      connectionTimeout: 10_000, greetingTimeout: 5_000, socketTimeout: 15_000, dnsTimeout: 5_000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
    });
  }

  /** Tests connectivity and credentials without sending any email. */
  async verify() {
    if (!this.transport) throw new HttpError(503, 'MAIL_NOT_CONFIGURED', '邮件服务尚未配置。');
    try { await this.transport.verify(); }
    catch { throw new HttpError(503, 'MAIL_CONNECTION_FAILED', 'SMTP 连接或身份验证失败，请检查服务端发信配置。'); }
  }

  async sendCode(input: { email: string; code: string; purpose: EmailCodePurpose; expiresAt: string }) {
    if (!this.transport) throw new HttpError(503, 'MAIL_NOT_CONFIGURED', '邮件服务尚未配置。');
    if (this.active >= 2) throw new HttpError(429, 'MAIL_BUSY', '邮件服务正忙，请稍后重试。');
    this.active++;
    try {
      const purpose = purposeNames[input.purpose];
      const info = await this.transport.sendMail({
        from: this.config.from, to: input.email,
        subject: `【简历有方】${purpose}验证码`,
        text: `你正在进行：${purpose}。\n\n验证码：${input.code}\n\n验证码有效期为 10 分钟，仅能使用一次。请在简历有方网站中填写，不要向他人提供。\n如果不是你本人操作，请忽略本邮件。\n`,
        disableFileAccess: true, disableUrlAccess: true,
      });
      if (!Array.isArray(info.accepted) || !info.accepted.some((recipient: unknown) => typeof recipient === 'string' && recipient.toLowerCase() === input.email.toLowerCase())) {
        throw new Error('SMTP recipient was not accepted.');
      }
    } catch {
      // Upstream SMTP errors can contain addresses and authorization details; never return or log them.
      throw new HttpError(503, 'MAIL_DELIVERY_FAILED', '验证码暂时未能提交发送，请稍后重试。');
    } finally { this.active--; }
  }

  close() { this.transport?.close(); }
}
