// Command-line checks against compiled artifacts and an isolated temporary database.
// No real accounts, SMTP, SMS, model calls, production writes, browser or visual checks.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const releaseRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const load = file => import(pathToFileURL(join(releaseRoot, 'api/server', file)).href);
const [{ createApiServer }, { ResumeService }, { JsonStore }, { QuotaService }, { AuthService }, { PhoneCodeService }] = await Promise.all([load('http.js'), load('service.js'), load('store.js'), load('quota.js'), load('auth.js'), load('phone-codes.js')]);
const catalog = JSON.parse(await readFile(join(releaseRoot, 'api/server/assets/career/catalog.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'youfang-release-check-'));
const store = new JsonStore(join(directory, 'isolated.json'));
let fixtureTime = Date.now();
const smsMessages = [];
const phoneCodes = new PhoneCodeService(store, { enabled: true, async sendCode(input) { smsMessages.push(input); } }, { secret: 'release-fixture-sms-secret-more-than-32-bytes', now: () => fixtureTime });
const auth = new AuthService(store, { phoneCodes, now: () => fixtureTime, requireEmailVerification: false });
const adminIds = new Set();
const refundCalls = [];
const fakeAlipay = {
  async createPayment() { throw new Error('The release verifier never creates an actual checkout.'); },
  parseNotification() { throw new Error('The release verifier never uses a real payment notification.'); },
  async submitRefund(target) { refundCalls.push(target); return 'succeeded'; },
  async queryRefund() { throw new Error('The synthetic refund completed synchronously.'); },
};
const server = createApiServer(new ResumeService(store), { secureCookies: false, auth, adminUserIds: adminIds, paymentAlipay: fakeAlipay });
const checks = [];
function fixtureVideo() {
  const box = (type, ...parts) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + parts.reduce((size, part) => size + part.length, 0));
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, ...parts]);
  };
  const handler = Buffer.alloc(12), sampleTable = Buffer.alloc(8);
  handler.write('vide', 8);
  sampleTable.writeUInt32BE(1, 4);
  const config = box('avcC', Buffer.from([1, 66, 0, 30, 255, 224, 0]));
  const descriptions = box('stsd', sampleTable, box('avc1', Buffer.alloc(78), config));
  const media = box('mdia', box('hdlr', handler), box('minf', box('stbl', descriptions)));
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('moov', box('trak', media)), box('mdat', Buffer.from('synthetic'))]);
}
try {
  // The existing server serves .js as JavaScript; .mjs can be octet-stream and blocked by nosniff.
  const assetNames = await readdir(join(releaseRoot, 'www/assets'));
  const pdfWorkers = assetNames.filter(name => /^pdf\.worker.*\.js$/.test(name));
  assert.equal(pdfWorkers.length, 1, 'PDF worker must be emitted as a JavaScript asset');
  assert.equal(assetNames.some(name => /^pdf\.worker.*\.mjs$/.test(name)), false);
  const scripts = await Promise.all(assetNames.filter(name => name.endsWith('.js') && !pdfWorkers.includes(name))
    .map(name => readFile(join(releaseRoot, 'www/assets', name), 'utf8')));
  assert.ok(scripts.some(script => script.includes(pdfWorkers[0])), 'PDF parser must reference the emitted worker');
  checks.push('pdf-worker-module-has-javascript-extension-and-reference');
  const adminPage = await readFile(join(releaseRoot, 'www/admin/index.html'), 'utf8');
  const adminScript = adminPage.match(/src="\/admin\/(assets\/[^"]+\.js)"/)?.[1];
  assert.ok(adminScript, 'Admin entry must load its own compiled script under /admin/');
  assert.ok((await readFile(join(releaseRoot, 'www/admin', adminScript), 'utf8')).includes('/api/v1/admin/'));
  checks.push('admin-static-entry-and-script');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(route, method = 'GET', input, cookie) {
    const response = await fetch(`${base}${route}`, {
      method, headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function account() {
    const credentials = { email: `deployment-${randomUUID()}@example.test`, password: 'Smoke26!Pass' };
    const result = await request('/auth/register', 'POST', credentials);
    assert.equal(result.status, 201);
    return { credentials, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  for (const path of ['/resumes', '/career', '/career/companies', '/membership', '/membership/quota', '/membership/workbench']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/career/assistant', 'POST', { requirements: '', message: '查找企业' })).status, 401);
  checks.push('private-routes-require-session');
  assert.equal((await request('/admin/overview')).body.error.code, 'ADMIN_NOT_CONFIGURED');
  checks.push('admin-disabled-without-allowlist');
  const operator = await account(), owner = operator.cookie, { cookie: other } = await account(), { cookie: quotaAccount } = await account();
  const { renderResumeFile } = await load('export-renderer.js');
  const { RESUME_IMPORT_CHUNK_BYTES } = await load('../shared/resume-import.js');
  const sample = {
    id: 'import-fixture', title: '导入测试', targetRole: '', text: '项目经历\n核对简历正文。', revision: 1,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
  };
  assert.equal((await request('/resume-imports', 'POST', { fileName: 'sample.pdf', size: 8 })).status, 401);
  for (const format of ['docx', 'pdf']) {
    const bytes = await renderResumeFile(sample, format, 'minimal');
    const fileName = `导入测试.${format}`;
    const started = await request('/resume-imports', 'POST', { fileName, size: bytes.length }, owner);
    assert.equal(started.status, 201);
    const route = `/resume-imports/${started.body.data.id}`;
    assert.equal((await request(`${route}/parse`, 'POST', undefined, other)).status, 404);
    for (let offset = 0; offset < bytes.length; offset += RESUME_IMPORT_CHUNK_BYTES) {
      const contentBase64 = bytes.subarray(offset, offset + RESUME_IMPORT_CHUNK_BYTES).toString('base64');
      assert.equal((await request(`${route}/chunks`, 'PUT', { offset, contentBase64 }, owner)).status, 200);
    }
    const parsed = await request(`${route}/parse`, 'POST', undefined, owner);
    assert.equal(parsed.status, 200, JSON.stringify(parsed.body.error));
    assert.equal(parsed.body.data.fileName, fileName);
    assert.match(parsed.body.data.text, /核对简历正文。/);
    assert.equal((await request(route, 'DELETE', undefined, owner)).status, 404);
  }
  assert.deepEqual((await request('/resumes', 'GET', undefined, owner)).body.data, []);
  checks.push('wechat-import-owner-only-word-pdf-parser-no-implicit-save');
  const preview = await request('/membership', 'GET', undefined, owner);
  assert.equal(preview.body.data.quota.status, 'preview');
  assert.equal(preview.body.data.quota.remainingPercent, null);
  const freeAccess = await request('/membership/workbench', 'GET', undefined, owner);
  assert.equal(freeAccess.body.data.planId, 'free');
  assert.ok(Object.values(freeAccess.body.data.features).every(value => value === false));
  const lockedWorkspace = await request('/career', 'GET', undefined, owner);
  for (const key of ['jobs', 'materials', 'portals', 'favoriteJobIds', 'applications']) assert.deepEqual(lockedWorkspace.body.data[key], []);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).status, 403);
  assert.equal((await request('/career/assistant', 'POST', { message: '查找企业', planId: 'premium' }, owner)).status, 403);
  const userId = (await request('/auth/me', 'GET', undefined, owner)).body.data.user.id;
  const quotaUserId = (await request('/auth/me', 'GET', undefined, quotaAccount)).body.data.user.id;
  const quota = new QuotaService(store);
  // Trusted synthetic events affect only this isolated database, never a provider or production account.
  for (const cookie of [owner, other, quotaAccount]) {
    const fixtureUserId = (await request('/auth/me', 'GET', undefined, cookie)).body.data.user.id;
    await quota.activateMembership({ userId: fixtureUserId, planId: cookie === quotaAccount ? 'basic' : 'premium', verifiedPaymentAt: new Date().toISOString(), verifiedEventId: `fixture-${randomUUID()}`, idempotencyKey: `fixture-${randomUUID()}` });
  }
  const basicAccess = (await request('/membership/workbench', 'GET', undefined, quotaAccount)).body.data;
  assert.equal(basicAccess.planId, 'basic');
  assert.equal(basicAccess.features.resumeOptimization, true);
  assert.equal(basicAccess.features.careerAssistant, false);
  assert.equal((await request('/career/companies', 'GET', undefined, quotaAccount)).status, 403);
  assert.deepEqual((await request('/career', 'GET', undefined, quotaAccount)).body.data.materials, []);
  const premiumAccess = (await request('/membership/workbench', 'GET', undefined, owner)).body.data;
  assert.equal(premiumAccess.planId, 'premium');
  assert.ok(Object.values(premiumAccess.features).every(value => value === true));
  checks.push('trusted-workbench-tiers-and-no-locked-content-leakage');
  const companies = await request('/career/companies', 'GET', undefined, owner);
  assert.equal(companies.status, 200);
  assert.equal(companies.body.data.access, 'authenticated-test');
  assert.equal(companies.body.data.catalogState, 'empty');
  assert.equal(companies.body.data.total, 0);
  assert.deepEqual(companies.body.data.items, []);
  assert.equal((await request('/career/companies?page=0', 'GET', undefined, owner)).status, 400);
  assert.equal((await request('/career/companies/missing-company', 'GET', undefined, owner)).status, 404);
  checks.push('premium-company-access-honest-empty-state-and-query-validation');
  const workspace = await request('/career', 'GET', undefined, owner);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.data.catalogState, 'ready');
  assert.ok(catalog.materials.length > 0 && catalog.jobs.length > 0);
  assert.deepEqual(workspace.body.data.materials, catalog.materials);
  assert.deepEqual(workspace.body.data.portals, []);
  assert.deepEqual(workspace.body.data.jobs, [...catalog.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  assert.equal(workspace.body.data.externalDeliveryAvailable, false);
  checks.push('bundled-materials-and-sourced-jobs-without-legacy-portals');
  const sourcedJob = workspace.body.data.jobs.find(job => job.id === 'poizon-7670431050971711798');
  assert.equal(sourcedJob?.audience, 'campus');
  assert.ok(sourcedJob.sourceUrl.startsWith('https://'));
  // Use a just-reviewed isolated fixture so this verifier remains valid after the bundled records age.
  const sourceOverride = join(directory, 'career-catalog.json');
  await writeFile(sourceOverride, JSON.stringify({ ...catalog, jobs: [{ ...sourcedJob, checkedAt: new Date().toISOString() }] }));
  try {
    const sourced = await request('/career/assistant', 'POST', { message: '找上海2027届校招供应链岗位', requirements: '' }, owner);
    assert.equal(sourced.status, 200);
    assert.deepEqual(sourced.body.data.officialJobs.map(job => job.id), [sourcedJob.id]);
  } finally { await rm(sourceOverride, { force: true }); }
  const applicant = await request('/resumes', 'POST', {
    title: '合成供应链验收', targetRole: '供应链规划运营',
    text: '项目经历\n参与库存盘点，使用 Excel 核对出入库台账。',
  }, owner);
  assert.equal(applicant.status, 201);
  const evidenceReport = await request('/analyses', 'POST', {
    resumeId: applicant.body.data.id, resumeRevision: 1, jobDescription: sourcedJob.description,
  }, owner);
  assert.equal(evidenceReport.status, 201);
  assert.equal(evidenceReport.body.data.engine, 'rules');
  assert.equal(evidenceReport.body.data.roleGuide.id, 'supply-chain-logistics');
  assert.equal(evidenceReport.body.data.jobReview.items[0].priority, 'eligibility');
  assert.ok(evidenceReport.body.data.jobReview.items.flatMap(item => item.evidence)
    .some(item => item.term === 'Excel' && item.excerpt?.includes('核对出入库台账')));
  assert.equal((await request(`/resumes/${applicant.body.data.id}`, 'DELETE', undefined, owner)).status, 200);
  checks.push('official-job-search-and-source-backed-jd-evidence');
  adminIds.add(userId);
  await store.mutate(data => { data.users.find(user => user.id === userId).emailVerified = true; });
  assert.equal((await request('/admin/career-content', 'GET', undefined, owner)).status, 401);
  const signedIn = await request('/admin/login', 'POST', operator.credentials);
  assert.equal(signedIn.status, 200);
  const admin = signedIn.headers.get('set-cookie').split(';')[0];
  const ordersPath = '/admin/orders/search';
  const orderTime = new Date().toISOString();
  const tradeId = 'synthetic-alipay-transaction';
  const renewal = await quota.activateMembership({ userId, planId: 'premium', verifiedPaymentAt: orderTime,
    verifiedEventId: tradeId, idempotencyKey: `alipay:${tradeId}` });
  const fixtureOrder = { id: randomUUID(), userId, planId: 'premium', status: 'paid', channel: 'alipay-wap',
    amountCents: 4200, createdAt: orderTime, paidAt: orderTime,
    expiresAt: new Date(Date.parse(orderTime) + 2 * 60 * 60_000).toISOString(),
    outTradeNo: 'YF20261109000000000001', description: '合成验收订单', transactionId: tradeId, paymentEventId: tradeId };
  await store.mutate(data => data.orders.push(fixtureOrder));
  const orderBefore = await readFile(store.path);
  const orderLookup = { query: fixtureOrder.outTradeNo, status: 'paid', channel: 'alipay-wap' };
  assert.equal((await request(ordersPath, 'POST', orderLookup, owner)).status, 401);
  const checkedOrder = await request(ordersPath, 'POST', orderLookup, admin);
  assert.equal(checkedOrder.status, 200);
  assert.deepEqual(checkedOrder.body.data, { page: 1, pageSize: 20, total: 1, items: [{
    id: fixtureOrder.id, userId, planId: 'premium', status: 'paid', channel: 'alipay-wap', amountCents: 4200,
    createdAt: orderTime, paidAt: orderTime, expiresAt: fixtureOrder.expiresAt,
    membershipActivation: { kind: 'renewal', startsAt: renewal.startsAt, expiresAt: renewal.expiresAt },
    refundable: true,
  }] });
  assert.equal((await request(ordersPath, 'POST', { ...orderLookup, userId: quotaUserId }, admin)).body.data.total, 0);
  assert.deepEqual(await readFile(store.path), orderBefore);
  checks.push('admin-order-search-reads-verified-historical-activation-without-mutation');

  const contacts = await request('/admin/users/search', 'POST', { query: userId }, admin);
  assert.deepEqual(contacts.body.data.items[0].email, { address: operator.credentials.email, verified: true });
  assert.equal(contacts.body.data.items[0].phone, null);
  const refundInput = { orderId: fixtureOrder.id };
  assert.equal((await request('/admin/orders/refund-preview', 'POST', refundInput, owner)).status, 401);
  const reviewRefund = await request('/admin/orders/refund-preview', 'POST', refundInput, admin);
  assert.equal(reviewRefund.status, 200);
  assert.equal(reviewRefund.body.data.amountCents, fixtureOrder.amountCents);
  assert.equal(reviewRefund.body.data.before.expiresAt, renewal.expiresAt);
  assert.equal(reviewRefund.body.data.after.expiresAt, premiumAccess.expiresAt);
  const applyRefund = { ...refundInput, previewId: reviewRefund.body.data.id, confirmed: true };
  assert.equal((await request('/admin/orders/refund-apply', 'POST', { ...applyRefund, amountCents: 1 }, admin)).status, 400);
  assert.equal(refundCalls.length, 0);
  const appliedRefund = await request('/admin/orders/refund-apply', 'POST', applyRefund, admin);
  assert.equal(appliedRefund.status, 200);
  assert.equal(appliedRefund.body.data.status, 'succeeded');
  assert.deepEqual((await request('/admin/orders/refund-apply', 'POST', applyRefund, admin)).body.data, appliedRefund.body.data);
  assert.deepEqual(refundCalls, [{ id: reviewRefund.body.data.id, outTradeNo: fixtureOrder.outTradeNo,
    transactionId: tradeId, amountCents: fixtureOrder.amountCents }]);
  assert.equal((await request('/membership/workbench', 'GET', undefined, owner)).body.data.expiresAt, premiumAccess.expiresAt);
  assert.equal((await request(ordersPath, 'POST', orderLookup, admin)).body.data.items[0].refund.status, 'succeeded');
  assert.equal((await new JsonStore(store.path).read()).version, 4);
  checks.push('admin-full-contacts-reviewed-full-refund-idempotence-and-other-paid-term-retention');

  const pricingPath = '/admin/pricing';
  assert.equal((await request(pricingPath, 'GET', undefined, owner)).status, 401);
  assert.deepEqual((await request('/environment')).body.data, { environment: 'public' });
  assert.equal((await request('/billing/simulate', 'POST', {}, owner)).status, 404);
  const beforePrices = (await request(pricingPath, 'GET', undefined, admin)).body.data;
  const priceDraft = { revision: beforePrices.revision, prices: { basicMonthlyCents: 1100, premiumMonthlyCents: 3300, premiumFirstPurchaseCents: 2700 } };
  const priceReview = await request(`${pricingPath}/preview`, 'POST', priceDraft, admin);
  assert.equal(priceReview.status, 200);
  assert.deepEqual(priceReview.body.data.before, beforePrices.prices);
  assert.equal((await request('/plans')).body.data.find(plan => plan.id === 'basic').priceCents, beforePrices.prices.basicMonthlyCents);
  const priceApply = { id: priceReview.body.data.id, confirmed: true };
  const pricePublished = await request(`${pricingPath}/apply`, 'POST', priceApply, admin);
  assert.equal(pricePublished.status, 200);
  assert.deepEqual((await request(`${pricingPath}/apply`, 'POST', priceApply, admin)).body.data, pricePublished.body.data);
  assert.equal((await request('/plans')).body.data.find(plan => plan.id === 'basic').priceCents, 1100);
  const oldAmount = { planId: 'basic', channel: 'alipay-page', requestId: 'release-quote-mismatch', expectedAmountCents: beforePrices.prices.basicMonthlyCents };
  assert.equal((await request('/billing/checkout', 'POST', oldAmount, quotaAccount)).body.error.code, 'BILLING_PRICE_CHANGED');
  assert.equal((await new JsonStore(store.path).read()).version, 5);
  checks.push('admin-reviewed-pricing-and-price-change-rejected-before-provider');

  const renewalQuote = (await request('/billing/quote?planId=premium', 'GET', undefined, owner)).body.data;
  const queuedQuote = (await request('/billing/quote?planId=basic', 'GET', undefined, owner)).body.data;
  assert.equal(renewalQuote.kind, 'renewal');
  assert.equal(queuedQuote.kind, 'scheduled');
  assert.equal(queuedQuote.amountCents, 1100);
  assert.deepEqual(queuedQuote.period, renewalQuote.period);
  assert.equal(queuedQuote.period.startsAt, premiumAccess.expiresAt);
  assert.match(queuedQuote.reviewId, /^[a-f0-9]{64}$/);
  const queuedCheckout = { ...oldAmount, expectedAmountCents: queuedQuote.amountCents };
  assert.equal((await request('/billing/checkout', 'POST', queuedCheckout, owner)).body.error.code, 'BILLING_QUOTE_REQUIRED');
  const booked = await quota.activateMembership({ userId, planId: 'basic', verifiedPaymentAt: new Date().toISOString(),
    verifiedEventId: `fixture-${randomUUID()}`, idempotencyKey: `fixture-${randomUUID()}` });
  assert.equal(booked.kind, 'scheduled');
  const withBooking = (await request('/membership', 'GET', undefined, owner)).body.data;
  assert.equal(withBooking.currentPlanId, 'premium');
  assert.equal(withBooking.quota.expiresAt, premiumAccess.expiresAt);
  assert.deepEqual(withBooking.nextPeriod, { planId: 'basic', ...queuedQuote.period });
  assert.equal((await new JsonStore(store.path).read()).version, 6);
  checks.push('renewal-dates-reviewed-and-booked-basic-term-keeps-current-premium-access');

  const { id: materialId, updatedAt: _updatedAt, ...material } = catalog.materials[0];
  const contentPath = `/admin/career-content/material/${materialId}`;
  const currentContent = async () => (await request(contentPath, 'GET', undefined, admin)).body.data;
  const currentWorkspace = async () => (await request('/career', 'GET', undefined, owner)).body.data;
  const document = await readFile(join(releaseRoot, 'www/static/resume-templates/classic-onyx.docx'));
  const uploadId = randomUUID();
  const chunk = { uploadId, index: 0, data: document.toString('base64') };
  assert.equal((await request('/admin/career-files/chunk', 'POST', chunk, admin)).body.data.receivedBytes, document.length);
  const uploaded = await request('/admin/career-files/finish', 'POST', { uploadId, fileName: '合成复习资料.docx', bytes: document.length }, admin);
  assert.equal(uploaded.status, 200);
  const attachment = uploaded.body.data;
  const filePath = `/career/materials/${materialId}/file/${attachment.id}`;
  const draft = { revision: (await currentContent()).revision, operationId: randomUUID(),
    content: { ...material, title: '合成发布验收提纲', content: '', attachment } };
  assert.deepEqual((await request(`${contentPath}/draft`, 'POST', draft, admin)).body.data, { version: 1 });
  assert.deepEqual((await currentWorkspace()).materials, catalog.materials);
  assert.equal((await request(filePath, 'GET', undefined, owner)).status, 404);
  async function releaseContent(action, sourceVersion) {
    const input = { action, sourceVersion, revision: (await currentContent()).revision };
    const review = await request(`${contentPath}/preview`, 'POST', input, admin);
    assert.equal(review.status, 200);
    const apply = { ...input, token: review.body.data.token, confirmed: true, operationId: randomUUID() };
    const result = await request(`${contentPath}/apply`, 'POST', apply, admin);
    assert.equal(result.status, 200);
    assert.deepEqual((await request(`${contentPath}/apply`, 'POST', apply, admin)).body.data, result.body.data);
  }
  await releaseContent('publish');
  assert.equal((await currentWorkspace()).materials.find(item => item.id === materialId).title, draft.content.title);
  assert.equal((await request(filePath, 'GET', undefined, quotaAccount)).status, 403);
  const savedFile = await fetch(`${base}${filePath}`, { headers: { Cookie: owner } });
  assert.equal(savedFile.status, 200);
  assert.deepEqual(Buffer.from(await savedFile.arrayBuffer()), document);
  assert.deepEqual((await request('/career', 'GET', undefined, quotaAccount)).body.data.materials, []);
  await releaseContent('restore', 0);
  assert.equal((await request(filePath, 'GET', undefined, owner)).status, 404);
  assert.deepEqual((await currentWorkspace()).materials, catalog.materials);
  assert.deepEqual((await currentContent()).history.map(entry => entry.action), ['restore', 'publish', 'draft']);
  checks.push('admin-reviewed-content-release-idempotent-restore-and-member-visibility');
  const posting = `/admin/career-content/job/${sourcedJob.id}`;
  const readPosting = async () => (await request(posting, 'GET', undefined, admin)).body.data;
  const { id: _jobId, origin: _jobOrigin, updatedAt: _jobUpdatedAt, ...editableJob } = sourcedJob;
  const jobDraft = { ...editableJob, checkedAt: new Date().toISOString(), title: '合成供应链规划运营复核' };
  assert.equal((await request(posting, 'GET', undefined, owner)).status, 401);
  assert.equal((await request(`${posting}/draft`, 'POST', { revision: (await readPosting()).revision, content: jobDraft, operationId: randomUUID() }, admin)).status, 200);
  assert.equal((await currentWorkspace()).jobs.find(job => job.id === sourcedJob.id).title, sourcedJob.title);
  async function publishJob(action, sourceVersion) {
    const input = { action, revision: (await readPosting()).revision, sourceVersion };
    const review = await request(`${posting}/preview`, 'POST', input, admin);
    assert.equal(review.status, 200);
    const apply = { ...input, token: review.body.data.token, operationId: randomUUID(), confirmed: true };
    const result = await request(`${posting}/apply`, 'POST', apply, admin);
    assert.equal(result.status, 200);
    assert.deepEqual((await request(`${posting}/apply`, 'POST', apply, admin)).body.data, result.body.data);
    return result.body.data.version;
  }
  const reviewedJobVersion = await publishJob('publish');
  assert.equal((await currentWorkspace()).jobs.find(job => job.id === sourcedJob.id).title, jobDraft.title);
  const reread = await new JsonStore(store.path).read();
  assert.equal(reread.careerJobContent[0].id, sourcedJob.id);
  await publishJob('withdraw');
  assert.equal((await currentWorkspace()).jobs.some(job => job.id === sourcedJob.id), false);
  await publishJob('restore', reviewedJobVersion);
  assert.equal((await currentWorkspace()).jobs.find(job => job.id === sourcedJob.id).title, jobDraft.title);
  checks.push('reviewed-job-publication-withdrawal-and-persisted-restore');
  const clip = fixtureVideo(), videoUploadId = randomUUID();
  const videoChunk = { uploadId: videoUploadId, index: 0, format: 'mp4', data: clip.toString('base64') };
  assert.equal((await request('/admin/career-files/chunk', 'POST', videoChunk, admin)).body.data.receivedBytes, clip.length);
  const videoUpload = await request('/admin/career-files/finish', 'POST', { uploadId: videoUploadId, fileName: '合成验收视频.mp4', bytes: clip.length }, admin);
  assert.equal(videoUpload.status, 200);
  const videoPath = `/career/materials/${materialId}/file/${videoUpload.body.data.id}`;
  const videoDraft = { revision: (await currentContent()).revision, operationId: randomUUID(),
    content: { ...material, content: '', attachment: videoUpload.body.data } };
  assert.equal((await request(`${contentPath}/draft`, 'POST', videoDraft, admin)).status, 200);
  assert.equal((await request(videoPath, 'GET', undefined, owner)).status, 404);
  await releaseContent('publish');
  const videoPart = await fetch(`${base}${videoPath}`, { headers: { Cookie: owner, Range: 'bytes=0-15' } });
  assert.equal(videoPart.status, 206);
  assert.equal(videoPart.headers.get('content-range'), `bytes 0-15/${clip.length}`);
  assert.deepEqual(Buffer.from(await videoPart.arrayBuffer()), clip.subarray(0, 16));
  assert.equal((await request(videoPath, 'GET', undefined, quotaAccount)).status, 403);
  await releaseContent('restore', 0);
  assert.equal((await request(videoPath, 'GET', undefined, owner)).status, 404);
  checks.push('career-video-protected-range-and-rollback');
  const batchPath = '/admin/company-batches';
  const csv = Buffer.from('公司名称,招聘批次,招聘链接\n合成验收单位,秋招,https://example.test/careers\n');
  const batchId = randomUUID();
  const batchChunk = { id: batchId, index: 0, data: csv.toString('base64') };
  assert.equal((await request(`${batchPath}/chunk`, 'POST', batchChunk, owner)).status, 401);
  assert.equal((await request(`${batchPath}/chunk`, 'POST', batchChunk, admin)).body.data.receivedBytes, csv.length);
  const batchPreview = await request(`${batchPath}/preview`, 'POST',
    { id: batchId, bytes: csv.length, format: 'csv', sourceTitle: '合成历史批次' }, admin);
  assert.equal(batchPreview.status, 200);
  assert.equal(batchPreview.body.data.afterCount, 1);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).body.data.total, 0);
  const publishBatch = { id: batchPreview.body.data.id, confirmed: true };
  const publishedBatch = await request(`${batchPath}/apply`, 'POST', publishBatch, admin);
  assert.equal(publishedBatch.status, 200);
  assert.deepEqual((await request(`${batchPath}/apply`, 'POST', publishBatch, admin)).body.data, publishedBatch.body.data);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).body.data.total, 1);
  assert.equal((await request('/career/companies', 'GET', undefined, quotaAccount)).status, 403);
  const batchRollback = await request(`${batchPath}/rollback-preview`, 'POST', {}, admin);
  assert.equal(batchRollback.status, 200);
  assert.equal((await request(`${batchPath}/apply`, 'POST', { id: batchRollback.body.data.id, confirmed: true }, admin)).status, 200);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).body.data.total, 0);
  checks.push('company-batch-admin-preview-idempotent-publish-and-rollback');
  const manual = { name: '合成手工录入企业', industries: '软件、教育', locations: '杭州',
    recruitmentTypes: '校招', educationLevels: '本科', recruitmentUrl: 'https://example.test/campus',
    aliases: '合成企业', nature: '民营', directions: '软件开发', cohorts: '应届毕业生', summary: '仅用于隔离发布验收。' };
  const manualBytes = Buffer.from(JSON.stringify([manual]));
  const manualId = randomUUID();
  const manualChunk = { id: manualId, index: 0, data: manualBytes.toString('base64') };
  assert.equal((await request(`${batchPath}/chunk`, 'POST', manualChunk, admin)).body.data.receivedBytes, manualBytes.length);
  const manualPreview = await request(`${batchPath}/preview`, 'POST', {
    id: manualId, bytes: manualBytes.length, format: 'json', sourceTitle: '合成手工来源', sheet: '后台手工录入', headerRow: 1,
  }, admin);
  assert.equal(manualPreview.status, 200);
  assert.equal(manualPreview.body.data.unmappedColumns, 0);
  assert.equal(manualPreview.body.data.afterCount, 1);
  const manualReport = await request(`${batchPath}/report`, 'POST', { id: manualPreview.body.data.reportId }, admin);
  assert.equal(manualReport.status, 200);
  const reviewed = manualReport.body.data.added[0];
  assert.equal(reviewed.name, manual.name);
  assert.deepEqual(reviewed.industries, ['软件', '教育']);
  assert.deepEqual(reviewed.educationLevels, ['本科']);
  assert.equal(reviewed.recruitmentUrl, manual.recruitmentUrl);
  assert.equal(reviewed.summary, manual.summary);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).body.data.total, 0);
  assert.equal((await request(`${batchPath}/apply`, 'POST', { id: manualPreview.body.data.id, confirmed: true }, admin)).status, 200);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).body.data.items[0].name, manual.name);
  const manualRollback = await request(`${batchPath}/rollback-preview`, 'POST', {}, admin);
  assert.equal((await request(`${batchPath}/apply`, 'POST', { id: manualRollback.body.data.id, confirmed: true }, admin)).status, 200);
  assert.equal((await request('/career/companies', 'GET', undefined, owner)).body.data.total, 0);
  checks.push('company-manual-entry-uses-reviewed-batch-publishing');
  const created = await request('/resumes', 'POST', {
    title: '合成部署验收简历', targetRole: '合成测试岗位',
    text: '合成部署验收内容，不对应真实个人。\n项目经历\n整理测试需求与接口约定，核对实际交付并记录验收依据。',
  }, owner);
  assert.equal(created.status, 201);
  const original = created.body.data, path = `/resumes/${original.id}`;
  const assistantInput = { resumeId: original.id, resumeRevision: 1, requirements: '杭州', message: '优化简历' };
  const assistant = await request('/career/assistant', 'POST', assistantInput, owner);
  assert.equal(assistant.status, 200);
  assert.equal(assistant.body.data.engine, 'local-rules');
  assert.equal(assistant.body.data.resume.revision, 1);
  assert.equal(assistant.body.data.action.type, 'analyze-resume');
  assert.equal(assistant.body.data.catalogState, 'empty');
  assert.deepEqual(assistant.body.data.companies, []);
  assert.deepEqual((await request(path, 'GET', undefined, owner)).body.data, original);
  assert.equal((await request('/career/assistant', 'POST', assistantInput, other)).status, 404);
  assert.equal((await request(path, 'PUT', { title: '缺少版本' }, owner)).status, 400);
  assert.equal((await request(path, 'PUT', { title: '合成编辑版本', revision: 1 }, owner)).status, 200);
  assert.equal((await request('/career/assistant', 'POST', assistantInput, owner)).status, 409);
  assert.equal((await request('/analyses', 'POST', { resumeId: original.id, resumeRevision: 1 }, owner)).status, 409);
  checks.push('local-assistant-owned-resume-no-mutation-and-revision-guard');

  // Restore the synthetic manual record after the empty-catalogue checks.
  const restoreManual = await request(`${batchPath}/rollback-preview`, 'POST', {}, admin);
  assert.equal(restoreManual.status, 200);
  assert.equal((await request(`${batchPath}/apply`, 'POST', { id: restoreManual.body.data.id, confirmed: true }, admin)).status, 200);
  const editSearchPath = `${batchPath}/records/search`;
  const editQuery = { q: manual.aliases, page: 1 };
  assert.equal((await request(editSearchPath, 'POST', editQuery, owner)).status, 401);
  const matches = await request(editSearchPath, 'POST', editQuery, admin);
  assert.equal(matches.status, 200);
  assert.equal(matches.body.data.total, 1);
  const companyId = matches.body.data.items[0].id;
  const editDetailPath = `${batchPath}/records/${companyId}`;
  assert.equal((await request(editDetailPath)).status, 401);
  const detail = await request(editDetailPath, 'GET', undefined, admin);
  assert.equal(detail.status, 200);
  const { record, catalogRevision } = detail.body.data;
  const editInput = { companyId, catalogRevision, sourceTitle: '合成更正依据', changes: { locations: ['宁波'] } };
  assert.equal((await request(`${batchPath}/edit-preview`, 'POST', editInput, owner)).status, 401);
  const edit = await request(`${batchPath}/edit-preview`, 'POST', editInput, admin);
  assert.equal(edit.status, 200);
  assert.deepEqual(edit.body.data.edit.fields, [{ key: 'locations', before: ['杭州'], after: ['宁波'] }]);
  const memberDetail = `/career/companies/${companyId}`;
  assert.deepEqual((await request(memberDetail, 'GET', undefined, owner)).body.data, record);
  const confirmEdit = { id: edit.body.data.id, confirmed: true };
  const edited = await request(`${batchPath}/apply`, 'POST', confirmEdit, admin);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.editedCompanyId, companyId);
  assert.deepEqual((await request(`${batchPath}/apply`, 'POST', confirmEdit, admin)).body.data, edited.body.data);
  assert.equal((await request(`${batchPath}/edit-preview`, 'POST', editInput, admin)).status, 409);
  const changed = (await request(memberDetail, 'GET', undefined, owner)).body.data;
  assert.deepEqual(changed, { ...record, locations: ['宁波'], updatedAt: changed.updatedAt });
  const undoEdit = await request(`${batchPath}/rollback-preview`, 'POST', {}, admin);
  assert.deepEqual(undoEdit.body.data.edit.fields, [{ key: 'locations', before: ['宁波'], after: ['杭州'] }]);
  assert.equal((await request(`${batchPath}/apply`, 'POST', { id: undoEdit.body.data.id, confirmed: true }, admin)).status, 200);
  assert.deepEqual((await request(memberDetail, 'GET', undefined, owner)).body.data, record);
  checks.push('company-single-edit-admin-only-diff-revision-idempotence-and-rollback');

  assert.equal((await request(path, 'PUT', { title: '过期请求', revision: 1 }, owner)).status, 409);
  assert.equal((await request(`${path}/versions`, 'GET', undefined, other)).status, 404);
  const restore = { revision: 2, confirmed: true, idempotencyKey: `deploy-${randomUUID()}` };
  assert.equal((await request(`${path}/versions/1/restore`, 'POST', { ...restore, confirmed: false }, owner)).status, 400);
  assert.equal((await request(`${path}/versions/1/restore`, 'POST', restore, other)).status, 404);
  const restored = await request(`${path}/versions/1/restore`, 'POST', restore, owner);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.resume.revision, 3);
  assert.equal(restored.body.data.resume.text, original.text);
  assert.equal(restored.body.data.resume.title, original.title);
  const repeated = await request(`${path}/versions/1/restore`, 'POST', restore, owner);
  assert.equal(repeated.body.data.alreadyRestored, true);
  assert.equal(repeated.body.data.resume.revision, 3);
  assert.deepEqual((await request(`${path}/versions`, 'GET', undefined, owner)).body.data.map(item => item.revision), [3, 2, 1]);
  checks.push('revision-conflicts-private-history-and-idempotent-restoration');
  // Synthetic trusted events test compiled ledger behavior only; no real membership or provider request.
  await quota.reserve(quotaUserId, 'release-quota-fixture', 'a'.repeat(64), 50000);
  await quota.dispatch(quotaUserId, 'release-quota-fixture');
  await quota.settle(quotaUserId, 'release-quota-fixture', { inputTokens: 30000, outputTokens: 10000, totalTokens: 40000 });
  const summary = (await request('/membership/quota', 'GET', undefined, quotaAccount)).body.data;
  assert.equal(summary.remainingPercent, 80);
  assert.deepEqual(Object.keys(summary).sort(), ['expiresAt', 'pending', 'remainingPercent', 'resetsAt', 'status']);
  assert.equal((await request('/membership/quota', 'GET', undefined, other)).body.data.remainingPercent, 100);
  assert.equal((await request('/analyses', 'POST', { resumeId: original.id, resumeRevision: 3 }, owner)).status, 201);
  assert.equal((await request('/membership/quota', 'GET', undefined, owner)).body.data.remainingPercent, 100);
  assert.equal((await new QuotaService(new JsonStore(store.path)).current(quotaUserId)).remainingPercent, 80);
  checks.push('percentage-only-private-quota-actual-token-ledger-reload-and-free-rules');
  const phoneChallenge = await request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'bind-phone' }, owner);
  assert.equal(phoneChallenge.status, 202);
  const phoneBound = await request('/auth/phone/bind', 'POST', { phone: '13900000001', code: smsMessages[0].code, challengeId: phoneChallenge.body.data.challengeId, currentPassword: 'Smoke26!Pass' }, owner);
  assert.equal(phoneBound.status, 200); assert.equal(phoneBound.body.data.id, userId);
  fixtureTime += 61000;
  const loginChallenge = await request('/auth/phone/code', 'POST', { phone: '13900000001', purpose: 'login' });
  const phoneLogin = await request('/auth/phone', 'POST', { phone: '13900000001', code: smsMessages[1].code, challengeId: loginChallenge.body.data.challengeId });
  assert.equal(phoneLogin.status, 200); assert.equal(phoneLogin.body.data.user.id, userId); assert.equal(phoneLogin.body.data.token, undefined);
  const phoneCookie = phoneLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(path, 'GET', undefined, phoneCookie)).body.data.id, original.id);
  const newPhoneChallenge = await request('/auth/phone/code', 'POST', { phone: '13900000002', purpose: 'login' });
  const phoneOnly = await request('/auth/phone', 'POST', { phone: '13900000002', code: smsMessages[2].code, challengeId: newPhoneChallenge.body.data.challengeId });
  assert.equal(phoneOnly.status, 200); assert.equal(phoneOnly.body.data.user.email, undefined); assert.equal(phoneOnly.body.data.user.phoneVerified, true);
  assert.ok((await new JsonStore(store.path).read()).users.some(user => user.id === phoneOnly.body.data.user.id && !user.email));
  checks.push('synthetic-sms-phone-registration-binding-same-account-and-phone-only-storage');
  assert.equal((await request(path, 'DELETE', undefined, owner)).status, 200);
  assert.equal((await request(`${path}/versions`, 'GET', undefined, owner)).status, 404);
  for (const cookie of [owner, other, quotaAccount]) assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 200);
  checks.push('deletion-cleans-history-and-sessions-can-logout');
  console.log(JSON.stringify({ passed: true, checks, isolatedDatabase: true, realEmailsSent: 0, realSmsSent: 0, modelCalls: 0, visualVerification: false, weixinDeviceVerification: false }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
