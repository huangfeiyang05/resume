import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { PlanId, WorkbenchAccess } from '../shared/types.js';
import { workbenchFeatures, workbenchPermissions } from '../shared/workbench.js';
import { ApiError, onUnauthorized, setAuthToken } from '../src/services/api.js';
import { useWorkbenchAccess, workbenchAccessApi } from '../src/services/workbenchAccess.js';

type RequestOptions = {
  url: string; method: string; header: Record<string, string>; withCredentials?: boolean;
  success: (response: { statusCode: number; data: unknown }) => void;
  fail: (reason: unknown) => void;
};
const now = Date.parse('2026-11-07T00:00:00.000Z');
function access(planId: PlanId = 'free', expiresAt = '2026-12-07T00:00:00.000Z'): WorkbenchAccess {
  return { planId, expiresAt: planId === 'free' ? null : expiresAt, features: workbenchPermissions(planId) };
}
function fixture(t: TestContext) {
  const globals = globalThis as typeof globalThis & { uni?: unknown; wx?: unknown };
  const originalUni = globals.uni, originalWx = globals.wx;
  delete globals.wx;
  const requests: RequestOptions[] = [];
  let respond = (options: RequestOptions) => options.success({ statusCode: 200, data: { data: access() } });
  globals.uni = { request: (options: RequestOptions) => { requests.push(options); respond(options); } };
  setAuthToken('');
  t.after(() => { setAuthToken(''); globals.uni = originalUni; if (originalWx === undefined) delete globals.wx; else globals.wx = originalWx; });
  return { requests, respond: (handler: typeof respond) => { respond = handler; } };
}

test('workbench access reads the authenticated H5/native endpoint and propagates session expiry', async t => {
  const { requests, respond } = fixture(t);
  setAuthToken('synthetic-session');
  await workbenchAccessApi.read();
  assert.equal(requests[0]?.url.endsWith('/api/v1/membership/workbench'), true);
  assert.equal(requests[0]?.withCredentials, true);
  assert.equal('Authorization' in requests[0]!.header, false);
  const globals = globalThis as typeof globalThis & { wx?: unknown }; globals.wx = {};
  await workbenchAccessApi.read();
  assert.equal(requests.at(-1)?.header.Authorization, 'Bearer synthetic-session');
  assert.equal(requests.at(-1)?.header['X-Auth-Client'], 'mp-weixin');
  let unauthorized = 0;
  t.after(onUnauthorized(() => { ++unauthorized; }));
  respond(options => options.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: '请登录后继续。' } } }));
  await assert.rejects(workbenchAccessApi.read(), error => error instanceof ApiError && error.status === 401);
  assert.equal(unauthorized, 1);
});

test('each trusted grade unlocks only its features and chooses the correct upgrade plan', async t => {
  const { respond } = fixture(t);
  const service = useWorkbenchAccess({ autoLoad: false, now: () => now }); t.after(service.dispose);
  assert.deepEqual(service.check('careerAssistant'), { status: 'loading' });
  for (const planId of ['free', 'basic', 'premium'] as const) {
    respond(options => options.success({ statusCode: 200, data: { data: access(planId) } }));
    assert.equal(await service.load(), true);
    assert.equal(service.planName.value, { free: '免费用户', basic: '初级会员', premium: '高级会员' }[planId]);
    for (const feature of workbenchFeatures) {
      const permitted = planId === 'premium' || (planId === 'basic' && feature === 'resumeOptimization');
      assert.equal(service.canUse(feature), permitted);
      assert.deepEqual(service.check(feature), permitted ? { status: 'allowed' } : {
        status: 'upgrade', planId: feature === 'resumeOptimization' ? 'basic' : 'premium', feature,
      });
    }
  }
});

