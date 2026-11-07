import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import JSZip from 'jszip';
import {
  detectResumeFormat, extractResumePdfText, importResumeFile, MAX_RESUME_FILE_BYTES, normalizeImportedText,
  pdfTextItemsToText, ResumeImportError, validateResumeFile,
} from '../src/utils/importResume.js';
import { inputLimits } from '../shared/limits.js';
import { createImportController } from '../src/utils/importCancellation.js';

const hasCode = (code: string) => (error: unknown) => error instanceof ResumeImportError && error.code === code;

test('file admission rejects unsupported, empty and oversized files before parsing', () => {
  assert.equal(detectResumeFormat('候选人.秋招.PDF'), 'pdf');
  assert.equal(detectResumeFormat('经历.docx'), 'docx');
  assert.equal(detectResumeFormat('经历.MD'), 'md');
  assert.throws(() => detectResumeFormat('旧简历.doc'), hasCode('unsupported-format'));
  assert.throws(() => validateResumeFile('简历.png', 100), hasCode('unsupported-format'));
  assert.throws(() => validateResumeFile('简历.txt', 0), hasCode('empty-file'));
  assert.throws(() => validateResumeFile('简历.txt', Number.NaN), hasCode('empty-file'));
  assert.throws(() => validateResumeFile('简历.txt', MAX_RESUME_FILE_BYTES + 1), hasCode('file-too-large'));
  assert.equal(validateResumeFile('简历.txt', MAX_RESUME_FILE_BYTES), 'txt');
});

test('import normalization preserves facts and enforces the same text boundary as the API', () => {
  assert.equal(normalizeImportedText('\uFEFF教育背景\r\n  本科，2024 年毕业。\u0000  \r\n\r\n\r\n\r\n项目经历  '), '教育背景\n  本科，2024 年毕业。\n\n\n项目经历');
  assert.equal(normalizeImportedText(`  ${'文'.repeat(inputLimits.resumeText)}  `).length, inputLimits.resumeText);
  assert.throws(() => normalizeImportedText('文'.repeat(inputLimits.resumeText + 1)), hasCode('text-too-long'));
  assert.equal(normalizeImportedText('  \n\t '), '');
});

test('TXT import returns reviewed text and refuses binary, malformed UTF-8 and empty contents', async () => {
  const imported = await importResumeFile(new File(['项目经历\r\n负责真实业务模块的开发。'], '简历.txt', { type: 'text/plain' }));
  assert.deepEqual(imported, { fileName: '简历.txt', format: 'txt', text: '项目经历\n负责真实业务模块的开发。' });
  await assert.rejects(() => importResumeFile(new File([new Uint8Array([65, 0, 66])], '简历.txt')), hasCode('invalid-file'));
  await assert.rejects(() => importResumeFile(new File([new Uint8Array([0xc3, 0x28])], '简历.txt')), hasCode('invalid-file'));
  await assert.rejects(() => importResumeFile(new File(['   '], '简历.txt')), hasCode('empty-file'));
  await assert.rejects(() => importResumeFile(new File(['文'.repeat(inputLimits.resumeText + 1)], '简历.txt')), hasCode('text-too-long'));
  await assert.rejects(() => importResumeFile(new File(['renamed text'], '简历.pdf')), hasCode('invalid-file'));
  await assert.rejects(() => importResumeFile(new File(['renamed text'], '简历.docx')), hasCode('invalid-file'));
});

