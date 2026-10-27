import { getResumeSectionKind, isResumeSectionTitle } from './resume-sections.js'

export type ResumeExportTemplate = 'minimal' | 'modern' | 'business'
export interface ResumeExportDocument {
  title?: string
  name?: string
  role?: string
  contact?: string[]
  sections: { title: string; body: string }[]
}

/** Split explicit headings while keeping all original lines in their original order. */
export function parseResumeText(text: string, title?: string): ResumeExportDocument {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const firstLine = lines[0] ?? ''
  // Do not infer a role, phone number or email from ambiguous header text.
  const name = firstLine.trim() && !isResumeSectionTitle(firstLine) ? firstLine : undefined
  const sections: ResumeExportDocument['sections'] = []
  let current: { title: string; lines: string[] } | undefined
  const flush = () => {
    if (current) sections.push({ title: current.title, body: current.lines.join('\n') })
  }
  for (const line of lines.slice(name === undefined ? 0 : 1)) {
    if (isResumeSectionTitle(line)) {
      flush()
      current = { title: line, lines: [] }
    } else {
      current ??= { title: '', lines: [] }
      current.lines.push(line)
    }
  }
  flush()
  return { title: title || name || '我的简历', ...(name === undefined ? {} : { name }), sections }
}

/** Escape every user-provided string before writing into a print document. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function resumeToText(resume: ResumeExportDocument): string {
  const header = [resume.name, resume.role, resume.contact?.filter(Boolean).join(' · ')].filter(Boolean).join('\n')
  return [header, ...resume.sections.map(section => [section.title, section.body].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n')
}

export function safeResumeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '我的简历'
}

/** Emphasize explicit line-start labels only; concatenating segments reproduces the original body. */
export function getResumeBodySegments(body: string): { text: string; emphasis: boolean }[] {
  const parts: { text: string; emphasis: boolean }[] = []
  const labels = /^([ \t\u3000]*)(项目描述|职责范围|技术栈)([：:])/gm
  let cursor = 0
  for (const match of body.matchAll(labels)) {
    const start = match.index + match[1]!.length
    const end = match.index + match[0].length
    if (start > cursor) parts.push({ text: body.slice(cursor, start), emphasis: false })
    parts.push({ text: body.slice(start, end), emphasis: true })
    cursor = end
  }
  if (cursor < body.length || !parts.length) parts.push({ text: body.slice(cursor), emphasis: false })
  return parts
}

/** Place only explicit skills, credentials and summary headings in a secondary column. */
export function getResumeLayoutColumns<T extends { title: string }>(sections: readonly T[], template: ResumeExportTemplate): { main: T[]; sidebar: T[] } {
  if (template === 'minimal') return { main: [...sections], sidebar: [] }
  const sidebarKinds = new Set(['skills', 'credentials', 'summary'])
  const main: T[] = []
  const sidebar: T[] = []
  for (const section of sections) {
    const isSidebar = Boolean(section.title) && sidebarKinds.has(getResumeSectionKind(section.title))
    if (isSidebar) sidebar.push(section)
    else main.push(section)
  }
  // A resume consisting only of secondary sections still receives the full readable width.
  return main.length && sidebar.length ? { main, sidebar } : { main: [...sections], sidebar: [] }
}
