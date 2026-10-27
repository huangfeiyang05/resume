import { createHash, randomUUID } from 'node:crypto';
import type { Analysis, AnalysisDimension, AnalysisIssue, AnalysisSuggestion, Resume } from '../shared/types.js';

export interface AnalysisContext {
  resume: Resume;
  jobDescription?: string;
  targetRole?: string;
  signal?: AbortSignal;
}

/** Replace this boundary with an authenticated Spring AI or LangGraph HTTP adapter. */
export interface AnalysisProvider {
  readonly name: string;
  readonly model?: string;
  analyze(context: AnalysisContext): Promise<Analysis>;
}

const roleKeywords: Array<{ pattern: RegExp; keywords: string[] }> = [
  { pattern: /前端|frontend|front.end|web开发|小程序|全栈/i, keywords: ['JavaScript', 'TypeScript', 'React', 'Vue', 'CSS', '性能优化', '工程化', '组件'] },
  { pattern: /后端|backend|back.end|java|服务端|全栈/i, keywords: ['Java', 'Spring Boot', 'MySQL', 'Redis', '接口', '数据库', '性能优化', '微服务'] },
  { pattern: /python|算法|机器学习|ai工程|人工智能|大模型/i, keywords: ['Python', '机器学习', '模型', '评估', 'RAG', '向量', '部署', '数据'] },
  { pattern: /产品|product/i, keywords: ['需求分析', '用户调研', '数据分析', '产品设计', '迭代', '转化率', '协作'] },
  { pattern: /数据|data|分析师/i, keywords: ['SQL', 'Python', '数据分析', '可视化', '指标', '业务', '统计'] },
  { pattern: /设计|designer|ux|ui/i, keywords: ['用户研究', '交互设计', '视觉设计', 'Figma', '设计系统', '可用性'] },
  { pattern: /运营|operation/i, keywords: ['用户增长', '活动', '内容', '数据分析', '转化率', '留存', '复盘'] },
];

const catalog = [...new Set([
  ...roleKeywords.flatMap(({ keywords }) => keywords),
  'HTML', 'Node.js', 'Next.js', 'Java', 'Spring', 'Spring AI', 'LangChain', 'LangGraph', 'Docker', 'Kubernetes',
  'Git', 'Linux', 'PostgreSQL', 'MongoDB', 'Elasticsearch', 'Kafka', 'RabbitMQ', 'Go', 'C++', 'C#',
  'REST', 'GraphQL', '微服务', '分布式', '高并发', '单元测试', '自动化测试', 'CI/CD', '沟通', '团队协作', '项目管理',
])];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasKeyword(text: string, keyword: string): boolean {
  const aliases: Record<string, string[]> = {
    'Spring Boot': ['Spring Boot', 'SpringBoot'],
    'Node.js': ['Node.js', 'NodeJS', 'Node JS'],
    'Next.js': ['Next.js', 'NextJS'],
    'JavaScript': ['JavaScript', 'JS'],
    'TypeScript': ['TypeScript', 'TS'],
    'PostgreSQL': ['PostgreSQL', 'Postgres'],
    'CSS': ['CSS', 'CSS3'],
    'HTML': ['HTML', 'HTML5'],
  };
  return (aliases[keyword] ?? [keyword]).some((word) => {
    if (/[\u3400-\u9fff]/.test(word)) return text.toLowerCase().includes(word.toLowerCase());
    return new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, 'i').test(text);
  });
}

function expectedKeywords(targetRole: string, jobDescription: string): string[] {
  const fromJob = catalog.filter((keyword) => hasKeyword(jobDescription, keyword));
  // A supplied JD is the source of expectations; role presets are only a fallback.
  if (jobDescription.trim()) return fromJob.slice(0, 20);
  return [...new Set(roleKeywords.filter(({ pattern }) => pattern.test(targetRole)).flatMap(({ keywords }) => keywords))].slice(0, 16);
}

const hasMeasuredImpact = (line: string) => /\d+(?:\.\d+)?\s*(?:%|％|倍|万元|万|亿|毫秒|ms\b|秒|分钟|小时|天|人|用户|订单|qps\b|tps\b|条|台|请求|个客户|次\/)/i.test(line)
  || /(?:提升|降低|减少|增长|节省|缩短|覆盖|服务|支撑|处理|完成|提高)[^。；\n]{0,16}\d+/i.test(line);

const responsibilityPattern = /(?:负责|参与|协助|完成|承担|跟进|维护|responsible for|assisted|participated)/i;
const actionPattern = /(?:设计|实现|搭建|重构|优化|推动|解决|交付|开发|上线|built|designed|implemented|improved|delivered|reduced|launched)/i;
export const hasUnresolvedPlaceholders = (text: string): boolean => /\[请填写真实[^\]]*\]/.test(text);

export class RuleAnalysisProvider implements AnalysisProvider {
  readonly name = 'rules';

