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
