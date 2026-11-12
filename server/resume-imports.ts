import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RESUME_IMPORT_CHUNK_BYTES, ResumeImportError, validateWechatResumeFile } from '../shared/resume-import.js';
import type { ImportedResume, ResumeImportUpload } from '../shared/types.js';
import { HttpError, invalid, notFound } from './errors.js';
import type { FileToParse, ParsedFile, ParserReply } from './resume-import-parser.js';

const uploadTtlMs = 3 * 60_000;
const maxUploads = 4;
const cancelled = () => new HttpError(409, 'RESUME_IMPORT_CANCELLED', '简历导入已取消。');
const unavailable = () => new HttpError(503, 'RESUME_IMPORT_UNAVAILABLE', '暂时无法解析文件，请稍后重试或粘贴正文。');
const busy = () => new HttpError(429, 'RESUME_IMPORT_BUSY', '当前有文件正在导入，请稍后重试。');

function fileError(error: Pick<ResumeImportError, 'code' | 'message'>) {
  const status = error.code === 'file-too-large' ? 413 : error.code === 'unsupported-format' ? 415 : 422;
  return new HttpError(status, `RESUME_IMPORT_${error.code.replace(/-/g, '_').toUpperCase()}`, error.message);
}

function parseInProcess(input: FileToParse, signal: AbortSignal): Promise<ParsedFile> {
  if (signal.aborted) return Promise.reject(cancelled());
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './resume-import-parser.ts' : './resume-import-parser.js', import.meta.url));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const args = source ? ['--import', 'tsx'] : ['--permission', `--allow-fs-read=${root}`];
  return new Promise((resolve, reject) => {
    // A parser crash or heap exhaustion must not bring down the API process.
    const child = fork(entry, [], {
      cwd: root, env: {}, execArgv: ['--max-old-space-size=192', ...args],
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let reply: ParserReply | undefined;
    let failure: HttpError | undefined;
    let stopped = false;
    const stop = (error?: HttpError) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.kill('SIGKILL');
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(new HttpError(504, 'RESUME_IMPORT_TIMEOUT', '文件解析超时，请精简文件或粘贴正文。')), 20_000);
    child.once('message', (message: ParserReply) => { reply = message; stop(); });
    child.on('error', () => stop(unavailable()));
    child.once('close', () => {
      stop();
      if (failure) reject(failure);
      else if (reply && 'error' in reply) reject(fileError(reply.error));
      else if (reply && 'result' in reply) resolve(reply.result);
      else reject(unavailable());
    });
    signal.addEventListener('abort', abort, { once: true });
    child.send(input, error => { if (error) stop(unavailable()); });
  });
}

interface Upload {
  id: string;
  userId: string;
  fileName: string;
  format: FileToParse['format'];
  bytes?: Buffer;
  uploadedBytes: number;
  timer: ReturnType<typeof setTimeout>;
  parser?: AbortController;
}

function record(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('导入参数必须是 JSON 对象。');
  if (Object.keys(body).some(key => !fields.includes(key))) invalid('导入参数包含不支持的字段。');
  return body as Record<string, unknown>;
}

/** Original files live in memory for one upload and are never written to the resume store. */
export class ResumeImports {
  private readonly uploads = new Map<string, Upload>();
  private parsing = false;

  start(userId: string, body: unknown): ResumeImportUpload {
    const { fileName, size } = record(body, ['fileName', 'size']);
    if (typeof fileName !== 'string' || fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(fileName)) invalid('文件名称无效。');
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) invalid('文件大小无效。');
    let format;
    try { format = validateWechatResumeFile(fileName, size); }
    catch (error) { if (error instanceof ResumeImportError) throw fileError(error); throw error; }
    const previous = [...this.uploads.values()].find(upload => upload.userId === userId);
    if (previous?.parser) throw busy();
    if (previous) this.remove(previous);
    if (this.uploads.size >= maxUploads) throw busy();
    const id = randomUUID();
    const bytes = Buffer.alloc(size);
    const timer = setTimeout(() => {
      const upload = this.uploads.get(id);
      if (upload) this.remove(upload);
    }, uploadTtlMs);
    timer.unref();
    this.uploads.set(id, { id, userId, fileName, format, bytes, uploadedBytes: 0, timer });
    return { id };
  }

  append(userId: string, id: string, body: unknown): { uploadedBytes: number } {
    const upload = this.get(userId, id);
    const { bytes } = upload;
    if (!bytes) throw busy();
    const { offset, contentBase64 } = record(body, ['offset', 'contentBase64']);
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length || offset % RESUME_IMPORT_CHUNK_BYTES !== 0) {
      invalid('上传分段位置无效。');
    }
    const length = Math.min(RESUME_IMPORT_CHUNK_BYTES, bytes.length - offset);
    if (typeof contentBase64 !== 'string' || contentBase64.length !== Math.ceil(length / 3) * 4) invalid('上传分段长度无效。');
    const part = Buffer.from(contentBase64, 'base64');
    if (part.length !== length || part.toString('base64') !== contentBase64) invalid('上传分段内容无效。');
    if (offset === upload.uploadedBytes) {
      part.copy(bytes, offset);
      upload.uploadedBytes += length;
    } else if (offset > upload.uploadedBytes || !bytes.subarray(offset, offset + length).equals(part)) {
      throw new HttpError(409, 'RESUME_IMPORT_CHUNK_CONFLICT', '上传分段不一致，请重新选择文件。');
    }
    return { uploadedBytes: upload.uploadedBytes };
  }

  async parse(userId: string, id: string, signal: AbortSignal): Promise<ImportedResume> {
    const upload = this.get(userId, id);
    const { bytes, fileName, format } = upload;
    if (this.parsing || !bytes) throw busy();
    if (upload.uploadedBytes !== bytes.length) throw new HttpError(409, 'RESUME_IMPORT_INCOMPLETE', '文件还未传完，请重新导入。');
    this.parsing = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    upload.parser = controller;
    upload.bytes = undefined;
    clearTimeout(upload.timer);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = await parseInProcess({ bytes, format }, controller.signal);
      if (controller.signal.aborted) throw cancelled();
      return { ...result, fileName, format };
    } finally {
      signal.removeEventListener('abort', abort);
      this.remove(upload);
      this.parsing = false;
    }
  }

  cancel(userId: string, id: string): ResumeImportUpload {
    this.remove(this.get(userId, id));
    return { id };
  }

  stop() {
    for (const upload of this.uploads.values()) this.remove(upload);
  }

  private get(userId: string, id: string): Upload {
    const upload = this.uploads.get(id);
    if (upload?.userId !== userId) notFound('文件导入会话');
    return upload;
  }

  private remove(upload: Upload) {
    this.uploads.delete(upload.id);
    clearTimeout(upload.timer);
    upload.parser?.abort();
    upload.bytes = undefined;
  }
}
