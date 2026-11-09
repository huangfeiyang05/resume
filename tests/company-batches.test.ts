import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CompanyBatches } from '../server/company-batches.js';
import { CompanyCatalogRepository } from '../server/company-catalog.js';
import { prepareCompanyImport } from '../server/company-import.js';

const original = '公司名称,招聘批次,招聘链接\n示例集团,春招,https://example.test/spring\n';
const batch = original + '示例集团,秋招,https://example.test/autumn\n示例集团,秋招,https://example.test/autumn\n另一个单位,秋招,https://example.test/careers\n';

test('company batch preview filters private rows and duplicates, publishes once, and restores exact earlier bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'company-batches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'company-catalog.json');
  const baseline = JSON.stringify(prepareCompanyImport({ bytes: Buffer.from(original), format: 'csv', sourceTitle: '历史目录' }).catalog, null, 2);
  await writeFile(file, baseline);
  const repository = new CompanyCatalogRepository(file);
  const batches = new CompanyBatches(repository);
  const actor = 'first-admin';
  async function stage(csv: string) {
    const bytes = Buffer.from(csv);
    const id = randomUUID(), chunk = { id, index: 0, data: bytes.toString('base64') };
    assert.deepEqual(batches.chunk(chunk, actor), { receivedBytes: bytes.length });
    assert.deepEqual(batches.chunk(chunk, actor), { receivedBytes: bytes.length });
    assert.throws(() => batches.chunk({ ...chunk, data: 'eA==' }, actor), { code: 'COMPANY_BATCH_CHUNK_CONFLICT' });
    assert.throws(() => batches.chunk(chunk, 'other-admin'), { status: 404 });
    return batches.preview({ id, bytes: bytes.length, format: 'csv', sourceTitle: '校招历史批次' }, actor);
  }
  const blocked = await stage(batch + '私密示例,联系人：张某,https://example.test/secret\n');
  assert.equal(blocked.id, null);
  assert.equal(blocked.reviewCount, 1);
  assert.equal(JSON.stringify(batches.reviewReport({ id: blocked.reportId }, actor)).includes('张某'), false);
  assert.throws(() => batches.reviewReport({ id: blocked.reportId }, 'other-admin'), { status: 404 });
  assert.equal(await readFile(file, 'utf8'), baseline);

  const first = await stage(batch);
  assert.equal(first.existingRecords, 1);
  assert.equal(first.duplicateRows, 1);
  assert.equal(first.sameNameRecords, 1);
  assert.equal(first.afterCount, 3);
  await assert.rejects(batches.apply({ id: first.id, confirmed: true }, 'other-admin'), { status: 404 });
  await assert.rejects(batches.apply({ id: first.id, confirmed: false }, actor), { status: 400 });
  await writeFile(file, baseline + '\n');
  await assert.rejects(batches.apply({ id: first.id, confirmed: true }, actor), { code: 'COMPANY_BATCH_STALE' });
  await writeFile(file, baseline);
  const preview = await stage(batch);
  const applied = await batches.apply({ id: preview.id, confirmed: true }, actor);
  assert.equal(applied.afterCount, 3);
  assert.equal((await repository.load()).records.filter(record => record.name === '示例集团').length, 2);
  assert.deepEqual(await new CompanyBatches(repository).apply({ id: preview.id, confirmed: true }, actor), applied);
  assert.equal((await batches.state()).history.length, 1);
  assert.equal((await stage(batch)).id, null);

  const rollback = await batches.previewRollback({}, actor);
  assert.equal(rollback.afterCount, 1);
  const reverted = await batches.apply({ id: rollback.id, confirmed: true }, actor);
  assert.equal(reverted.action, 'rollback');
  assert.equal(await readFile(file, 'utf8'), baseline);
  assert.deepEqual((await batches.state()).history.map(event => event.action), ['rollback', 'publish']);

  // A crash after switching the directory but before finalizing its audit is still recoverable.
  const journal = join(directory, 'company-batches/journal.json');
  await writeFile(journal, JSON.stringify({ events: [applied], pending: reverted }));
  assert.equal((await batches.state()).history.length, 2);
  assert.deepEqual(await batches.apply({ id: rollback.id, confirmed: true }, actor), reverted);
});

