import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getResumeSectionKind, isResumeSectionTitle, normalizeResumeHeading,
  type ResumeSectionKind,
} from '../src/utils/resumeSections.ts'

test('recognizes whole combined education, credentials and work/internship headings', () => {
  const headings: [string, ResumeSectionKind][] = [
    ['教育学历', 'education'], ['学历与学位', 'education'], ['教育与培训', 'education'],
    ['工作实习经历', 'experience'], ['工作/实习经历', 'experience'], ['工作 / 实习经历', 'experience'],
    ['工作与实习经历', 'experience'], ['实习与实践经历', 'experience'],
    ['技能证书', 'credentials'], ['技能与证书', 'credentials'], ['技能 / 证书', 'credentials'],
    ['专业技能与证书', 'credentials'], ['证书与技能', 'credentials'], ['证书与资质', 'credentials'],
    ['专业技能', 'skills'], ['项目与科研经历', 'projects'], ['个人简介', 'summary'],
  ]
  for (const [title, kind] of headings) {
    assert.equal(isResumeSectionTitle(title), true, title)
    assert.equal(getResumeSectionKind(title), kind, title)
  }
})

test('retains support for all original export parser heading aliases', () => {
  const originalHeadings = [
    '个人简介', '自我介绍', '自我评价', '个人优势', '求职意向', '基本信息', '个人信息', '联系方式',
    '教育经历', '教育背景', '学习经历', '工作经历', '工作经验', '职业经历', '实习经历', '实习经验',
    '项目经历', '项目经验', '项目介绍', '专业技能', '技术技能', '核心技能', '技能', '技能清单', '技能特长',
    '专业能力', '证书', '资格证书', '专业证书', '荣誉奖项', '荣誉奖励', '获奖', '获奖经历', '获奖情况',
    '奖项荣誉', '竞赛经历', '校园经历', '校园活动', '社会实践', '志愿经历', '语言能力', '兴趣爱好', '其他',
  ]
  for (const title of originalHeadings) assert.equal(isResumeSectionTitle(title), true, title)
})

test('normalizes only whitespace, boundary colons and matching bracket decorations', () => {
  assert.equal(normalizeResumeHeading('  【 教育背景： 】 ：  '), '教育背景')
  assert.equal(normalizeResumeHeading('\t[【工作/实习经历】]:\t'), '工作/实习经历')
  assert.equal(normalizeResumeHeading('： [ 技能证书 ] ：'), '技能证书')
  assert.equal(isResumeSectionTitle('  【学历与学位】： '), true)
  assert.equal(getResumeSectionKind('[【技能证书】]：'), 'credentials')
  assert.equal(normalizeResumeHeading(' 工作 / 实习经历 '), '工作 / 实习经历')
  assert.equal(normalizeResumeHeading(' 项目经历：开发一个管理系统，保留正文。 '), '项目经历：开发一个管理系统，保留正文。')
  assert.equal(normalizeResumeHeading(' # 教育背景 '), '# 教育背景')
})

test('does not promote sentences, partial matches, malformed decorations or numbered text to headings', () => {
  const ordinaryLines = [
    '参与教育背景信息录入模块，保留这句话而不误当章节。',
    '项目经历：开发一个管理系统，这是一整句正文。',
    '技能证书尚未取得，请勿写入已持有证书。',
    '本科毕业，具备相关工作与实习经历。',
    '【专业技能】TypeScript、Vue', '教育背景如下', '工作经历（持续更新）',
    '【教育背景]', '[技能证书】', '教育\n背景', '# 教育背景', '1. 工作经历', '- 专业技能', '', '   ',
  ]
  for (const line of ordinaryLines) {
    assert.equal(isResumeSectionTitle(line), false, line)
    assert.equal(getResumeSectionKind(line), 'other', line)
  }
})

test('classification leaves original decorated titles and factual body strings unchanged', () => {
  const section = Object.freeze({
    title: '  【工作 / 实习经历】：  ',
    body: '参与测试；尚未获得证书；未提供公司、日期或量化成果。\n项目经历：此行仍是正文。',
  })
  const original = { ...section }
  assert.equal(getResumeSectionKind(section.title), 'experience')
  assert.equal(isResumeSectionTitle(section.title), true)
  assert.equal(isResumeSectionTitle(section.body), false)
  assert.deepEqual(section, original)
  assert.equal(section.title, '  【工作 / 实习经历】：  ')
  assert.equal(section.body, original.body)
})
