import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectResumeFormat, importResumeFile, MAX_RESUME_FILE_BYTES, normalizeImportedText,
  pdfTextItemsToText, ResumeImportError, validateResumeFile,
} from '../src/utils/importResume.js';
import { inputLimits } from '../shared/limits.js';

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
