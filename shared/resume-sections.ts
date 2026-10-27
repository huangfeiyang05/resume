export type ResumeSectionKind = 'education' | 'experience' | 'projects' | 'skills' | 'credentials' | 'summary' | 'other'

// Explicit aliases only. Mentioning one of these words inside a sentence is not a heading.
const SECTION_TITLES: Record<ResumeSectionKind, readonly string[]> = {
  education: [
    '教育经历', '教育背景', '学习经历', '学习背景', '教育信息', '教育情况',
    '学历', '学历背景', '学历信息', '学历经历', '学历教育', '教育学历',
    '教育与学历', '教育及学历', '学历学位', '学历与学位', '学历及学位',
    '教育培训', '教育与培训', '教育及培训', '培训经历', '学术背景',
  ],
  experience: [
    '工作经历', '工作经验', '职业经历', '实习经历', '实习经验', '实践经历',
    '工作实习', '工作与实习', '工作及实习', '工作和实习', '工作/实习', '工作 / 实习', '工作／实习',
    '工作实习经历', '工作与实习经历', '工作及实习经历', '工作和实习经历',
    '工作/实习经历', '工作 / 实习经历', '工作／实习经历', '工作与实习经验', '工作/实习经验',
    '实习工作经历', '实习与工作经历', '实习及工作经历',
    '实习实践', '实习与实践', '实习及实践', '实习实践经历',
    '实习与实践经历', '实习及实践经历', '实习/实践经历', '实习 / 实践经历', '实践与实习经历',
    '相关经历', '相关工作经历', '相关实习经历', '专业实践',
    '校园经历', '校园活动', '社会实践', '志愿经历', '志愿服务', '志愿服务经历',
  ],
  projects: [
    '项目经历', '项目经验', '项目介绍', '项目实践', '项目成果',
    '科研经历', '科研经验', '研究经历', '研究项目', '科研项目', '学术项目',
    '工程项目', '课程项目', '设计项目', '项目与科研', '项目与科研经历', '科研与项目经历',
    '竞赛经历', '竞赛项目', '项目与竞赛经历',
  ],
  skills: [
    '专业技能', '技术技能', '核心技能', '技能', '技能清单', '技能特长', '专业能力', '语言能力',
    '技术能力', '技能能力', '技能与能力', '技能及能力', '专业技术技能',
    '计算机技能', '软件技能', '工具技能', '语言技能', '职业技能', '技能概览',
  ],
  credentials: [
    '证书', '资格证书', '专业证书', '资质证书', '证书资质', '职业资格', '职业资格证书',
    '专业资格', '执业资格', '执业证书', '资格与证书', '资质与证书', '证书与资质',
    '资质及证书', '证书及资质', '证书与资格', '证书及资格',
    '技能证书', '技能与证书', '技能及证书', '技能和证书', '技能/证书', '技能 / 证书', '技能／证书',
    '专业技能与证书', '专业技能及证书', '专业技能/证书', '专业技能 / 证书',
    '技能与资格证书', '专业技能与资质', '技能与资质', '技能及资质',
    '证书与技能', '证书及技能', '技能证书与荣誉', '语言及技能证书',
    '荣誉奖项', '荣誉奖励', '获奖', '获奖经历', '获奖情况', '奖项荣誉', '奖项',
    '获奖与荣誉', '奖项与荣誉', '奖励与荣誉', '证书荣誉',
    '荣誉与证书', '荣誉及证书', '证书与荣誉', '证书及荣誉',
  ],
  summary: ['个人简介', '自我介绍', '自我评价', '个人优势', '求职意向', '职业目标', '个人总结'],
  other: [
    '基本信息', '个人信息', '联系方式', '兴趣爱好', '兴趣与爱好', '其他', '其他信息', '补充信息',
    '附加信息', '作品集', '公开成果',
  ],
}

const kindByTitle = new Map<string, ResumeSectionKind>()
for (const [kind, titles] of Object.entries(SECTION_TITLES)) {
  for (const title of titles) kindByTitle.set(title, kind as ResumeSectionKind)
}

/** Normalize heading decorations for lookup only; callers retain the original title and body. */
export function normalizeResumeHeading(title: string): string {
  let normalized = title.trim()
  let previous: string
  do {
    previous = normalized
    normalized = normalized.replace(/^[：:]+|[：:]+$/g, '').trim()
    if ((normalized.startsWith('【') && normalized.endsWith('】')) ||
      (normalized.startsWith('[') && normalized.endsWith(']'))) {
      normalized = normalized.slice(1, -1).trim()
    }
  } while (normalized !== previous)
  return normalized
}

export function isResumeSectionTitle(line: string): boolean {
  return kindByTitle.has(normalizeResumeHeading(line))
}

/** Classify only explicit known headings, without interpreting or changing resume facts. */
export function getResumeSectionKind(title: string): ResumeSectionKind {
  return kindByTitle.get(normalizeResumeHeading(title)) ?? 'other'
}
