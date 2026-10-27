import { createApiServer } from './http.js';
import { loadModelConfig } from './model-config.js';
import { BailianAnalysisProvider } from './bailian.js';
import { RuleAnalysisProvider } from './analysis.js';
import { ResumeService } from './service.js';
import { JsonStore } from './store.js';
import { AuthService } from './auth.js';
import { EmailCodeService } from './email-codes.js';
import { loadMailConfig, SmtpMailSender } from './mail.js';

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const config = await loadModelConfig();
const provider = config.enabled ? new BailianAnalysisProvider(config) : new RuleAnalysisProvider();
const secureFlag = process.env.AUTH_SECURE_COOKIES ?? String(process.env.NODE_ENV === 'production');
if (!['true', 'false'].includes(secureFlag)) throw new Error('AUTH_SECURE_COOKIES must be true or false.');
if (process.env.NODE_ENV === 'production' && secureFlag !== 'true') throw new Error('Production authentication requires secure cookies.');
const trustedOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map(origin => origin.trim()).filter(Boolean);
for (const origin of trustedOrigins) {
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('AUTH_TRUSTED_ORIGINS contains an invalid origin.');
}
const store = new JsonStore();
const mailConfig = loadMailConfig();
const mailer = new SmtpMailSender(mailConfig);
const auth = new AuthService(store, {
  ...(mailConfig.enabled ? { emailCodes: new EmailCodeService(store, mailer, { secret: mailConfig.codeSecret }) } : {}),
  requireEmailVerification: process.env.NODE_ENV === 'production',
});
const server = createApiServer(new ResumeService(store, provider), {
  auth,
  secureCookies: secureFlag === 'true', trustedOrigins, trustProxy: process.env.NODE_ENV === 'production',
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Resume API: http://127.0.0.1:${port} · ${config.enabled ? `百炼 ${config.model}（待请求验证）` : '本地规则诊断'}`);
});
server.on('error', (error) => {
  console.error('Resume API failed:', error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { mailer.close(); process.exit(0); }));
}
