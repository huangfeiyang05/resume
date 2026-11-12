import { inputLimits } from './limits.js'
export const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024
export const MAX_RESUME_PDF_PAGES = 50
export const MAX_RESUME_TEXT_LENGTH = inputLimits.resumeText
// With base64 and JSON overhead, each request stays below the existing 256 KiB API limit.
export const RESUME_IMPORT_CHUNK_BYTES = 180 * 1024

export interface ImportSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface ResumeImportStart {
  fileName: string
  size: number
}

export interface ResumeImportChunk {
  offset: number
  contentBase64: string
}

export interface ResumeImportUpload {
  id: string
}

export type ResumeFileFormat = 'pdf' | 'docx' | 'txt' | 'md'
export interface ImportedResume {
  text: string
  fileName: string
  format: ResumeFileFormat
  pageCount?: number
}
export type ResumeImportErrorCode =
  | 'unsupported-format' | 'file-too-large' | 'too-many-pages' | 'empty-file'
  | 'scanned-pdf' | 'password-protected' | 'invalid-file' | 'text-too-long'
  | 'unsupported-platform' | 'cancelled'

export class ResumeImportError extends Error {
  constructor(public readonly code: ResumeImportErrorCode, message: string) {
    super(message)
    this.name = 'ResumeImportError'
  }
}

function cancelledImport(): ResumeImportError {
  return new ResumeImportError('cancelled', '文件解析已取消，原有简历内容未更改。')
}

export function checkImportSignal(signal?: ImportSignal): void {
  if (signal?.aborted) throw cancelledImport()
}

/** File reads and DOCX work cannot all be interrupted, but late results must never be accepted. */
export function awaitImport<T>(operation: Promise<T>, signal?: ImportSignal): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = () => finish(() => reject(cancelledImport()))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => finish(() => signal.aborted ? reject(cancelledImport()) : resolve(value)),
      error => finish(() => reject(signal.aborted ? cancelledImport() : error)),
    )
    if (signal.aborted) onAbort()
  })
}

function resumeExtension(fileName: string): string | undefined {
  return fileName.split('.').pop()?.toLowerCase()
}

export function detectResumeFormat(fileName: string): ResumeFileFormat {
  const extension = resumeExtension(fileName)
  if (extension === 'pdf' || extension === 'docx' || extension === 'txt' || extension === 'md') return extension
  if (extension === 'doc') {
    throw new ResumeImportError('unsupported-format', '暂不支持旧版 .doc，请用 Word 另存为 .docx，或粘贴简历正文。')
  }
  throw new ResumeImportError('unsupported-format', '请选择 PDF、Word（.docx）、TXT 或 Markdown 文件。')
}

function validateFileSize(size: number): void {
  if (size > MAX_RESUME_FILE_BYTES) throw new ResumeImportError('file-too-large', '文件超过 10 MB，请压缩文件或粘贴简历正文。')
  if (!Number.isFinite(size) || size <= 0) throw new ResumeImportError('empty-file', '文件为空，请选择有内容的简历。')
}

export function validateResumeFile(fileName: string, size: number): ResumeFileFormat {
  const format = detectResumeFormat(fileName)
  validateFileSize(size)
  return format
}

export function validateWechatResumeFile(fileName: string, size: number): 'docx' | 'pdf' {
  const format = resumeExtension(fileName)
  if (format !== 'docx' && format !== 'pdf') {
    const message = format === 'doc'
      ? '请用 Word 将 .doc 另存为 .docx，或粘贴简历正文。'
      : '请选择 Word（.docx）或 PDF 文件。'
    throw new ResumeImportError('unsupported-format', message)
  }
  validateFileSize(size)
  return format
}

export function normalizeImportedText(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (normalized.length > MAX_RESUME_TEXT_LENGTH) {
    throw new ResumeImportError('text-too-long', '正文超过 5 万字符，请只保留需要分析的简历内容。')
  }
  return normalized
}

/** Reconstruct lines from PDF text runs without flattening the whole page. */
export function pdfTextItemsToText(items: readonly unknown[]): string {
  let text = ''
  let previousY: number | undefined
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item)) continue
    const run = item as { str: string; hasEOL?: boolean; transform?: number[] }
    if (typeof run.str !== 'string') continue
    const y = run.transform?.[5]
    if (text && !text.endsWith('\n')) {
      if (y !== undefined && previousY !== undefined && Math.abs(y - previousY) > 3) text += '\n'
      else if (run.str && !text.endsWith(' ') && !/^\s/.test(run.str)) text += ' '
    }
    text += run.str
    if (run.hasEOL && !text.endsWith('\n')) text += '\n'
    if (y !== undefined) previousY = y
  }
  return text.trim()
}

interface ResumePdfLoadingTask {
  promise: Promise<{
    numPages: number
    getPage(index: number): Promise<{
      getTextContent(): Promise<{ items: readonly unknown[] }>
      cleanup(): unknown
    }>
  }>
  destroy(): Promise<void>
}

/** The PDF task owns its worker; abort destroys it even while loading or reading a page. */
export async function extractResumePdfText(loadingTask: ResumePdfLoadingTask, options: { signal?: ImportSignal } = {}): Promise<{ text: string; pageCount: number }> {
  const { signal } = options
  let destruction: Promise<void> | undefined
  const destroy = () => destruction ??= Promise.resolve().then(() => loadingTask.destroy())
  const onAbort = () => { void destroy().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    const document = await awaitImport(loadingTask.promise, signal)
    checkImportSignal(signal)
    const pageCount = document.numPages
    if (pageCount > MAX_RESUME_PDF_PAGES) throw new ResumeImportError('too-many-pages', 'PDF 超过 50 页，请只导入简历页。')
    const pages: string[] = []
    for (let index = 1; index <= pageCount; index += 1) {
      checkImportSignal(signal)
      const page = await awaitImport(document.getPage(index), signal)
      try {
        checkImportSignal(signal)
        const content = await awaitImport(page.getTextContent(), signal)
        checkImportSignal(signal)
        pages.push(pdfTextItemsToText(content.items))
      } finally {
        page.cleanup()
      }
    }
    checkImportSignal(signal)
    const text = pages.join('\n\n')
    if (!text.trim()) throw new ResumeImportError('scanned-pdf', '这份 PDF 没有可提取的文字，可能是扫描件。请先进行 OCR，或粘贴简历正文。')
    return { text, pageCount }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    const cleanup = destroy()
    if (signal?.aborted) void cleanup.catch(() => undefined)
    else await awaitImport(cleanup, signal)
  }
}
