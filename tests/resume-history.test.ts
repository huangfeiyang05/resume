import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { JsonStore } from '../server/store.js';
import { ResumeService } from '../server/service.js';
import { HttpError } from '../server/errors.js';
import { createApiServer } from '../server/http.js';

const text = '工作经历\n负责业务系统的需求分析、接口维护和项目文档整理，与团队共同处理日常问题。\n教育背景\n计算机专业本科。';
const input = { title: '真实简历', targetRole: '后端开发', text };
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'resumes.json');
  const store = new JsonStore(path);
  return { path, store, service: new ResumeService(store).forUser('owner') };
}

test('creation, editing, suggestion application and restoration retain immutable snapshots after restart', async t => {
  const { path, service } = await fixture(t);
  const first = await service.createResume(input);
  const edited = await service.updateResume(first.id, { title: '第二份名称', revision: 1 });
  await service.updateResume(first.id, { title: edited.title, revision: 2 });
  const report = await service.analyze({ resumeId: first.id });
  const suggestion = report.suggestions[0];
  await service.applySuggestion(report.id, suggestion.id, { confirmed: true, replacement: '梳理真实需求与接口约定，逐项记录问题定位过程，并保留团队评审的验收依据。', revision: 2 });
  const before = await service.getVersion(first.id, 1);
  const restored = await service.restoreVersion(first.id, 1, { revision: 3, confirmed: true, idempotencyKey: 'restore-initial' });
  assert.equal(restored.resume.revision, 4);
  assert.equal(restored.resume.title, first.title);
  assert.equal(restored.resume.text, first.text);
  assert.equal(restored.resume.createdAt, first.createdAt);
  assert.deepEqual(await service.getVersion(first.id, 1), before);
  const fresh = new ResumeService(new JsonStore(path)).forUser('owner');
  const versions = await fresh.listVersions(first.id);
  assert.deepEqual(versions.map(item => [item.revision, item.source]), [[4, 'restored'], [3, 'suggestion'], [2, 'edited'], [1, 'created']]);
  assert.equal(versions[0].restoredFromRevision, 1);
  assert.equal('snapshot' in versions[0], false, 'lists contain metadata, not all historical private text');
  assert.equal('userId' in versions[0], false);
  assert.deepEqual((await fresh.getVersion(first.id, 1)).snapshot, first);
  assert.equal('userId' in await fresh.getVersion(first.id, 1), false);
  assert.equal((await fresh.getVersion(first.id, 4)).contentHash, before.contentHash);
  assert.equal((await fresh.getResume(first.id)).revision, 4);
});

