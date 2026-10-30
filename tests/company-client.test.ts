import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CompanyRecord, CompanySearchResult } from '../shared/company.js';
import { companyFilterKeys } from '../shared/company.js';
import { companyApi, companyQuery, useCompanyLibrary } from '../src/services/companies.js';
import { ApiError } from '../src/services/api.js';

const company: CompanyRecord = {
  id: 'synthetic-company', name: '合成测试企业', aliases: ['合成测试简称'], industries: ['合成测试行业'], nature: '合成测试性质',
  locations: ['合成测试城市'], directions: ['软件'], educationLevels: ['本科'], recruitmentTypes: ['校园招聘'], cohorts: ['2026届'],
  summary: '只供自动化测试，不代表真实招聘。', verification: 'source-provided', updatedAt: '2026-10-30T00:00:00+08:00',
  sources: [{ title: '合成测试来源', url: 'https://example.test/source', sheet: '测试表', rows: [5], snapshotHash: 'a'.repeat(64), importedAt: '2026-10-30T00:00:00+08:00' }],
};
function result(overrides: Partial<CompanySearchResult> = {}): CompanySearchResult {
  return {
    access: 'authenticated-test', catalogState: 'ready', catalogMessage: '按来源整理', catalogRevision: 'a'.repeat(64),
    total: 1, page: 1, pageSize: 20, items: [{ ...company, matchedFields: ['name'] }],
    facets: Object.fromEntries(companyFilterKeys.map(key => [key, []])) as unknown as CompanySearchResult['facets'], ...overrides,
  };
}
type Request = { url: string; method: string; success: (value: { statusCode: number; data: unknown }) => void; fail: (reason: unknown) => void };
function fixture(t: TestContext) {
  const globals = globalThis as typeof globalThis & { uni?: unknown };
  const previous = globals.uni, requests: Request[] = [];
  let respond = (request: Request) => request.success({ statusCode: 200, data: { data: result() } });
  globals.uni = { request: (request: Request) => { requests.push(request); respond(request); } };
  t.after(() => { globals.uni = previous; });
  return { requests, respond: (handler: typeof respond) => { respond = handler; }, ok: (request: Request, data: unknown) => request.success({ statusCode: 200, data: { data } }) };
}

test('company query encodes text and repeated same-dimension choices without granting tiers or selecting files', () => {
  const query = new URLSearchParams(companyQuery({ q: '北京 & role=premium', filters: { natures: ['国企', '民企'], locations: ['上海'] } }));
  assert.deepEqual(query.getAll('natures'), ['国企', '民企']);
  assert.equal(query.get('q'), '北京 & role=premium');
  assert.equal(query.has('role'), false);
  for (const input of [{ pageSize: 51 }, { page: 0 }, { q: 'x'.repeat(201) }, { userId: 'other' }, { filters: { scope: ['private'] } }, { filters: { natures: ['国企', '国企'] } }]) {
    assert.throws(() => companyQuery(input as never), error => error instanceof ApiError && error.code === 'INVALID_COMPANY_QUERY');
  }
});

test('company client refuses unsafe provenance, fabricated access and responses for another query or detail', async t => {
  const { respond, ok } = fixture(t);
  for (const mutate of [
    (value: any) => { value.access = 'premium'; },
    (value: any) => { value.items[0] = { ...value.items[0], verification: 'officially-hiring' }; },
    (value: any) => { value.items[0] = { ...value.items[0], sources: [] }; },
    (value: any) => { value.items[0] = { ...value.items[0], recruitmentUrl: 'javascript:alert(1)' }; },
    (value: any) => { value.page = 2; },
    (value: any) => { value.catalogState = 'unavailable'; },
  ]) {
    const value = result(); mutate(value); respond(request => ok(request, value));
    await assert.rejects(companyApi.search(), error => error instanceof ApiError && error.code === 'INVALID_COMPANY_RESPONSE');
  }
  respond(request => ok(request, { ...company, id: 'other-company' }));
  await assert.rejects(companyApi.detail(company.id), error => error instanceof ApiError && error.code === 'INVALID_COMPANY_RESPONSE');
});

test('late company search and detail responses cannot replace newer selections', async t => {
  const { respond, ok } = fixture(t), c = useCompanyLibrary({ autoLoad: false }); t.after(c.dispose);
  let first!: Request;
  respond(request => { first = request; }); c.query.value = '旧条件'; const pending = c.search();
  respond(request => ok(request, result({ total: 0, items: [] }))); c.query.value = '新条件'; await c.search();
  ok(first, result()); await pending;
  assert.equal(c.result.value?.total, 0);
  assert.equal(c.appliedInput.value?.q, '新条件');
  let detail!: Request;
  respond(request => { detail = request; }); const old = c.openCompany(company.id);
  respond(request => ok(request, { ...company, id: 'second-company', name: '另一合成企业' }));
  await c.openCompany('second-company'); ok(detail, company); await old;
  assert.equal(c.selected.value?.id, 'second-company');
});

test('changed catalogues reset pagination and distinguish unavailable catalogues from a successful empty result', async t => {
  const { respond, ok, requests } = fixture(t), c = useCompanyLibrary({ autoLoad: false }); t.after(c.dispose);
  await c.search();
  respond(request => {
    const page = Number(new URL(request.url, 'https://example.test').searchParams.get('page'));
    ok(request, result({ catalogRevision: 'b'.repeat(64), total: 40, page }));
  });
  c.result.value = result({ total: 40 }); await c.goToPage(2);
  assert.equal(c.result.value?.page, 1);
  assert.match(c.notice.value, /已更新/);
  assert.equal(new URL(requests.at(-1)!.url, 'https://example.test').searchParams.get('page'), '1');
  respond(request => ok(request, result({ catalogState: 'unavailable', catalogRevision: '', total: 0, items: [] })));
  await c.search(); assert.equal(c.result.value?.catalogState, 'unavailable');
  respond(request => ok(request, result({ total: 0, items: [] })));
  await c.search(); assert.equal(c.result.value?.catalogState, 'ready'); assert.equal(c.result.value?.total, 0);
});

test('disposing a company view discards pending results and details', async t => {
  const { respond, ok } = fixture(t), c = useCompanyLibrary({ autoLoad: false });
  let pending!: Request; respond(request => { pending = request; }); const search = c.search();
  c.dispose(); ok(pending, result()); await search;
  assert.equal(c.result.value, undefined); assert.equal(c.selected.value, undefined);
});
