import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HttpError } from './errors.js';
import { JsonStore } from './store.js';
import { ResumeService } from './service.js';
import { limits, validateVersionRevision } from './validation.js';
import { PaymentService } from './payments.js';
import type { WechatPayGateway } from './wechat-pay.js';
import type { AlipayGateway } from './alipay.js';
import type { BillingPricing } from './payment-config.js';
import { AnalysisJobs } from './jobs.js';
import { AuthService } from './auth.js';
import { isIP } from 'node:net';
import { CareerService } from './career.js';
import { exportResume } from './exports.js';
import { dirname, join } from 'node:path';
import { CompanyCatalogRepository } from './company-catalog.js';
import { validateCompanyId, validateCompanySearchParams } from './company-validation.js';
import { searchCompanies } from './company-search.js';
import { answerCareerAssistant } from './career-assistant.js';

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Authorization' });
  response.end(JSON.stringify(value));
}

function text(response: ServerResponse, status: number, value: string) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(value);
}

async function rawBody(request: IncomingMessage, allowEmpty = false): Promise<string> {
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求体。');
  const declared = request.headers['content-length'];
  if (declared && Number(declared) > limits.bodyBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 256 KB 限制。');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limits.bodyBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 256 KB 限制。');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim() && allowEmpty) return '';
  return text;
}

async function body(request: IncomingMessage, allowEmpty = false): Promise<unknown> {
  const text = await rawBody(request, allowEmpty);
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new HttpError(400, 'INVALID_JSON', '请求体不是有效的 JSON。'); }
}

/** Alipay notifications are application/x-www-form-urlencoded, so they need their own bounded reader. */
async function formBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers['content-length'];
  if (declared && Number(declared) > limits.bodyBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 256 KB 限制。');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limits.bodyBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 256 KB 限制。');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function formFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  new URLSearchParams(raw).forEach((value, key) => { fields[key] = value; });
  return fields;
}

export interface ApiServerOptions {
  auth?: AuthService;
  secureCookies?: boolean;
  trustedOrigins?: string[];
  trustProxy?: boolean;
  careerCatalogPath?: string;
  companyCatalogPath?: string;
  paymentGateway?: WechatPayGateway;
  paymentAlipay?: AlipayGateway;
  pricing?: BillingPricing;
  paymentAppid?: string;
  paymentMchid?: string;
  paymentNotifyUrl?: string;
}
const cookieName = 'youfang_session';
function sessionToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  // An old browser may still send cached Basic credentials; only Bearer has meaning here.
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined;
}

