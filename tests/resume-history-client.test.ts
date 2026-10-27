import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Resume, ResumeVersion, ResumeVersionSummary, RestoreResumeInput } from '../shared/types.js';
import { api, ApiError } from '../src/services/api.js';
import { useResumeHistory } from '../src/services/resumeHistory.js';

function resume(id = 'A', revision = 2): Resume {
  return { id, revision, title: `简历 ${id}`, targetRole: '后端开发', text: `已保存的真实经历：整理业务需求和项目文档，记录实际处理过程。修订 ${revision}`, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z' };
}
function version(id = 'A', revision = 1): ResumeVersion {
  const snapshot = resume(id, revision);
  return { resumeId: id, revision, title: snapshot.title, targetRole: snapshot.targetRole, recordedAt: snapshot.updatedAt, contentHash: 'fixture-hash', source: 'edited', snapshot };
}
function summary(item: ResumeVersion): ResumeVersionSummary { const { snapshot: _snapshot, ...result } = item; return result; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}
function fixture(t: TestContext) {
  const original = { ...api };
  api.resume = async id => resume(id);
  api.versions = async id => [summary(version(id, 2)), summary(version(id, 1))];
  api.version = async (id, revision) => version(id, revision);
  const h = useResumeHistory();
  t.after(() => { h.dispose(); Object.assign(api, original); });
  return h;
}

test('a late history response cannot put one resumes private content under another', async t => {
  const h = fixture(t);
  const pending = deferred<ResumeVersionSummary[]>();
  api.versions = id => id === 'A' ? pending.promise : Promise.resolve([summary(version('B', 1))]);
  const loadingA = h.load('A');
  await h.load('B');
  pending.resolve([summary(version('A', 1))]);
  await loadingA;
  assert.equal(h.current.value?.id, 'B');
  assert.equal(h.selected.value?.resumeId, 'B');
  assert.deepEqual(h.versions.value.map(item => item.resumeId), ['B']);
  assert.equal(h.reviewed.value, false);
});

test('changing the historical selection clears confirmation and discards out of order details', async t => {
  const h = fixture(t);
  await h.load('A');
  h.reviewed.value = true;
  const pending = deferred<ResumeVersion>();
  api.version = (_id, revision) => revision === 1 ? pending.promise : Promise.resolve(version('A', 2));
  const selectingOld = h.choose(1);
  assert.equal(h.reviewed.value, false);
  await h.choose(2);
  pending.resolve(version('A', 1));
  await selectingOld;
  assert.equal(h.selected.value?.revision, 2);
  assert.equal(h.sameContent.value, true);
});

test('restoration blocks unchecked, unchanged and incomplete content', async t => {
  const h = fixture(t);
  let requests = 0;
  api.restoreVersion = async () => { ++requests; return { resume: resume('A', 3), restoredFromRevision: 1, alreadyRestored: false, noChange: false }; };
  await h.load('A');
  await h.restore();
  assert.equal(requests, 0);
  await h.choose(2); h.reviewed.value = true;
  await h.restore();
  assert.equal(requests, 0);
  api.version = async () => ({ ...version('A', 1), snapshot: { ...resume('A', 1), text: '[请填写真实验收依据]' } });
  await h.choose(1); h.reviewed.value = true;
  await h.restore();
  assert.equal(requests, 0);
});

test('an ambiguous network failure retries the exact restore key and a conflict requires another review', async t => {
  const h = fixture(t);
  await h.load('A'); h.reviewed.value = true;
  const submitted: RestoreResumeInput[] = [];
  api.restoreVersion = async (_id, _revision, input) => {
    submitted.push(structuredClone(input));
    if (submitted.length === 1) throw new ApiError('连接中断', 'NETWORK_ERROR', 0);
    return { resume: resume('A', 3), restoredFromRevision: 1, alreadyRestored: true, noChange: false };
  };
  await h.restore();
  assert.equal(h.reviewed.value, true);
  const result = await h.restore();
  assert.equal(result?.alreadyRestored, true);
  assert.deepEqual(submitted[0], submitted[1]);
  assert.equal(h.reviewed.value, false);
  await h.load('A'); h.reviewed.value = true;
  api.restoreVersion = async () => { throw new ApiError('请重新核对', 'REVISION_CONFLICT', 409); };
  await h.restore();
  assert.equal(h.reviewed.value, false);
  assert.match(h.error.value, /重新核对/);
});

test('disposing the history reader discards an inflight private snapshot', async t => {
  const h = fixture(t);
  const pending = deferred<Resume>();
  api.resume = () => pending.promise;
  const loading = h.load('A');
  h.dispose();
  pending.resolve(resume('A'));
  await loading;
  assert.equal(h.current.value, undefined);
  assert.equal(h.selected.value, undefined);
});
