import { createHash, randomUUID } from 'node:crypto';
import type { Analysis, AnalysisDimension, AnalysisIssue, AnalysisSuggestion, Resume } from '../shared/types.js';
import { inputLimits } from '../shared/limits.js';
import { reviewJobDescription } from './job-review.js';
import { hasTerm, retrieveRoleGuide, reviewTerms } from './role-guides.js';

export const analysisWorkflowVersion = 'jd-evidence-v2';

export interface AnalysisContext {
  resume: Resume;
  jobDescription?: string;
  targetRole?: string;
  roleGuide?: Analysis['roleGuide'] | null;
  signal?: AbortSignal;
  /** Server-only hooks: dispatch is recorded before sending; usage is supplier-reported. */
  metering?: {
    onDispatch(): Promise<void>;
    onUsage(usage: { inputTokens: number; outputTokens: number; totalTokens: number; requestId?: string }): Promise<void>;
  };
}

/** Replace this boundary with an authenticated Spring AI or LangGraph HTTP adapter. */
export interface AnalysisProvider {
  readonly name: string;
  readonly model?: string;
  readonly modelSettings?: { promptVersion: string; temperature: number; maxTokens: number };
  /** Conservative reservation only; never an actual usage or settlement amount. */
  estimateReservation?(context: AnalysisContext): number;
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

function expectedKeywords(targetRole: string, jobDescription: string): string[] {
  // A supplied JD is the source of expectations; role presets are only a fallback.
  if (jobDescription.trim()) return reviewTerms(jobDescription, catalog).slice(0, 20);
  return [...new Set(roleKeywords.filter(({ pattern }) => pattern.test(targetRole)).flatMap(({ keywords }) => keywords))].slice(0, 16);
}

const hasMeasuredImpact = (line: string) => /\d+(?:\.\d+)?\s*(?:%|％|倍|万元|万|亿|毫秒|ms\b|秒|分钟|小时|天|人|用户|订单|qps\b|tps\b|条|台|请求|个客户|次\/)/i.test(line)
  || /(?:提升|降低|减少|增长|节省|缩短|覆盖|服务|支撑|处理|完成|提高)[^。；\n]{0,16}\d+/i.test(line);

const responsibilityPattern = /(?:负责|参与|协助|完成|承担|跟进|维护|responsible for|assisted|participated)/i;
const actionPattern = /(?:设计|实现|搭建|重构|优化|推动|解决|交付|开发|上线|核对|编写|built|designed|implemented|improved|delivered|reduced|launched)/i;
export const hasUnresolvedPlaceholders = (text: string): boolean => /\[请填写真实[^\]]*\]/.test(text);

function affirmativeMatch(line: string, pattern: RegExp): string | undefined {
  for (const match of line.matchAll(new RegExp(pattern.source, 'gi'))) {
    const prefix = line.slice(Math.max(0, match.index! - 20), match.index!);
    if (/(?:未|尚未|没有|并未|无法|未能|未曾|计划|准备|预计|希望|待|打算|拟|not|never|plan to|planning to|will)\s*$/i.test(prefix)) continue;
    return match[0];
  }
}

// A stated delivery/acceptance result can be useful evidence without a number.
// Keep this narrow: merely mentioning a test, launch plan or desired result is not evidence.
const hasDeliveryEvidence = (line: string): boolean => line.split(/[，,。；;\n]/).some(clause =>
  !/(?:计划|准备|预计|希望|争取|打算|尚未|未能|无法)/.test(clause) && !!affirmativeMatch(clause,
    /(?:验收|评审|回归测试|集成测试|单元测试|测试)(?:结果)?(?:已|均|全部)?通过|已通过[^，,。；;\n]{0,12}(?:验收|评审|回归测试|集成测试|单元测试)|(?:按期|按时|如期)(?:交付|上线)/i));

function contributionSuggestion(original: string): Omit<AnalysisSuggestion, 'id' | 'applied'> {
  const focus = original.replace(/[。；;]$/, '');
  const excerpt = focus.length > 18 ? `${focus.slice(0, 18)}…` : focus;
  const action = affirmativeMatch(original, actionPattern);
  const profiles = [
    { pattern: /接口|\bAPI\b/i, question: '具体承担了哪些接口工作，怎样核对交付或使用结果？', facts: '接口交付结果和测试、验收或使用反馈依据' },
    { pattern: /文档|资料|约定|说明书|材料/, question: '哪些内容由你整理或确认，交付后如何被采用或核对？', facts: '材料交付、采用情况和评审或确认依据' },
    { pattern: /活动|推广|运营|增长/, question: '你负责哪一执行环节，实际交付了什么，如何核对反馈？', facts: '活动或运营交付结果和反馈依据' },
    { pattern: /数据|分析|报表/, question: '形成了哪些数据交付或分析结果，如何核对或使用？', facts: '数据交付或分析结果和核对、使用依据' },
    { pattern: /沟通|协作|协调|跟进/, question: '你具体跟进了什么事项，形成了什么可核对的结果？', facts: '协作交付或问题处理结果和确认依据' },
  ];
  const profile = profiles.find(({ pattern }) => pattern.test(original))
    ?? { question: '具体交付了什么，可依据哪些记录或反馈核对？', facts: '交付结果和验收、记录或反馈依据' };
  return {
    title: `${action ? '补充验证依据' : '明确个人行动'}｜${excerpt}`,
    original,
    replacement: `${original}${action ? '' : ' 个人行动：[请填写真实负责范围与个人行动]；'} 交付与验证：[请填写真实${profile.facts}]。`,
    reason: action
      ? `“${excerpt}”已提到“${action}”的动作表达，重点补充交付与验证。${profile.question}`
      : `“${excerpt}”主要是职责描述，还需明确本人实际承担的动作。${profile.question}`,
    needsConfirmation: true,
  };
}

