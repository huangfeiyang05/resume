export const careerFileLimits = { bytes: 10 * 1024 * 1024, chunkBytes: 144 * 1024 } as const;
export const careerFileTypes = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;
export type CareerFileFormat = keyof typeof careerFileTypes;

export interface CareerAttachment {
  id: string;
  format: CareerFileFormat;
  fileName: string;
  bytes: number;
}

export const careerFileFallbackText = '请打开资料文件阅读正文。';
export const careerFileIdPattern = /^[a-f0-9]{64}$/;
export function careerFileFormat(fileName: string): CareerFileFormat | undefined {
  const extension = fileName.split('.').at(-1)?.toLowerCase();
  if (extension === 'pdf' || extension === 'docx') return extension;
}

export function isCareerAttachment(value: unknown): value is CareerAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 4 && typeof item.id === 'string' && careerFileIdPattern.test(item.id)
    && (item.format === 'pdf' || item.format === 'docx')
    && typeof item.fileName === 'string' && item.fileName.length <= 120 && item.fileName.includes('.')
    && !/[\\/:*?"<>|\u0000-\u001f\u007f\ud800-\udfff]/u.test(item.fileName) && careerFileFormat(item.fileName) === item.format
    && typeof item.bytes === 'number' && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= careerFileLimits.bytes;
}
