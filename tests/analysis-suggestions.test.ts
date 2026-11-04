import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Resume } from '../shared/types.js';
import { inputLimits } from '../shared/limits.js';
import { RuleAnalysisProvider, hasUnresolvedPlaceholders } from '../server/analysis.js';
import { JsonStore } from '../server/store.js';
import { ResumeService } from '../server/service.js';
import { HttpError } from '../server/errors.js';

function resume(text: string): Resume {
  return { id: 'synthetic-advice', title: '合成建议验收', targetRole: '后端开发', text, revision: 3,
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' };
}
const provider = new RuleAnalysisProvider();
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
const lines = [
  '负责用户账户相关接口的日常维护与需求跟进。',
  '设计并实现订单查询的缓存处理方案。',
  '参与业务说明文档的整理和部门间沟通工作。',
];

test('different source lines receive specific gaps, explanations and fact questions instead of one repeated template', async () => {
  const input = resume(`项目经历\n${lines.join('\n')}`);
  const result = await provider.analyze({ resume: input });
  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(result.suggestions.map(item => item.original), lines);
  assert.equal(new Set(result.suggestions.map(item => item.title)).size, 3);
  assert.equal(new Set(result.suggestions.map(item => item.reason)).size, 3);
  const [interfaces, action, documents] = result.suggestions;
  assert.match(interfaces.title, /个人行动/); assert.match(interfaces.reason, /哪些接口工作/);
  assert.match(interfaces.replacement, /请填写真实负责范围与个人行动/);
  assert.match(action.title, /验证依据/); assert.match(action.reason, /已提到“设计”/);
  assert.equal(action.replacement.includes('个人行动：'), false, 'an already supplied action is not replaced with a made-up action request');
  assert.equal(action.replacement.includes('真实业务问题'), false);
  assert.match(documents.reason, /哪些内容由你整理或确认/);
  assert.match(documents.replacement, /材料交付、采用情况/);
  assert.equal(result.engine, 'rules'); assert.equal(result.resumeRevision, 3);
  assert.deepEqual(result.inputSnapshot, { text: input.text, targetRole: input.targetRole, jobDescription: '' });
  for (const suggestion of result.suggestions) {
    assert.equal(suggestion.needsConfirmation, true); assert.equal(suggestion.applied, false);
    assert.equal(hasUnresolvedPlaceholders(suggestion.replacement), true);
    assert.ok(suggestion.replacement.startsWith(suggestion.original));
    assert.equal(/\d|35%|Redis|阿里|清华/.test(suggestion.replacement), false, 'no unsupported dates, numbers, technologies or identities are appended');
  }
});

test('dates, prefixes and technology versions remain intact in the proposed text', async () => {
  const original = '2024.03—2024.05 负责 Java 17 项目的接口维护和需求跟进工作。';
  const result = await provider.analyze({ resume: resume(`项目经历\n${original}`) });
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].original, original);
  assert.ok(result.suggestions[0].replacement.startsWith(original));
  assert.ok(result.suggestions[0].replacement.includes('2024.03—2024.05'));
  assert.ok(result.suggestions[0].replacement.includes('Java 17'));
  assert.deepEqual(result.suggestions[0].replacement.match(/\d+/g), original.match(/\d+/g), 'all proposed numeric text must come from the original');
});

test('ambiguous lines and nested substring sources do not produce unapplyable suggestions or consume the three useful slots', async () => {
  const duplicate = '负责用户账户相关接口的日常维护与需求跟进。';
  const valid = ['参与项目验收文档的整理与版本归档工作。', '协助业务部门开展产品资料的核对工作。', '设计并实现客户请求的校验处理流程。'];
  const input = `${duplicate}\n${duplicate}\n${valid.join('\n')}`;
  const result = await provider.analyze({ resume: resume(input) });
  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(result.suggestions.map(item => item.original), valid);
  assert.equal(result.suggestions.some(item => item.original === duplicate), false);
  assert.equal(new Set(result.suggestions.map(item => item.original)).size, 3);
  assert.ok(result.issues.some(issue => issue.title.includes('相同原文') && issue.actionable === false));
  for (const suggestion of result.suggestions) {
    const first = input.indexOf(suggestion.original);
    assert.equal(input.indexOf(suggestion.original, first + suggestion.original.length), -1);
  }
  const repeatedOnly = await provider.analyze({ resume: resume(`${duplicate}\n${duplicate}`) });
  assert.deepEqual(repeatedOnly.suggestions, []);
  assert.equal(repeatedOnly.issues.find(item => item.category === 'impact')?.actionable, false);
  const nested = await provider.analyze({ resume: resume(`${duplicate}\n此前也曾${duplicate}`) });
  assert.equal(nested.suggestions.some(item => item.original === duplicate), false, 'a short source occurring inside another line is also ambiguous');
});

