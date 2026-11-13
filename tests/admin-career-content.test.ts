import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../server/auth.js';
import { CareerService } from '../server/career.js';
import { createApiServer } from '../server/http.js';
import { QuotaService } from '../server/quota.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { renderResumeFile } from '../server/export-renderer.js';
import { careerFileLimits, careerFileTypes } from '../shared/career-attachment.js';
import type { CareerAttachment } from '../shared/types.js';

const existingMaterial = {
  id: 'sample-guide', title: '原目录提纲', major: '计算机与软件', role: '', summary: '', content: '旧版正文。',
  sourceLabel: '项目原创', updatedAt: '2026-10-27T10:00:00+08:00',
};
const sampleJob = {
  id: 'sample-job', origin: 'catalog', company: '合成企业', title: '合成岗位', major: '计算机与软件', location: '合成地区',
  description: '用于验证现有岗位目录未被内容发布改动。', companyOverview: '', sourceLabel: '合成测试', availability: 'closed',
  updatedAt: '2026-10-27T10:00:00+08:00',
};
const { id: _id, updatedAt: _updatedAt, ...editableMaterial } = existingMaterial;

function mp4Box(type: string, ...parts: Buffer[]) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + parts.reduce((bytes, part) => bytes + part.length, 0));
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, ...parts]);
}

function videoContainer(codec: string) {
  const handler = Buffer.alloc(12), samples = Buffer.alloc(8);
  handler.write('vide', 8, 'ascii');
  samples.writeUInt32BE(1, 4);
  const configuration = mp4Box('avcC', Buffer.from([1, 66, 0, 30, 255, 224, 0]));
  const info = mp4Box('minf', mp4Box('stbl', mp4Box('stsd', samples, mp4Box(codec, Buffer.alloc(78), configuration))));
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')),
    mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('hdlr', handler), info))),
    mp4Box('mdat', Buffer.from('synthetic transport bytes')),
  ]);
}

