import assert from 'node:assert/strict'
import test from 'node:test'
import {
  escapeHtml, getResumeBodySegments, getResumeLayoutColumns, parseResumeText, resumeToText, safeResumeFileName,
} from '../shared/resume-layout.ts'

const RESUME_TEXT = [
  '林一',
  '前端开发工程师 | 上海',
  'linyi@example.com  13800138000',
  '以下所有经历均由本人提供。',
  '',
  '个人简介',
  '关注产品体验与可维护性，不修改真实经历。',
  '',
  '【教育背景】',
  '某大学 | 计算机科学 | 2020.09–2024.06',
  '工作经历：',
  '示例科技 | 前端开发 | 2024.07–至今',
  '项目经历',
  '参与教育背景信息录入模块，保留这句话而不误当章节。',
  '项目经历：开发一个管理系统，这是一整句正文。',
  '专业技能',
  'Vue 3、TypeScript；接触过 Java，不推断熟练度。',
  '证书',
  '英语六级',
  '获奖',
  '校级奖学金',
].join('\n')

function meaningfulLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim().length > 0)
}

test('parses explicit headings without inferring contacts or changing any original line', () => {
  const parsed = parseResumeText(RESUME_TEXT, '林一的求职简历')
  assert.equal(parsed.name, '林一')
  assert.equal(parsed.title, '林一的求职简历')
  assert.equal(parsed.role, undefined)
  assert.equal(parsed.contact, undefined)
  assert.equal(parsed.sections[0]?.title, '')
  assert.equal(parsed.sections[0]?.body, '前端开发工程师 | 上海\nlinyi@example.com  13800138000\n以下所有经历均由本人提供。\n')
  assert.deepEqual(parsed.sections.slice(1).map(section => section.title), [
    '个人简介', '【教育背景】', '工作经历：', '项目经历', '专业技能', '证书', '获奖',
  ])
  assert.deepEqual(meaningfulLines(resumeToText(parsed)), meaningfulLines(RESUME_TEXT))
  assert.ok(parsed.sections.find(section => section.title === '项目经历')?.body.includes('项目经历：开发一个管理系统，这是一整句正文。'))
})

test('preserves duplicate headings, empty sections, blank body lines and heading-only input', () => {
  const parsed = parseResumeText('张三\n教育经历\n\n某大学\n项目经历\n项目经历\n\n')
  assert.deepEqual(parsed.sections, [
    { title: '教育经历', body: '\n某大学' },
    { title: '项目经历', body: '' },
    { title: '项目经历', body: '\n' },
  ])
  const noName = parseResumeText('教育经历\r\n某大学\r\n专业技能\r\nTypeScript')
  assert.equal(noName.name, undefined)
  assert.equal(noName.sections[0]?.title, '教育经历')
  assert.deepEqual(meaningfulLines(resumeToText(noName)), ['教育经历', '某大学', '专业技能', 'TypeScript'])
  assert.equal(parseResumeText('王五').name, '王五')
  assert.equal(parseResumeText('王五').title, '王五')
  assert.equal(parseResumeText('').name, undefined)
  assert.equal(parseResumeText('').title, '我的简历')
})

test('groups degree, internship and combined certificate headings without adding qualifications', () => {
  const text = '姓名待填写\n学历与学位\n院校及学历由本人填写\n工作/实习经历\n仅保留本人提供的岗位与日期\n技能与证书\n证书名称及取得时间待本人补充'
  const parsed = parseResumeText(text)
  assert.deepEqual(parsed.sections.map(section => section.title), ['学历与学位', '工作/实习经历', '技能与证书'])
  assert.deepEqual(meaningfulLines(resumeToText(parsed)), meaningfulLines(text))
  const columns = getResumeLayoutColumns(parsed.sections, 'modern')
  assert.deepEqual(columns.main.map(section => section.title), ['学历与学位', '工作/实习经历'])
  assert.deepEqual(columns.sidebar.map(section => section.title), ['技能与证书'])
})

test('layout columns keep every section exactly once in source order inside each column', () => {
  const parsed = parseResumeText(RESUME_TEXT, '林一的求职简历')
  const minimal = getResumeLayoutColumns(parsed.sections, 'minimal')
  assert.deepEqual(minimal.main, parsed.sections)
  assert.deepEqual(minimal.sidebar, [])
  for (const template of ['modern', 'business'] as const) {
    const columns = getResumeLayoutColumns(parsed.sections, template)
    assert.deepEqual(columns.sidebar.map(section => section.title), ['个人简介', '专业技能', '证书', '获奖'])
    assert.deepEqual(columns.main.map(section => section.title), ['', '【教育背景】', '工作经历：', '项目经历'])
    const flattened = [...columns.main, ...columns.sidebar]
    assert.equal(flattened.length, parsed.sections.length)
    assert.deepEqual([...flattened].sort((one, two) => one.title.localeCompare(two.title)), [...parsed.sections].sort((one, two) => one.title.localeCompare(two.title)))
    assert.equal(flattened.find(section => section.title === '专业技能')?.body, 'Vue 3、TypeScript；接触过 Java，不推断熟练度。')
  }
})

test('a resume made only of secondary sections keeps the full readable column', () => {
  const parsed = parseResumeText('王五\n个人简介\n一段真实简介。\n专业技能\nTypeScript')
  for (const template of ['modern', 'business'] as const) {
    const columns = getResumeLayoutColumns(parsed.sections, template)
    assert.deepEqual(columns.main, parsed.sections)
    assert.deepEqual(columns.sidebar, [])
  }
})

test('emphasizes explicit experience labels losslessly without interpreting prose or accepting markup', () => {
  const body = '单位与岗位 日期待填写\n  项目描述：保留 <script>evil()</script>\n职责范围:本人分工\n技术栈：本人使用的工具\n在正文中提到项目描述：仍是普通正文。'
  const segments = getResumeBodySegments(body)
  assert.equal(segments.map(part => part.text).join(''), body)
  assert.deepEqual(segments.filter(part => part.emphasis).map(part => part.text), ['项目描述：', '职责范围:', '技术栈：'])
  assert.deepEqual(getResumeBodySegments(''), [{ text: '', emphasis: false }])
  assert.deepEqual(getResumeBodySegments('只有正文'), [{ text: '只有正文', emphasis: false }])
})

test('escapes every structured user field without affecting plain text parsing', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
  assert.equal(escapeHtml('普通正文 TypeScript'), '普通正文 TypeScript')
  const text = '张三<script>alert(1)</script>\n保留 <img src=x onerror="evil()"> & 这句话\n项目经历\n</p><script>evil()</script>'
  assert.deepEqual(meaningfulLines(resumeToText(parseResumeText(text))), meaningfulLines(text))
})

test('sanitizes download file names and falls back to a readable title', () => {
  assert.equal(safeResumeFileName('前端 / 高级版:2026'), '前端 _ 高级版_2026')
  assert.equal(safeResumeFileName('   '), '我的简历')
  assert.equal(safeResumeFileName(''), '我的简历')
  assert.equal(safeResumeFileName('a'.repeat(120)).length, 80)
  assert.equal(safeResumeFileName('正常名称'), '正常名称')
})
