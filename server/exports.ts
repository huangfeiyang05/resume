import { Worker } from 'node:worker_threads';
import type { Resume, ResumeExportFile, ResumeExportInput } from '../shared/types.js';
import { safeResumeFileName } from '../shared/resume-layout.js';
import { HttpError, invalid } from './errors.js';
import type { ResumeService } from './service.js';

let active = false;
export function validateExportInput(body: unknown): ResumeExportInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('导出参数必须是 JSON 对象。');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['revision', 'format', 'template'].includes(key))) invalid('导出只支持简历版本、格式和版式，正文由服务端读取。');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) invalid('请选择已保存的简历版本。');
  if (!['docx', 'pdf'].includes(value.format as string) || !['minimal', 'modern', 'business'].includes(value.template as string)) invalid('请选择 Word 或 PDF，以及有效的简历版式。');
  return value as unknown as ResumeExportInput;
}
function generate(resume: Resume, input: ResumeExportInput, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith('.ts');
    const url = new URL(source ? './export-worker.ts' : './export-worker.js', import.meta.url);
    const worker = source
      ? new Worker(`import('tsx/esm/api').then(({register})=>{register();return import(require('node:worker_threads').workerData.moduleUrl)}).catch(()=>process.exit(1));`, { eval: true, workerData: { resume, ...input, moduleUrl: url.href }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
      : new Worker(url, { workerData: { resume, ...input }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const finish = (error?: HttpError, buffer?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); void worker.terminate();
      if (error) reject(error); else resolve(buffer!);
    };
    const cancel = () => finish(new HttpError(409, 'EXPORT_CANCELLED', '导出已取消，没有生成下载文件。'));
    const timer = setTimeout(() => finish(new HttpError(504, 'EXPORT_TIMEOUT', '生成文件超时，请稍后重试。')), 20_000);
    worker.once('message', result => {
      if (!result?.bytes) return finish(new HttpError(502, 'EXPORT_RENDER_FAILED', '文件未能生成，请检查正文后重试。'));
      const bytes = Buffer.from(result.bytes);
      if (bytes.length > 8 * 1024 * 1024) return finish(new HttpError(413, 'EXPORT_TOO_LARGE', '导出文件过大，请精简简历后重试。'));
      finish(undefined, bytes);
    });
    worker.once('error', () => finish(new HttpError(502, 'EXPORT_RENDER_FAILED', '文件未能生成，请稍后重试。')));
    worker.once('exit', () => { if (!settled) finish(new HttpError(502, 'EXPORT_RENDER_FAILED', '文件生成中断，请稍后重试。')); });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
export async function exportResume(service: ResumeService, id: string, body: unknown, signal: AbortSignal): Promise<ResumeExportFile> {
  const input = validateExportInput(body);
  const resume = await service.getResume(id);
  if (resume.revision !== input.revision) throw new HttpError(409, 'REVISION_CONFLICT', '简历已更新，请重新载入预览再导出。');
  if (active) throw new HttpError(429, 'EXPORT_BUSY', '当前有文件正在生成，请稍后重试。');
  active = true;
  try {
    const buffer = await generate(resume, input, signal);
    const current = await service.getResume(id);
    if (current.revision !== input.revision) throw new HttpError(409, 'REVISION_CONFLICT', '生成期间简历已更新，请重新预览后导出。');
    if (signal.aborted) throw new HttpError(409, 'EXPORT_CANCELLED', '导出已取消。');
    return { ...input, resumeId: id, fileName: `${safeResumeFileName(resume.title)}.${input.format}`, mimeType: input.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBase64: buffer.toString('base64') };
  } finally { active = false; }
}
