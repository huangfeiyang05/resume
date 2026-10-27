export interface ResumeTemplateDownload {
  path: string
  fileName: string
}

export type ResumeTemplateDownloadResult = 'download-started' | 'document-opened'

const TEMPLATE_PATHS = new Set([
  '/static/resume-templates/classic-onyx.docx',
  '/static/resume-templates/blue-azurill.docx',
  '/static/resume-templates/navy-chikorita.docx',
])
const WEB_FALLBACK = '请在网页版「发现」下载 Word 模板。'

function requireTemplatePath(path: string): void {
  if (!TEMPLATE_PATHS.has(path)) throw new Error('未找到这份 Word 模板，请刷新页面后重试。')
}

/** Only a configured public HTTPS site can supply files to the WeChat document viewer. */
export function resolveResumeTemplateUrl(path: string, configuredBase: string | undefined): string {
  requireTemplatePath(path)
  const unavailable = () => new Error(`微信版暂未配置可用的模板下载地址，${WEB_FALLBACK}`)
  // Avoid the browser-only URL API: this helper also runs in mp-weixin.
  const match = /^https:\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/[a-z0-9._~/-]*)?$/i.exec(configuredBase?.trim() || '')
  if (!match) throw unavailable()
  const host = match[1]!.toLowerCase()
  const labels = host.split('.')
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
    || !/[a-z]/i.test(labels.at(-1)!) || /\.(?:localhost|local|internal)$/i.test(host)
    || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) throw unavailable()
  const basePath = match[3] || ''
  if (basePath.split('/').some(segment => segment === '.' || segment === '..')) throw unavailable()
  return `${match[0].replace(/\/+$/, '')}${path}`
}

interface TemplateDocumentPlatform {
  downloadFile(options: {
    url: string
    timeout: number
    success(result: { statusCode: number; tempFilePath: string }): void
    fail(): void
  }): unknown
  openDocument(options: {
    filePath: string
    fileType: 'docx'
    showMenu: boolean
    success(): void
    fail(): void
  }): unknown
}

/** Resolve only after the platform has actually opened the downloaded document. */
export function openResumeTemplateDocument(
  template: ResumeTemplateDownload,
  configuredBase: string | undefined,
  platform: TemplateDocumentPlatform,
): Promise<'document-opened'> {
  const url = resolveResumeTemplateUrl(template.path, configuredBase)
  return new Promise((resolve, reject) => {
    platform.downloadFile({
      url,
      timeout: 20000,
      success(result) {
        if (result.statusCode !== 200 || !result.tempFilePath) {
          reject(new Error(`Word 模板下载失败，请稍后重试，或${WEB_FALLBACK}`))
          return
        }
        try {
          platform.openDocument({
            filePath: result.tempFilePath,
            fileType: 'docx',
            showMenu: true,
            success: () => resolve('document-opened'),
            fail: () => reject(new Error(`Word 模板未能打开，请重试，或${WEB_FALLBACK}`)),
          })
        } catch {
          reject(new Error(`当前微信无法打开 Word 模板，${WEB_FALLBACK}`))
        }
      },
      fail: () => reject(new Error(`Word 模板下载失败，请检查网络后重试，或${WEB_FALLBACK}`)),
    })
  })
}

/** Invoke from a user action. A resolved H5 result means the download was started, not saved. */
export async function downloadResumeTemplate(template: ResumeTemplateDownload): Promise<ResumeTemplateDownloadResult> {
  requireTemplatePath(template.path)
  // #ifdef H5
  if (typeof window === 'undefined') throw new Error('请在浏览器中下载 Word 模板。')
  const basePath = (import.meta.env?.BASE_URL || '/').replace(/\/+$/, '')
  const base = new URL(`${basePath}/`, window.location.href)
  const source = new URL(template.path.slice(1), base)
  if (source.origin !== window.location.origin) throw new Error('模板地址不可用，请刷新页面后重试。')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 20000)
  let objectUrl: string | undefined
  try {
    const response = await fetch(source.href, { signal: controller.signal, credentials: 'same-origin' })
    if (!response.ok || response.redirected) throw new Error('download-failed')
    const blob = await response.blob()
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
    // DOCX is a ZIP package. Reject an HTML fallback instead of downloading an error page as Word.
    if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
      throw new Error('invalid-document')
    }
    objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    const name = template.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100)
    link.download = name.toLowerCase().endsWith('.docx') ? name : `${name || '简历模板'}.docx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    const downloadedUrl = objectUrl
    window.setTimeout(() => URL.revokeObjectURL(downloadedUrl), 10000)
    objectUrl = undefined
    return 'download-started'
  } catch {
    throw new Error('Word 模板下载失败，请检查网络后重试。')
  } finally {
    window.clearTimeout(timeout)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
  // #endif
  // #ifdef MP-WEIXIN
  return openResumeTemplateDocument(template, import.meta.env?.VITE_TEMPLATE_BASE_URL, uni)
  // #endif
  // #ifndef H5
  // #ifndef MP-WEIXIN
  throw new Error(WEB_FALLBACK)
  // #endif
  // #endif
}