test('PDF text runs preserve line boundaries rather than merging different resume rows', () => {
  assert.equal(pdfTextItemsToText([
    { str: '项目', transform: [1, 0, 0, 1, 0, 100] },
    { str: '经历', transform: [1, 0, 0, 1, 30, 100], hasEOL: true },
    { str: '开发订单系统', transform: [1, 0, 0, 1, 0, 80] },
    { str: '并通过测试验收', transform: [1, 0, 0, 1, 0, 60] },
    { unrelated: true }, null,
  ]), '项目 经历\n开发订单系统\n并通过测试验收');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

test('cancelled imports do not begin a file read and pending reads reject before their late response', async () => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  const file = new File(['合成项目经历，整理需求并验证实际交付。'], '合成简历.txt');
  let reads = 0;
  const reading = deferred<ArrayBuffer>();
  file.arrayBuffer = () => { ++reads; return reading.promise; };
  await assert.rejects(importResumeFile(file, { signal: alreadyCancelled.signal }), hasCode('cancelled'));
  assert.equal(reads, 0);
  const controller = new AbortController();
  const pending = importResumeFile(file, { signal: controller.signal });
  assert.equal(reads, 1);
  controller.abort();
  await assert.rejects(pending, hasCode('cancelled'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  reading.reject(new Error('A late cancelled read must not cause an unhandled rejection.'));
  await new Promise(resolve => setImmediate(resolve));
});

test('aborting immediately after file bytes arrive prevents parsing or accepting their contents', async () => {
  const controller = new AbortController();
  const file = new File(['合成简历正文，取消后不应填回编辑器。'], '合成简历.txt');
  const bytes = await file.arrayBuffer();
  file.arrayBuffer = async () => { controller.abort(); return bytes; };
  await assert.rejects(importResumeFile(file, { signal: controller.signal }), hasCode('cancelled'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('DOCX import extracts actual synthetic document paragraphs without inventing resume facts', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成项目经历</w:t></w:r></w:p><w:p><w:r><w:t>整理合成测试需求，核对接口交付。</w:t></w:r></w:p></w:body></w:document>');
  const controller = new AbortController();
  const imported = await importResumeFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], '合成文档.docx'), { signal: controller.signal });
  assert.deepEqual(imported, { fileName: '合成文档.docx', format: 'docx', text: '合成项目经历\n\n整理合成测试需求，核对接口交付。' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling PDF loading destroys its task once and discards a later loaded document', async () => {
  const controller = new AbortController();
  let destroyed = 0, pagesRequested = 0;
  const document = {
    numPages: 1,
    async getPage() { ++pagesRequested; return { async getTextContent() { return { items: [{ str: '合成文字' }] }; }, cleanup() {} }; },
  };
  const loading = deferred<typeof document>();
  const extraction = extractResumePdfText({ promise: loading.promise, async destroy() { ++destroyed; } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(extraction, hasCode('cancelled'));
  assert.equal(destroyed, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  loading.resolve(document);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pagesRequested, 0);
  assert.equal(destroyed, 1);
});

test('cancelling an active PDF page cleans it up and never reads subsequent pages or returns late text', async () => {
  const controller = createImportController();
  const content = deferred<{ items: Array<{ str: string }> }>();
  const pageStarted = deferred<void>();
  let destroyed = 0, cleaned = 0;
  const pagesRequested: number[] = [];
  const extraction = extractResumePdfText({
    promise: Promise.resolve({
      numPages: 2,
      async getPage(index: number) {
        pagesRequested.push(index);
        return { getTextContent() { pageStarted.resolve(); return content.promise; }, cleanup() { ++cleaned; } };
      },
    }),
    async destroy() { ++destroyed; },
  }, { signal: controller.signal });
  await pageStarted.promise;
  controller.abort();
  await assert.rejects(extraction, hasCode('cancelled'));
  assert.deepEqual(pagesRequested, [1]);
  assert.equal(cleaned, 1);
  assert.equal(destroyed, 1);
  content.resolve({ items: [{ str: '不应被接受的晚回正文' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pagesRequested, [1]);
});

test('PDF completion and validation failures release tasks and abort listeners', async () => {
  for (const [pageCount, items, expected] of [
    [1, [{ str: '合成项目经历', hasEOL: true }, { str: '核对真实交付' }], '合成项目经历\n核对真实交付'],
    [51, [], 'too-many-pages'],
    [1, [], 'scanned-pdf'],
  ] as const) {
    const controller = new AbortController();
    let destroyed = 0, cleaned = 0;
    const extraction = extractResumePdfText({
      promise: Promise.resolve({ numPages: pageCount, async getPage() { return { async getTextContent() { return { items }; }, cleanup() { ++cleaned; } }; } }),
      async destroy() { ++destroyed; },
    }, { signal: controller.signal });
    if (expected === 'too-many-pages' || expected === 'scanned-pdf') await assert.rejects(extraction, hasCode(expected));
    else assert.deepEqual(await extraction, { text: expected, pageCount });
    assert.equal(destroyed, 1);
    assert.equal(cleaned, pageCount > 50 ? 0 : 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
