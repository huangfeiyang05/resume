import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledCareerCatalogPath, loadCareerCatalog, validateCareerCatalog } from '../server/career-catalog.js';
import { CareerService } from '../server/career.js';
import { JsonStore } from '../server/store.js';

const portal = { id: 'synthetic-portal', organization: '合成测试机构', majors: ['计算机与软件'], audience: '校园招聘', description: '仅供测试的入口，不代表当前有在招岗位。', sourceUrl: 'https://example.test/careers', checkedAt: '2026-10-27T10:00:00+08:00' };
const empty = { version: 1, jobs: [], materials: [] };

test('catalogue v1 remains valid and v2 validates recruitment provenance without turning entry points into jobs', () => {
  assert.deepEqual(validateCareerCatalog(empty).portals, []);
  const result = validateCareerCatalog({ ...empty, version: 2, portals: [portal] });
  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.portals, [portal]);
  for (const input of [
    { ...empty, portals: [portal] }, { ...empty, version: 2 },
    { ...empty, version: 2, portals: [portal, portal] },
    ...[
      { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://user:secret@example.test/careers' },
      { sourceUrl: 'http://example.test/careers' }, { majors: [] }, { majors: ['计算机', '计算机'] },
      { checkedAt: '2026-02-31T00:00:00+08:00' }, { availability: 'open' },
    ].map(overrides => ({ ...empty, version: 2, portals: [{ ...portal, ...overrides }] })),
  ]) assert.throws(() => validateCareerCatalog(input));
});

test('missing defaults can load public bundled content while explicit empty, broken or missing overrides keep their meaning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'career-catalog.json');
  const fallback = join(directory, 'public.json');
  await writeFile(fallback, JSON.stringify({ ...empty, version: 2, portals: [portal] }));
  assert.equal((await loadCareerCatalog(path)).state, 'empty');
  assert.equal((await loadCareerCatalog(path, fallback)).portals.length, 1);
  await writeFile(path, JSON.stringify(empty));
  assert.equal((await loadCareerCatalog(path, fallback)).state, 'empty', 'explicit empty content must not be replaced');
  await writeFile(path, '{broken');
  const broken = await loadCareerCatalog(path, fallback);
  assert.equal(broken.state, 'unavailable', 'invalid local overrides must not be disguised by fallback');
  assert.deepEqual(broken.portals, []);
  assert.equal(JSON.stringify(broken).includes(directory), false);
  await writeFile(path, JSON.stringify({ ...empty, version: 2, portals: [portal] }));
  assert.equal((await loadCareerCatalog(path, fallback)).state, 'ready', 'corrected content can be read without restarting');
});

test('default workspace serves original guides for all existing majors and official entry points without inventing open vacancies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'youfang-bundled-career-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const playbooks = JSON.parse(await readFile(new URL('../docs/resume-library/playbooks.json', import.meta.url), 'utf8'));
  const catalog = await loadCareerCatalog(bundledCareerCatalogPath);
  assert.equal(catalog.state, 'ready');
  assert.deepEqual(catalog.jobs, []);
  assert.ok(catalog.portals.length >= 8);
  for (const track of playbooks.tracks) {
    assert.ok(catalog.materials.some(item => item.major === track.name && item.id.startsWith('resume-guide-')));
    assert.ok(catalog.materials.some(item => item.major === track.name && item.sourceUrl?.startsWith('https://') && !item.id.startsWith('resume-guide-')));
  }
  const service = new CareerService(new JsonStore(join(directory, 'resumes.json')), 'synthetic-owner');
  const workspace = await service.workspace();
  assert.equal(workspace.mode, 'preview');
  assert.equal(workspace.externalDeliveryAvailable, false);
  assert.deepEqual(workspace.jobs, []);
  assert.deepEqual(workspace.portals, catalog.portals);
  assert.equal(workspace.materials.length, catalog.materials.length);
});