  async analyze({ resume, jobDescription = '', targetRole = resume.targetRole }: AnalysisContext): Promise<Analysis> {
    const text = resume.text;
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const workHeading = /^(?:[一二三四五六七八九十\d.、\s]*)?(?:工作经历|实习经历|项目经历|项目经验|工作经验|专业经历|experience|projects?)(?:\s*[:：]|\s*$)/i;
    const otherHeading = /^(?:[一二三四五六七八九十\d.、\s]*)?(?:教育背景|教育经历|专业技能|技术栈|技能|个人简介|个人信息|联系方式|自我评价|求职意向|协作方式|education|skills|summary|profile|contact)(?:\s*[:：]|\s*$)/i;
    const hasWorkHeading = lines.some((line) => line.length < 60 && workHeading.test(line));
    let withinWork = !hasWorkHeading;
    const experienceLines = lines.filter((line) => {
      if (line.length < 60 && workHeading.test(line)) { withinWork = true; return false; }
      if (line.length < 60 && otherHeading.test(line)) { if (hasWorkHeading) withinWork = false; return false; }
      return withinWork;
    });
    const workLines = experienceLines.filter((line) => line.length >= 12 && (responsibilityPattern.test(line) || actionPattern.test(line)));
    const unmeasured = workLines.filter((line) => !hasMeasuredImpact(line));
    const measured = workLines.filter(hasMeasuredImpact);
    const responsibilityOnly = workLines.filter((line) => responsibilityPattern.test(line) && !actionPattern.test(line));
    const expected = expectedKeywords(targetRole, jobDescription);
    const matched = expected.filter((keyword) => hasKeyword(text, keyword));
    const missing = expected.filter((keyword) => !hasKeyword(text, keyword));
    const sections = [
      { label: '工作或项目经历', exists: /工作经历|实习经历|项目经历|项目经验|工作经验|专业经历|experience|projects?/i.test(text) },
      { label: '教育背景', exists: /教育背景|教育经历|学历|毕业|本科|硕士|博士|专科|大学|学院|education|bachelor|master|university/i.test(text) },
      { label: '技能清单', exists: /专业技能|技术栈|技能|技术能力|熟悉|熟练|skills|tech stack/i.test(text) },
    ];
    const missingSections = sections.filter((section) => !section.exists);
    const veryShort = text.replace(/\s/g, '').length < 180;
    const longLines = lines.filter((line) => line.length > 220);
    const issues: AnalysisIssue[] = [];
    const suggestions: AnalysisSuggestion[] = [];

    const addIssue = (issue: Omit<AnalysisIssue, 'id'>) => issues.push({ id: randomUUID(), ...issue });
    const addSuggestion = (suggestion: Omit<AnalysisSuggestion, 'id' | 'applied'>) => suggestions.push({ id: randomUUID(), applied: false, ...suggestion });

    if (unmeasured.length) {
      const evidence = unmeasured[0];
      addIssue({
        title: '经历写了做什么，还缺少结果证据', severity: 'high', category: 'impact',
        description: `${workLines.length} 条可识别经历中，${unmeasured.length} 条没有可识别的规模、效率或业务结果。招聘者难以判断你的贡献。`,
        evidence, suggestion: '补充真实的行动、业务场景和可核实结果；没有数据时，写清交付范围与验证方式。', actionable: true,
      });
      for (const original of unmeasured.slice(0, 3)) {
        const concise = original.replace(/^[\s•·\-*\d.、]+/, '').replace(/[。；;]$/, '');
        addSuggestion({
          title: '把职责补充为可验证的贡献', original,
          replacement: `${concise}；针对[请填写真实业务问题]，采取[请填写真实行动或技术方案]，取得[请填写真实结果与验证依据]。`,
          reason: '保留原始事实，补齐问题、行动和结果。占位内容必须由你核实填写，不会自动生成业绩数字。', needsConfirmation: true,
        });
      }
    } else if (!workLines.length) {
      addIssue({ title: '缺少可识别的经历描述', severity: 'high', category: 'impact', description: '当前正文中没有识别到描述具体行动的工作或项目经历。规则可能漏识别特殊排版，请以原文为准。', evidence: lines.slice(0, 2).join(' / ').slice(0, 240), suggestion: '为一段真实经历补充场景、个人行动、交付成果与可验证结果。', actionable: false });
    }

    if (responsibilityOnly.length) {
      addIssue({ title: '职责表达多，个人贡献不够突出', severity: responsibilityOnly.length >= 3 ? 'high' : 'medium', category: 'clarity', description: `${responsibilityOnly.length} 条经历以“负责 / 参与 / 协助”等职责词为主，没有识别到清晰的交付动作。`, evidence: responsibilityOnly[0], suggestion: '说明你独立解决了什么问题、作了什么选择、实际交付了什么。', actionable: unmeasured.includes(responsibilityOnly[0]) });
    }

    if (missingSections.length) {
      addIssue({ title: '核心信息模块还不完整', severity: missingSections.length >= 2 ? 'high' : 'medium', category: 'structure', description: `没有识别到：${missingSections.map(({ label }) => label).join('、')}。完整模块能帮助招聘者快速定位信息。`, evidence: `已识别模块：${sections.filter(({ exists }) => exists).map(({ label }) => label).join('、') || '暂无'}`, suggestion: '使用清晰的小标题补齐真实内容；如已有对应内容，调整标题即可。', actionable: false });
    }

    if (missing.length) {
      addIssue({ title: '目标岗位的关键能力还缺少证据', severity: missing.length > expected.length / 2 ? 'high' : 'medium', category: 'keywords', description: `${jobDescription.trim() ? '提供的岗位描述' : `“${targetRole || '目标岗位'}”常见能力参考`}中有 ${missing.length} 个关键词未在正文中识别到。这不等于你不具备这些能力。`, evidence: missing.join('、'), suggestion: '只补充你实际使用过的技能，并用具体项目证明；不要为匹配岗位堆砌关键词。', actionable: false });
    } else if (!expected.length) {
      addIssue({ title: '补充岗位描述，才能判断匹配程度', severity: 'low', category: 'keywords', description: jobDescription.trim() ? '当前规则词库没有从岗位描述中识别出可比较的专业关键词，匹配维度暂按中性分计算。' : '当前目标岗位没有对应的规则词库。填写具体岗位描述可获得更有依据的关键词比较。', evidence: targetRole || '未设置目标岗位', suggestion: '粘贴真实招聘要求，并检查简历中的相关经历。', actionable: false });
    }

    if (veryShort) {
      addIssue({ title: '正文偏短，信息密度有待补足', severity: 'medium', category: 'structure', description: `当前正文约 ${text.replace(/\s/g, '').length} 字符，难以完整展示经历与能力。`, evidence: '正文不足 180 个非空白字符', suggestion: '补充最近的相关经历、技术或方法、个人贡献和教育信息，优先保留与岗位有关的内容。', actionable: false });
    }
    if (longLines.length) {
      addIssue({ title: '长段落影响快速阅读', severity: 'low', category: 'clarity', description: `${longLines.length} 段超过 220 字符，关键信息容易被埋没。`, evidence: `${longLines[0].slice(0, 160)}…`, suggestion: '按一个要点一行拆分，先写行动和结果，再补充必要背景。', actionable: false });
    }

    const impact = workLines.length ? Math.round(40 + 60 * measured.length / workLines.length) : 25;
    const structure = Math.max(15, 100 - missingSections.length * 24 - (veryShort ? 15 : 0));
    const relevance = expected.length ? Math.round(25 + 75 * matched.length / expected.length) : 60;
    const clarity = Math.max(25, 100 - Math.min(45, responsibilityOnly.length * 12) - Math.min(24, longLines.length * 8) - (workLines.length ? 0 : 12));
    const dimensions: AnalysisDimension[] = [
      { key: 'impact', label: '成果表达', score: impact, description: workLines.length ? `${measured.length} / ${workLines.length} 条经历包含可识别的结果或规模证据` : '尚未识别到具体行动描述' },
      { key: 'structure', label: '信息结构', score: structure, description: `${sections.length - missingSections.length} / ${sections.length} 个核心模块已识别` },
      { key: 'relevance', label: '岗位匹配', score: relevance, description: expected.length ? `${matched.length} / ${expected.length} 个参考关键词已覆盖` : '缺少可比较的岗位关键词，按中性分计算' },
      { key: 'clarity', label: '表达清晰', score: clarity, description: responsibilityOnly.length || longLines.length ? `${responsibilityOnly.length} 条职责表达，${longLines.length} 个长段落待整理` : '未发现明显的职责堆砌或长段落' },
    ];
    const score = Math.round(impact * .35 + structure * .25 + relevance * .25 + clarity * .15);
    const summary = issues.length
      ? `规则诊断得分 ${score} / 100。优先处理${issues.filter(({ severity }) => severity === 'high').length ? '高优先级问题' : '表达与匹配细节'}：${issues.slice(0, 2).map(({ title }) => title).join('；')}。分数仅供修改前后比较，不代表录用概率。`
      : `规则诊断得分 ${score} / 100。核心模块、成果表达和岗位关键词覆盖较完整，请继续核对事实与岗位相关性。分数不代表录用概率。`;
    const inputSnapshot = { text, targetRole, jobDescription };
    const inputHash = createHash('sha256').update(JSON.stringify(inputSnapshot)).digest('hex');
    return { id: randomUUID(), resumeId: resume.id, resumeRevision: resume.revision, inputHash, inputSnapshot, engine: 'rules', score, summary, dimensions, issues, suggestions, keywords: { matched, missing }, createdAt: new Date().toISOString(), status: 'completed' };
  }
}
