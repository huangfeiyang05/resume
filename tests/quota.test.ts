import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { HttpError } from '../server/errors.js';
import { QuotaService, type TrustedMembershipActivation } from '../server/quota.js';
import { normalizeQuotaStorage, normalizeTokenUsage, quotaWeekMilliseconds } from '../server/quota-storage.js';
import { JsonStore } from '../server/store.js';

const start = '2026-11-05T06:30:00.000Z';
const hash = 'a'.repeat(64);
const usage = (inputTokens: number, outputTokens = 0, requestId?: string) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(requestId ? { requestId } : {}) });
function code(expected: string) { return (error: unknown) => error instanceof HttpError && error.code === expected; }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resume-quota-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'resumes.json');
  let instant = Date.parse(start), event = 0;
  const store = new JsonStore(path), quota = new QuotaService(store, () => new Date(instant));
  function activation(userId = 'alice', planId: 'basic' | 'premium' = 'basic', overrides: Partial<TrustedMembershipActivation> = {}) {
    event += 1;
    return { userId, planId, verifiedPaymentAt: new Date(instant).toISOString(), verifiedEventId: `payment-${event}`, idempotencyKey: `activation-${event}`, ...overrides };
  }
  return { store, quota, path, activation, now: () => instant, setNow: (value: number | string) => { instant = typeof value === 'string' ? Date.parse(value) : value; },
    restart: () => new QuotaService(new JsonStore(path), () => new Date(instant)) };
}

test('preview records actual supplier usage without fabricating a paid balance', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.quota.current('alice'), { status: 'preview', remainingPercent: null, resetsAt: null, expiresAt: null, pending: false });
  await f.quota.reserve('alice', 'preview-task', hash, 2_000_000);
  assert.equal((await f.quota.current('alice')).pending, true);
  await f.quota.dispatch('alice', 'preview-task');
  await f.quota.settle('alice', 'preview-task', usage(1000, 500, 'supplier-preview'));
  const stored = (await f.store.read()).aiUsage[0];
  assert.equal(stored.mode, 'preview'); assert.equal(stored.quotaAnchorAt, null);
  assert.equal(stored.usage?.totalTokens, 1500);
  assert.equal((await f.restart().current('alice')).remainingPercent, null);
});

test('actual input plus output settle once; reservations control admission without becoming displayed consumption', async t => {
  const f = await fixture(t);
  await f.quota.activateMembership(f.activation());
  await f.quota.reserve('alice', 'task-1', hash, 100_000);
  assert.equal((await f.quota.current('alice')).remainingPercent, 100);
  assert.equal((await f.quota.current('alice')).pending, true);
  await f.quota.dispatch('alice', 'task-1');
  await f.quota.settle('alice', 'task-1', usage(30_000, 10_000, 'supplier-1'));
  await f.quota.settle('alice', 'task-1', usage(30_000, 10_000, 'supplier-1'));
  await f.quota.finish('alice', 'task-1');
  assert.equal((await f.quota.current('alice')).remainingPercent, 80);
  const snapshot = await readFile(f.path, 'utf8');
  await assert.rejects(f.quota.settle('alice', 'task-1', usage(30_001, 10_000, 'supplier-1')), code('QUOTA_USAGE_CONFLICT'));
  assert.equal(await readFile(f.path, 'utf8'), snapshot, 'conflicting usage never modifies the ledger');
  assert.equal((await f.restart().current('alice')).remainingPercent, 80);
  assert.equal(/token|inputHash|requestId/i.test(JSON.stringify(await f.quota.current('alice'))), false);
  await f.quota.reserve('alice', 'task-2', hash, 160_000);
  await f.quota.dispatch('alice', 'task-2');
  await f.quota.settle('alice', 'task-2', usage(159_999));
  assert.equal((await f.quota.current('alice')).remainingPercent, 1, 'a nonzero balance never displays zero percent');
  await assert.rejects(f.quota.reserve('alice', 'task-3', hash, 2), code('AI_QUOTA_EXHAUSTED'));
});

