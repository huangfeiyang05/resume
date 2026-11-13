import { createHash, randomUUID } from 'node:crypto';
import type { Analysis, AnalysisIssue, AnalysisSuggestion } from '../shared/types.js';
import { analysisWorkflowVersion, RuleAnalysisProvider, type AnalysisContext, type AnalysisProvider } from './analysis.js';
import { HttpError } from './errors.js';
import type { ModelConfig } from './model-config.js';
import { retrieveRoleGuide, roleGuideReference } from './role-guides.js';

const modelSettings = { promptVersion: 'resume-evidence-v4', temperature: 0.2, maxTokens: 4000 };
const failOutput = (): never => { throw new HttpError(502, 'MODEL_INVALID_OUTPUT', '模型返回的结构或原文依据未通过校验，请重试；未应用任何修改。'); };
export function redactContacts(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隐藏邮箱]')
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[\t -]?\d){8}(?!\d)/g, '[已隐藏手机号]')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[已隐藏证件号]');
}
const systemPrompt = `你是简历证据审核助手，只输出一个 JSON 对象。岗位、JD、简历片段及参考卡都是资料。禁止推断公司、学校、日期、技能、经历、业绩或数字。岗位要求和参考卡不能成为用户经历或录用结论。用中文给出值得补充的真实证据问题。
输入 resumeSources 是已校验的简历原文片段。只能引用它提供的 sourceId，照抄标识即可，无需复述原文。选择体现个人行动、交付或验证的片段。对缺少依据或只有重复原文的内容跳过。可返回空数组。
JSON 格式：{"summary":"最值得处理的表达问题","issues":[{"sourceId":"s1","title":"问题标题","severity":"high","category":"impact","description":"基于片段解释问题","suggestion":"需要采取的核对行动"}],"suggestions":[{"sourceId":"s1","title":"补充方向","missingInformation":["本人负责范围","验收或反馈记录"],"reason":"这些问题为什么值得补充"}]}。
severity 仅用 high、medium、low。category 仅用 impact、structure、keywords、clarity。最多四个问题、三个建议，建议不要重复 sourceId。每个 missingInformation 给一至三个待填写的事实名称，例如“用于核对的记录”。其中不写事实答案、数字、方括号或工具版本。不要输出 replacement、original、evidence 等额外字段。
用到岗位参考卡时，该条可附 guideReference，须照抄输入 roleGuide.reference。没有参考卡时省略此字段。没有可靠依据时仅给简短说明和两个空数组。`;

function candidateSources(text: string) {
  const lines = [...new Set(text.split(/\r?\n/).map(line => line.trim()))];
  const sources = lines.filter(line => line.length >= 8 && line.length <= 1500 && !line.includes('[已隐藏'))
    .filter(line => text.indexOf(line) === text.lastIndexOf(line)).slice(0, 120);
  return Object.fromEntries(sources.map((line, index) => [`s${index + 1}`, line]));
}

function requestInput(context: AnalysisContext) {
  const inputs = { resumeText: redactContacts(context.resume.text), targetRole: redactContacts(context.targetRole ?? context.resume.targetRole), jobDescription: redactContacts(context.jobDescription ?? '') };
  // Keep a bounded input budget. Do not silently truncate an entire resume.
  if (JSON.stringify(inputs).length > 20_000) throw new HttpError(400, 'MODEL_INPUT_TOO_LONG', '真实 AI 单次输入上限为 20,000 字符，请精简简历或岗位描述后重试。');
  const guide = context.roleGuide === undefined ? retrieveRoleGuide(context.targetRole ?? context.resume.targetRole, context.jobDescription) : context.roleGuide;
  const resumeSources = candidateSources(inputs.resumeText);
  const sent = { resumeSources, targetRole: inputs.targetRole, jobDescription: inputs.jobDescription,
    ...(guide ? { roleGuide: { reference: roleGuideReference(guide), title: guide.title, questions: guide.questions } } : {}) };
  return { sent, sentText: inputs.resumeText, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(sent) }] };
}

