// Authored evaluation examples. Each resume and JD is synthetic.
export interface DiagnosisCase {
  id: string;
  role: string;
  resume: string;
  jd: string;
  guide: string | null;
  requirements: Array<{ text: string; priority: 'eligibility' | 'required' | 'preferred' | 'review' }>;
  evidence: Array<{ term: string; excerpt: string | null }>;
  focus?: string;
}
export const diagnosisCases: DiagnosisCase[] = [
  {
    id: 'software-campus', role: '前端开发', guide: 'cs-software',
    resume: '教育经历\n本科在读，预计2027届毕业。\n专业技能\nVue、JavaScript\n课程项目\n使用 Vue 实现社团活动报名页并整理组件说明。\n尚未使用 TypeScript。',
    jd: '岗位职责：开发活动页面。\n【任职要求】\n2027届，本科及以上。\n掌握 Vue 或 React 中的一种。\n熟悉 JavaScript。\n有 TypeScript 项目经验优先。',
    requirements: [{ text: '2027届', priority: 'eligibility' }, { text: 'Vue 或 React', priority: 'required' }, { text: 'TypeScript', priority: 'preferred' }],
    evidence: [{ term: 'Vue', excerpt: '使用 Vue 实现社团活动报名页' }, { term: 'React', excerpt: null }, { term: 'TypeScript', excerpt: '尚未使用 TypeScript' }],
    focus: '使用 Vue 实现社团活动报名页',
  },
  {
    id: 'data-intern', role: '数据分析实习生', guide: 'data-statistics',
    resume: '技能\nSQL、Excel。\n项目经历\n使用 SQL 核对问卷数据并整理异常记录。\n仅在课程中阅读过 Python 示例。',
    jd: '【职位要求】\n本科在读，每周至少 4 天，实习不少于 6 个月。\n掌握 SQL 与 Excel。\n加分项：有 Python 项目经验。',
    requirements: [{ text: '本科在读', priority: 'eligibility' }, { text: '至少 4 天', priority: 'eligibility' }, { text: '不少于 6 个月', priority: 'eligibility' }, { text: 'SQL 与 Excel', priority: 'required' }],
    evidence: [{ term: 'SQL', excerpt: '使用 SQL 核对问卷数据' }, { term: 'Python', excerpt: '阅读过 Python 示例' }],
    focus: '使用 SQL 核对问卷数据',
  },
  {
    id: 'manufacturing-campus', role: '设备工程师', guide: 'mechanical-electrical',
    resume: '专业技能\nPLC\n工程项目\n参与实训产线设备调试并整理故障排查记录。\n使用 PLC 实现模拟传送带控制。',
    jd: '必要条件：2027届，机械相关专业，本科及以上。\nCET-4 及以上。\n了解 PLC 和设备调试。\n有产线实习经验优先。',
    requirements: [{ text: '2027届', priority: 'eligibility' }, { text: 'CET-4', priority: 'eligibility' }, { text: 'PLC 和设备调试', priority: 'required' }],
    evidence: [{ term: 'PLC', excerpt: '使用 PLC 实现模拟传送带控制' }, { term: '设备调试', excerpt: '参与实训产线设备调试' }],
    focus: '参与实训产线设备调试',
  },
  {
    id: 'accounting-campus', role: '财务会计', guide: 'business-finance',
    resume: '专业技能\nExcel。\n实习经历\n协助用 Excel 核对费用报销台账，并归档对账记录。\n尚未参加 CPA 考试。',
    jd: '职责：整理会计凭证。\n要求：2027届，本科及以上，财会类相关专业。\n熟练使用 Excel，具备对账能力，有 CPA 考试经历优先。',
    requirements: [{ text: '本科及以上', priority: 'eligibility' }, { text: 'Excel', priority: 'required' }, { text: '对账能力', priority: 'required' }, { text: 'CPA', priority: 'preferred' }],
    evidence: [{ term: 'Excel', excerpt: '协助用 Excel 核对费用报销台账' }, { term: 'CPA', excerpt: '尚未参加 CPA 考试' }],
    focus: '协助用 Excel 核对费用报销台账',
  },
  {
    id: 'supply-chain-campus', role: '供应链规划运营', guide: 'supply-chain-logistics',
    resume: '技能\nExcel\n项目经历\n参与库存盘点，使用 Excel 核对出入库台账。\n尚未接触 SQL。',
    jd: '职位要求：2027届，本科及以上，供应链背景优先。\n熟练使用 Excel，了解 SQL、Python 或 R 中的一种。',
    requirements: [{ text: '2027届，本科及以上', priority: 'eligibility' }, { text: '供应链背景优先', priority: 'preferred' }, { text: 'SQL、Python 或 R 中的一种', priority: 'required' }],
    evidence: [{ term: 'Excel', excerpt: '使用 Excel 核对出入库台账' }, { term: 'SQL', excerpt: '尚未接触 SQL' }, { term: 'Python', excerpt: null }],
    focus: '使用 Excel 核对出入库台账',
  },
  {
    id: 'teaching-certificate', role: '小学教师', guide: 'education',
    resume: '实习经历\n参与教学设计并整理课堂观察记录。\n资格证书\n尚未取得教师资格证。',
    jd: '【招聘条件】持有教师资格证。\n具备课堂管理能力。\n有教研经历优先。',
    requirements: [{ text: '持有教师资格证', priority: 'eligibility' }, { text: '课堂管理', priority: 'required' }, { text: '教研经历', priority: 'preferred' }],
    evidence: [{ term: '教师资格证', excerpt: '尚未取得教师资格证' }, { term: '课堂管理', excerpt: null }],
    focus: '参与教学设计',
  },
  {
    id: 'duplicate-original', role: '后端开发', guide: 'cs-software',
    resume: '项目经历\n负责订单接口维护和联调工作。\n负责订单接口维护和联调工作。',
    jd: '岗位要求：熟悉 Java，能够承担接口联调。',
    requirements: [{ text: '熟悉 Java', priority: 'required' }],
    evidence: [{ term: 'Java', excerpt: null }],
  },
  {
    id: 'ambiguous-role', role: '业务支持', guide: null,
    resume: '基本信息\n目标岗位：Excel 专员。\n项目经历\n参与汇总活动资料并记录各方意见。',
    jd: '每月输出简明的业务报告，使用 Excel。',
    requirements: [{ text: '每月输出简明的业务报告', priority: 'review' }],
    evidence: [{ term: 'Excel', excerpt: null }],
    focus: '参与汇总活动资料',
  },
];
