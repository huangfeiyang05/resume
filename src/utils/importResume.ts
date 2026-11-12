import {
  awaitImport, checkImportSignal, extractResumePdfText, normalizeImportedText,
  ResumeImportError, validateResumeFile, type ImportedResume, type ImportSignal,
} from '../../shared/resume-import'

export {
  detectResumeFormat, extractResumePdfText, MAX_RESUME_FILE_BYTES, MAX_RESUME_PDF_PAGES,
  MAX_RESUME_TEXT_LENGTH, normalizeImportedText, pdfTextItemsToText, ResumeImportError, validateResumeFile,
} from '../../shared/resume-import'
export type { ImportedResume, ResumeFileFormat, ResumeImportErrorCode } from '../../shared/resume-import'

/** H5 keeps file selection and parsing in the browser. */
export async function importResumeFile(file: File, options: { signal?: ImportSignal } = {}): Promise<ImportedResume> {
  let supportsBrowserImport = false
  // #ifdef H5
  supportsBrowserImport = true
  // #endif
  if (!supportsBrowserImport) throw new ResumeImportError('unsupported-platform', '请粘贴简历正文；文件解析可在网页版本使用。')
  // #ifdef H5
  const { signal } = options
  checkImportSignal(signal)
  const format = validateResumeFile(file.name, file.size)
  let text = ''
  let pageCount: number | undefined
  try {
    const bytes = await awaitImport(file.arrayBuffer(), signal)
    checkImportSignal(signal)
    const signature = new Uint8Array(bytes)
    if (format === 'pdf') {
      const prefix = new TextDecoder('latin1').decode(signature.subarray(0, 1024))
      if (!prefix.includes('%PDF-')) throw new ResumeImportError('invalid-file', '文件不是有效的 PDF，请重新导出后再导入。')
      const [pdfjs, worker] = await awaitImport(Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]), signal)
      checkImportSignal(signal)
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      const loadingTask = pdfjs.getDocument({ data: bytes })
      const result = await extractResumePdfText(loadingTask, { signal })
      text = result.text
      pageCount = result.pageCount
    } else if (format === 'docx') {
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new ResumeImportError('invalid-file', '文件不是有效的 .docx，请用 Word 重新保存后再导入。')
      // @ts-expect-error Mammoth ships declarations for its main entry, but not this browser bundle.
      const bundle = await awaitImport(import('mammoth/mammoth.browser.js'), signal) as typeof import('mammoth') & { default?: typeof import('mammoth') }
      checkImportSignal(signal)
      const mammoth = bundle.default ?? bundle
      const result = await awaitImport(mammoth.extractRawText({ arrayBuffer: bytes }), signal)
      checkImportSignal(signal)
      text = result.value
    } else {
      checkImportSignal(signal)
      if (signature.includes(0)) throw new ResumeImportError('invalid-file', '文本文件包含二进制内容，请保存为 UTF-8 编码后重试。')
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new ResumeImportError('invalid-file', '文本不是 UTF-8 编码，请另存为 UTF-8，或直接粘贴简历正文。')
      }
    }
    checkImportSignal(signal)
    text = normalizeImportedText(text)
    checkImportSignal(signal)
    if (!text) throw new ResumeImportError('empty-file', '没有读取到简历正文，请检查文件或粘贴文字。')
    return { text, fileName: file.name, format, ...(pageCount === undefined ? {} : { pageCount }) }
  } catch (error) {
    checkImportSignal(signal)
    if (error instanceof ResumeImportError) throw error
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new ResumeImportError('password-protected', 'PDF 已加密，请移除密码后重试，或粘贴简历正文。')
    }
    throw new ResumeImportError('invalid-file', '文件解析失败，请检查文件是否损坏，或改用粘贴简历正文。')
  }
  // #endif
  throw new ResumeImportError('unsupported-platform', '请在网页版本导入文件。')
}