test('concurrent calls serialize, task identity rejects changed input, and users cannot mutate another ledger', async t => {
  const f = await fixture(t);
  await f.quota.activateMembership(f.activation());
  const results = await Promise.allSettled([
    f.quota.reserve('alice', 'task-a', hash, 100_000),
    f.quota.reserve('alice', 'task-b', hash, 100_000),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const accepted = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<QuotaService['reserve']>>>).value;
  await f.quota.reserve('alice', accepted.taskId, hash, 100_000);
  assert.equal((await f.store.read()).aiUsage.length, 1);
  await assert.rejects(f.quota.reserve('alice', accepted.taskId, 'b'.repeat(64), 100_000), code('QUOTA_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.quota.reserve('alice', accepted.taskId, hash, 100_001), code('QUOTA_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.quota.reserve('bob', accepted.taskId, hash, 100_000), code('QUOTA_TASK_NOT_FOUND'));
  for (const action of [() => f.quota.dispatch('bob', accepted.taskId), () => f.quota.settle('bob', accepted.taskId, usage(1)), () => f.quota.finish('bob', accepted.taskId)]) {
    await assert.rejects(action(), code('QUOTA_TASK_NOT_FOUND'));
  }
  assert.equal((await f.quota.current('bob')).pending, false);
});

test('business failure still settles real billed usage; unknown usage retains its reservation', async t => {
  const f = await fixture(t);
  await f.quota.activateMembership(f.activation());
  await f.quota.reserve('alice', 'failed-output', hash, 100_000);
  await f.quota.dispatch('alice', 'failed-output');
  await f.quota.settle('alice', 'failed-output', usage(20_000, 20_000));
  await f.quota.finish('alice', 'failed-output');
  assert.equal((await f.quota.current('alice')).remainingPercent, 80);
  await f.quota.reserve('alice', 'unknown-usage', hash, 50_000);
  await f.quota.dispatch('alice', 'unknown-usage');
  await assert.rejects(f.quota.settle('alice', 'unknown-usage', { inputTokens: 1, outputTokens: 2, totalTokens: 4 }), code('MODEL_USAGE_INVALID'));
  await f.quota.finish('alice', 'unknown-usage');
  assert.equal((await f.store.read()).aiUsage[1].status, 'pending');
  assert.equal((await f.quota.current('alice')).remainingPercent, 80, 'unknown tokens are never guessed into displayed actual consumption');
  await assert.rejects(f.quota.reserve('alice', 'another-call', hash, 1), code('QUOTA_TASK_PENDING'));
  await f.quota.reconcile('alice', 'unknown-usage', { idempotencyKey: 'reconcile-billed', reason: 'Supplier usage confirmed', usage: usage(10_000, 10_000) });
  assert.equal((await f.quota.current('alice')).remainingPercent, 70);
  assert.equal((await f.restart().current('alice')).remainingPercent, 70);
});

test('unknown calls need audited supplier evidence; no-charge evidence cannot reverse billed usage', async t => {
  const f = await fixture(t);
  await f.quota.reserve('alice', 'unbilled', hash, 1000); await f.quota.dispatch('alice', 'unbilled'); await f.quota.finish('alice', 'unbilled');
  const input = { idempotencyKey: 'supplier-unbilled', reason: 'Supplier confirmed request was never executed', confirmedNoUsage: true as const };
  await f.quota.reconcile('alice', 'unbilled', input);
  await f.quota.reconcile('alice', 'unbilled', input);
  assert.equal((await f.store.read()).aiUsage[0].reconciliations.length, 1);
  await assert.rejects(f.quota.reconcile('alice', 'unbilled', { ...input, reason: 'Changed evidence' }), code('QUOTA_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.quota.reconcile('alice', 'unbilled', { ...input, usage: usage(1) } as never), code('INVALID_QUOTA_RECONCILIATION'));
  await assert.rejects(f.quota.settle('alice', 'unbilled', usage(1)), code('QUOTA_TASK_STATE_CONFLICT'));
  await f.quota.reserve('alice', 'billed', hash, 1000); await f.quota.dispatch('alice', 'billed'); await f.quota.settle('alice', 'billed', usage(100));
  await assert.rejects(f.quota.reconcile('alice', 'billed', { ...input, idempotencyKey: 'cannot-refund' }), code('QUOTA_TASK_STATE_CONFLICT'));
  await assert.rejects(f.quota.reconcile('alice', 'billed', input), code('QUOTA_IDEMPOTENCY_CONFLICT'));
});

test('week rollover keeps pending reservations attached to the old cycle and conservatively blocks new calls', async t => {
  const f = await fixture(t);
  await f.quota.activateMembership(f.activation());
  await f.quota.reserve('alice', 'cross-week', hash, 100_000); await f.quota.dispatch('alice', 'cross-week');
  f.setNow(Date.parse(start) + quotaWeekMilliseconds);
  assert.equal((await f.quota.current('alice')).remainingPercent, 100);
  assert.equal((await f.quota.current('alice')).resetsAt, new Date(Date.parse(start) + quotaWeekMilliseconds * 2).toISOString());
  await assert.rejects(f.quota.reserve('alice', 'next-week', hash, 1), code('QUOTA_TASK_PENDING'));
  await f.quota.finish('alice', 'cross-week');
  await f.quota.reconcile('alice', 'cross-week', { idempotencyKey: 'old-cycle-billed', reason: 'Actual usage returned after rollover', usage: usage(60_000) });
  assert.equal((await f.quota.current('alice')).remainingPercent, 100, 'late settlement never charges the next week');
  await f.quota.reserve('alice', 'next-week', hash, 200_000); await f.quota.finish('alice', 'next-week');
  assert.equal((await f.quota.current('alice')).remainingPercent, 100, 'an unused reservation cannot create extra next-week credit');
});

test('upgrades change the denominator while preserving used tokens, reservations, and the weekly anchor', async t => {
  const f = await fixture(t);
  const original = await f.quota.activateMembership(f.activation());
  await f.quota.reserve('alice', 'consumed-basic', hash, 100_000); await f.quota.dispatch('alice', 'consumed-basic'); await f.quota.settle('alice', 'consumed-basic', usage(40_000));
  await f.quota.reserve('alice', 'inflight-basic', hash, 100_000); await f.quota.dispatch('alice', 'inflight-basic');
  const oldReset = (await f.quota.current('alice')).resetsAt;
  f.setNow(Date.parse(start) + 2 * 24 * 60 * 60 * 1000);
  const input = f.activation('alice', 'premium');
  const upgrade = await f.quota.activateMembership(input);
  assert.equal(upgrade.kind, 'upgrade'); assert.equal(upgrade.quotaAnchorAt, original.quotaAnchorAt);
  assert.equal((await f.quota.current('alice')).remainingPercent, 95);
  assert.equal((await f.quota.current('alice')).resetsAt, oldReset);
  await f.quota.settle('alice', 'inflight-basic', usage(40_000));
  assert.equal((await f.quota.current('alice')).remainingPercent, 90);
  assert.deepEqual(await f.quota.activateMembership(input), upgrade, 'repeated verified payment events do not grant more time');
  await assert.rejects(f.quota.activateMembership({ ...input, userId: 'bob' }), code('MEMBERSHIP_EVENT_CONFLICT'));
  await assert.rejects(f.quota.activateMembership({ ...input, planId: 'basic' }), code('MEMBERSHIP_EVENT_CONFLICT'));
  assert.equal((await f.restart().current('alice')).remainingPercent, 90);
});

test('continuous renewal extends expiry without resetting usage, and the last week ends at membership expiry', async t => {
  const f = await fixture(t);
  const original = await f.quota.activateMembership(f.activation());
  await f.quota.reserve('alice', 'before-renewal', hash, 100_000); await f.quota.dispatch('alice', 'before-renewal'); await f.quota.settle('alice', 'before-renewal', usage(40_000));
  f.setNow(Date.parse(start) + 24 * 60 * 60 * 1000);
  const renewal = await f.quota.activateMembership(f.activation());
  assert.equal(renewal.kind, 'renewal'); assert.equal(renewal.startsAt, original.expiresAt);
  assert.equal(renewal.quotaAnchorAt, original.quotaAnchorAt);
  assert.equal((await f.quota.current('alice')).remainingPercent, 80);
  assert.equal((await f.quota.getMembershipRecord('alice'))?.startsAt, start, 'prepaid renewal does not make the current membership start in the future');
  f.setNow(Date.parse(renewal.expiresAt) - 1);
  assert.equal((await f.quota.current('alice')).resetsAt, renewal.expiresAt);
  await f.quota.reserve('alice', 'before-expiry', hash, 100_000); await f.quota.dispatch('alice', 'before-expiry');
  f.setNow(renewal.expiresAt);
  assert.equal((await f.quota.current('alice')).status, 'inactive');
  await assert.rejects(f.quota.reserve('alice', 'after-expiry', hash, 1), code('MEMBERSHIP_EXPIRED'));
  await f.quota.settle('alice', 'before-expiry', usage(40_000));
  assert.equal((await f.quota.current('alice')).status, 'inactive', 'accepted work may finish after expiry without reopening admission');
  const repurchase = await f.quota.activateMembership(f.activation());
  assert.equal(repurchase.kind, 'purchase'); assert.equal(repurchase.quotaAnchorAt, renewal.expiresAt);
  assert.equal((await f.quota.current('alice')).remainingPercent, 100);
});

test('restart releases only undispatched reservations and persists dispatched unknown usage as pending', async t => {
  const f = await fixture(t);
  await f.quota.reserve('alice', 'queued', hash, 1000);
  await f.quota.reserve('bob', 'sent', hash, 1000); await f.quota.dispatch('bob', 'sent');
  const restarted = f.restart();
  await restarted.recover(); await restarted.recover();
  const stored = await new JsonStore(f.path).read();
  assert.equal(stored.aiUsage.find(row => row.taskId === 'queued')?.status, 'released');
  assert.equal(stored.aiUsage.find(row => row.taskId === 'sent')?.status, 'pending');
  assert.equal((await restarted.current('alice')).pending, false);
  assert.equal((await restarted.current('bob')).pending, true);
  await assert.rejects(restarted.reserve('bob', 'new-call', hash, 1), code('QUOTA_TASK_PENDING'));
});

test('quota storage migrates absent old fields but rejects corrupted balances and usage instead of granting free calls', async t => {
  assert.deepEqual(normalizeQuotaStorage({}), { memberships: [], aiUsage: [] });
  for (const invalid of [null, [], { memberships: null }, { aiUsage: 'not-an-array' }, { memberships: [{}] }, { aiUsage: [{}] }]) {
    assert.throws(() => normalizeQuotaStorage(invalid), /malformed quota/);
  }
  for (const invalid of [usage(-1), { inputTokens: 1, outputTokens: 1, totalTokens: 3 }, { ...usage(1), cachedTokens: 1 }, usage(Number.MAX_SAFE_INTEGER, 1)]) {
    assert.throws(() => normalizeTokenUsage(invalid), /malformed quota/);
  }
  const f = await fixture(t);
  await f.quota.activateMembership(f.activation());
  await f.quota.reserve('alice', 'real-billed', hash, 100_000); await f.quota.dispatch('alice', 'real-billed'); await f.quota.settle('alice', 'real-billed', usage(40_000));
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  for (const corrupt of [
    (record: any) => { record.memberships[0].activations[0].kind = 'upgrade'; },
    (record: any) => { record.memberships[0].activations[0].quotaAnchorAt = '2026-11-04T06:30:00.000Z'; },
    (record: any) => { record.aiUsage[0].cycleEndsAt = '2026-11-11T06:30:00.000Z'; },
    (record: any) => { record.aiUsage[0].planId = 'premium'; },
  ]) {
    const malformed = structuredClone(saved); corrupt(malformed);
    assert.throws(() => normalizeQuotaStorage(malformed), /malformed quota/);
  }
  saved.aiUsage[0].usage.totalTokens = -1;
  await writeFile(f.path, JSON.stringify(saved));
  await assert.rejects(f.restart().current('alice'), /malformed quota/);
});

test('supplier request IDs cannot be charged twice under different tasks', async t => {
  const f = await fixture(t);
  await f.quota.reserve('alice', 'first', hash, 1000); await f.quota.dispatch('alice', 'first'); await f.quota.settle('alice', 'first', usage(100, 50, 'supplier-same'));
  await f.quota.reserve('alice', 'second', hash, 1000); await f.quota.dispatch('alice', 'second');
  await assert.rejects(f.quota.settle('alice', 'second', usage(100, 50, 'supplier-same')), code('QUOTA_USAGE_CONFLICT'));
  await f.quota.finish('alice', 'second');
  assert.equal((await f.store.read()).aiUsage[1].status, 'pending');
});

test('reconciliation audit timestamps remain reloadable when the clock advances during the operation', async t => {
  const f = await fixture(t);
  await f.quota.reserve('alice', 'audit-timing', hash, 1000); await f.quota.dispatch('alice', 'audit-timing'); await f.quota.finish('alice', 'audit-timing');
  let instant = f.now() + 1;
  const advancing = new QuotaService(f.store, () => new Date(instant++));
  await advancing.reconcile('alice', 'audit-timing', { idempotencyKey: 'audit-observed', reason: 'Usage confirmed by supplier', usage: usage(100) });
  const row = (await new JsonStore(f.path).read()).aiUsage[0];
  assert.equal(row.status, 'settled');
  assert.equal(row.updatedAt, row.reconciliations[0].createdAt);
});