test('restores require review and current revision, reject placeholders, and avoid unnecessary new revisions', async t => {
  const { service } = await fixture(t);
  const saved = await service.createResume(input);
  const request = { revision: 1, confirmed: true, idempotencyKey: 'restore-review' };
  await assert.rejects(service.restoreVersion(saved.id, 1, { ...request, confirmed: false }), hasCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(service.restoreVersion(saved.id, 1, { ...request, revision: undefined }), hasCode('VALIDATION_ERROR'));
  await assert.rejects(service.restoreVersion(saved.id, 1, { ...request, userId: 'other' }), hasCode('VALIDATION_ERROR'));
  const same = await service.restoreVersion(saved.id, 1, request);
  assert.equal(same.noChange, true);
  assert.equal(same.resume.revision, 1);
  assert.equal((await service.listVersions(saved.id)).length, 1);
  await service.updateResume(saved.id, { title: '已修改名称', revision: 1 });
  await assert.rejects(service.restoreVersion(saved.id, 1, { ...request, idempotencyKey: 'restore-stale' }), hasCode('REVISION_CONFLICT'));
  const incomplete = await service.createResume({ ...input, text: `${text}\n[请填写真实验收结果]` });
  await service.updateResume(incomplete.id, { text, revision: 1 });
  await assert.rejects(service.restoreVersion(incomplete.id, 1, { ...request, revision: 2 }), hasCode('PLACEHOLDERS_UNRESOLVED'));
  assert.equal((await service.getResume(incomplete.id)).revision, 2);
});

test('concurrent restore replays are idempotent across restart and different input cannot reuse a key', async t => {
  const { path, service } = await fixture(t);
  const saved = await service.createResume(input);
  await service.updateResume(saved.id, { title: '待恢复', revision: 1 });
  const body = { revision: 2, confirmed: true, idempotencyKey: 'restore-once' };
  const [one, two] = await Promise.all([service.restoreVersion(saved.id, 1, body), service.restoreVersion(saved.id, 1, body)]);
  assert.equal(one.alreadyRestored, false);
  assert.equal(two.alreadyRestored, true);
  assert.deepEqual(one.resume, two.resume);
  assert.equal(one.resume.revision, 3);
  assert.equal((await service.listVersions(saved.id)).length, 3);
  const fresh = new ResumeService(new JsonStore(path)).forUser('owner');
  assert.equal((await fresh.restoreVersion(saved.id, 1, body)).alreadyRestored, true);
  await assert.rejects(fresh.restoreVersion(saved.id, 2, body), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(fresh.restoreVersion(saved.id, 1, { ...body, revision: 3 }), hasCode('IDEMPOTENCY_CONFLICT'));
  await fresh.updateResume(saved.id, { title: '恢复后又有编辑', revision: 3 });
  const replay = await fresh.restoreVersion(saved.id, 1, body);
  assert.equal(replay.resume.revision, 3, 'a replay reports its original commit without rewriting newer content');
  assert.equal((await fresh.getResume(saved.id)).revision, 4);
});

test('version access, restoration and deletion enforce ownership and remove associated snapshots', async t => {
  const { store, service } = await fixture(t);
  const saved = await service.createResume(input);
  const other = new ResumeService(store).forUser('other');
  await assert.rejects(other.listVersions(saved.id), hasCode('NOT_FOUND'));
  await assert.rejects(other.getVersion(saved.id, 1), hasCode('NOT_FOUND'));
  await assert.rejects(other.restoreVersion(saved.id, 1, { revision: 1, confirmed: true, idempotencyKey: 'restore-other' }), hasCode('NOT_FOUND'));
  await service.restoreVersion(saved.id, 1, { revision: 1, confirmed: true, idempotencyKey: 'restore-nochange' });
  await service.deleteResume(saved.id);
  assert.deepEqual((await store.read()).resumeVersions, []);
  assert.deepEqual((await store.read()).resumeRestores, []);
  await assert.rejects(service.getVersion(saved.id, 1), hasCode('NOT_FOUND'));
});

test('legacy data records only the currently known revision as the history baseline', async t => {
  const { path } = await fixture(t);
  const saved = { ...input, id: 'legacy-owned', userId: 'owner', revision: 7, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' };
  await writeFile(path, JSON.stringify({ version: 3, users: [], sessions: [], emailChallenges: [], resumes: [saved], analyses: [] }));
  const service = new ResumeService(new JsonStore(path)).forUser('owner');
  assert.deepEqual((await service.listVersions(saved.id)).map(item => [item.revision, item.source]), [[7, 'baseline']]);
  await assert.rejects(service.getVersion(saved.id, 6), hasCode('NOT_FOUND'));
  await service.updateResume(saved.id, { title: '开始记录新版本', revision: 7 });
  const disk = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(disk.resumeVersions.map((item: { revision: number }) => item.revision), [7, 8]);
  assert.equal((await new ResumeService(new JsonStore(path)).forUser('owner').getVersion(saved.id, 7)).snapshot.text, text);
});

test('corrupted historical content fails closed instead of being offered for restoration', async t => {
  const { path, service } = await fixture(t);
  const saved = await service.createResume(input);
  const disk = JSON.parse(await readFile(path, 'utf8'));
  disk.resumeVersions[0].snapshot.text = '文件中的内容被改变，但没有相应的历史版本校验值。';
  await writeFile(path, JSON.stringify(disk));
  await assert.rejects(new ResumeService(new JsonStore(path)).forUser('owner').listVersions(saved.id), /malformed resume history/);
});

test('writes require a revision while repeated applied suggestions still return the original application', async t => {
  const { service } = await fixture(t);
  const saved = await service.createResume(input);
  await assert.rejects(service.updateResume(saved.id, { title: '遗漏版本' }), hasCode('VALIDATION_ERROR'));
  const report = await service.analyze({ resumeId: saved.id });
  const suggestion = report.suggestions[0];
  const body = { confirmed: true, replacement: '维护真实需求清单，在团队评审中核实个人贡献，整理实际交付和验收的依据。', revision: 1 };
  await assert.rejects(service.applySuggestion(report.id, suggestion.id, { ...body, revision: undefined }), hasCode('VALIDATION_ERROR'));
  await service.applySuggestion(report.id, suggestion.id, body);
  assert.equal((await service.applySuggestion(report.id, suggestion.id, body)).alreadyApplied, true);
  assert.equal((await service.listVersions(saved.id)).length, 2);
  await service.restoreVersion(saved.id, 1, { revision: 2, confirmed: true, idempotencyKey: 'restore-analysis' });
  if (report.suggestions[1]) await assert.rejects(service.applySuggestion(report.id, report.suggestions[1].id, { ...body, revision: 3 }), hasCode('SOURCE_CONFLICT'));
});

test('version API routes require a session, validate revisions and restore only the current users snapshot', async t => {
  const { store } = await fixture(t);
  const server = createApiServer(new ResumeService(store));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const registered = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'history@example.test', password: 'Test-pw-26!' }) });
  const cookie = registered.headers.get('set-cookie')!.split(';')[0];
  const request = async (path: string, method = 'GET', value?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const created = await request('/resumes', 'POST', input), id = created.body.data.id;
  assert.equal((await fetch(`${base}/resumes/${id}/versions`)).status, 401);
  assert.equal((await request(`/resumes/${id}/versions`)).body.data.length, 1);
  assert.equal((await request(`/resumes/${id}/versions/1`)).body.data.snapshot.text, text);
  assert.equal((await request(`/resumes/${id}/versions/0`)).status, 400);
  assert.equal((await request(`/resumes/${id}/versions/1.5`)).status, 400);
  assert.equal((await request(`/resumes/${id}/versions/2`)).status, 404);
  assert.equal((await request(`/resumes/${id}`, 'PUT', { title: '缺少版本' })).status, 400);
  await request(`/resumes/${id}`, 'PUT', { title: '第二版', revision: 1 });
  const restored = await request(`/resumes/${id}/versions/1/restore`, 'POST', { revision: 2, confirmed: true, idempotencyKey: 'http-restore-key' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.resume.revision, 3);
  assert.equal((await request(`/resumes/${id}/versions/1/restore`, 'GET')).status, 405);
});
