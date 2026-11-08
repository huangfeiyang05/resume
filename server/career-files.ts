import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { careerFileFormat, careerFileIdPattern, careerFileLimits, isCareerAttachment, type CareerAttachment, type CareerFileFormat } from '../shared/career-attachment.js';
import { careerObject } from './career-validation.js';
import { HttpError, invalid, notFound } from './errors.js';

const uploadLifetime = 15 * 60_000;
const maxUploads = 4;
const maxStorageBytes = 512 * 1024 * 1024;
const maxFiles = 2000;
const storedFile = /^[a-f0-9]{64}\.(pdf|docx)$/;
const uploadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
interface Upload {
  actorId: string;
  chunks: Buffer[];
  bytes: number;
  touchedAt: number;
  finalizing?: boolean;
  attachment?: CareerAttachment;
}

function uploadId(value: unknown) {
  if (typeof value !== 'string' || !uploadIdPattern.test(value)) invalid('上传标识无效。');
  return value;
}

export function validateCareerAttachment(value: unknown): CareerAttachment {
  if (!isCareerAttachment(value)) invalid('资料文件信息无效，请重新上传。');
  return { id: value.id, fileName: value.fileName, bytes: value.bytes, format: value.format };
}

function fileDigest(format: CareerFileFormat, bytes: Buffer) {
  return createHash('sha256').update(format).update('\0').update(bytes).digest('hex');
}

async function validateFile(bytes: Buffer, format: CareerFileFormat) {
  if (format === 'pdf') {
    if (/^%PDF-[12]\.\d[\r\n]/.test(bytes.subarray(0, 12).toString('latin1'))
      && /%%EOF[ \t\r\n\f]*$/.test(bytes.subarray(-1024).toString('latin1'))) return;
    invalid('无法识别 PDF 文件，请重新导出后上传。');
  }
  try {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error();
    // Inspect the directory only. Never extract or execute the document or its embedded files.
    const zip = await JSZip.loadAsync(bytes);
    if (zip.file('[Content_Types].xml') && zip.file('_rels/.rels') && zip.file('word/document.xml')
      && !Object.keys(zip.files).some(name => /(?:^|\/)vbaProject\.bin$/i.test(name))) return;
  } catch { /* Return a safe validation message below. */ }
  invalid('无法识别 Word（.docx）文件，请重新导出后上传。');
}

export class CareerFiles {
  readonly directory: string;
  private uploads = new Map<string, Upload>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(databasePath: string) { this.directory = join(dirname(databasePath), 'career-files'); }

  private find(id: string, actorId: string) {
    const now = Date.now();
    for (const [key, upload] of this.uploads) {
      if (!upload.finalizing && now - upload.touchedAt >= uploadLifetime) this.uploads.delete(key);
    }
    const upload = this.uploads.get(id);
    if (upload && upload.actorId !== actorId) notFound('上传');
    if (upload) upload.touchedAt = now;
    return upload;
  }

