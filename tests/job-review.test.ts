import assert from 'node:assert/strict';
import test from 'node:test';
import type { Resume } from '../shared/types.js';
import { RuleAnalysisProvider } from '../server/analysis.js';

const now = '2026-11-13T00:00:00+08:00';
const provider = new RuleAnalysisProvider();

test('supply-chain JD prioritizes eligibility and shows the applicant’s actual Excel excerpt', async () => {
  const resume: Resume = { id: 'sample', revision: 2, title: '合成简历', targetRole: '供应链规划运营', createdAt: now, updatedAt: now,
    text: '教育背景\n本科在读\n技能\nExcel。\n项目经历\n参与迎新活动的材料整理和部门沟通工作。\n参与库存盘点，使用 Excel 核对出入库台账。\n技能\n尚未使用 Python。' };
  const jobDescription = '职责：跟进库容与产能。\n要求：2027届，本科及以上，熟练使用 Excel，了解 SQL、Python 或 R 中的一种。\n加分项：物流或供应链管理专业优先。';
  const report = await provider.analyze({ resume, jobDescription });
  assert.equal(report.engine, 'rules');
  assert.equal(report.resumeRevision, 2);
  assert.equal(report.inputSnapshot.jobDescription, jobDescription);
  assert.equal(report.roleGuide?.id, 'supply-chain-logistics');
  assert.equal(report.jobReview?.items[0].priority, 'eligibility');
  assert.match(report.jobReview!.items[0].requirement, /2027届，本科及以上/);
  const excel = report.jobReview!.items.find(item => item.requirement.includes('Excel'));
  assert.equal(excel?.priority, 'required');
  assert.equal(excel?.evidence[0].excerpt, '参与库存盘点，使用 Excel 核对出入库台账');
  const alternatives = report.jobReview!.items.find(item => item.requirement.includes('SQL'));
  assert.match(alternatives!.requirement, /或 R 中的一种/);
  assert.deepEqual(alternatives?.evidence.find(item => item.term === 'SQL'), { term: 'SQL' });
  assert.equal(alternatives?.evidence.find(item => item.term === 'Python')?.excerpt, '尚未使用 Python');
  assert.equal(report.jobReview?.items.at(-1)?.priority, 'preferred');
  assert.ok(report.jobReview?.items.every(item => !item.requirement.includes('跟进库容')));
  assert.ok(report.suggestions.every(suggestion => suggestion.needsConfirmation && suggestion.replacement.startsWith(suggestion.original)));
  assert.equal(report.suggestions[0]?.original, '参与库存盘点，使用 Excel 核对出入库台账。');
});

test('non-technical JD surfaces certification without assuming it, generic JDs keep manual review', async () => {
  const resume: Resume = { id: 'sample', revision: 1, title: '合成简历', targetRole: '小学教师', createdAt: now, updatedAt: now,
    text: '教学实习\n参与课程设计并交付教案。\n尚未取得教师资格证。' };
  const report = await provider.analyze({ resume, jobDescription: '招聘条件：持有教师资格证。\n具备课堂管理能力。\n有教研经历优先。' });
  assert.equal(report.roleGuide?.id, 'education');
  assert.equal(report.jobReview?.items[0].priority, 'eligibility');
  assert.equal(report.jobReview?.items[0].evidence[0].excerpt, '尚未取得教师资格证');
  assert.equal(report.jobReview?.items[1].evidence[0].excerpt, undefined);
  assert.equal(report.jobReview?.items[2].priority, 'preferred');
  const generic = await provider.analyze({ resume, targetRole: '其他', jobDescription: '能按月输出方案和书面反馈。' });
  assert.equal(generic.roleGuide, undefined);
  assert.deepEqual(generic.jobReview?.items, [{ requirement: '能按月输出方案和书面反馈', priority: 'review', evidence: [] }]);
});