/** The HTTP boundary always authenticates business requests before selecting a user's scope. */
export function createApiServer(baseService = new ResumeService(new JsonStore()), options: ApiServerOptions = {}) {
  const auth = options.auth ?? new AuthService(baseService.store);
  const jobs = new AnalysisJobs(baseService);
  const payments = new PaymentService({
    store: baseService.store, quota: jobs.quota, ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(options.paymentGateway ? { gateway: options.paymentGateway } : {}),
    ...(options.paymentAlipay ? { alipay: options.paymentAlipay } : {}),
    ...(options.paymentAppid ? { appid: options.paymentAppid } : {}),
    ...(options.paymentMchid ? { mchid: options.paymentMchid } : {}),
    ...(options.paymentNotifyUrl ? { notifyUrl: options.paymentNotifyUrl } : {}),
  });
  // Shared company reference data is available to authenticated users during testing.
  // Future paid access belongs here on the server, never in a client-supplied tier.
  const companies = new CompanyCatalogRepository(options.companyCatalogPath ?? join(dirname(baseService.store.path), 'company-catalog.json'));
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const trustedOrigins = new Set(options.trustedOrigins ?? ['http://127.0.0.1:5173', 'http://localhost:5173']);
  const cookie = (token: string, maxAge: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  function assertWriteOrigin(request: IncomingMessage) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) return;
    const origin = request.headers.origin;
    let localSameOrigin = false;
    if (!secureCookies && origin) {
      try {
        const url = new URL(origin);
        localSameOrigin = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && origin === `http://${request.headers.host}`;
      } catch { /* An invalid origin is rejected below. */ }
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && !trustedOrigins.has(origin) && !localSameOrigin)) {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', '请求来源未获允许，请从本站重新操作。');
    }
  }
  function clientAddress(request: IncomingMessage) {
    const remote = request.socket.remoteAddress ?? 'unknown';
    const supplied = request.headers['x-real-ip'];
    if (options.trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && typeof supplied === 'string' && isIP(supplied)) return supplied;
    return remote;
  }
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/$/, '');
      const method = request.method ?? 'GET';
      assertWriteOrigin(request);
      if (path === '/api/v1/billing/wechat/notify') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const raw = await rawBody(request);
        json(response, 200, await payments.applyNotification(request.headers, raw)); return;
      }
      if (path === '/api/v1/billing/alipay/notify') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const fields = formFields(await formBody(request));
        try {
          await payments.applyAlipayNotification(fields);
        } catch (error) {
          // Alipay retries until it receives the literal "success"; log only the safe error code.
          console.error('[resume-api] alipay notification rejected', error instanceof HttpError ? error.code : error instanceof Error ? error.name : 'UnknownError');
          text(response, 200, 'failure'); return;
        }
        text(response, 200, 'success'); return;
      }
      if (path === '/api/v1/auth/providers') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: auth.capabilities() }); return;
      }
      if (path === '/api/v1/auth/email/code') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const input = await body(request);
        const verification = input && typeof input === 'object' && !Array.isArray(input) && ['verify-email', 'bind-email'].includes((input as Record<string, unknown>).purpose as string);
        const userId = verification ? (await auth.authenticate(sessionToken(request))).user.id : undefined;
        json(response, 202, { data: await auth.requestEmailCode(input, clientAddress(request), userId) }); return;
      }
      if (path === '/api/v1/auth/phone/code') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const input = await body(request);
        const needsSession = input && typeof input === 'object' && !Array.isArray(input)
          && ['bind-phone', 'verify-account'].includes((input as Record<string, unknown>).purpose as string);
        const userId = needsSession ? (await auth.authenticate(sessionToken(request))).user.id : undefined;
        json(response, 202, { data: await auth.requestPhoneCode(input, clientAddress(request), userId) }); return;
      }
      if (path === '/api/v1/auth/phone/bind' || path === '/api/v1/auth/email/bind') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const session = await auth.authenticate(sessionToken(request));
        const input = await body(request);
        const result = path.endsWith('/phone/bind')
          ? await auth.bindPhone(session.user.id, input, clientAddress(request))
          : await auth.bindEmail(session.user.id, input, clientAddress(request));
        json(response, 200, { data: result }); return;
      }
      if (path === '/api/v1/auth/password/reset') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const result = await auth.resetPassword(await body(request), clientAddress(request));
        response.setHeader('Set-Cookie', cookie('', 0));
        json(response, 200, { data: result }); return;
      }
      if (path === '/api/v1/auth/email/verify') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const session = await auth.authenticate(sessionToken(request));
        json(response, 200, { data: await auth.verifyEmail(session.user.id, await body(request)) }); return;
      }
      if (path === '/api/v1/auth/register' || path === '/api/v1/auth/login') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const credentials = await body(request);
        const result = path.endsWith('/register') ? await auth.register(credentials, clientAddress(request)) : await auth.login(credentials, clientAddress(request));
        const miniProgram = request.headers['x-auth-client'] === 'mp-weixin';
        if (!miniProgram) response.setHeader('Set-Cookie', cookie(result.token, Math.floor(auth.sessionTtlMs / 1000)));
        json(response, path.endsWith('/register') ? 201 : 200, { data: { ...result.session, ...(miniProgram ? { token: result.token } : {}) } }); return;
      }
      if (path === '/api/v1/auth/me') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await auth.authenticate(sessionToken(request)) }); return;
      }
      if (path === '/api/v1/auth/logout') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const result = await auth.logout(sessionToken(request));
        response.setHeader('Set-Cookie', cookie('', 0));
        json(response, 200, { data: result }); return;
      }
      if (path === '/api/v1/auth/phone') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const result = await auth.phoneLogin(await body(request), clientAddress(request));
        const miniProgram = request.headers['x-auth-client'] === 'mp-weixin';
        if (!miniProgram) response.setHeader('Set-Cookie', cookie(result.token, Math.floor(auth.sessionTtlMs / 1000)));
        json(response, 200, { data: { ...result.session, ...(miniProgram ? { token: result.token } : {}) } }); return;
      }
      if (path === '/api/v1/auth/wechat') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const result = await auth.wechatLogin(await body(request), clientAddress(request));
        const miniProgram = request.headers['x-auth-client'] === 'mp-weixin';
        if (!miniProgram) response.setHeader('Set-Cookie', cookie(result.token, Math.floor(auth.sessionTtlMs / 1000)));
        json(response, 200, { data: { ...result.session, ...(miniProgram ? { token: result.token } : {}) } }); return;
      }
      if (path === '/api/v1/auth/wechat/bind') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const session = await auth.authenticate(sessionToken(request));
        json(response, 200, { data: await auth.bindWechat(session.user.id, await body(request), clientAddress(request)) }); return;
      }
      const publicRoute = path === '/api/v1/health' || path === '/api/v1/plans' || path === '/api/v1/billing/payment-methods';
      const service = publicRoute ? baseService : baseService.forUser((await auth.authenticate(sessionToken(request))).user.id);
      const career = new CareerService(service.store, service.userId, options.careerCatalogPath);
      let match: RegExpMatchArray | null;
      if (path === '/api/v1/health') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: { status: 'ok', analysisEngine: service.provider.name, aiConfigured: service.provider.name === 'bailian', ...(service.provider.model ? { model: service.provider.model } : {}), persistence: 'local-json' } });
      } else if (path === '/api/v1/membership') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await payments.membership(service.userId) });
      } else if (path === '/api/v1/membership/quota') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await jobs.quota.current(service.userId) });
      } else if (path === '/api/v1/plans') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: payments.plans() });
      } else if (path === '/api/v1/billing/payment-methods') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: payments.methods() });
      } else if (path === '/api/v1/billing/checkout') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 201, { data: await payments.checkout(service.userId, await body(request)) });
      } else if (path === '/api/v1/billing/quote') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const planId = url.searchParams.get('planId');
        if (!planId || [...url.searchParams.keys()].some(key => key !== 'planId')) throw new HttpError(400, 'VALIDATION_ERROR', '请提供有效的方案标识。');
        json(response, 200, { data: await payments.quote(service.userId, planId as never) });
      } else if ((match = path.match(/^\/api\/v1\/billing\/orders\/([^/]+)$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await payments.getOrder(service.userId, decodeURIComponent(match[1])) });
      } else if (path === '/api/v1/career') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await career.workspace() });
      } else if (path === '/api/v1/career/companies') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const input = validateCompanySearchParams(url.searchParams);
        json(response, 200, { data: searchCompanies(await companies.load(), input) });
      } else if (path === '/api/v1/career/assistant') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (url.searchParams.size) throw new HttpError(400, 'VALIDATION_ERROR', '求职助手不接受查询参数。');
        json(response, 200, { data: await answerCareerAssistant(service, companies, await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/career\/companies\/([^/]+)$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (url.searchParams.size) throw new HttpError(400, 'VALIDATION_ERROR', '企业详情不接受查询参数。');
        let id: string;
        try { id = decodeURIComponent(match[1]); } catch { throw new HttpError(400, 'VALIDATION_ERROR', '企业 ID 格式无效。'); }
        json(response, 200, { data: await companies.get(validateCompanyId(id)) });
      } else if (path === '/api/v1/career/jobs') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 201, { data: await career.createJob(await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/career\/jobs\/([^/]+)$/))) {
        if (method !== 'DELETE') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await career.deleteJob(match[1]) });
      } else if ((match = path.match(/^\/api\/v1\/career\/favorites\/([^/]+)$/))) {
        if (method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await career.favorite(match[1], await body(request)) });
      } else if (path === '/api/v1/career/applications') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 201, { data: await career.createApplication(await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/career\/applications\/([^/]+)$/))) {
        if (method === 'PUT' || method === 'PATCH') json(response, 200, { data: await career.updateApplication(match[1], await body(request)) });
        else if (method === 'DELETE') json(response, 200, { data: await career.deleteApplication(match[1], await body(request)) });
        else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
      } else if ((match = path.match(/^\/api\/v1\/resumes\/([^/]+)\/versions\/([^/]+)\/restore$/))) {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await service.restoreVersion(match[1], validateVersionRevision(match[2]), await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/resumes\/([^/]+)\/versions\/([^/]+)$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await service.getVersion(match[1], validateVersionRevision(match[2])) });
      } else if ((match = path.match(/^\/api\/v1\/resumes\/([^/]+)\/versions$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await service.listVersions(match[1]) });
      } else if ((match = path.match(/^\/api\/v1\/resumes\/([^/]+)\/export$/))) {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const input = await body(request);
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try { json(response, 200, { data: await exportResume(service, match[1], input, controller.signal) }); }
        finally { response.off('close', cancel); }
      } else if (path === '/api/v1/resumes') {
        if (method === 'GET') json(response, 200, { data: await service.listResumes() });
        else if (method === 'POST') json(response, 201, { data: await service.createResume(await body(request)) });
        else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
      } else if ((match = path.match(/^\/api\/v1\/resumes\/([^/]+)\/analyses$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await service.listAnalyses(match[1]) });
      } else if ((match = path.match(/^\/api\/v1\/resumes\/([^/]+)$/))) {
        if (method === 'GET') json(response, 200, { data: await service.getResume(match[1]) });
        else if (method === 'PATCH' || method === 'PUT') json(response, 200, { data: await service.updateResume(match[1], await body(request)) });
        else if (method === 'DELETE') json(response, 200, { data: await service.deleteResume(match[1]) });
        else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
      } else if (path === '/api/v1/analysis-jobs') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 202, { data: await jobs.start(await body(request), service) });
      } else if ((match = path.match(/^\/api\/v1\/analysis-jobs\/([^/]+)$/))) {
        if (method === 'GET') json(response, 200, { data: await jobs.get(match[1], service) });
        else if (method === 'DELETE') json(response, 200, { data: await jobs.cancel(match[1], service) });
        else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
      } else if (path === '/api/v1/analyses') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (service.provider.name === 'bailian') throw new HttpError(400, 'USE_ANALYSIS_JOB', '真实 AI 诊断请使用 analysis-jobs 接口，以便查询状态与取消。');
        json(response, 201, { data: await service.analyze(await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/analyses\/([^/]+)\/suggestions\/([^/]+)\/apply$/))) {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await service.applySuggestion(match[1], match[2], await body(request, true)) });
      } else if ((match = path.match(/^\/api\/v1\/analyses\/([^/]+)$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await service.getAnalysis(match[1]) });
      } else {
        throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
      }
    } catch (error) {
      if (error instanceof HttpError) json(response, error.status, { error: { code: error.code, message: error.message } });
      else {
        // Parsing or provider errors can embed private text in their message; keep logs free of request content.
        console.error('[resume-api] internal failure', error instanceof Error ? error.name : 'UnknownError');
        json(response, 500, { error: { code: 'INTERNAL_ERROR', message: '本地服务暂时无法完成请求，请检查服务日志。' } });
      }
    }
  });
}