function uniquelyLocated(text: string, original: string): boolean {
  const first = text.indexOf(original);
  return first >= 0 && text.indexOf(original, first + original.length) < 0;
}

export class RuleAnalysisProvider implements AnalysisProvider {
  readonly name = 'rules';

  async analyze({ resume, jobDescription = '', targetRole = resume.targetRole, roleGuide = retrieveRoleGuide(targetRole, jobDescription) }: AnalysisContext): Promise<Analysis> {
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
    const unmeasured = workLines.filter((line) => !hasMeasuredImpact(line) && !hasDeliveryEvidence(line));
    const measured = workLines.filter((line) => hasMeasuredImpact(line) || hasDeliveryEvidence(line));
    const responsibilityOnly = workLines.filter((line) => responsibilityPattern.test(line) && !actionPattern.test(line));
    const expected = expectedKeywords(targetRole, jobDescription);
    const matched = expected.filter((keyword) => hasTerm(text, keyword));
    const missing = expected.filter((keyword) => !hasTerm(text, keyword));
    const jobReview = reviewJobDescription(jobDescription, text, catalog);
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
    const evidenceLines = jobReview?.items.filter(item => item.priority === 'required')
      .flatMap(item => item.evidence.flatMap(({ excerpt }) => excerpt ? [excerpt] : [])) ?? [];
    const relevant = (line: string) => evidenceLines.some(excerpt => line.includes(excerpt));
    const candidates = [...new Set(unmeasured)].filter(original => uniquelyLocated(text, original))
      .sort((a, b) => Number(relevant(b)) - Number(relevant(a)))
      .map(contributionSuggestion).filter(suggestion => suggestion.replacement.length <= inputLimits.replacement).slice(0, 3);

    if (unmeasured.length) {
      const evidence = candidates[0]?.original ?? unmeasured[0];
      addIssue({
        title: '经历写了做什么，还缺少结果证据', severity: 'high', category: 'impact',
        description: `${workLines.length} 条可识别经历中，${unmeasured.length} 条没有可识别的规模、效率或业务结果。招聘者难以判断你的贡献。`,
        evidence, suggestion: '补充真实的行动、业务场景和可核实结果；没有数据时，写清交付范围与验证方式。', actionable: candidates.length > 0,
      });
      candidates.forEach(addSuggestion);
      const ambiguous = [...new Set(unmeasured)].filter(original => !uniquelyLocated(text, original));
      if (ambiguous.length) addIssue({ title: '相同原文有多处，需先确定修改位置', severity: 'medium', category: 'clarity',
        description: '部分经历的原文出现在多个位置，无法安全定位改写位置，未生成自动应用建议。', evidence: ambiguous[0],
        suggestion: '在编辑器中确认具体段落，合并重复内容或补充各段区别后再诊断。', actionable: false });
    } else if (!workLines.length) {
      addIssue({ title: '缺少可识别的经历描述', severity: 'high', category: 'impact', description: '当前正文中没有识别到描述具体行动的工作或项目经历。规则可能漏识别特殊排版，请以原文为准。', evidence: lines.slice(0, 2).join(' / ').slice(0, 240), suggestion: '为一段真实经历补充场景、个人行动、交付成果与可验证结果。', actionable: false });
    }

    if (responsibilityOnly.length) {
      addIssue({ title: '职责表达多，个人贡献不够突出', severity: responsibilityOnly.length >= 3 ? 'high' : 'medium', category: 'clarity', description: `${responsibilityOnly.length} 条经历以“负责 / 参与 / 协助”等职责词为主，没有识别到清晰的交付动作。`, evidence: responsibilityOnly[0], suggestion: '说明你独立解决了什么问题、作了什么选择、实际交付了什么。', actionable: candidates.some(({ original }) => original === responsibilityOnly[0]) });
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
    const inputHash = createHash('sha256').update(JSON.stringify({ ...inputSnapshot, roleGuide, workflowVersion: analysisWorkflowVersion })).digest('hex');
    return { id: randomUUID(), resumeId: resume.id, resumeRevision: resume.revision, inputHash, inputSnapshot, engine: 'rules', workflowVersion: analysisWorkflowVersion, score, summary, dimensions, issues, suggestions, keywords: { matched, missing },
      ...(jobReview ? { jobReview } : {}), ...(roleGuide ? { roleGuide } : {}), createdAt: new Date().toISOString(), status: 'completed' };
  }
}
