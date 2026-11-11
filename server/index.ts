import { createApiServer } from './http.js';
import { loadModelConfig } from './model-config.js';
import { BailianAnalysisProvider } from './bailian.js';
import { RuleAnalysisProvider } from './analysis.js';
import { ResumeService } from './service.js';
import { JsonStore } from './store.js';
import { AuthService } from './auth.js';
import { EmailCodeService } from './email-codes.js';
import { loadMailConfig, SmtpMailSender } from './mail.js';
import { loadSmsConfig, createSmsSender } from './sms.js';
import { PhoneCodeService } from './phone-codes.js';
import { loadAlipayConfig, loadBillingPricing, loadPaymentConfig } from './payment-config.js';
import { WechatPayClient } from './wechat-pay.js';
import { AlipayClient } from './alipay.js';
import { WechatCodeExchange } from './wechat-identity.js';
import { loadWechatAppCredentials, WechatApi, WechatPhoneVerification, wechatFlag } from './wechat-api.js';
import { loadWechatVirtualConfig, WechatVirtualGateway } from './wechat-virtual-gateway.js';
import { WechatMessagePush } from './wechat-message-push.js';
import { parseAdminUserIds } from './admin.js';

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
const pricing = loadBillingPricing();
const paymentConfig = loadPaymentConfig();
const gateway = paymentConfig ? new WechatPayClient(paymentConfig) : undefined;
const wechatApp = loadWechatAppCredentials();
const wechatApi = wechatApp && new WechatApi(wechatApp);
const phoneAuthorization = wechatFlag('WECHAT_PHONE_ENABLED', process.env);
const virtualConfig = loadWechatVirtualConfig();
if ((phoneAuthorization || virtualConfig) && !wechatApi) throw new Error('WeChat phone or virtual payment requires mini-program credentials.');
const paymentVirtual = virtualConfig && wechatApi && wechatApp ? {
  gateway: new WechatVirtualGateway(virtualConfig, wechatApi),
  push: new WechatMessagePush(wechatApp.appid, virtualConfig.pushToken, virtualConfig.pushAesKey),
} : undefined;
const alipayConfig = loadAlipayConfig();
const alipayGateway = alipayConfig ? new AlipayClient(alipayConfig) : undefined;
const mailConfig = loadMailConfig();
const mailer = new SmtpMailSender(mailConfig);
const smsConfig = loadSmsConfig();
const smsDailyLimit = Number(process.env.SMS_DAILY_LIMIT ?? 100);
const auth = new AuthService(store, {
  ...(mailConfig.enabled ? { emailCodes: new EmailCodeService(store, mailer, { secret: mailConfig.codeSecret }) } : {}),
  requireEmailVerification: process.env.NODE_ENV === 'production',
  ...(smsConfig.enabled ? { phoneCodes: new PhoneCodeService(store, createSmsSender(smsConfig), { secret: smsConfig.codeSecret, dailyLimit: smsDailyLimit }) } : {}),
  ...(wechatApp ? { wechat: new WechatCodeExchange(wechatApp.appid, wechatApp.appSecret) } : {}),
  ...(phoneAuthorization && wechatApi && wechatApp ? { wechatPhone: new WechatPhoneVerification(wechatApi, wechatApp.appid) } : {}),
});
const server = createApiServer(new ResumeService(store, provider), {
  auth,
  adminUserIds: parseAdminUserIds(process.env.ADMIN_USER_IDS),
  secureCookies: secureFlag === 'true', trustedOrigins, trustProxy: process.env.NODE_ENV === 'production',
  pricing,
  ...(paymentConfig && gateway ? { paymentGateway: gateway, paymentAppid: paymentConfig.appid, paymentMchid: paymentConfig.mchid, paymentNotifyUrl: paymentConfig.notifyUrl } : {}),
  ...(alipayGateway ? { paymentAlipay: alipayGateway } : {}),
  ...(paymentVirtual ? { paymentVirtual } : {}),
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
