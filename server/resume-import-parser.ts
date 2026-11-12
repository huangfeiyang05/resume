import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { buffer } from 'node:stream/consumers';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { fromBufferPromise } from 'yauzl';
import {
  extractResumePdfText, normalizeImportedText, ResumeImportError, type ImportedResume,
} from '../shared/resume-import.js';

export type FileToParse = { bytes: Buffer; format: 'docx' | 'pdf' };
export type ParsedFile = Pick<ImportedResume, 'text' | 'pageCount'>;
export type ParserReply = { result: ParsedFile } | { error: Pick<ResumeImportError, 'code' | 'message'> };

const require = createRequire(import.meta.url);
const invalidFile = () => new ResumeImportError('invalid-file', '文件解析失败，请重新导出文件或粘贴简历正文。');

async function readWordText(bytes: Buffer): Promise<string> {
  const archive = await fromBufferPromise(bytes, { strictFileNames: true });
  const xml = new JSZip();
  let expanded = 0;
  try {
    if (archive.entryCount > 2048) throw invalidFile();
    for await (const entry of archive.eachEntry()) {
      if (!/\.(?:xml|rels)$/i.test(entry.fileName)) continue;
      expanded += entry.uncompressedSize;
      if (expanded > 8 * 1024 * 1024 || xml.file(entry.fileName)) {
        throw new ResumeImportError('invalid-file', 'Word 文档结构异常或过大，请精简或重新保存后再导入。');
      }
      // yauzl bounds decompression to the declared size, even if the stream misstates it.
      xml.file(entry.fileName, await buffer(await archive.openReadStreamPromise(entry)));
    }
    if (!xml.file('word/document.xml')) throw invalidFile();
    // Raw text extraction uses local archive parts only. Media and embedded files are excluded.
    return (await mammoth.extractRawText({ buffer: await xml.generateAsync({ type: 'nodebuffer' }) })).value;
  } finally {
    archive.close();
  }
}

const pdfDirectory = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfAssets = {
  cMapUrl: join(pdfDirectory, 'cmaps') + sep,
  standardFontDataUrl: join(pdfDirectory, 'standard_fonts') + sep,
};

class PdfTextAssets {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    if (kind === 'cMapUrl' && /^[a-z0-9_-]+\.bcmap$/i.test(filename)) {
      return new Uint8Array(await readFile(join(pdfAssets.cMapUrl, filename)));
    }
    if (kind === 'standardFontDataUrl' && /^[a-z0-9_-]+\.(?:pfb|ttf)$/i.test(filename)) {
      return new Uint8Array(await readFile(join(pdfAssets.standardFontDataUrl, filename)));
    }
    throw new Error('Unknown PDF resource');
  }
}

async function readPdfText(bytes: Buffer): Promise<ParsedFile> {
  if (!bytes.subarray(0, 1024).includes('%PDF-')) throw invalidFile();
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return extractResumePdfText(pdf.getDocument({
    data: new Uint8Array(bytes), ...pdfAssets, BinaryDataFactory: PdfTextAssets,
    useWorkerFetch: false, useWasm: false, useSystemFonts: false, disableFontFace: true, enableXfa: false,
    verbosity: 0,
  }));
}

process.once('message', async ({ bytes, format }: FileToParse) => {
  let reply: ParserReply;
  try {
    const result = format === 'docx' ? { text: await readWordText(bytes) } : await readPdfText(bytes);
    const text = normalizeImportedText(result.text);
    if (!text) throw new ResumeImportError('empty-file', '没有读取到简历正文，请检查文件或粘贴文字。');
    reply = { result: { ...result, text } };
  } catch (cause) {
    const error = cause instanceof ResumeImportError ? cause
      : cause instanceof Error && cause.name === 'PasswordException'
        ? new ResumeImportError('password-protected', 'PDF 已加密，请移除密码后再导入。')
        : invalidFile();
    reply = { error: { code: error.code, message: error.message } };
  }
  process.send?.(reply);
});
