import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnalysisContext } from '../server/analysis.js';
import { BailianAnalysisProvider } from '../server/bailian.js';
import { HttpError } from '../server/errors.js';
import { normalizeTokenUsage } from '../server/quota-storage.js';

const original = '负责真实业务接口的开发和维护，并编写接口说明。';
const context: AnalysisContext = {
  resume: { id: 'metered-resume', title: '测试', targetRole: '后端开发', text: `项目经历\n${original}`, revision: 1, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' },
  targetRole: 'Java 开发', jobDescription: '需要 Java 和数据库开发经验。',
};
const config = { enabled: true, apiKey: 'sk-test-only', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'test-model' };
const output = () => ({ summary: '请补充可核实的交付依据。', issues: [], suggestions: [] });
const envelope = (usage: unknown = { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 }) => ({
  id: 'completion-123', usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }],
});
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
type Usage = Parameters<NonNullable<AnalysisContext['metering']>['onUsage']>[0];

test('reservation includes the complete redacted prompt and output ceiling but does not dispatch', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; max_tokens: number }> = [];
  const privateContext = { ...context, resume: { ...context.resume, text: `${context.resume.text}\n13800138000 synthetic@example.test` } };
  const provider = new BailianAnalysisProvider(config, async (_url, options) => {
    requests.push(JSON.parse(options!.body as string));
    return Response.json(envelope());
  });
  const reserved = provider.estimateReservation(privateContext);
  assert.equal(requests.length, 0, 'reservation must not make a supplier request');
  await provider.analyze(privateContext);
  const sent = requests[0];
  assert.ok(sent);
  assert.equal(reserved, Buffer.byteLength(JSON.stringify(sent.messages), 'utf8') + 256 + sent.max_tokens);
  assert.equal(sent.max_tokens, 4000);
  assert.equal(JSON.stringify(sent.messages).includes('13800138000'), false);
  assert.equal(JSON.stringify(sent.messages).includes('synthetic@example.test'), false);
  assert.ok(reserved > 4000);
});

test('dispatch is awaited before fetch and actual usage is recorded before output validation', async () => {
  const events: string[] = [], usages: Usage[] = [];
  const invalid = envelope(); invalid.choices[0].message.content = '{invalid output';
  const provider = new BailianAnalysisProvider(config, async () => {
    events.push('fetch');
    return Response.json(invalid, { headers: { 'x-request-id': 'request-456' } });
  });
  await assert.rejects(provider.analyze({ ...context, metering: {
    async onDispatch() { await Promise.resolve(); events.push('dispatch'); },
    async onUsage(usage) { await Promise.resolve(); events.push('usage'); usages.push(usage); },
  } }), hasCode('MODEL_INVALID_OUTPUT'));
  assert.deepEqual(events, ['dispatch', 'fetch', 'usage']);
  assert.deepEqual(usages, [{ inputTokens: 120, outputTokens: 35, totalTokens: 155, requestId: 'request-456' }]);
});

test('supplier HTTP failures still record trustworthy actual usage without exposing response text', async () => {
  let calls = 0;
  const usages: Usage[] = [];
  const provider = new BailianAnalysisProvider(config, async () => {
    calls++;
    return Response.json({ id: 'request-err', error: { message: 'secret supplier detail' }, usage: { prompt_tokens: 42, completion_tokens: 0, total_tokens: 42 } }, { status: 500 });
  });
  await assert.rejects(provider.analyze({ ...context, metering: {
    async onDispatch() {}, async onUsage(usage) { usages.push(usage); },
  } }), error => hasCode('MODEL_UNAVAILABLE')(error) && !(error as Error).message.includes('secret'));
  assert.deepEqual(usages, [{ inputTokens: 42, outputTokens: 0, totalTokens: 42, requestId: 'request-err' }]);
  assert.equal(calls, 1, 'HTTP failures must not be retried automatically');
});

test('missing or invalid supplier usage never becomes estimated or zero usage', async () => {
  const invalidUsages: unknown[] = [
    undefined, null, [], {},
    { prompt_tokens: 1, completion_tokens: 2 },
    { prompt_tokens: '1', completion_tokens: 2, total_tokens: 3 },
    { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
    { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const usage of invalidUsages) {
    let dispatches = 0, records = 0;
    const body = { ...envelope(), usage };
    const provider = new BailianAnalysisProvider(config, async () => Response.json(body));
    const report = await provider.analyze({ ...context, metering: {
      async onDispatch() { dispatches++; }, async onUsage() { records++; },
    } });
    assert.equal(report.engine, 'bailian');
    assert.equal(dispatches, 1);
    assert.equal(records, 0, `invalid usage ${JSON.stringify(usage)} must remain unknown`);
  }
});

test('explicit zero usage is accepted and unsafe request identifiers are omitted', async () => {
  const usages: Usage[] = [];
  const provider = new BailianAnalysisProvider(config, async () => Response.json({ ...envelope({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), id: 'private response text with spaces' }));
  await provider.analyze({ ...context, metering: { async onDispatch() {}, async onUsage(usage) { usages.push(usage); } } });
  assert.deepEqual(usages, [{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }]);
});

test('an invalid identifier prefix does not prevent valid token usage from reaching settlement', async () => {
  const usages: Usage[] = [];
  for (const id of ['-supplier-request', '_supplier-request', '.supplier-request', ':supplier-request']) {
    const provider = new BailianAnalysisProvider(config, async () => Response.json({ ...envelope(), id }, { headers: { 'x-request-id': id } }));
    await provider.analyze({ ...context, metering: {
      async onDispatch() {}, async onUsage(usage) { usages.push(normalizeTokenUsage(usage)); },
    } });
  }
  assert.deepEqual(usages, Array.from({ length: 4 }, () => ({ inputTokens: 120, outputTokens: 35, totalTokens: 155 })));
});

test('local input failures, pre-cancellation and failed dispatch recording never send a supplier request', async () => {
  let dispatches = 0, fetches = 0;
  const provider = new BailianAnalysisProvider(config, async () => { fetches++; return Response.json(envelope()); });
  const metering = { async onDispatch() { dispatches++; }, async onUsage() {} };
  const oversized = { ...context, resume: { ...context.resume, text: '真实经历'.repeat(6000) }, metering };
  assert.throws(() => provider.estimateReservation(oversized), hasCode('MODEL_INPUT_TOO_LONG'));
  await assert.rejects(provider.analyze(oversized), hasCode('MODEL_INPUT_TOO_LONG'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.analyze({ ...context, signal: controller.signal, metering }), hasCode('ANALYSIS_CANCELLED'));
  assert.equal(dispatches, 0);
  await assert.rejects(provider.analyze({ ...context, metering: {
    async onDispatch() { throw new HttpError(409, 'METERING_UNAVAILABLE', '额度记录不可用。'); }, async onUsage() {},
  } }), hasCode('METERING_UNAVAILABLE'));
  assert.equal(fetches, 0);
});

test('a dispatched timeout leaves actual usage unknown and never retries', async () => {
  let fetches = 0, dispatches = 0, records = 0;
  const provider = new BailianAnalysisProvider(config, (_url, options) => {
    fetches++;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('supplier transport detail'));
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  }, 25);
  await assert.rejects(provider.analyze({ ...context, metering: {
    async onDispatch() { dispatches++; }, async onUsage() { records++; },
  } }), hasCode('MODEL_TIMEOUT'));
  assert.equal(fetches, 1); assert.equal(dispatches, 1); assert.equal(records, 0);
});