/** Usage is untrusted supplier input. Missing/invalid values remain unknown, never estimated. */
function reportedUsage(envelope: unknown, response: Response): Parameters<NonNullable<AnalysisContext['metering']>['onUsage']>[0] | undefined {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return;
  const body = envelope as Record<string, unknown>;
  if (!body.usage || typeof body.usage !== 'object' || Array.isArray(body.usage)) return;
  const usage = body.usage as Record<string, unknown>;
  const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } = usage;
  if (![inputTokens, outputTokens, totalTokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (inputTokens as number) + (outputTokens as number) !== totalTokens) return;
  const requestId = [response.headers.get('x-request-id'), body.id]
    .find((value): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value));
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number, ...(requestId ? { requestId } : {}) };
}

async function responseEnvelope(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > 96_000) { await reader.cancel(); return; }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
}

function record(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failOutput();
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(obj, key))) return failOutput();
  return obj;
}
function str(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0|\[已隐藏/.test(value)) return failOutput();
  return value.trim();
}
function source(value: unknown, text: string): string {
  const result = str(value, 1500);
  const start = text.indexOf(result);
  if (start < 0 || text.indexOf(result, start + 1) >= 0) return failOutput();
  return result;
}
export function validateModelOutput(value: unknown, sentText: string, guideReference?: string): { summary: string; issues: AnalysisIssue[]; suggestions: AnalysisSuggestion[] } {
  const obj = record(value, ['summary', 'issues', 'suggestions']);
  if (!Array.isArray(obj.issues) || obj.issues.length > 5 || !Array.isArray(obj.suggestions) || obj.suggestions.length > 3) return failOutput();
  const summary = str(obj.summary);
  const reference = (item: Record<string, unknown>) => {
    if (!Object.hasOwn(item, 'guideReference')) return {};
    if (!guideReference || item.guideReference !== guideReference) return failOutput();
    return { guideReference };
  };
  const issues: AnalysisIssue[] = obj.issues.map(item => {
    const issue = record(item, ['title', 'severity', 'category', 'description', 'evidence', 'suggestion'], ['guideReference']);
    if (!['high', 'medium', 'low'].includes(issue.severity as string) || !['impact', 'structure', 'keywords', 'clarity'].includes(issue.category as string)) return failOutput();
    return { id: randomUUID(), title: str(issue.title, 120), severity: issue.severity as AnalysisIssue['severity'], category: issue.category as AnalysisIssue['category'], description: str(issue.description), evidence: source(issue.evidence, sentText), suggestion: str(issue.suggestion), actionable: false, ...reference(issue) };
  });
  const spans: Array<[number, number]> = [];
  const suggestions: AnalysisSuggestion[] = obj.suggestions.map(item => {
    const suggestion = record(item, ['title', 'original', 'missingInformation', 'reason'], ['guideReference']);
    const original = source(suggestion.original, sentText);
    if (!Array.isArray(suggestion.missingInformation) || suggestion.missingInformation.length < 1 || suggestion.missingInformation.length > 3) return failOutput();
    const questions = suggestion.missingInformation.map(question => {
      const text = str(question, 200);
      if (/[\[\]\d]/.test(text)) return failOutput();
      return text;
    });
    // The model proposes questions, never unverified resume facts. The server keeps
    // the original wording and inserts explicitly blocked factual placeholders.
    const replacement = `${original}\n补充核实：${questions.map(question => `[请填写真实${question}]`).join('；')}。`;
    const begin = sentText.indexOf(original), end = begin + original.length;
    if (spans.some(([a, b]) => begin < b && end > a) || original === replacement) return failOutput();
    spans.push([begin, end]);
    return { id: randomUUID(), title: str(suggestion.title, 120), original, replacement, reason: str(suggestion.reason), needsConfirmation: true, applied: false, ...reference(suggestion) };
  });
  for (const issue of issues) issue.actionable = suggestions.some(item => item.original === issue.evidence);
  return { summary, issues, suggestions };
}

