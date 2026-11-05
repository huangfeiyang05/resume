import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

const entry = '../deploy/reconcile-ai-usage.mjs';
const { readEvidence } = await import(entry);

test('offline reconciliation reads bounded stdin chunks without requiring a numeric fs/promises descriptor', async () => {
  const evidence = { userId: 'synthetic-owner', taskId: 'synthetic-task', idempotencyKey: 'synthetic-evidence', reason: '供应商用量确认', usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
  const bytes = Buffer.from(JSON.stringify(evidence));
  assert.deepEqual(await readEvidence(Readable.from([bytes.subarray(0, 21), bytes.subarray(21, 49), bytes.subarray(49)])), evidence);
  await assert.rejects(readEvidence(Readable.from([Buffer.alloc(8192), Buffer.from('x')])), /Evidence too large/);
  await assert.rejects(readEvidence(Readable.from(['{"userId":'])), SyntaxError);
  await assert.rejects(readEvidence(Readable.from(['{"userId":"synthetic","grantMembership":true}'])), /Invalid evidence/);
});
