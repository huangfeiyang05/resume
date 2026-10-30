import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CompanyImportError, prepareCompanyImport, runCompanyImport, type PrepareCompanyImportInput } from '../server/company-import.js';

const importedAt = '2026-10-30T00:00:00+08:00';
const source = { sourceTitle: '合成企业资料测试表', sourceUrl: 'https://example.test/companies', sheet: '合成工作表', importedAt };
const bytes = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const hasCode = (code: string) => (error: unknown) => error instanceof CompanyImportError && error.code === code;
function prepare(value: unknown, overrides: Partial<PrepareCompanyImportInput> = {}) {
  return prepareCompanyImport({ ...source, bytes: bytes(value), format: 'json', ...overrides });
}
async function fixture(t: TestContext, content = '公司名称,行业\n合成资料企业,软件\n') {
  const root = await mkdtemp(join(tmpdir(), 'youfang-company-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = join(root, 'input.csv'), outputPath = join(root, '.data/company-catalog.json');
  await writeFile(inputPath, content);
  return { root, inputPath, outputPath, options: { ...source, inputPath, outputPath } };
}

test('company CSV import keeps logical sheet row locations, quoted text, supplied classifications and unmapped columns', () => {
  const input = '\uFEFF合成说明行\r\n公司名称,行业,企业性质,工作地点,招聘方向,学历要求,招聘类型,届别,企业简介,网申链接,联系人,截止日期\r\n'
    + '合成资料企业,软件、数据,原表性质,北京;上海,研发、测试,本科;硕士,秋招,2026届,"第一行\r\n第二行,含逗号",https://jobs.example.test/campus,仅限私有报告的合成联系人,2025-09-01\r\n';
  const result = prepare(input, { format: 'csv', headerRow: 2 });
  assert.equal(result.catalog.records.length, 1);
  const record = result.catalog.records[0];
  assert.deepEqual(record.sources[0].rows, [3]);
  assert.equal(record.sources[0].sheet, source.sheet);
  assert.equal(record.sources[0].snapshotHash, sha(bytes(input)));
  assert.equal(record.summary, '第一行\n第二行,含逗号');
  assert.equal(record.nature, '原表性质');
  assert.deepEqual(record.locations, ['北京', '上海']);
  assert.deepEqual(record.industries, ['软件', '数据']);
  assert.deepEqual(record.directions, ['研发', '测试']);
  assert.deepEqual(record.educationLevels, ['本科', '硕士']);
  assert.deepEqual(record.recruitmentTypes, ['秋招']);
  assert.deepEqual(record.cohorts, ['2026届']);
  assert.equal(record.verification, 'source-provided');
  assert.equal('url' in record.sources[0], false, 'shared catalog does not expose source links');
  assert.equal(result.report.sourceUrl, source.sourceUrl, 'restricted report keeps the source link for audit');
  assert.equal('availability' in record, false, 'old dates do not turn into a current hiring claim');
  assert.deepEqual(result.report.unmappedColumns, ['截止日期']);
  assert.deepEqual(result.report.excludedContactColumns, ['联系人']);
  assert.equal(JSON.stringify(record).includes('合成联系人'), false);
  assert.ok(JSON.stringify(result.report.rawRows).includes('合成联系人'), 'the restricted audit copy keeps omitted source material');
});

test('JSON imports distinguish array positions from explicit source row numbers and do not infer missing company facts', () => {
  const objectRows = prepare([{ 公司名称: '合成央企字样名称不证明性质', 未映射字段: '保留在受限报告' }]);
  assert.equal(objectRows.report.rowNumberBasis, 'json-array-index');
  assert.deepEqual(objectRows.catalog.records[0].sources[0].rows, [1]);
  assert.equal(objectRows.catalog.records[0].nature, '');
  assert.deepEqual(objectRows.catalog.records[0].locations, []);
  assert.deepEqual(objectRows.catalog.records[0].cohorts, []);
  const explicit = prepare({ headers: ['公司名称', '行业'], rows: [['合成甲企业', '软件'], ['合成乙企业', '制造']], rowNumbers: [12, 97] });
  assert.equal(explicit.report.rowNumberBasis, 'explicit-row-number');
  assert.deepEqual(explicit.catalog.records.map(record => record.sources[0].rows), [[12], [97]]);
  assert.throws(() => prepare({ headers: ['公司名称'], rows: [['甲'], ['乙']], rowNumbers: [12, 12] }), hasCode('INVALID_ROW_NUMBERS'));
  assert.throws(() => prepare({ headers: ['公司名称'], rows: [['甲']], rowNumbers: [0] }), hasCode('INVALID_ROW_NUMBERS'));
  assert.throws(() => prepare([{ 公司名称: '合成企业' }], { headerRow: 2 }), hasCode('INVALID_HEADER_ROW'));
});

test('ambiguous or unsafe mappings fail before publication and explicit mappings resolve only the selected columns', () => {
  const table = { headers: ['公司名称', '企业名称', '联系电话'], rows: [['合成甲企业', '合成乙企业', '13800138000']] };
  assert.throws(() => prepare(table), hasCode('AMBIGUOUS_COLUMN'));
  const chosen = prepare(table, { mapping: { name: '企业名称' } });
  assert.equal(chosen.catalog.records[0].name, '合成乙企业');
  assert.deepEqual(chosen.report.mapping, { name: '企业名称' });
  assert.deepEqual(chosen.report.unmappedColumns, ['公司名称']);
  assert.deepEqual(chosen.report.excludedContactColumns, ['联系电话']);
  assert.throws(() => prepare(table, { mapping: { name: '企业名称', summary: '联系电话' } }), hasCode('CONTACT_COLUMN_MAPPING'));
  assert.throws(() => prepare(table, { mapping: { name: '不存在的列' } }), hasCode('MAPPING_COLUMN_MISSING'));
  assert.throws(() => prepare(table, { mapping: { name: '企业名称', summary: '企业名称' } }), hasCode('DUPLICATE_MAPPING'));
  assert.throws(() => prepare(table, { mapping: null as any }), hasCode('INVALID_MAPPING'));
  assert.throws(() => prepare([{ 行业: '软件' }]), hasCode('NAME_COLUMN_REQUIRED'));
  assert.throws(() => prepare({ headers: ['公司名称', '公 司名称'], rows: [['甲', '乙']] }), hasCode('DUPLICATE_HEADERS'));
});

test('exact duplicate facts combine provenance while same-name conflicts and subsidiaries remain distinct records', () => {
  const result = prepare([
    { 公司名称: '合成科技有限公司', 行业: '软件、数据', 地区: '北京' },
    { 公司名称: '合成科技有限公司', 行业: '数据、软件', 地区: '北京' },
    { 公司名称: '合成科技有限公司', 行业: '软件、数据', 地区: '上海' },
    { 公司名称: '合成科技北京子公司', 行业: '软件、数据', 地区: '北京' },
  ]);
  assert.equal(result.report.acceptedRows, 4);
  assert.equal(result.report.duplicateRowsMerged, 1);
  assert.equal(result.catalog.records.length, 3);
  assert.deepEqual(result.catalog.records[0].sources[0].rows, [1, 2]);
  assert.deepEqual(result.report.sameNameCandidates.map(item => item.rows), [[1, 2, 3]]);
  assert.equal(new Set(result.catalog.records.map(record => record.id)).size, 3);
});

test('duplicate provenance remains valid when more than ten thousand source rows repeat the same supplied facts', () => {
  const result = prepare({ headers: ['公司名称'], rows: Array.from({ length: 10_002 }, () => ['合成重复资料企业']) });
  assert.equal(result.catalog.records.length, 1);
  assert.equal(result.report.acceptedRows, 10_002);
  assert.equal(result.report.duplicateRowsMerged, 10_001);
  assert.deepEqual(result.catalog.records[0].sources.map(item => item.rows.length), [10_000, 2]);
  assert.equal(result.catalog.records[0].sources[1].rows[1], 10_003);
});

test('large supplied location lists and vacancy IDs in reference URLs remain readable without leaking contact URLs', () => {
  const locations = Array.from({ length: 107 }, (_, index) => `合成城市${index}`).join('、');
  const result = prepare([{ 公司名称: '合成多地区招聘单位', 工作地点: locations, 企业简介: '补充来源：https://jobs.example.test/13800138000' }]);
  assert.equal(result.report.reviewRows.length, 0);
  assert.equal(result.catalog.records[0].locations.length, 107);
  assert.match(result.catalog.records[0].summary, /13800138000/);
  for (const link of ['https://jobs.example.test/apply?email=private.person@example.test', 'https://user:secret@jobs.example.test/apply', 'https://example.test/form#email=synthetic.person%40example.test', 'https://example.test/form#phone=13800138000']) {
    const rejected = prepare([{ 公司名称: '合成联系参数行', 企业简介: `详情 ${link}` }]);
    assert.equal(rejected.catalog.records.length, 0);
    assert.equal(rejected.report.reviewRows[0].code, 'CONTACT_CONTENT');
  }
});

test('contact values and formulas are quarantined instead of becoming shared company information', () => {
  const rows = [
    { 公司名称: '合成安全企业', 公司简介: '从事软件研发与教学工具。', 联系人: '只在私有原件中保留', 招聘链接: 'https://jobs.example.test/12345678901' },
    { 公司名称: '合成手机行', 公司简介: '13800138000' },
    { 公司名称: '合成邮件行', 公司简介: 'private.person@example.test' },
    { 公司名称: '合成固话行', 公司简介: '010-12345678' },
    { 公司名称: '合成链接邮件行', 招聘链接: 'https://jobs.example.test/apply?email=private.person%40example.test' },
    { 公司名称: '合成坏转义链接行', 招聘链接: 'https://jobs.example.test/%zz?email=private.person%40example.test' },
    { 公司名称: '=HYPERLINK("https://example.test","not evaluated")' },
  ];
  const result = prepare(rows);
  assert.equal(result.catalog.records.length, 1);
  assert.equal(result.catalog.records[0].name, '合成安全企业');
  assert.deepEqual(result.report.reviewRows.map(item => item.row), [2, 3, 4, 5, 6, 7]);
  assert.equal(result.report.reviewRows.at(-1)?.code, 'FORMULA_CONTENT');
  assert.equal(JSON.stringify(result.catalog).includes('private.person'), false);
  assert.equal(JSON.stringify(result.catalog).includes('13800138000'), false);
  assert.ok(JSON.stringify(result.report.rawRows).includes('private.person'));
});

test('malformed input, oversized tables and unsupported formats fail rather than silently becoming an empty company library', () => {
  assert.throws(() => prepare('公司名称\n"引号未闭合', { format: 'csv' }), hasCode('INVALID_CSV'));
  assert.throws(() => prepare('公司名称\n"结束后"异常', { format: 'csv' }), hasCode('INVALID_CSV'));
  assert.throws(() => prepare('{bad json'), hasCode('INVALID_JSON'));
  assert.throws(() => prepare([{ 公司名称: { nested: 'object' } }]), hasCode('INVALID_CELL'));
  assert.throws(() => prepare('公司名称\n合成企业', { format: 'csv', bytes: Buffer.from([0xff, 0xfe]) }), hasCode('INVALID_ENCODING'));
  assert.throws(() => prepare('公司名称\n合成企业', { format: 'csv', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }), hasCode('INPUT_TOO_LARGE'));
  assert.throws(() => prepare({ headers: ['公司名称'], rows: Array.from({ length: 25_001 }, () => ['合成企业']) }), hasCode('INVALID_TABLE'));
  assert.throws(() => prepare([{ 公司名称: '合成企业' }], { format: 'xlsx' as any }), hasCode('UNSUPPORTED_FORMAT'));
  assert.throws(() => prepare([{ 公司名称: '合成企业' }], { sourceUrl: 'https://user:secret@example.test/source' }), hasCode('INVALID_SOURCE_URL'));
  const invalidUrl = prepare([{ 公司名称: '合成企业', 招聘链接: 'javascript:alert(1)' }]);
  assert.equal(invalidUrl.catalog.records.length, 0);
  assert.equal(invalidUrl.report.reviewRows[0].code, 'INVALID_RECORD');
});

test('dry-run saves restricted audit material but does not publish a company catalogue', async t => {
  const f = await fixture(t);
  const result = await runCompanyImport(f.options);
  assert.equal(result.applied, false);
  await assert.rejects(readFile(f.outputPath), { code: 'ENOENT' });
  await assert.rejects(readFile(`${f.outputPath}.import-state.json`), { code: 'ENOENT' });
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.outputWritten, false);
  assert.equal((await stat(result.reportPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(result.reportPath))).mode & 0o777, 0o700);
  const raw = join(dirname(result.reportPath), 'input.csv');
  assert.deepEqual(await readFile(raw), await readFile(f.inputPath));
  assert.equal((await stat(raw)).mode & 0o777, 0o600);
  await assert.rejects(readFile(`${f.outputPath}.import.lock`), { code: 'ENOENT' });
});

test('applying the same import is idempotent and metadata changes cannot silently reuse or overwrite it', async t => {
  const f = await fixture(t, '公司名称,备用名称,行业\n合成企业,另一个来源名称,软件\n');
  const first = await runCompanyImport({ ...f.options, apply: true });
  assert.equal(first.applied, true);
  assert.equal(first.alreadyImported, false);
  const original = await readFile(f.outputPath), originalStat = await stat(f.outputPath), originalState = await readFile(`${f.outputPath}.import-state.json`);
  const repeated = await runCompanyImport({ ...f.options, apply: true, importedAt: '2026-10-31T00:00:00+08:00' });
  assert.equal(repeated.alreadyImported, true);
  assert.deepEqual(await readFile(f.outputPath), original);
  assert.deepEqual(await readFile(`${f.outputPath}.import-state.json`), originalState);
  assert.equal((await stat(f.outputPath)).mtimeMs, originalStat.mtimeMs);
  for (const changed of [
    { sourceUrl: 'https://example.test/another-source' }, { sourceTitle: '另一份来源资料' },
    { sheet: '另一工作表' }, { mapping: { name: '备用名称' } },
  ]) await assert.rejects(runCompanyImport({ ...f.options, ...changed, apply: true }), hasCode('REPLACE_REQUIRED'));
  assert.deepEqual(await readFile(f.outputPath), original);
});

test('replacing different input requires an explicit request and retains exact private backups', async t => {
  const f = await fixture(t);
  await runCompanyImport({ ...f.options, apply: true });
  const before = await readFile(f.outputPath), state = await readFile(`${f.outputPath}.import-state.json`);
  await writeFile(f.inputPath, '公司名称,行业\n合成替换企业,制造\n');
  await assert.rejects(runCompanyImport({ ...f.options, apply: true }), hasCode('REPLACE_REQUIRED'));
  assert.deepEqual(await readFile(f.outputPath), before);
  const replaced = await runCompanyImport({ ...f.options, apply: true, replace: true });
  assert.ok(replaced.backupDirectory);
  assert.deepEqual(await readFile(join(replaced.backupDirectory!, basename(f.outputPath))), before);
  assert.deepEqual(await readFile(join(replaced.backupDirectory!, 'import-state.json')), state);
  assert.equal((await stat(replaced.backupDirectory!)).mode & 0o777, 0o700);
  assert.equal((await stat(join(replaced.backupDirectory!, basename(f.outputPath)))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(f.outputPath, 'utf8')).records[0].name, '合成替换企业');
  assert.equal((await stat(f.outputPath)).mode & 0o777, 0o600);
});

test('quarantined rows block publication until the operator explicitly allows a partial import', async t => {
  const f = await fixture(t, '公司名称,公司简介\n合成安全企业,安全描述\n合成待审核企业,13800138000\n');
  await assert.rejects(runCompanyImport({ ...f.options, apply: true }), hasCode('REVIEW_REQUIRED'));
  await assert.rejects(readFile(f.outputPath), { code: 'ENOENT' });
  const result = await runCompanyImport({ ...f.options, apply: true, allowPartial: true });
  assert.equal(result.report.acceptedRows, 1);
  assert.equal(result.report.reviewRows.length, 1);
  assert.equal(JSON.parse(await readFile(f.outputPath, 'utf8')).records.length, 1);
  assert.equal((await readFile(f.outputPath, 'utf8')).includes('13800138000'), false);
});

test('lock ownership and failed input recovery do not damage an existing catalogue or leave a new import locked', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.outputPath), { recursive: true });
  const lockPath = `${f.outputPath}.import.lock`;
  await writeFile(lockPath, '合成外部锁');
  await assert.rejects(runCompanyImport({ ...f.options, apply: true }), hasCode('IMPORT_LOCKED'));
  assert.equal(await readFile(lockPath, 'utf8'), '合成外部锁', 'a rejected concurrent importer cannot delete another importer lock');
  await rm(lockPath);
  await writeFile(f.inputPath, '公司名称\n"损坏的CSV');
  await assert.rejects(runCompanyImport({ ...f.options, apply: true }), hasCode('INVALID_CSV'));
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  await writeFile(f.inputPath, '公司名称\n合成恢复企业\n');
  await runCompanyImport({ ...f.options, apply: true });
  const damaged = '{ 合成损坏目录';
  await writeFile(f.outputPath, damaged);
  await assert.rejects(runCompanyImport({ ...f.options, apply: true }), hasCode('REPLACE_REQUIRED'));
  assert.equal(await readFile(f.outputPath, 'utf8'), damaged);
  const recovered = await runCompanyImport({ ...f.options, apply: true, replace: true });
  assert.equal(await readFile(join(recovered.backupDirectory!, basename(f.outputPath)), 'utf8'), damaged);
  assert.equal(JSON.parse(await readFile(f.outputPath, 'utf8')).records[0].name, '合成恢复企业');
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});

