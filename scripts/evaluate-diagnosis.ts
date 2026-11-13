import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { analysisWorkflowVersion, hasUnresolvedPlaceholders, RuleAnalysisProvider, type AnalysisContext } from '../server/analysis.js';
import { BailianAnalysisProvider } from '../server/bailian.js';
import { HttpError } from '../server/errors.js';
import { loadModelConfig } from '../server/model-config.js';
import { retrieveRoleGuide } from '../server/role-guides.js';
import type { Analysis } from '../shared/types.js';
import { diagnosisCases, type DiagnosisCase } from '../tests/fixtures/diagnosis-evaluation.js';

const args = process.argv.slice(2);
const live = args.length === 1 && args[0] === '--bailian';
if (args.length && !live) throw new Error('Usage: npm run diagnosis:evaluate [-- --bailian]');
const rules = new RuleAnalysisProvider();
const config = live ? await loadModelConfig() : undefined;
if (config && !config.enabled) throw new Error('The local model configuration must be enabled for this synthetic evaluation.');
const model = config ? new BailianAnalysisProvider(config) : undefined;
const modes = live ? ['rules', 'model', 'model-with-guide'] as const : ['rules'] as const;
type Mode = typeof modes[number];
type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
interface EvaluationResult {
  id: string;
  mode: Mode;
  elapsedMs: number;
  usage?: Usage;
  error?: string;
  metrics?: ReturnType<typeof measure>;
  review?: { summary: string; issues: Array<Omit<Analysis['issues'][number], 'id'>>; suggestions: Array<Omit<Analysis['suggestions'][number], 'id'>>; knowledge?: string };
}
const date = '2026-11-13T00:00:00+08:00';
const reportPath = resolve(import.meta.dirname, '../.deployment', live ? 'diagnosis-evaluation-bailian.json' : 'diagnosis-evaluation-rules.json');
const results: EvaluationResult[] = [];
let stopProvider = false;

function measure(example: DiagnosisCase, analysis: Analysis, expectedGuide: string | null) {
  const items = analysis.jobReview?.items ?? [];
  const requirements = example.requirements.map(expected =>
    items.some(item => item.requirement.includes(expected.text) && item.priority === expected.priority));
  const evidence = example.evidence.map(({ term, excerpt }) => {
    const matches = items.flatMap(item => item.evidence).filter(item => item.term === term);
    return matches.length > 0 && (excerpt === null
      ? matches.every(item => item.excerpt === undefined)
      : matches.some(item => item.excerpt?.includes(excerpt)));
  });
  const suggestionsSafe = analysis.suggestions.every(item => {
    const start = example.resume.indexOf(item.original);
    return start >= 0 && example.resume.indexOf(item.original, start + 1) < 0
      && item.needsConfirmation && item.replacement.startsWith(item.original) && hasUnresolvedPlaceholders(item.replacement);
  });
  return {
    requirements: { hits: requirements.filter(Boolean).length, total: requirements.length },
    evidence: { hits: evidence.filter(Boolean).length, total: evidence.length },
    guideCorrect: (analysis.roleGuide?.id ?? null) === expectedGuide,
    suggestionsSafe,
    topSuggestionTargetsPriority: example.focus ? !!analysis.suggestions[0]?.original.includes(example.focus) : null,
  };
}

for (const example of diagnosisCases) {
  const roleGuide = retrieveRoleGuide(example.role, example.jd);
  const input: AnalysisContext = { resume: { id: example.id, title: '合成评测', targetRole: example.role, text: example.resume,
    revision: 1, createdAt: date, updatedAt: date }, jobDescription: example.jd };
  for (const mode of modes) {
    if (mode !== 'rules' && stopProvider) continue;
    const started = performance.now();
    let usage: Usage | undefined;
    try {
      const analysis = mode === 'rules' ? await rules.analyze(input) : await model!.analyze({
        ...input, roleGuide: mode === 'model' ? null : roleGuide,
        metering: { async onDispatch() {}, async onUsage({ inputTokens, outputTokens, totalTokens }) { usage = { inputTokens, outputTokens, totalTokens }; } },
      });
      results.push({ id: example.id, mode, elapsedMs: Math.round(performance.now() - started), ...(usage ? { usage } : {}),
        metrics: measure(example, analysis, mode === 'model' ? null : example.guide),
        review: { summary: analysis.summary, issues: analysis.issues.map(({ id: _, ...issue }) => issue),
          suggestions: analysis.suggestions.map(({ id: _, ...suggestion }) => suggestion), knowledge: analysis.modelRun?.knowledgeScope } });
    } catch (error) {
      if (!(error instanceof HttpError) || mode === 'rules') throw error;
      results.push({ id: example.id, mode, elapsedMs: Math.round(performance.now() - started), ...(usage ? { usage } : {}), error: error.code });
      stopProvider = ['MODEL_AUTH_FAILED', 'MODEL_RATE_LIMITED', 'MODEL_UNAVAILABLE', 'MODEL_NETWORK_ERROR', 'MODEL_TIMEOUT'].includes(error.code);
    }
    if (live) console.log(`${example.id} ${mode} ${results.at(-1)?.error ?? 'completed'}`);
  }
}
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
const sampleHash = createHash('sha256').update(JSON.stringify(diagnosisCases)).digest('hex');
await writeFile(reportPath, `${JSON.stringify({ workflow: analysisWorkflowVersion, sampleHash, model: config?.model, modelSettings: model?.modelSettings, results }, null, 2)}\n`, { mode: 0o600 });
for (const mode of modes) {
  const group = results.filter(item => item.mode === mode);
  const passed = group.flatMap(item => item.metrics ? [item.metrics] : []);
  const pair = (key: 'requirements' | 'evidence') => `${passed.reduce((sum, item) => sum + item[key].hits, 0)}/${passed.reduce((sum, item) => sum + item[key].total, 0)}`;
  const times = group.map(item => item.elapsedMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, attempted: group.length, completed: passed.length, cases: diagnosisCases.length,
    requirements: pair('requirements'), evidence: pair('evidence'), guideCorrect: passed.filter(item => item.guideCorrect).length,
    safeSuggestionCases: passed.filter(item => item.suggestionsSafe).length, topSuggestion: `${passed.filter(item => item.topSuggestionTargetsPriority).length}/${passed.filter(item => item.topSuggestionTargetsPriority !== null).length}`,
    medianMs: times[Math.floor(times.length / 2)], usageCases: group.filter(item => item.usage).length,
    inputTokens: group.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
    outputTokens: group.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    errors: group.flatMap(item => item.error ? [item.error] : []) }));
}
console.log(reportPath);
if (stopProvider || results.some(({ mode, metrics }) => metrics && (!metrics.suggestionsSafe || mode === 'rules'
  && (metrics.requirements.hits !== metrics.requirements.total || metrics.evidence.hits !== metrics.evidence.total
    || !metrics.guideCorrect || metrics.topSuggestionTargetsPriority === false)))) process.exitCode = 1;
