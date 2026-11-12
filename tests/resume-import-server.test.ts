import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RESUME_FILE_BYTES, RESUME_IMPORT_CHUNK_BYTES } from '../shared/resume-import.js';
import { HttpError } from '../server/errors.js';
import { ResumeImports } from '../server/resume-imports.js';
import { renderResumeFile } from '../server/export-renderer.js';

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test('resume import isolates uploads and admits only sequential, bounded and identical retry chunks', async (t) => {
  const imports = new ResumeImports();
  t.after(() => imports.stop());
  const owner = 'fixture-owner', other = 'fixture-other';
  const size = RESUME_IMPORT_CHUNK_BYTES + 4;
  assert.throws(() => imports.start(owner, { fileName: '简历.pdf', size: MAX_RESUME_FILE_BYTES + 1 }), hasCode('RESUME_IMPORT_FILE_TOO_LARGE'));
  assert.throws(() => imports.start(owner, { fileName: '简历.doc', size }), hasCode('RESUME_IMPORT_UNSUPPORTED_FORMAT'));
  const { id } = imports.start(owner, { fileName: '简历.pdf', size });
  const first = { offset: 0, contentBase64: Buffer.alloc(RESUME_IMPORT_CHUNK_BYTES, 1).toString('base64') };
  const last = { offset: RESUME_IMPORT_CHUNK_BYTES, contentBase64: Buffer.from('test').toString('base64') };
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
  assert.throws(() => imports.append(other, id, first), hasCode('NOT_FOUND'));
  assert.throws(() => imports.cancel(other, id), hasCode('NOT_FOUND'));
  await assert.rejects(imports.parse(other, id, new AbortController().signal), hasCode('NOT_FOUND'));
  await assert.rejects(imports.parse(owner, id, new AbortController().signal), hasCode('RESUME_IMPORT_INCOMPLETE'));
  assert.throws(() => imports.append(owner, id, last), hasCode('RESUME_IMPORT_CHUNK_CONFLICT'));
  assert.deepEqual(imports.append(owner, id, first), { uploadedBytes: RESUME_IMPORT_CHUNK_BYTES });
  assert.deepEqual(imports.append(owner, id, first), { uploadedBytes: RESUME_IMPORT_CHUNK_BYTES });
  const replacement = { ...first, contentBase64: Buffer.alloc(RESUME_IMPORT_CHUNK_BYTES, 2).toString('base64') };
  assert.throws(() => imports.append(owner, id, replacement), hasCode('RESUME_IMPORT_CHUNK_CONFLICT'));
  assert.deepEqual(imports.append(owner, id, last), { uploadedBytes: size });
  imports.cancel(owner, id);
  assert.throws(() => imports.append(owner, id, first), hasCode('NOT_FOUND'));
});

test('cancelling an active parser clears the original and permits another import', async (t) => {
  const imports = new ResumeImports();
  t.after(() => imports.stop());
  const text = '项目经历\n负责合成项目的开发与测试。';
  const bytes = await renderResumeFile({
    id: 'import-fixture', title: '合成简历', text, targetRole: '', revision: 1,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
  }, 'docx', 'minimal');
  const begin = () => {
    const { id } = imports.start('fixture-owner', { fileName: '合成简历.docx', size: bytes.length });
    imports.append('fixture-owner', id, { offset: 0, contentBase64: bytes.toString('base64') });
    return id;
  };
  const first = begin();
  const pending = imports.parse('fixture-owner', first, new AbortController().signal);
  imports.cancel('fixture-owner', first);
  await assert.rejects(pending, hasCode('RESUME_IMPORT_CANCELLED'));
  const second = begin();
  const result = await imports.parse('fixture-owner', second, new AbortController().signal);
  assert.equal(result.format, 'docx');
  assert.match(result.text, /负责合成项目的开发与测试。/);
  await assert.rejects(imports.parse('fixture-owner', second, new AbortController().signal), hasCode('NOT_FOUND'));
});