test('admin drafts, reviewed releases and restores are atomic, auditable and visible only to eligible workbench users', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-career-content-'));
  const databasePath = join(directory, 'db.json');
  const catalogPath = join(directory, 'catalog.json');
  const base = JSON.stringify({ version: 2, materials: [existingMaterial], portals: [], jobs: [sampleJob] });
  await writeFile(catalogPath, base);
  const store = new JsonStore(databasePath);
  const auth = new AuthService(store);
  const credentials = { email: 'content-operator@example.test', password: 'Synthetic26!' };
  const operator = await auth.register(credentials);
  const subscriber = await auth.register({ email: 'content-reader@example.test', password: 'Synthetic26!' });
  const operatorId = operator.session.user.id, subscriberId = subscriber.session.user.id;
  await store.mutate(data => { data.users.find(user => user.id === operatorId)!.emailVerified = true; });
  await new QuotaService(store).activateMembership({
    userId: subscriberId, planId: 'premium', verifiedPaymentAt: new Date(Date.now() - 1000).toISOString(),
    verifiedEventId: 'fixture-content-member', idempotencyKey: 'fixture-content-activation',
  });
  const server = createApiServer(new ResumeService(store), { auth, adminUserIds: new Set([operatorId]), careerCatalogPath: catalogPath });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(route: string, cookie?: string, input?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(origin + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  const operatorNormal = `youfang_session=${operator.token}`, reader = `youfang_session=${subscriber.token}`;
  const signedIn = await request('/admin/login', undefined, credentials);
  assert.equal(signedIn.status, 200);
  const admin = signedIn.cookie!;
  const content = '/admin/career-content';
  const material = `${content}/material/${existingMaterial.id}`;
  const inspect = async (route = material) => (await request(route, admin)).body.data;
  const workbench = async (cookie = reader) => (await request('/career', cookie)).body.data;
  const write = (route: string, input: unknown) => request(route, admin, input);
  const newDraft = (revision: string | null, content: object) => ({ revision, content, operationId: randomUUID() });
  const preview = async (route: string, input: object) => {
    const result = await write(`${route}/preview`, input);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { ...input, token: result.body.data.token, operationId: randomUUID(), confirmed: true };
  };

  assert.equal((await request(content)).status, 401);
  assert.equal((await request(material, operatorNormal)).status, 401);
  assert.equal((await request(`${material}/draft`, reader, {})).status, 401);
  assert.equal((await request(`${material}/apply`, admin, {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request(`${material}/draft`, admin, {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.deepEqual((await workbench()).materials, [existingMaterial]);

  const initial = await inspect();
  const draft = newDraft(initial.revision, { ...editableMaterial, title: '第一次草稿' });
  assert.equal((await write(`${material}/draft`, { ...draft, actorId: subscriberId })).status, 400);
  assert.equal((await write(`${material}/draft`, draft)).body.data.version, 1);
  assert.equal((await write(`${material}/draft`, draft)).body.data.version, 1);
  assert.equal((await write(`${material}/draft`, { ...draft, content: editableMaterial })).body.error.code, 'CAREER_CONTENT_OPERATION_CONFLICT');
  assert.equal((await write(`${material}/draft`, newDraft(initial.revision, editableMaterial))).body.error.code, 'CAREER_CONTENT_CONFLICT');
  assert.deepEqual((await workbench()).materials, [existingMaterial]);

  const firstPreview = await preview(material, { revision: (await inspect()).revision, action: 'publish' });
  const newEdit = newDraft((await inspect()).revision, { ...editableMaterial, title: '已审核新标题', content: '新稿仅在确认发布后展示。' });
  assert.equal((await write(`${material}/draft`, newEdit)).status, 200);
  assert.equal((await write(`${material}/apply`, firstPreview)).body.error.code, 'CAREER_CONTENT_CONFLICT');
  const reviewed = await preview(material, { revision: (await inspect()).revision, action: 'publish' });
  assert.equal((await write(`${material}/apply`, { ...reviewed, confirmed: false })).status, 400);
  assert.equal((await write(`${material}/apply`, { ...reviewed, token: '0'.repeat(64) })).body.error.code, 'CAREER_CONTENT_REVIEW_CHANGED');
  const duplicate = await Promise.all([write(`${material}/apply`, reviewed), write(`${material}/apply`, reviewed)]);
  for (const result of duplicate) assert.deepEqual(result.body.data, { version: 3 });
  const afterPublish = await workbench();
  assert.equal(afterPublish.materials[0].title, '已审核新标题');
  assert.deepEqual(afterPublish.jobs, [sampleJob]);
  assert.deepEqual((await workbench(operatorNormal)).materials, []);
  assert.equal((await inspect()).draft, null);

  const withdrawal = await preview(material, { revision: (await inspect()).revision, action: 'withdraw' });
  assert.equal((await write(`${material}/apply`, withdrawal)).body.data.version, 4);
  assert.deepEqual((await workbench()).materials, []);
  const restorePublished = await preview(material, { revision: (await inspect()).revision, action: 'restore', sourceVersion: 3 });
  assert.equal((await write(`${material}/apply`, restorePublished)).body.data.version, 5);
  assert.deepEqual((await workbench()).materials, afterPublish.materials);
  const restoreBaseline = await preview(material, { revision: (await inspect()).revision, action: 'restore', sourceVersion: 0 });
  assert.equal((await write(`${material}/apply`, restoreBaseline)).body.data.version, 6);
  assert.deepEqual((await workbench()).materials, [existingMaterial]);
  const history = (await inspect()).history;
  assert.deepEqual(history.map((entry: { action: string }) => entry.action), ['restore', 'restore', 'withdraw', 'publish', 'draft', 'draft']);
  assert.equal(history[0].sourceVersion, 0);
  assert.ok(history.every((entry: { actorId: string; at: string }) => entry.actorId === operatorId && Number.isFinite(Date.parse(entry.at))));
  assert.equal(Object.hasOwn(history[0], 'requestHash'), false);

  const portal = `${content}/portal/admin-${randomUUID()}`;
  const portalData = { organization: '合成机构', majors: ['计算机与软件'], audience: '应届生',
    description: '合成测试渠道，仅用于验证入口发布。', sourceUrl: 'https://example.test/careers', checkedAt: '2025-10-01T00:00:00+08:00' };
  assert.equal((await write(`${portal}/draft`, newDraft(null, { ...portalData, sourceUrl: 'http://example.test' }))).status, 400);
  assert.equal((await write(`${portal}/draft`, newDraft(null, { ...portalData, checkedAt: '2099-10-01T00:00:00+08:00' }))).status, 400);
  assert.equal((await write(`${portal}/draft`, newDraft(null, { ...portalData, availability: 'open' }))).status, 400);
  assert.equal((await write(`${portal}/draft`, newDraft(null, portalData))).status, 200);
  assert.deepEqual((await workbench()).portals, []);
  const portalRelease = await preview(portal, { revision: (await inspect(portal)).revision, action: 'publish' });
  assert.equal((await write(`${portal}/apply`, portalRelease)).status, 200);
  assert.equal((await workbench()).portals[0].organization, portalData.organization);
  assert.deepEqual((await workbench()).jobs, [sampleJob]);
  assert.equal(await readFile(catalogPath, 'utf8'), base, 'managed changes must leave the base catalog file untouched');

  const reloaded = new CareerService(new JsonStore(databasePath), subscriberId, catalogPath);
  assert.deepEqual((await reloaded.workspace()).materials, [existingMaterial]);
  assert.equal((await reloaded.workspace()).portals[0].organization, portalData.organization);
  const persisted = await new JsonStore(databasePath).read();
  assert.equal(persisted.careerContent[0].changes.length, 6);

  const pdf = await renderResumeFile({ id: 'fixture', title: '合成资料', targetRole: '', text: '测试文档。',
    createdAt: existingMaterial.updatedAt, updatedAt: existingMaterial.updatedAt, revision: 1 }, 'pdf', 'minimal');
  const word = await readFile(new URL('../src/static/resume-templates/classic-onyx.docx', import.meta.url));
  const files = '/admin/career-files';
  async function upload(fileName: string, bytes: Buffer, format?: 'mp4') {
    const uploadId = randomUUID();
    for (let offset = 0, index = 0; offset < bytes.length; offset += careerFileLimits.chunkBytes, index++) {
      const chunk = bytes.subarray(offset, offset + careerFileLimits.chunkBytes);
      const payload = { uploadId, index, format, data: chunk.toString('base64') };
      const sent = await write(`${files}/chunk`, payload);
      assert.equal(sent.status, 200);
      assert.deepEqual((await write(`${files}/chunk`, payload)).body.data, { receivedBytes: offset + chunk.length });
    }
    const body = { uploadId, fileName, bytes: bytes.length };
    const finished = await write(`${files}/finish`, body);
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.deepEqual((await write(`${files}/finish`, body)).body.data, finished.body.data);
    return finished.body.data as CareerAttachment;
  }
  const invalidUploadId = randomUUID();
  const badBytes = Buffer.from('<html>文件内容有误</html>');
  const badChunk = { uploadId: invalidUploadId, index: 0, data: badBytes.toString('base64') };
  assert.equal((await request(`${files}/chunk`, reader, badChunk)).status, 401);
  assert.equal((await write(`${files}/chunk`, { ...badChunk, index: 1 })).status, 404);
  assert.equal((await write(`${files}/chunk`, badChunk)).status, 200);
  assert.equal((await write(`${files}/chunk`, { ...badChunk, data: 'd3Jvbmc=' })).status, 409);
  assert.equal((await write(`${files}/finish`, { uploadId: invalidUploadId, bytes: badBytes.length, fileName: '假资料.pdf' })).status, 400);
  assert.equal((await write(`${files}/finish`, { uploadId: invalidUploadId, bytes: badBytes.length, fileName: '假资料.docx' })).status, 400);
  assert.equal((await write(`${files}/cancel`, { uploadId: invalidUploadId })).status, 200);

  // A PDF comment after its header leaves the transport larger than one proxy-safe chunk.
  const headerEnd = pdf.indexOf(10) + 1;
  const comment = Buffer.from(`%${'x'.repeat(careerFileLimits.chunkBytes)}\n`);
  const tail = pdf.subarray(headerEnd).toString('latin1');
  // Shift the PDF's cross-reference offsets to account for the inserted comment.
  const adjusted = tail.replace(/^(\d{10}) 00000 n/gm, (_line, offset: string) =>
    `${String(Number(offset) + comment.length).padStart(10, '0')} 00000 n`)
    .replace(/startxref\n(\d+)/, (_line, offset: string) => `startxref\n${Number(offset) + comment.length}`);
  const multiChunkPdf = Buffer.concat([pdf.subarray(0, headerEnd), comment, Buffer.from(adjusted, 'latin1')]);
  const originalFile = await upload('复习提纲.pdf', multiChunkPdf);
  const replacement = await upload('复习提纲.docx', word);
  const adminFile = (file: CareerAttachment) => `${files}/${file.id}.${file.format}`;
  const publicFile = (file: CareerAttachment) => `/career/materials/${existingMaterial.id}/file/${file.id}`;
  const download = (route: string, cookie?: string) => fetch(origin + route, { headers: cookie ? { Cookie: cookie } : {} });
  const downloadOriginal = await download(adminFile(originalFile), admin);
  assert.equal(downloadOriginal.status, 200);
  assert.deepEqual(Buffer.from(await downloadOriginal.arrayBuffer()), multiChunkPdf);
  assert.equal((await download(adminFile(originalFile), reader)).status, 401);
  assert.equal((await download(publicFile(originalFile), reader)).status, 404);

  const saveFile = async (attachment: CareerAttachment) => write(`${material}/draft`,
    newDraft((await inspect()).revision, { ...editableMaterial, content: '', attachment }));
  const publishFile = async () => write(`${material}/apply`,
    await preview(material, { revision: (await inspect()).revision, action: 'publish' }));
  assert.equal((await saveFile({ ...originalFile, id: '0'.repeat(64) })).status, 404);
  assert.equal((await saveFile(originalFile)).status, 200);
  assert.equal((await download(publicFile(originalFile), reader)).status, 404);
  const fileRelease = await publishFile();
  assert.equal(fileRelease.status, 200);
  assert.equal((await download(publicFile(originalFile))).status, 401);
  assert.equal((await download(publicFile(originalFile), operatorNormal)).status, 403);
  const pdfDownload = await download(publicFile(originalFile), reader);
  assert.equal(pdfDownload.status, 200);
  assert.equal(pdfDownload.headers.get('content-type'), careerFileTypes.pdf);
  assert.match(pdfDownload.headers.get('cache-control')!, /no-store/);
  assert.deepEqual(Buffer.from(await pdfDownload.arrayBuffer()), multiChunkPdf);
  assert.equal((await saveFile(replacement)).status, 200);
  assert.equal((await download(publicFile(replacement), reader)).status, 404);
  assert.equal((await publishFile()).status, 200);
  assert.equal((await download(publicFile(originalFile), reader)).status, 404);
  const wordDownload = await download(publicFile(replacement), reader);
  assert.equal(wordDownload.status, 200);
  assert.equal(wordDownload.headers.get('content-type'), careerFileTypes.docx);
  assert.deepEqual(Buffer.from(await wordDownload.arrayBuffer()), word);
  const nativeDownload = await fetch(origin + publicFile(replacement), { headers: { Authorization: `Bearer ${subscriber.token}` } });
  assert.equal(nativeDownload.status, 200);
  assert.deepEqual(Buffer.from(await nativeDownload.arrayBuffer()), word);
  const restoreAttachment = await preview(material, { revision: (await inspect()).revision,
    action: 'restore', sourceVersion: fileRelease.body.data.version });
  assert.equal((await write(`${material}/apply`, restoreAttachment)).status, 200);
  assert.deepEqual((await new CareerService(new JsonStore(databasePath), subscriberId, catalogPath).workspace()).materials[0].attachment, originalFile);
  assert.equal((await download(publicFile(replacement), reader)).status, 404);

  const unsupported = videoContainer('hvc1'), badVideo = randomUUID();
  assert.equal((await write(`${files}/chunk`, { uploadId: badVideo, index: 0, format: 'mp4', data: unsupported.toString('base64') })).status, 200);
  assert.equal((await write(`${files}/finish`, { uploadId: badVideo, fileName: 'HEVC.mp4', bytes: unsupported.length })).status, 400);
  assert.equal((await write(`${files}/cancel`, { uploadId: badVideo })).status, 200);
  const videoBytes = videoContainer('avc1');
  const video = await upload('复习视频.mp4', videoBytes, 'mp4');
  const videoFile = publicFile(video);
  const readVideo = (options: { range?: string; method?: 'GET' | 'HEAD'; cookie?: string } = {}) => fetch(origin + videoFile, {
    method: options.method ?? 'GET', headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.range ? { Range: options.range } : {}),
    },
  });
  assert.equal((await download(adminFile(video), admin)).status, 200);
  assert.equal((await saveFile(video)).status, 200);
  assert.equal((await readVideo({ range: 'bytes=0-1', cookie: reader })).status, 404);
  const videoRelease = await publishFile();
  assert.equal(videoRelease.status, 200);
  assert.equal((await readVideo({ range: 'bytes=0-1' })).status, 401);
  assert.equal((await readVideo({ range: 'bytes=0-1', cookie: operatorNormal })).status, 403);
  const metadata = await readVideo({ method: 'HEAD', cookie: reader });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get('content-type'), 'video/mp4');
  assert.equal(metadata.headers.get('content-length'), String(videoBytes.length));
  assert.equal(metadata.headers.get('accept-ranges'), 'bytes');
  assert.equal(await metadata.text(), '');
  for (const [range, start, end] of [
    ['bytes=0-1', 0, 1],
    ['bytes=8-', 8, videoBytes.length - 1],
    ['bytes=-8', videoBytes.length - 8, videoBytes.length - 1],
  ] as const) {
    const partial = await readVideo({ range, cookie: reader });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${videoBytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), videoBytes.subarray(start, end + 1));
  }
  const outOfBounds = await readVideo({ range: 'bytes=1000000-', cookie: reader });
  assert.equal(outOfBounds.status, 416);
  assert.equal(outOfBounds.headers.get('content-range'), `bytes */${videoBytes.length}`);
  const database = await new JsonStore(databasePath).read();
  assert.equal(Object.values(database.careerVideos)[0].format, 'mp4');
  assert.ok(Object.values(database.careerAttachments).every(file => file.format !== 'mp4'), 'previous release can still read document metadata');
  const videoRestore = await preview(material, { revision: (await inspect()).revision,
    action: 'restore', sourceVersion: fileRelease.body.data.version });
  assert.equal((await write(`${material}/apply`, videoRestore)).status, 200);
  assert.equal((await readVideo({ range: 'bytes=0-1', cookie: reader })).status, 404);
  assert.equal((await download(publicFile(originalFile), reader)).status, 200);
  const off = await preview(material, { revision: (await inspect()).revision, action: 'withdraw' });
  assert.equal((await write(`${material}/apply`, off)).status, 200);
  assert.equal((await download(publicFile(originalFile), reader)).status, 404);

  await writeFile(catalogPath, '{invalid');
  assert.equal((await request(content, admin)).body.error.code, 'CAREER_CATALOG_UNAVAILABLE');
  assert.equal((await workbench()).catalogState, 'unavailable');
});

test('shared job review and publication change member search and planning together, survive reload and keep historical snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-job-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'db.json'), catalogPath = join(directory, 'catalog.json');
  const baseline = { ...sampleJob, availability: 'open', title: '供应链采购', location: '上海',
    audience: 'campus', checkedAt: '2020-01-01T00:00:00+08:00', description: '2027届，熟悉 Excel。',
    sourceUrl: 'https://example.test/jobs/sample' };
  await writeFile(catalogPath, JSON.stringify({ version: 2, jobs: [baseline], materials: [], portals: [] }));
  const { AdminCareerContent } = await import('../server/admin-career-content.js');
  let store = new JsonStore(databasePath);
  let admin = new AdminCareerContent(store, catalogPath);
  const target = { kind: 'job' as const, id: baseline.id }, actor = 'catalog-editor';
  const workspace = () => new CareerService(store, 'reader', catalogPath);
  const { id: _id, origin: _origin, updatedAt: _updatedAt, ...job } = baseline;
  const save = async (content: object, revision: string | null, operationId = randomUUID()) =>
    admin.saveDraft(target, { content, revision, operationId }, actor);
  const code = (name: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === name;
  const preview = async (action: 'publish' | 'withdraw' | 'restore', sourceVersion?: number) => {
    const input = { action, revision: (await admin.detail(target)).revision, ...(sourceVersion === undefined ? {} : { sourceVersion }) };
    const { token } = await admin.preview(target, input);
    return { ...input, token, operationId: randomUUID(), confirmed: true as const };
  };
  assert.equal((await admin.list()).find(row => row.id === baseline.id)?.needsRecheck, true);
  await save(job, (await admin.detail(target)).revision);
  await assert.rejects(preview('publish'), code('VALIDATION_ERROR'));
  await assert.rejects(save({ ...job, sourceUrl: 'http://example.test/jobs/sample' }, (await admin.detail(target)).revision), code('VALIDATION_ERROR'));
  const refreshed = { ...job, title: '供应链采购与交付', checkedAt: new Date().toISOString() };
  const revision = (await admin.detail(target)).revision, operationId = randomUUID();
  const saved = await save(refreshed, revision, operationId);
  assert.deepEqual(await save(refreshed, revision, operationId), saved);
  assert.equal((await workspace().catalogJobs())[0].title, baseline.title);
  const old = await preview('publish');
  await save(refreshed, (await admin.detail(target)).revision);
  await assert.rejects(admin.apply(target, old, actor), code('CAREER_CONTENT_CONFLICT'));
  const publish = await preview('publish');
  const published = await admin.apply(target, publish, actor);
  assert.deepEqual(await admin.apply(target, publish, actor), published);
  const duplicateTarget = { kind: 'job' as const, id: `admin-${randomUUID()}` };
  await admin.saveDraft(duplicateTarget, { content: refreshed, revision: null, operationId: randomUUID() }, actor);
  await assert.rejects(admin.preview(duplicateTarget, { action: 'publish', revision: (await admin.detail(duplicateTarget)).revision }), code('VALIDATION_ERROR'));

  store = new JsonStore(databasePath);
  admin = new AdminCareerContent(store, catalogPath);
  assert.equal((await workspace().workspace()).jobs[0].title, refreshed.title);
  assert.equal((await workspace().catalogJobs())[0].title, refreshed.title);
  assert.equal((await admin.list()).find(row => row.id === baseline.id)?.needsRecheck, false);
  const resume = await new ResumeService(store, undefined, 'reader').createResume({ title: '合成简历', text: '参与库存盘点，使用 Excel 核对库存台账。' });
  const planInput = { jobId: baseline.id, resumeId: resume.id, resumeRevision: 1, idempotencyKey: randomUUID() };
  const application = await workspace().createApplication(planInput);
  assert.equal(application.jobSnapshot.title, refreshed.title);
  await admin.apply(target, await preview('withdraw'), actor);
  assert.deepEqual(await workspace().catalogJobs(), []);
  assert.equal((await workspace().workspace()).applications[0].jobSnapshot.title, refreshed.title);
  assert.deepEqual(await workspace().createApplication(planInput), application);
  await assert.rejects(workspace().createApplication({ ...planInput, idempotencyKey: randomUUID() }), code('NOT_FOUND'));
  await admin.apply(target, await preview('restore', published.version), actor);
  assert.equal((await workspace().catalogJobs())[0].title, refreshed.title);
  const persisted = await new JsonStore(databasePath).read();
  assert.equal(persisted.careerContent.length, 0);
  assert.equal(persisted.careerJobContent?.length, 2);
});