  chunk(body: unknown, actorId: string) {
    const input = careerObject(body, ['uploadId', 'index', 'data']);
    const id = uploadId(input.uploadId), index = input.index, value = input.data;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0
      || typeof value !== 'string' || !value || value.length > careerFileLimits.chunkBytes * 4 / 3
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid('文件分片无效。');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) invalid('文件分片编码无效。');
    let upload = this.find(id, actorId);
    if (!upload) {
      if (index !== 0) notFound('上传');
      const active = [...this.uploads.values()].filter(item => !item.attachment);
      if (active.length >= maxUploads || active.some(item => item.actorId === actorId)) {
        throw new HttpError(429, 'CAREER_FILE_UPLOAD_BUSY', '已有资料文件正在上传，请完成、取消或稍后重试。');
      }
      // Completed receipts are small and short-lived. Keep the collection bounded.
      if (this.uploads.size >= 32) {
        const completed = [...this.uploads].find(([, item]) => item.attachment);
        if (completed) this.uploads.delete(completed[0]);
      }
      upload = { actorId, chunks: [], bytes: 0, touchedAt: Date.now() };
      this.uploads.set(id, upload);
    }
    if (upload.finalizing || upload.attachment) throw new HttpError(409, 'CAREER_FILE_UPLOAD_STATE', '该文件正在完成或已经上传。');
    if (index < upload.chunks.length && upload.chunks[index].equals(bytes)) return { receivedBytes: upload.bytes };
    if (index !== upload.chunks.length || (index > 0 && upload.chunks[index - 1].length !== careerFileLimits.chunkBytes)) {
      throw new HttpError(409, 'CAREER_FILE_CHUNK_CONFLICT', '文件分片顺序或内容不一致，请重新上传。');
    }
    if (upload.bytes + bytes.length > careerFileLimits.bytes) throw new HttpError(413, 'CAREER_FILE_TOO_LARGE', '资料文件不能超过 10 MB。');
    upload.chunks.push(bytes);
    upload.bytes += bytes.length;
    return { receivedBytes: upload.bytes };
  }

  async finish(body: unknown, actorId: string): Promise<CareerAttachment> {
    const input = careerObject(body, ['uploadId', 'fileName', 'bytes']);
    const upload = this.find(uploadId(input.uploadId), actorId) ?? notFound('上传');
    const name = typeof input.fileName === 'string' ? input.fileName.trim() : '';
    const format = careerFileFormat(name);
    if (!format || input.bytes !== upload.bytes) invalid('资料文件格式或长度不符。');
    if (upload.attachment) {
      if (upload.attachment.fileName !== name) invalid('该上传已使用其他文件名完成。');
      return upload.attachment;
    }
    if (upload.finalizing) throw new HttpError(409, 'CAREER_FILE_UPLOAD_STATE', '资料文件正在校验，请稍后重试。');
    const bytes = Buffer.concat(upload.chunks, upload.bytes);
    const attachment = validateCareerAttachment({ id: fileDigest(format, bytes), format, fileName: name, bytes: bytes.length });
    upload.finalizing = true;
    try {
      await validateFile(bytes, format);
      const write = this.writes.then(() => this.persist(attachment, bytes));
      this.writes = write.catch(() => undefined);
      await write;
      upload.attachment = attachment;
      upload.chunks = [];
      return attachment;
    } finally {
      upload.finalizing = false;
    }
  }

  cancel(body: unknown, actorId: string) {
    const id = uploadId(careerObject(body, ['uploadId']).uploadId);
    const upload = this.find(id, actorId);
    if (upload?.finalizing) throw new HttpError(409, 'CAREER_FILE_UPLOAD_STATE', '资料文件正在校验，请稍后重试。');
    if (upload && !upload.attachment) this.uploads.delete(id);
    return { cancelled: true };
  }

  private path(id: string, format: CareerFileFormat) { return join(this.directory, `${id}.${format}`); }

  async file(id: string, format: CareerFileFormat, expectedBytes?: number) {
    if (!careerFileIdPattern.test(id)) notFound('资料文件');
    let handle;
    try { handle = await open(this.path(id, format), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') notFound('资料文件');
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > careerFileLimits.bytes || (expectedBytes !== undefined && info.size !== expectedBytes)) {
        throw new HttpError(503, 'CAREER_FILE_UNAVAILABLE', '资料文件暂时不可读取。');
      }
      return { handle, bytes: info.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async verify(attachment: CareerAttachment) {
    const { handle } = await this.file(attachment.id, attachment.format, attachment.bytes);
    try {
      if (fileDigest(attachment.format, await handle.readFile()) !== attachment.id) {
        throw new HttpError(503, 'CAREER_FILE_UNAVAILABLE', '资料文件校验失败，请重新上传。');
      }
    } finally { await handle.close(); }
  }

  private async persist(attachment: CareerAttachment, bytes: Buffer) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(attachment.id, attachment.format);
    const present = await stat(path).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (present) return this.verify(attachment);
    const files = (await readdir(this.directory)).filter(name => storedFile.test(name));
    let used = 0;
    for (const name of files) used += (await stat(join(this.directory, name))).size;
    if (files.length >= maxFiles || used + bytes.length > maxStorageBytes) {
      throw new HttpError(409, 'CAREER_FILE_STORAGE_FULL', '资料文件存储已满，请联系维护人员。');
    }
    const temp = join(this.directory, `.${randomUUID()}.upload`);
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await link(temp, path);
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