test('report paths cannot overwrite import locks, states, snapshots or unrelated files, and symlinks fail closed', async t => {
  const f = await fixture(t);
  await runCompanyImport({ ...f.options, apply: true });
  const before = await readFile(f.outputPath), state = await readFile(`${f.outputPath}.import-state.json`);
  for (const reportPath of [f.inputPath, f.outputPath, `${f.outputPath}.import.lock`, `${f.outputPath}.import-state.json`]) {
    await assert.rejects(runCompanyImport({ ...f.options, reportPath, apply: true }), hasCode('PATH_CONFLICT'));
  }
  const unrelated = join(f.root, 'unrelated.json');
  await writeFile(unrelated, '{"unrelated":"preserve"}');
  await assert.rejects(runCompanyImport({ ...f.options, reportPath: unrelated }), hasCode('REPORT_CONFLICT'));
  assert.equal(await readFile(unrelated, 'utf8'), '{"unrelated":"preserve"}');
  const linked = join(f.root, 'linked-report.json');
  await symlink(unrelated, linked);
  await assert.rejects(runCompanyImport({ ...f.options, reportPath: linked }), hasCode('SYMLINK_NOT_ALLOWED'));
  assert.deepEqual(await readFile(f.outputPath), before);
  assert.deepEqual(await readFile(`${f.outputPath}.import-state.json`), state);
});

test('CLI rejects an explicitly invalid mapping and prints only safe import counts for a dry run', async t => {
  const f = await fixture(t, '公司名称,联系人\n合成CLI企业,13800138000\n');
  const mapping = join(f.root, 'mapping.json');
  await writeFile(mapping, 'null');
  const script = fileURLToPath(new URL('../scripts/import-company-library.ts', import.meta.url));
  const args = ['--import', 'tsx', script, '--input', f.inputPath, '--output', f.outputPath, '--source-title', source.sourceTitle];
  const invalid = spawnSync(process.execPath, [...args, '--mapping', mapping], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).code, 'INVALID_MAPPING');
  const preview = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000 });
  assert.equal(preview.status, 0, preview.stderr);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.applied, false);
  assert.equal(result.acceptedRows, 1);
  assert.equal(result.excludedContactColumns, 1);
  assert.equal(preview.stdout.includes('13800138000'), false);
  assert.equal(preview.stdout.includes('合成CLI企业'), false);
  await assert.rejects(readFile(f.outputPath), { code: 'ENOENT' });
});