test('single company edits bind the selected record and revision, preserve provenance, and use batch recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'company-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'company-catalog.json');
  const csv = '公司名称,招聘批次,招聘链接,企业简称\n示例集团,春招,https://example.test/spring,示例ＧＲＯＵＰ\n示例集团,秋招,https://example.test/autumn,\n';
  const bytes = Buffer.from(csv);
  const { catalog } = prepareCompanyImport({ bytes, format: 'csv', sourceTitle: '历史资料', importedAt: '2025-01-01T00:00:00Z' });
  const [spring, autumn] = catalog.records;
  catalog.records.push(...Array.from({ length: 20 }, (_, index) => ({
    ...autumn, id: `test-company-${index}`, name: `合成目录企业 ${index}`,
  })));
  const baseline = JSON.stringify(catalog, null, 2);
  await writeFile(file, baseline);
  const repository = new CompanyCatalogRepository(file);
  const batches = new CompanyBatches(repository);
  const actor = 'first-admin';
  assert.deepEqual((await batches.searchForEdit({ q: '示例集团', page: 1 })).items.map(item => item.id), [spring.id, autumn.id]);
  assert.deepEqual((await batches.searchForEdit({ q: 'group', page: 1 })).items.map(item => item.id), [spring.id]);
  const lastPage = await batches.searchForEdit({ q: '', page: 2 });
  assert.deepEqual([lastPage.total, lastPage.page, lastPage.items.length], [22, 2, 2]);
  await assert.rejects(batches.searchForEdit({ q: '', page: 0 }), { status: 400 });
  await assert.rejects(batches.editDetail('missing-company'), { status: 404 });

  async function previewOldImport() {
    const id = randomUUID();
    batches.chunk({ id, index: 0, data: bytes.toString('base64') }, actor);
    return batches.preview({ id, bytes: bytes.length, format: 'csv', sourceTitle: '重新导入原表' }, actor);
  }
  assert.equal((await previewOldImport()).existingRecords, 2);
  const detail = await batches.editDetail(spring.id);
  assert.deepEqual(detail.record, spring);
  const input = { companyId: spring.id, catalogRevision: detail.catalogRevision, sourceTitle: '招聘页面更正',
    changes: { recruitmentTypes: [' 春季招聘 '], recruitmentUrl: null } };
  for (const changes of [{ id: 'wrong-company' }, { sources: [] }, { recruitmentTypes: '秋招' },
    { summary: '联系人：合成测试' }, { aliases: ['＝1+1'] }, { recruitmentUrl: 'https://example.test/jobs?email=test%40example.test' },
    { name: ' 示例集团 ' }, {}]) {
    await assert.rejects(batches.previewEdit({ ...input, changes }, actor), { status: 400 });
  }
  await assert.rejects(batches.previewEdit({ ...input, sourceTitle: 'https://example.test/source' }, actor), { status: 400 });
  await assert.rejects(batches.previewEdit({ ...input, changes: {
    aliases: [], recruitmentTypes: autumn.recruitmentTypes, recruitmentUrl: autumn.recruitmentUrl,
  } }, actor), { code: 'COMPANY_BATCH_DUPLICATE' });

  const preview = await batches.previewEdit(input, actor);
  assert.deepEqual(preview.edit, { companyId: spring.id, name: spring.name, fields: [
    { key: 'recruitmentTypes', before: ['春招'], after: ['春季招聘'] },
    { key: 'recruitmentUrl', before: spring.recruitmentUrl, after: null },
  ] });
  assert.equal(preview.beforeCount, preview.afterCount);
  assert.equal(await readFile(file, 'utf8'), baseline);
  await assert.rejects(batches.apply({ id: preview.id, confirmed: false }, actor), { status: 400 });
  await assert.rejects(batches.apply({ id: preview.id, confirmed: true }, 'other-admin'), { status: 404 });
  await writeFile(file, baseline + '\n');
  await assert.rejects(batches.previewEdit(input, actor), { code: 'COMPANY_BATCH_STALE' });
  await assert.rejects(batches.apply({ id: preview.id, confirmed: true }, actor), { code: 'COMPANY_BATCH_STALE' });
  const updated = await batches.previewEdit({ ...input, catalogRevision: (await batches.editDetail(spring.id)).catalogRevision }, actor);
  const apply = { id: updated.id, confirmed: true };
  const event = await batches.apply(apply, actor);
  assert.equal(event.editedCompanyId, spring.id);
  assert.equal(event.sourceTitle, input.sourceTitle);
  assert.deepEqual(await new CompanyBatches(repository).apply(apply, actor), event);
  const { recruitmentUrl: _url, updatedAt: _timestamp, ...untouched } = spring;
  const edited = await repository.get(spring.id);
  assert.deepEqual(edited, { ...untouched, recruitmentTypes: ['春季招聘'], updatedAt: edited.updatedAt });
  assert.ok(Date.parse(edited.updatedAt) > Date.parse(spring.updatedAt));
  assert.deepEqual((await repository.load()).records.slice(1), catalog.records.slice(1));
  assert.deepEqual((await batches.state()).history, [event]);
  await assert.rejects(previewOldImport(), { code: 'COMPANY_BATCH_ID_CONFLICT' });

  const rollback = await batches.previewRollback({}, actor);
  assert.deepEqual(rollback.edit?.fields, [
    { key: 'recruitmentTypes', before: ['春季招聘'], after: ['春招'] },
    { key: 'recruitmentUrl', before: null, after: spring.recruitmentUrl },
  ]);
  const restored = await batches.apply({ id: rollback.id, confirmed: true }, actor);
  assert.equal(restored.editedCompanyId, spring.id);
  assert.equal(await readFile(file, 'utf8'), baseline + '\n');
  assert.deepEqual(await repository.get(spring.id), spring);
  assert.deepEqual((await batches.previewRollback({}, actor)).edit, preview.edit);
});
