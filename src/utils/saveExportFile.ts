import type { ResumeExportFile } from '../../shared/types'

export type ExportFileSaveResult = 'download-started' | 'file-opened'

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const MIME_TYPES: Record<ResumeExportFile['format'], string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
}
const EXTENSIONS: Record<ResumeExportFile['format'], string> = { docx: '.docx', pdf: '.pdf' }
const SIGNATURES: Record<ResumeExportFile['format'], readonly number[]> = {
  docx: [0x50, 0x4b, 0x03, 0x04],
  pdf: [0x25, 0x50, 0x44, 0x46],
}
const INVALID_FILE = '导出文件内容无效，请重新导出。'
const PLATFORM_UNSUPPORTED = '当前平台暂不支持导出文件，请在网页版导出。'

/** Decode standard base64 without relying on atob, which some mini program runtimes lack. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.replace(/[\r\n\t ]/g, '')
  if (!clean.length) return new Uint8Array(0)
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error(INVALID_FILE)
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array(clean.length / 4 * 3 - padding)
  let offset = 0
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = clean.slice(index, index + 4)
    const values = chunk.split('').map(character => character === '=' ? 0 : BASE64_ALPHABET.indexOf(character))
    if (values.some(value => value < 0) || (chunk.includes('=') && index !== clean.length - 4)) throw new Error(INVALID_FILE)
    bytes[offset++] = (values[0]! << 2) | (values[1]! >> 4)
    if (offset < bytes.length) bytes[offset++] = ((values[1]! & 0x0f) << 4) | (values[2]! >> 2)
    if (offset < bytes.length) bytes[offset++] = ((values[2]! & 0x03) << 6) | values[3]!
  }
  return bytes
}

/** Server-provided names are sanitized already; still guarantee a safe download name and the right extension. */
export function resolveExportFileName(file: Pick<ResumeExportFile, 'fileName' | 'format'>): string {
  const name = file.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100)
  const extension = EXTENSIONS[file.format]
  return name.toLowerCase().endsWith(extension) ? name : `${name || '我的简历'}${extension}`
}

/** Reject a mismatched MIME type or an error page before it reaches the user's disk. */
export function assertExportFile(file: Pick<ResumeExportFile, 'format' | 'mimeType' | 'contentBase64'>): void {
  if (file.mimeType !== MIME_TYPES[file.format]) throw new Error(INVALID_FILE)
  const prefix = base64ToBytes(file.contentBase64.slice(0, 16))
  const signature = SIGNATURES[file.format]
  if (prefix.length < signature.length || signature.some((byte, index) => prefix[index] !== byte)) throw new Error(INVALID_FILE)
}

/** The subset of the WeChat file APIs the export needs, injected so the flow stays testable. */
export interface ExportDocumentPlatform {
  env: { USER_DATA_PATH: string }
  getFileSystemManager(): {
    writeFile(options: {
      filePath: string
      data: string
      encoding: 'base64'
      success(): void
      fail(result: { errMsg?: string }): void
    }): void
  }
  openDocument(options: {
    filePath: string
    fileType: 'docx' | 'pdf'
    showMenu: boolean
    success(): void
    fail(result: { errMsg?: string }): void
  }): void
}

/** Resolve only after the platform has actually opened the generated document. */
export async function openResumeExportFile(file: ResumeExportFile, platform: ExportDocumentPlatform): Promise<'file-opened'> {
  assertExportFile(file)
  const filePath = `${platform.env.USER_DATA_PATH}/${resolveExportFileName(file)}`
  return new Promise((resolve, reject) => {
    platform.getFileSystemManager().writeFile({
      filePath,
      data: file.contentBase64,
      encoding: 'base64',
      success() {
        try {
          platform.openDocument({
            filePath,
            fileType: file.format,
            showMenu: true,
            success: () => resolve('file-opened'),
            fail: () => reject(new Error('简历文件已生成，但当前微信无法打开，请稍后重试。')),
          })
        } catch {
          reject(new Error('简历文件已生成，但当前微信无法打开，请稍后重试。'))
        }
      },
      fail: () => reject(new Error('简历文件保存失败，请检查微信存储空间后重试。')),
    })
  })
}

// #ifdef H5
/** A resolved browser result means the download was started, not that it was saved. */
function downloadExportFileInBrowser(file: ResumeExportFile): 'download-started' {
  if (typeof window === 'undefined' || typeof document === 'undefined') throw new Error(PLATFORM_UNSUPPORTED)
  assertExportFile(file)
  const objectUrl = URL.createObjectURL(new Blob([base64ToBytes(file.contentBase64)], { type: file.mimeType }))
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = resolveExportFileName(file)
    document.body.appendChild(link)
    link.click()
    link.remove()
    return 'download-started'
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)
  }
}
// #endif

export async function saveResumeExportFile(file: ResumeExportFile): Promise<ExportFileSaveResult> {
  assertExportFile(file)
  // #ifdef H5
  return downloadExportFileInBrowser(file)
  // #endif
  // #ifdef MP-WEIXIN
  return openResumeExportFile(file, uni as unknown as ExportDocumentPlatform)
  // #endif
  // #ifndef H5
  // #ifndef MP-WEIXIN
  throw new Error(PLATFORM_UNSUPPORTED)
  // #endif
  // #endif
}