test('forged, missing or contradictory permissions never become displayed as free or paid access', async t => {
  const { respond } = fixture(t);
  const service = useWorkbenchAccess({ autoLoad: false, now: () => now }); t.after(service.dispose);
  for (const invalid of [
    { ...access('free'), features: workbenchPermissions('premium') },
    { ...access('basic'), features: workbenchPermissions('premium') },
    { ...access('premium'), expiresAt: null },
    { ...access('premium'), expiresAt: 'unknown' },
    { ...access('free'), expiresAt: '2026-12-07T00:00:00.000Z' },
    { ...access('premium'), features: { ...workbenchPermissions('premium'), applications: 1 } },
    { ...access('premium'), features: { resumeOptimization: true } },
    { ...access('premium'), features: { ...workbenchPermissions('premium'), invented: true } },
    { ...access('premium'), planId: 'admin' },
    null,
  ]) {
    respond(options => options.success({ statusCode: 200, data: { data: invalid } }));
    assert.equal(await service.load(), false);
    assert.equal(service.ready.value, false);
    assert.equal(service.planName.value, '', 'an unreadable identity must not be labelled free');
    assert.deepEqual(service.check('resumeOptimization'), { status: 'error' }, 'a bad response must not prompt a purchase');
    assert.equal(service.canUse('careerAssistant'), false);
  }
});

test('refresh immediately hides old paid capabilities and a network failure offers retry rather than purchase', async t => {
  const { respond } = fixture(t);
  const service = useWorkbenchAccess({ autoLoad: false, now: () => now }); t.after(service.dispose);
  respond(options => options.success({ statusCode: 200, data: { data: access('premium') } }));
  await service.load();
  assert.equal(service.canUse('companyJobs'), true);
  let pending!: RequestOptions;
  respond(options => { pending = options; });
  const refreshing = service.load();
  assert.equal(service.canUse('companyJobs'), false);
  assert.equal(service.planName.value, '');
  assert.deepEqual(service.check('companyJobs'), { status: 'loading' });
  pending.fail({ errMsg: 'synthetic lost response' });
  assert.equal(await refreshing, false);
  assert.deepEqual(service.check('companyJobs'), { status: 'error' });
  assert.ok(service.error.value);
  respond(options => options.success({ statusCode: 200, data: { data: access('basic') } }));
  assert.equal(await service.load(), true);
  assert.equal(service.planName.value, '初级会员');
  assert.deepEqual(service.check('companyJobs'), { status: 'upgrade', planId: 'premium', feature: 'companyJobs' });
  assert.equal(service.canUse('resumeOptimization'), true);
});

test('an expired membership loses capabilities at the boundary, including before a click without another API read', async t => {
  const { respond, requests } = fixture(t);
  let time = now;
  const service = useWorkbenchAccess({ autoLoad: false, now: () => time }); t.after(service.dispose);
  respond(options => options.success({ statusCode: 200, data: { data: access('premium', new Date(now + 60_000).toISOString()) } }));
  await service.load();
  assert.equal(service.canUse('companyJobs'), true);
  time += 60_000;
  assert.deepEqual(service.check('resumeOptimization'), { status: 'upgrade', planId: 'basic', feature: 'resumeOptimization' });
  assert.equal(service.planName.value, '免费用户');
  assert.ok(workbenchFeatures.every(feature => !service.canUse(feature)));
  assert.equal(requests.length, 1);
  await service.load();
  assert.equal(service.planName.value, '免费用户', 'an already expired server response cannot reopen a feature');
});

test('late access reads and disposed accounts cannot restore older paid capabilities', async t => {
  const { respond } = fixture(t);
  const service = useWorkbenchAccess({ autoLoad: false, now: () => now });
  let old!: RequestOptions;
  respond(options => { old = options; });
  const first = service.load();
  respond(options => options.success({ statusCode: 200, data: { data: access('free') } }));
  await service.load();
  old.success({ statusCode: 200, data: { data: access('premium') } });
  assert.equal(await first, false);
  assert.equal(service.planName.value, '免费用户');
  const last = service.load();
  service.dispose();
  await last;
  assert.equal(service.ready.value, false);
  assert.equal(service.canUse('companyJobs'), false);
  assert.equal(await service.load(), false);
});
