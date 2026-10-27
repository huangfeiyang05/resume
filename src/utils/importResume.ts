import { inputLimits } from '../../shared/limits'

/** Browser import stays local: resume files are never uploaded by this utility. */
export const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024
export const MAX_RESUME_PDF_PAGES = 50
export const MAX_RESUME_TEXT_LENGTH = inputLimits.resumeText

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
  | 'unsupported-platform'

export class ResumeImportError extends Error {
  constructor(public readonly code: ResumeImportErrorCode, message: string) {
    super(message)
    this.name = 'ResumeImportError'
  }
}

export function detectResumeFormat(fileName: string): ResumeFileFormat {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (extension === 'pdf' || extension === 'docx' || extension === 'txt' || extension === 'md') return extension
  if (extension === 'doc') {
    throw new ResumeImportError('unsupported-format', '暂不支持旧版 .doc，请用 Word 另存为 .docx，或粘贴简历正文。')
  }
  throw new ResumeImportError('unsupported-format', '请选择 PDF、Word（.docx）、TXT 或 Markdown 文件。')
}

export function validateResumeFile(fileName: string, size: number): ResumeFileFormat {
  const format = detectResumeFormat(fileName)
  if (size > MAX_RESUME_FILE_BYTES) throw new ResumeImportError('file-too-large', '文件超过 10 MB，请压缩文件或粘贴简历正文。')
  if (!Number.isFinite(size) || size <= 0) throw new ResumeImportError('empty-file', '文件为空，请选择有内容的简历。')
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

/** H5 only. Mini program uses its clipboard/paste flow or a future server parser. */
export async function importResumeFile(file: File): Promise<ImportedResume> {
  let supportsBrowserImport = false
  // #ifdef H5
  supportsBrowserImport = true
  // #endif
  if (!supportsBrowserImport) throw new ResumeImportError('unsupported-platform', '请粘贴简历正文；文件解析可在网页版本使用。')
  // #ifdef H5
  const format = validateResumeFile(file.name, file.size)
  const bytes = await file.arrayBuffer()
  const signature = new Uint8Array(bytes)
  let text = ''
  let pageCount: number | undefined
  try {
    if (format === 'pdf') {
      const prefix = new TextDecoder('latin1').decode(signature.subarray(0, 1024))
      if (!prefix.includes('%PDF-')) throw new ResumeImportError('invalid-file', '文件不是有效的 PDF，请重新导出后再导入。')
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      const loadingTask = pdfjs.getDocument({ data: bytes })
      try {
        const document = await loadingTask.promise
        pageCount = document.numPages
        if (pageCount > MAX_RESUME_PDF_PAGES) throw new ResumeImportError('too-many-pages', 'PDF 超过 50 页，请只导入简历页。')
        const pages: string[] = []
        for (let index = 1; index <= pageCount; index += 1) {
          const page = await document.getPage(index)
          const content = await page.getTextContent()
          pages.push(pdfTextItemsToText(content.items))
          page.cleanup()
        }
        text = pages.join('\n\n')
        if (!text.trim()) throw new ResumeImportError('scanned-pdf', '这份 PDF 没有可提取的文字，可能是扫描件。请先进行 OCR，或粘贴简历正文。')
      } finally {
        await loadingTask.destroy()
      }
    } else if (format === 'docx') {
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new ResumeImportError('invalid-file', '文件不是有效的 .docx，请用 Word 重新保存后再导入。')
      // @ts-expect-error Mammoth ships declarations for its main entry, but not this browser bundle.
      const bundle = await import('mammoth/mammoth.browser.js') as typeof import('mammoth') & { default?: typeof import('mammoth') }
      const mammoth = bundle.default ?? bundle
      const result = await mammoth.extractRawText({ arrayBuffer: bytes })
      text = result.value
    } else {
      if (signature.includes(0)) throw new ResumeImportError('invalid-file', '文本文件包含二进制内容，请保存为 UTF-8 编码后重试。')
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new ResumeImportError('invalid-file', '文本不是 UTF-8 编码，请另存为 UTF-8，或直接粘贴简历正文。')
      }
    }
    text = normalizeImportedText(text)
    if (!text) throw new ResumeImportError('empty-file', '没有读取到简历正文，请检查文件或粘贴文字。')
    return { text, fileName: file.name, format, ...(pageCount === undefined ? {} : { pageCount }) }
  } catch (error) {
    if (error instanceof ResumeImportError) throw error
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new ResumeImportError('password-protected', 'PDF 已加密，请移除密码后重试，或粘贴简历正文。')
    }
    throw new ResumeImportError('invalid-file', '文件解析失败，请检查文件是否损坏，或改用粘贴简历正文。')
  }
  // #endif
  throw new ResumeImportError('unsupported-platform', '请在网页版本导入文件。')
}
