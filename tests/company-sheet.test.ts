import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCompanySheet } from '../server/company-sheet.js';

const headers = ['更新/开启时间', '企业/招聘单位名称', '企业/单位性质', '行业分类', '招聘类型/批次', '招聘对象', '招聘岗位', '工作地点', '网申截止时间', '投递方式', '官方招聘推文', '备注'];
function source(row: unknown[] = ['2026-03-01', '合成测试企业', '国企', '软件/信息服务', '春招', '2026届\n本科及以上', '后端软件开发工程师', '北京/上海', '招满即止', '点击申请', '查看推文', '合成推广备注']) {
  return { headers, rows: [row], rowNumbers: [8], source: { stoppedUpdatingNotices: ['本表即日起不再更新'] } };
}
test('sheet preparation keeps the application deadline in shared prose and reports the archived source separately', () => {
  const { table, report } = prepareCompanySheet(source(), [{ row: 8, column: 10, hrefs: ['https://example.test/jobs'] }, { row: 8, column: 11, hrefs: ['https://example.test/news'] }]);
  assert.deepEqual(table.rowNumbers, [8]);
  assert.match(table.rows[0][8], /网申截止时间：招满即止/);
  assert.equal(table.rows[0][8].includes('2026-03-01'), false);
  assert.equal(table.rows[0][8].includes('来源状态'), false);
  assert.equal(table.rows[0][8].includes('来源开启'), false);
  assert.equal(table.rows[0][8].includes('来源截止说明'), false);
  assert.match(table.rows[0][8], /后端软件开发工程师/);
  assert.match(table.rows[0][8], /https:\/\/example.test\/news/);
  assert.equal(table.rows[0][9], 'https://example.test/jobs');
  assert.equal(table.rows[0][5], '软件与计算机');
  assert.equal(table.rows[0][7], '本科及以上');
  assert.equal(table.rows[0][4], '2026届');
  assert.equal(report.archivedSource, true);
  assert.equal(JSON.stringify(table).includes('合成推广备注'), false);
});
test('sheet preparation excludes private contact channels and unsafe links without deleting the company facts', () => {
  const row = source().rows[0]; row[9] = '请联系：synthetic@example.test';
  const { table, report } = prepareCompanySheet(source(row), [{ row: 8, column: 10, hrefs: ['mailto:synthetic@example.test', 'javascript:alert(1)', 'https://example.test/apply?email=synthetic@example.test'] }]);
  assert.equal(table.rows[0][0], '合成测试企业');
  assert.equal(table.rows[0][9], '');
  assert.equal(JSON.stringify(table).includes('synthetic@example.test'), false);
  assert.equal(report.contactDeliveryRows, 1);
  assert.equal(report.discardedLinks, 3);
});

test('contact-only delivery instructions cannot become shared prose or invalidate an otherwise usable company row', () => {
  const row = source().rows[0]; row[9] = '投递链接及联系方式详见来源';
  const prepared = prepareCompanySheet(source(row), []);
  assert.equal(prepared.report.contactDeliveryRows, 1);
  assert.equal(prepared.table.rows[0][8].includes('联系方式'), false);
  assert.equal(prepared.table.rows[0][0], '合成测试企业');
});
test('sheet preparation keeps missing fields empty and never fills a missing company name from another row', () => {
  const row = source().rows[0]; row[1] = ''; row[2] = ''; row[6] = '资料未列出';
  const { table, report } = prepareCompanySheet(source(row), []);
  assert.equal(table.rows[0][0], ''); assert.equal(table.rows[0][1], ''); assert.equal(table.rows[0][5], '');
  assert.equal(report.unclassifiedDirectionRows, 1);
  assert.throws(() => prepareCompanySheet({ ...source(), headers: ['错误列'] }, []));
});

test('classification groups source industry words and city spelling variants without inferring from company names', () => {
  const row = source().rows[0]; row[3] = '建筑/施工'; row[7] = '北京市/浙江省杭州市/全国（不含北京）';
  const prepared = prepareCompanySheet(source(row), []);
  assert.equal(prepared.table.rows[0][2], '建筑土木与房地产');
  assert.equal(prepared.table.rows[0][6], '北京\n杭州\n全国（不含北京）');
  assert.match(prepared.table.rows[0][8], /行业原文：建筑\/施工/);
  row[1] = '合成互联网企业名称'; row[3] = '';
  assert.equal(prepareCompanySheet(source(row), []).table.rows[0][2], '');
});