test('long originals that exceed the replacement boundary stay manual while later useful suggestions remain available', async () => {
  const long = '负责' + '合成业务'.repeat(5100);
  assert.ok(long.length > inputLimits.replacement);
  const result = await provider.analyze({ resume: resume(`项目经历\n${long}\n${lines.join('\n')}`) });
  assert.equal(result.suggestions.length, 3);
  assert.equal(result.suggestions.some(item => item.original === long), false);
  assert.ok(result.suggestions.every(item => item.replacement.length <= inputLimits.replacement));
  assert.ok(result.issues.some(item => item.category === 'impact'));
});

test('stated nonnumeric delivery evidence is accepted without forcing invented performance numbers', async () => {
  const originals = [
    '设计并实现业务接口方案，回归测试通过。',
    '开发并整理项目交付内容，按期交付。',
    '优化订单查询流程，已通过业务部门验收。',
  ];
  const result = await provider.analyze({ resume: resume(`项目经历\n${originals.join('\n')}`) });
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.issues.some(item => item.category === 'impact'), false);
  assert.equal(result.dimensions.find(item => item.key === 'impact')?.score, 100);
  for (const negative of [
    '设计并实现业务接口方案，回归测试未通过。',
    '开发并整理项目交付内容，计划在下月按期交付。',
    '优化订单查询流程，尚未通过业务部门验收。',
  ]) {
    const pending = await provider.analyze({ resume: resume(`项目经历\n${negative}`) });
    assert.equal(pending.suggestions.length, 1, negative);
    assert.ok(pending.issues.some(item => item.category === 'impact'));
  }
});

test('specific suggestions still require real facts, preserve source versions and apply idempotently', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-specific-suggestions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new ResumeService(new JsonStore(join(directory, 'isolated.json')));
  const saved = await service.createResume({ title: '合成行为验收', targetRole: '后端开发', text: `项目经历\n${lines.join('\n')}` });
  const result = await service.analyze({ resumeId: saved.id }); const suggestion = result.suggestions[0];
  await assert.rejects(service.applySuggestion(result.id, suggestion.id, { revision: 1 }), hasCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(service.applySuggestion(result.id, suggestion.id, { revision: 1, confirmed: true }), hasCode('PLACEHOLDERS_UNRESOLVED'));
  assert.deepEqual(await service.getResume(saved.id), saved);
  const replacement = suggestion.replacement.replace('[请填写真实负责范围与个人行动]', '设计并核对接口检查清单')
    .replace(/\[请填写真实[^\]]*\]/g, '接口检查完成，团队验收通过');
  assert.equal(replacement.includes('\n'), false, 'the reviewed evidence remains in the same source paragraph');
  const applied = await service.applySuggestion(result.id, suggestion.id, { revision: 1, confirmed: true, replacement });
  assert.equal(applied.resume.revision, 2); assert.equal(applied.alreadyApplied, false);
  assert.equal(applied.resume.text.split(replacement).length - 1, 1);
  const replay = await service.applySuggestion(result.id, suggestion.id, { revision: 1, confirmed: true, replacement });
  assert.equal(replay.alreadyApplied, true); assert.equal(replay.resume.revision, 2);
  assert.equal(replay.analysis.resumeRevision, 1); assert.equal(replay.analysis.inputSnapshot.text, saved.text);
  const refreshed = await service.analyze({ resumeId: saved.id });
  assert.equal(refreshed.suggestions.length, 2, 'only the other, still incomplete source lines need more facts');
  assert.equal(refreshed.suggestions.some(item => item.original.includes(lines[0])), false, 'confirmed delivery evidence must not trigger the same source suggestion again');
});