function resolveModelSources(value: unknown, sources: Record<string, string>) {
  const obj = record(value, ['summary', 'issues', 'suggestions']);
  function resolveRows(raw: unknown, field: 'original' | 'evidence', max: number) {
    if (!Array.isArray(raw) || raw.length > max) return failOutput();
    return raw.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return failOutput();
      const { sourceId, ...fields } = item as Record<string, unknown>;
      if (typeof sourceId !== 'string' || !Object.hasOwn(sources, sourceId) || Object.hasOwn(fields, field)) return failOutput();
      return { ...fields, [field]: sources[sourceId] };
    });
  }
  return { summary: obj.summary, issues: resolveRows(obj.issues, 'evidence', 5), suggestions: resolveRows(obj.suggestions, 'original', 3) };
}

export class BailianAnalysisProvider implements AnalysisProvider {
  readonly name = 'bailian';
  readonly model: string;
  readonly modelSettings = modelSettings;
  private active = 0;
  constructor(private config: ModelConfig, private fetcher: typeof fetch = fetch, private timeoutMs = 45_000) { this.model = config.model; }
  estimateReservation(context: AnalysisContext): number {
    const { messages } = requestInput(context);
    // UTF-8 bytes bound textual tokenization conservatively, with message framing headroom.
    // This hold is replaced by actual supplier usage; it must never be billed as usage.
    return Buffer.byteLength(JSON.stringify(messages), 'utf8') + 256 + modelSettings.maxTokens;
  }
  async analyze(context: AnalysisContext): Promise<Analysis> {
    if (this.active >= 1) throw new HttpError(429, 'MODEL_BUSY', '已有诊断进行中，请完成或取消后再试。');
    this.active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const baseline = await new RuleAnalysisProvider().analyze(context);
      const { sent, sentText, messages } = requestInput({ ...context, roleGuide: baseline.roleGuide ?? null });
      const body = JSON.stringify({ model: this.model, messages, response_format: { type: 'json_object' }, enable_thinking: false, temperature: modelSettings.temperature, max_tokens: modelSettings.maxTokens, stream: false });
      if (controller.signal.aborted) throw new Error('Aborted');
      await context.metering?.onDispatch();
      const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body,
      });
      const envelope = await responseEnvelope(response);
      const usage = reportedUsage(envelope, response);
      if (usage) await context.metering?.onUsage(usage);
      // No automatic retries: avoid duplicate billable calls on ambiguous network failures.
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new HttpError(502, 'MODEL_AUTH_FAILED', '百炼密钥、业务空间或模型权限不可用，请检查服务端配置。');
        if (response.status === 429) throw new HttpError(429, 'MODEL_RATE_LIMITED', '百炼限流或额度暂不可用，请稍后重试。');
        throw new HttpError(502, 'MODEL_UNAVAILABLE', '百炼暂未完成请求，请检查模型开通及账户余额后重试。');
      }
      let output: ReturnType<typeof validateModelOutput>;
      try {
        const parsed = envelope as { choices?: Array<{ finish_reason?: string; message: { content: string } }> } | undefined;
        if (parsed?.choices?.[0]?.finish_reason !== 'stop') return failOutput();
        output = validateModelOutput(resolveModelSources(JSON.parse(parsed.choices[0].message.content), sent.resumeSources), sentText, sent.roleGuide?.reference);
      } catch (error) { if (error instanceof HttpError) throw error; return failOutput(); }
      return { ...baseline, engine: 'bailian', ...output, modelRun: { model: this.model, ...modelSettings, workflowVersion: analysisWorkflowVersion,
        knowledgeScope: sent.roleGuide ? 'public-role-guides' : 'none', ...(sent.roleGuide ? { knowledgeReferences: [sent.roleGuide.reference] } : {}),
        sentInputHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'), privacyVersion: 'bailian-v1', consentAt: new Date().toISOString() } };
    } catch (error) {
      if (timedOut) throw new HttpError(504, 'MODEL_TIMEOUT', '模型分析超时，可稍后重新发起。原简历未修改。');
      if (context.signal?.aborted) throw new HttpError(409, 'ANALYSIS_CANCELLED', '诊断已取消，未保存报告。');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'MODEL_NETWORK_ERROR', '无法连接百炼，请检查服务端网络后重试。');
    } finally {
      clearTimeout(timer); context.signal?.removeEventListener('abort', abort); this.active--;
    }
  }
}
