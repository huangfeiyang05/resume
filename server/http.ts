import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { CareerFiles } from './career-files.js';
import { careerFileTypes, isCareerFileFormat, type CareerAttachment } from '../shared/career-attachment.js';
import { HttpError } from './errors.js';
import { JsonStore } from './store.js';
import { ResumeService } from './service.js';
import { limits, validateVersionRevision } from './validation.js';
import { PaymentService } from './payments.js';
import { AdminRefunds } from './refunds.js';
import { AdminPricing } from './admin-pricing.js';
import { testPaymentGateway } from './test-payment.js';
import type { WechatPayGateway } from './wechat-pay.js';
import type { AlipayGateway } from './alipay.js';
import type { BillingPricing } from './payment-config.js';
import { AnalysisJobs } from './jobs.js';
import { adminSessionTtlMs, AuthService } from './auth.js';
import { adminOrders, adminOverview, adminTasks, adminUsers, parseAdminOrderQuery, parseAdminQuery } from './admin.js';
import { AdminCareerContent } from './admin-career-content.js';
import { careerContentKind } from './career-content-storage.js';
import { careerId } from './career-validation.js';
import { isIP } from 'node:net';
import { CareerService } from './career.js';
import { exportResume } from './exports.js';
import { dirname, join } from 'node:path';
import { CompanyCatalogRepository } from './company-catalog.js';
import { CompanyBatches } from './company-batches.js';
import { validateCompanyId, validateCompanySearchParams } from './company-validation.js';
import { searchCompanies } from './company-search.js';
import { answerCareerAssistant } from './career-assistant.js';
import { assertWorkbenchFeature, getWorkbenchAccess } from './workbench-access.js';
import type { CareerWorkspace } from '../shared/types.js';

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Authorization' });
  response.end(JSON.stringify(value));
}

function text(response: ServerResponse, status: number, value: string) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(value);
}

/** A single byte range supports seeking without caching private videos. */
function videoRange(header: string, bytes: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!match[1]) return last > 0 ? { start: Math.max(0, bytes - last), end: bytes - 1 } : null;
  const end = match[2] ? Math.min(last, bytes - 1) : bytes - 1;
  return first <= end ? { start: first, end } : null;
}

