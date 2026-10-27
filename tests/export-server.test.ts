import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import type { Resume, ResumeExportFormat, ResumeExportTemplate } from '../shared/types.js';
import { HttpError } from '../server/errors.js';
import { createApiServer } from '../server/http.js';
import { exportResume, validateExportInput } from '../server/exports.js';
import { renderResumeFile } from '../server/export-renderer.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const EXPORT_TEXT = [
  '林一',
  '前端开发工程师 | 上海',
  'linyi@example.com  13800138000',
  '个人简介',
  '关注产品体验与可维护性，只保留本人提供的经历。',
  '【教育背景】',
  '某大学 | 计算机科学 | 2020.09–2024.06',
  '工作经历：',
  '示例科技 | 前端开发 | 2024.07–至今',
  '项目经历',
  '项目描述：参与简历诊断页面开发。',
  '职责范围：负责交互与接口联调。',
  '技术栈：Vue 3、TypeScript。',
  '专业技能',
  'Vue 3、TypeScript；不推断其他技能。',
  '证书',
  '英语六级',
  '获奖',
  '校级奖学金',
].join('\n');

function resume(overrides: Partial<Resume> = {}): Resume {
  return {
    id: 'export-fixture-resume', title: '导出测试简历', targetRole: '前端开发工程师', text: EXPORT_TEXT, revision: 1,
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...overrides,
  };
}

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
const meaningfulLines = (value: string) => value.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim().length > 0);

const unescapeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!);

async function wordText(buffer: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(buffer);
  const xml = await archive.file('word/document.xml')!.async('string');
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => unescapeXml(match[1]!)).join('\n');
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { service: new ResumeService(new JsonStore(join(directory, 'resumes.json'))) };
}

test('renders Word and PDF files that keep every saved line without changing the resume', async () => {
  const saved = resume();
  const docxBuffers: Buffer[] = [];
  for (const template of ['minimal', 'modern', 'business'] as ResumeExportTemplate[]) {
    const buffer = await renderResumeFile(saved, 'docx', template);
    assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    const text = await wordText(buffer);
    for (const line of meaningfulLines(EXPORT_TEXT)) assert.ok(text.includes(line), `Word export is missing: ${line}`);
    assert.ok(text.includes('林一'));
    docxBuffers.push(buffer);
  }
  assert.notDeepEqual(docxBuffers[0], docxBuffers[1]);
  assert.notDeepEqual(docxBuffers[1], docxBuffers[2]);
  const pdfBuffers: Buffer[] = [];
  for (const template of ['minimal', 'modern'] as ResumeExportTemplate[]) {
    const buffer = await renderResumeFile(saved, 'pdf', template);
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.length > 1_000);
    assert.ok(buffer.includes(Buffer.from('%%EOF')), 'PDF must be terminated');
    pdfBuffers.push(buffer);
  }
  assert.notDeepEqual(pdfBuffers[0], pdfBuffers[1]);
  assert.deepEqual(saved, resume(), 'rendering must never mutate the saved resume');
});

test('rejects text that cannot be rendered instead of producing a broken file', async () => {
  for (const format of ['docx', 'pdf'] as ResumeExportFormat[]) {
    await assert.rejects(() => renderResumeFile(resume({ text: '正常\n\u0000控制字符' }), format, 'minimal'), (error: unknown) => error instanceof Error && error.message === 'INVALID_EXPORT_TEXT');
    await assert.rejects(() => renderResumeFile(resume({ text: '正常\n孤立代理 \uD800' }), format, 'minimal'), (error: unknown) => error instanceof Error && error.message === 'INVALID_EXPORT_TEXT');
  }
});

test('validates export input against the saved resume contract', () => {
  assert.deepEqual(validateExportInput({ revision: 2, format: 'docx', template: 'modern' }), { revision: 2, format: 'docx', template: 'modern' });
  for (const body of [null, [], 'docx', { revision: 1, format: 'docx' }, { revision: 1, format: 'docx', template: 'minimal', text: '正文由服务端读取' }, { revision: 0, format: 'docx', template: 'minimal' }, { revision: 1.5, format: 'docx', template: 'minimal' }, { revision: '1', format: 'docx', template: 'minimal' }, { revision: 1, format: 'rtf', template: 'minimal' }, { revision: 1, format: 'docx', template: 'fancy' }]) {
    assert.throws(() => validateExportInput(body), hasCode('VALIDATION_ERROR'));
  }
});

test('refuses to export a stale or missing revision', async (t) => {
  const { service } = await fixture(t);
  const saved = await service.createResume({ title: '版本冲突', targetRole: '', text: EXPORT_TEXT });
  const controller = new AbortController();
  await assert.rejects(() => exportResume(service, saved.id, { revision: 2, format: 'docx', template: 'minimal' }, controller.signal), hasCode('REVISION_CONFLICT'));
  await assert.rejects(() => exportResume(service, 'no-such-resume', { revision: 1, format: 'docx', template: 'minimal' }, controller.signal), hasCode('NOT_FOUND'));
});

test('exports through the API with the saved revision and returns a downloadable file', async (t) => {
  const { service } = await fixture(t);
  const server = createApiServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const registration = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'export-fixture@example.test', password: 'Fixture-pw-26!' }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  const request = async (path: string, method = 'GET', data?: unknown) => {
    const result = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: result.status, body: await result.json() as any };
  };
  const created = await request('/resumes', 'POST', { title: '导出测试简历', targetRole: '前端开发工程师', text: EXPORT_TEXT });
  assert.equal(created.status, 201);
  const id = created.body.data.id as string;
  const exportPath = `/resumes/${id}/export`;

  const anonymous = await fetch(`${base}${exportPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1, format: 'docx', template: 'minimal' }) });
  assert.equal(anonymous.status, 401);
  assert.equal((await request(exportPath, 'GET')).status, 405);
  assert.equal((await request(exportPath, 'POST', { revision: 1, format: 'rtf', template: 'minimal' })).status, 400);
  assert.equal((await request(exportPath, 'POST', { revision: 1, format: 'docx', template: 'minimal', text: '替换正文' })).status, 400);
  assert.equal((await request(exportPath, 'POST', { revision: 2, format: 'docx', template: 'minimal' })).status, 409);

  const word = await request(exportPath, 'POST', { revision: 1, format: 'docx', template: 'modern' });
  assert.equal(word.status, 200);
  assert.equal(word.body.data.format, 'docx');
  assert.equal(word.body.data.template, 'modern');
  assert.equal(word.body.data.revision, 1);
  assert.equal(word.body.data.resumeId, id);
  assert.equal(word.body.data.fileName, '导出测试简历.docx');
  assert.equal(word.body.data.mimeType, DOCX_MIME);
  const wordBytes = Buffer.from(word.body.data.contentBase64 as string, 'base64');
  assert.deepEqual([...wordBytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.ok((await wordText(wordBytes)).includes('示例科技 | 前端开发 | 2024.07–至今'));

  const pdf = await request(exportPath, 'POST', { revision: 1, format: 'pdf', template: 'minimal' });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.data.format, 'pdf');
  assert.equal(pdf.body.data.fileName, '导出测试简历.pdf');
  assert.equal(pdf.body.data.mimeType, PDF_MIME);
  const pdfBytes = Buffer.from(pdf.body.data.contentBase64 as string, 'base64');
  assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-');

  const saved = await request(`/resumes/${id}`);
  assert.equal(saved.body.data.revision, 1);
  assert.equal(saved.body.data.text, EXPORT_TEXT);
});