async function sendCareerFile(request: IncomingMessage, response: ServerResponse, files: CareerFiles,
  { id, format, fileName, bytes: size }: Pick<CareerAttachment, 'id' | 'format'> & Partial<CareerAttachment>) {
  const { handle, bytes } = await files.file(id, format, size);
  try {
    const name = fileName ? `; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}` : '';
    const video = format === 'mp4';
    const range = video && request.headers.range && !request.headers['if-range'] ? videoRange(request.headers.range, bytes) : undefined;
    const headers = {
      'Content-Type': careerFileTypes[format], 'Content-Disposition': `${video ? 'inline' : 'attachment'}${name}`,
      'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', Vary: 'Cookie, Authorization',
      ...(video ? { 'Accept-Ranges': 'bytes' } : {}),
    };
    if (range === null) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes}`, 'Content-Length': 0 }).end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      ...headers, 'Content-Length': range ? range.end - range.start + 1 : bytes,
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes}` } : {}),
    });
    if (request.method === 'HEAD') response.end();
    else await pipeline(handle.createReadStream(range), response);
  } catch { response.destroy(); }
  finally { await handle.close().catch(() => undefined); }
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
  adminUserIds?: ReadonlySet<string>;
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
const adminPath = '/api/v1/admin';
function cookieToken(request: IncomingMessage, name: string) {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}
/** The HTTP boundary always authenticates business requests before selecting a user's scope. */
export function createApiServer(baseService = new ResumeService(new JsonStore()), options: ApiServerOptions = {}) {
  const environment = baseService.store.environment;
  const test = environment === 'test';
  if (test && (options.paymentGateway || options.paymentAlipay)) throw new Error('Test environment cannot use real payment gateways.');
  const alipay = test ? testPaymentGateway : options.paymentAlipay;
  const cookieName = test ? 'youfang_test_session' : 'youfang_session';
  const adminCookieName = test ? 'youfang_test_admin' : 'youfang_admin';
  function sessionToken(request: IncomingMessage) {
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ') ? authorization.slice(7) : cookieToken(request, cookieName);
  }
  const auth = options.auth ?? new AuthService(baseService.store);
  const careerFiles = new CareerFiles(baseService.store.path);
  const careerContent = new AdminCareerContent(baseService.store, options.careerCatalogPath, careerFiles);
  const jobs = new AnalysisJobs(baseService);
  const payments = new PaymentService({
    store: baseService.store, quota: jobs.quota, ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(options.paymentGateway ? { gateway: options.paymentGateway } : {}),
    ...(alipay ? { alipay } : {}),
    ...(options.paymentAppid ? { appid: options.paymentAppid } : {}),
    ...(options.paymentMchid ? { mchid: options.paymentMchid } : {}),
    ...(options.paymentNotifyUrl ? { notifyUrl: options.paymentNotifyUrl } : {}),
  });
  const refunds = new AdminRefunds(baseService.store, {
    wechat: options.paymentGateway, alipay, notifyUrl: options.paymentNotifyUrl,
  });
  const pricing = new AdminPricing(baseService.store, options.pricing, environment);
  // Shared company reference data requires a currently effective trusted membership.
  const companies = new CompanyCatalogRepository(options.companyCatalogPath ?? join(dirname(baseService.store.path), 'company-catalog.json'));
  const companyBatches = new CompanyBatches(companies);
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const trustedOrigins = new Set(options.trustedOrigins ?? ['http://127.0.0.1:5173', 'http://localhost:5173']);
  const cookie = (token: string, maxAge: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const adminCookie = (token: string, maxAge: number) => `${adminCookieName}=${token}; Path=${adminPath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
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
  async function handleAdmin(request: IncomingMessage, response: ServerResponse, path: string, method: string) {
    const token = cookieToken(request, adminCookieName);
    if (path === '/logout' && method === 'POST') {
      await auth.logout(token, 'admin');
      response.setHeader('Set-Cookie', adminCookie('', 0));
      json(response, 200, { data: { signedOut: true } });
      return;
    }
    const allowed = options.adminUserIds;
    if (!allowed?.size) throw new HttpError(503, 'ADMIN_NOT_CONFIGURED', '管理后台尚未配置管理员。');
    if (path === '/login' && method === 'POST') {
      const result = await auth.login(await body(request), clientAddress(request), allowed);
      response.setHeader('Set-Cookie', adminCookie(result.token, adminSessionTtlMs / 1000));
      json(response, 200, { data: { expiresAt: result.session.expiresAt } });
      return;
    }
    const { user } = await auth.authenticate(token, 'admin');
    if (!allowed.has(user.id) || !user.emailVerified || !user.hasPassword) {
      throw new HttpError(403, 'ADMIN_FORBIDDEN', '此账号没有管理权限。');
    }
    if (path === '/company-batches' && method === 'GET') {
      json(response, 200, { data: await companyBatches.state() });
      return;
    }
    const companyToEdit = path.match(/^\/company-batches\/records\/([A-Za-z0-9_-]+)$/);
    if (companyToEdit && method === 'GET') {
      json(response, 200, { data: await companyBatches.editDetail(companyToEdit[1]) });
      return;
    }
    if (method === 'POST' && ['/company-batches/chunk', '/company-batches/preview', '/company-batches/report', '/company-batches/rollback-preview',
      '/company-batches/apply', '/company-batches/records/search', '/company-batches/edit-preview'].includes(path)) {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求体。');
      }
      const input = await body(request);
      const data = path.endsWith('/chunk') ? companyBatches.chunk(input, user.id)
        : path.endsWith('/preview') ? await companyBatches.preview(input, user.id)
        : path.endsWith('/report') ? companyBatches.reviewReport(input, user.id)
        : path.endsWith('/rollback-preview') ? await companyBatches.previewRollback(input, user.id)
        : path.endsWith('/search') ? await companyBatches.searchForEdit(input)
        : path.endsWith('/edit-preview') ? await companyBatches.previewEdit(input, user.id)
        : await companyBatches.apply(input, user.id);
      json(response, 200, { data });
      return;
    }
    const uploadedFile = path.match(/^\/career-files\/([a-f0-9]{64})\.([a-z0-9]+)$/);
    if (uploadedFile && isCareerFileFormat(uploadedFile[2]) && (method === 'GET' || method === 'HEAD')) {
      await sendCareerFile(request, response, careerFiles, { id: uploadedFile[1], format: uploadedFile[2] });
      return;
    }
    if (method === 'POST' && ['/career-files/chunk', '/career-files/finish', '/career-files/cancel'].includes(path)) {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求体。');
      }
      const input = await body(request);
      const data = path.endsWith('/chunk') ? careerFiles.chunk(input, user.id)
        : path.endsWith('/finish') ? await careerFiles.finish(input, user.id) : careerFiles.cancel(input, user.id);
      json(response, 200, { data });
      return;
    }
    const contentRoute = path.match(/^\/career-content\/([^/]+)\/([A-Za-z0-9_-]+)(?:\/(draft|preview|apply))?$/);
    if (path === '/career-content' && method === 'GET') {
      json(response, 200, { data: await careerContent.list() });
    } else if (contentRoute) {
      const target = { kind: careerContentKind(contentRoute[1]), id: careerId(contentRoute[2]) };
      const operation = contentRoute[3];
      if (!operation && method === 'GET') {
        json(response, 200, { data: await careerContent.detail(target) });
      } else if (operation && method === 'POST') {
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求体。');
        }
        const input = await body(request);
        const data = operation === 'draft' ? await careerContent.saveDraft(target, input, user.id)
          : operation === 'preview' ? await careerContent.preview(target, input) : await careerContent.apply(target, input, user.id);
        json(response, 200, { data });
      } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
    } else if (path === '/overview' && method === 'GET') {
      json(response, 200, { data: adminOverview(await baseService.store.read(), Date.now()) });
    } else if (path === '/pricing' && method === 'GET') {
      json(response, 200, { data: await pricing.state() });
    } else if ((path === '/pricing/preview' || path === '/pricing/apply') && method === 'POST') {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求体。');
      }
      const input = await body(request);
      json(response, 200, { data: path === '/pricing/preview' ? await pricing.preview(input, user.id) : await pricing.apply(input, user.id) });
    } else if (method === 'POST' && ['/orders/search', '/orders/refund-preview', '/orders/refund-apply', '/orders/refund-refresh'].includes(path)) {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求体。');
      }
      const input = await body(request);
      const data = path === '/orders/search' ? adminOrders(await baseService.store.read(), parseAdminOrderQuery(input), channel => refunds.available(channel))
        : path === '/orders/refund-preview' ? await refunds.preview(input, user.id)
        : path === '/orders/refund-apply' ? await refunds.apply(input, user.id)
        : await refunds.refresh(input);
      json(response, 200, { data });
    } else if ((path === '/users/search' || path === '/tasks/search') && method === 'POST') {
      const query = parseAdminQuery(await body(request), path === '/users/search' ? 'users' : 'tasks');
      const database = await baseService.store.read();
      json(response, 200, { data: path === '/users/search'
        ? adminUsers(database, query.query, query.page, Date.now()) : adminTasks(database, query) });
    } else {
      throw new HttpError(404, 'NOT_FOUND', '管理接口不存在。');
    }
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/$/, '');
      const method = request.method ?? 'GET';
      assertWriteOrigin(request);
      if (path === adminPath || path.startsWith(`${adminPath}/`)) {
        if (url.searchParams.size) throw new HttpError(400, 'VALIDATION_ERROR', '管理接口不接受 URL 查询参数。');
        await handleAdmin(request, response, path.slice(adminPath.length), method);
        return;
      }
      if (path === '/api/v1/environment' && method === 'GET') {
        json(response, 200, { data: { environment } }); return;
      }
      if ((test && ['/api/v1/billing/wechat/notify', '/api/v1/billing/wechat/refund-notify', '/api/v1/billing/alipay/notify'].includes(path))
        || (!test && path === '/api/v1/billing/simulate')) {
        throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
      }
      if (path === '/api/v1/billing/wechat/notify') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const raw = await rawBody(request);
        json(response, 200, await payments.applyNotification(request.headers, raw)); return;
      }
      if (path === '/api/v1/billing/wechat/refund-notify') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        await refunds.wechatNotification(request.headers, await rawBody(request));
        response.writeHead(204).end();
        return;
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
      } else if (path === '/api/v1/membership/workbench') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (url.searchParams.size) throw new HttpError(400, 'VALIDATION_ERROR', '工作台会员权限不接受查询参数。');
        json(response, 200, { data: await getWorkbenchAccess(service.store, service.userId) });
      } else if (path === '/api/v1/plans') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await payments.plans() });
      } else if (path === '/api/v1/billing/payment-methods') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: payments.methods() });
      } else if (path === '/api/v1/billing/checkout') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (test) throw new HttpError(409, 'TEST_CHECKOUT_ONLY', '测试环境仅支持模拟支付。');
        json(response, 201, { data: await payments.checkout(service.userId, await body(request)) });
      } else if (path === '/api/v1/billing/simulate' && test) {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 201, { data: await payments.simulateCheckout(service.userId, await body(request)) });
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
        const access = await getWorkbenchAccess(service.store, service.userId);
        const workspace: CareerWorkspace = access.features.companyJobs ? await career.workspace() : {
          mode: 'preview', externalDeliveryAvailable: false, catalogState: 'empty',
          catalogMessage: '升级高级会员解锁公司岗位、招聘入口、复习资料和投递计划。',
          jobs: [], materials: [], portals: [], favoriteJobIds: [], applications: [],
        };
        json(response, 200, { data: workspace });
      } else if ((match = path.match(/^\/api\/v1\/career\/materials\/([A-Za-z0-9_-]+)\/file\/([a-f0-9]{64})$/))) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        await assertWorkbenchFeature(service.store, service.userId, 'studyMaterials');
        const file = await career.materialFile(careerId(match[1]), match[2]);
        await sendCareerFile(request, response, careerFiles, file);
      } else if (path === '/api/v1/career/companies') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        const input = validateCompanySearchParams(url.searchParams);
        await assertWorkbenchFeature(service.store, service.userId, 'companyJobs');
        json(response, 200, { data: searchCompanies(await companies.load(), input) });
      } else if (path === '/api/v1/career/assistant') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (url.searchParams.size) throw new HttpError(400, 'VALIDATION_ERROR', '求职助手不接受查询参数。');
        await assertWorkbenchFeature(service.store, service.userId, 'careerAssistant');
        json(response, 200, { data: await answerCareerAssistant(service, companies, await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/career\/companies\/([^/]+)$/))) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        if (url.searchParams.size) throw new HttpError(400, 'VALIDATION_ERROR', '企业详情不接受查询参数。');
        let id: string;
        try { id = decodeURIComponent(match[1]); } catch { throw new HttpError(400, 'VALIDATION_ERROR', '企业 ID 格式无效。'); }
        const companyId = validateCompanyId(id);
        await assertWorkbenchFeature(service.store, service.userId, 'companyJobs');
        json(response, 200, { data: await companies.get(companyId) });
      } else if (path === '/api/v1/career/jobs') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        await assertWorkbenchFeature(service.store, service.userId, 'companyJobs');
        json(response, 201, { data: await career.createJob(await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/career\/jobs\/([^/]+)$/))) {
        if (method !== 'DELETE') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        json(response, 200, { data: await career.deleteJob(match[1]) });
      } else if ((match = path.match(/^\/api\/v1\/career\/favorites\/([^/]+)$/))) {
        if (method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        await assertWorkbenchFeature(service.store, service.userId, 'companyJobs');
        json(response, 200, { data: await career.favorite(match[1], await body(request)) });
      } else if (path === '/api/v1/career/applications') {
        if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法。');
        await assertWorkbenchFeature(service.store, service.userId, 'applications');
        json(response, 201, { data: await career.createApplication(await body(request)) });
      } else if ((match = path.match(/^\/api\/v1\/career\/applications\/([^/]+)$/))) {
        if (method === 'PUT' || method === 'PATCH') {
          await assertWorkbenchFeature(service.store, service.userId, 'applications');
          json(response, 200, { data: await career.updateApplication(match[1], await body(request)) });
        }
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
  server.on('listening', () => { void refunds.recover().catch(() => console.error('[resume-api] refund recovery unavailable')); });
  server.on('close', () => refunds.stop());
  return server;
}
