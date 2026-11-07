import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { CompanyRecord } from '../shared/company.js';
import { companyFilterKeys } from '../shared/company.js';
import { CompanyCatalogRepository } from '../server/company-catalog.js';
import { searchCompanies } from '../server/company-search.js';
import { companyCatalogLimits, validateCompanyCatalog, validateCompanyRecord, validateCompanySearchParams } from '../server/company-validation.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';
import { QuotaService } from '../server/quota.js';

const timestamp = '2026-10-30T00:00:00+08:00';
function company(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    id: 'synthetic-alpha', name: 'ＡＣＭＥ', aliases: ['合成甲'], industries: ['软件'], nature: '民营', locations: ['杭州'],
    directions: ['软件开发'], educationLevels: ['本科'], recruitmentTypes: ['校招'], cohorts: ['2026届'],
    summary: '仅供自动化测试的合成企业资料，不代表真实企业或在招岗位。', verification: 'source-provided', updatedAt: timestamp,
    sources: [{ title: '合成测试来源', url: 'https://example.test/source', sheet: '合成工作表', rows: [2], snapshotHash: 'a'.repeat(64), importedAt: timestamp }],
    ...overrides,
  };
}
const records = () => [
  company(),
  company({ id: 'synthetic-beta', name: 'Beta', aliases: ['Acme'], industries: ['机械'], nature: '国有', locations: ['杭州', '上海'], directions: ['机械设计'], updatedAt: '2026-10-30T01:00:00+08:00' }),
  company({ id: 'synthetic-gamma', name: 'Gamma ACME', aliases: [], industries: ['软件'], nature: '国有', locations: ['北京'], directions: ['产品运营'], summary: '合成数据中的 ACME 文本，仅作检索测试。' }),
];
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'youfang-companies-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(t: TestContext) {
  const root = await directory(t), catalogPath = join(root, 'company-catalog.json');
  const store = new JsonStore(join(root, 'resumes.json'));
  const server = createApiServer(new ResumeService(store));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function request(path: string, method = 'GET', input?: unknown, cookie?: string) {
    const response = await fetch(base + path, { method,
      headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  }
  async function account(label: string) {
    const result = await request('/auth/register', 'POST', { email: `${label}@example.test`, password: 'Synthetic26!' });
    assert.equal(result.status, 201);
    await new QuotaService(store).activateMembership({
      userId: result.body.data.user.id, planId: 'premium', verifiedPaymentAt: new Date().toISOString(),
      verifiedEventId: `synthetic-event-${label}`, idempotencyKey: `synthetic-member-${label}`,
    });
    const cookie = result.headers.get('set-cookie')!.split(';')[0];
    return (path: string, method = 'GET', input?: unknown) => request(path, method, input, cookie);
  }
  const catalog = (values: CompanyRecord[]) => writeFile(catalogPath, JSON.stringify({ version: 1, records: values }));
  return { root, catalogPath, request, account, catalog };
}

test('company validation preserves supplied facts and sources without inferring ownership or hiring status', () => {
  const input = company({ nature: '', industries: [], locations: [], aliases: [], recruitmentUrl: 'https://example.test/jobs?batch=old' });
  const validated = validateCompanyRecord(input);
  assert.equal(validated.nature, '');
  assert.deepEqual(validated.industries, []);
  assert.equal(validated.verification, 'source-provided');
  assert.equal(validated.sources[0].rows[0], 2);
  assert.equal('availability' in validated, false);
  assert.equal('userId' in validated, false);
  assert.deepEqual(validateCompanyCatalog({ version: 1, records: [input] }).records, [validated]);
  for (const bad of [
    { ...input, userId: 'other-user' }, { ...input, membership: 'premium' }, { ...input, availability: 'open' },
    { ...input, verification: 'officially-verified' }, { ...input, sources: [] }, { ...input, aliases: ['重复', '重复'] },
    { ...input, name: '' }, { ...input, summary: 'a'.repeat(20_001) },
    { ...input, recruitmentUrl: 'javascript:alert(1)' }, { ...input, recruitmentUrl: 'https://user:secret@example.test/' },
    { ...input, recruitmentUrl: 'https:\\example.test' },
    { ...input, sources: [{ ...input.sources[0], snapshotHash: 'missing' }] },
    { ...input, sources: [{ ...input.sources[0], rows: [0] }] },
    { ...input, sources: [{ ...input.sources[0], rows: [2, 2] }] },
    { ...input, updatedAt: '2026-02-31T00:00:00+08:00' },
  ]) assert.throws(() => validateCompanyRecord(bad), hasCode('VALIDATION_ERROR'));
  for (const bad of [{ version: 2, records: [] }, { version: 1, records: [input, input] }, { version: 1, records: Array(25_001).fill(input) }]) {
    assert.throws(() => validateCompanyCatalog(bad), hasCode('VALIDATION_ERROR'));
  }
});

test('company query validates external inputs and keeps only whitelisted bounded query parameters', () => {
  const input = validateCompanySearchParams(new URLSearchParams('q=%EF%BC%A1%EF%BC%A3%EF%BC%AD%EF%BC%A5%E3%80%80%E6%9D%AD%E5%B7%9E&industries=软件&industries=机械&page=2&pageSize=5&sort=updated'));
  assert.equal(input.q, 'ACME 杭州');
  assert.deepEqual(input.filters?.industries, ['软件', '机械']);
  assert.equal(input.page, 2); assert.equal(input.pageSize, 5);
  assert.equal(validateCompanySearchParams(new URLSearchParams()).pageSize, 20);
  for (const params of [
    'userId=other', 'membership=premium', 'file=/tmp/private', '__proto__=x', 'sort=ai-match', 'q=a&q=b',
    'page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=9007199254740992', 'pageSize=51', 'pageSize=0',
    'industries=', `q=${'a'.repeat(201)}`, `q=${Array(21).fill('a').join('+')}`,
    Array(31).fill('locations=杭州').join('&'),
  ]) assert.throws(() => validateCompanySearchParams(new URLSearchParams(params)), hasCode('VALIDATION_ERROR'));
});

test('company repository caches immutable snapshots, invalidates changed files and never masks missing or broken data', async t => {
  const root = await directory(t), path = join(root, 'company-catalog.json'), repository = new CompanyCatalogRepository(path);
  assert.equal((await repository.load()).state, 'empty');
  assert.equal((await repository.load()).revision, '');
  await writeFile(path, JSON.stringify({ version: 1, records: [company()] }));
  const first = await repository.load();
  assert.equal(first.state, 'ready'); assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(await repository.load(), first, 'unchanged trusted path and stat signature reuse a validated snapshot');
  assert.ok(Object.isFrozen(first.records[0].sources[0].rows));
  assert.throws(() => { first.records[0].name = 'must not mutate cache'; });
  const next = join(root, 'next.json');
  await writeFile(next, JSON.stringify({ version: 1, records: [company({ name: '已更新的合成名称' })] }));
  await rename(next, path);
  const changed = await repository.load();
  assert.notEqual(changed.revision, first.revision); assert.equal(changed.records[0].name, '已更新的合成名称');
  await writeFile(path, '{broken');
  const broken = await repository.load();
  assert.equal(broken.state, 'unavailable'); assert.equal(broken.records.length, 0); assert.equal(broken.revision, '');
  assert.equal(JSON.stringify(broken).includes(root), false);
  await assert.rejects(repository.get('synthetic-alpha'), hasCode('COMPANY_CATALOG_UNAVAILABLE'));
  const malformedUtf8 = Buffer.from(JSON.stringify({ version: 1, records: [company({ name: 'BAD_UTF8_NAME' })] }));
  malformedUtf8[malformedUtf8.indexOf('BAD_UTF8_NAME')] = 0xff;
  await writeFile(path, malformedUtf8);
  assert.equal((await repository.load()).state, 'unavailable', 'invalid UTF-8 must not silently alter enterprise facts');
  await rm(path);
  assert.equal((await repository.load()).state, 'empty');
  await assert.rejects(repository.get('synthetic-alpha'), hasCode('NOT_FOUND'));
  await writeFile(path, JSON.stringify({ version: 1, records: [] }));
  const empty = await repository.load();
  assert.equal(empty.state, 'empty'); assert.match(empty.revision, /^[a-f0-9]{64}$/);
  const large = await open(path, 'w'); await large.truncate(companyCatalogLimits.bytes + 1); await large.close();
  assert.equal((await repository.load()).state, 'unavailable');
});

test('company search uses AND keywords, OR within facets, AND across dimensions and source-only text explanations', async t => {
  const root = await directory(t), path = join(root, 'company-catalog.json');
  await writeFile(path, JSON.stringify({ version: 1, records: records() }));
  const snapshot = await new CompanyCatalogRepository(path).load();
  const query = (params: string) => searchCompanies(snapshot, validateCompanySearchParams(new URLSearchParams(params)));
  assert.deepEqual(query('q=ａｃｍｅ').items.map(item => item.id), ['synthetic-alpha', 'synthetic-beta', 'synthetic-gamma']);
  const multi = query('q=ACME+杭州');
  assert.equal(multi.total, 2);
  assert.ok(multi.items.every(item => item.matchedFields.includes('locations')));
  assert.deepEqual(query('q=ACME+不存在的词').items, []);
  assert.deepEqual(query('q=.*').items, [], 'query text must not execute as a regular expression');
  assert.deepEqual(query('q=constructor').items, [], 'ordinary words must not select inherited dictionary properties');
  assert.deepEqual(query('q=__proto__').items, []);
  assert.equal(query('industries=软件&industries=机械&locations=杭州').total, 2);
  const filtered = query('industries=软件&industries=机械&locations=杭州&natures=国有');
  assert.deepEqual(filtered.items.map(item => item.id), ['synthetic-beta']);
  assert.deepEqual(filtered.facets.natures.map(item => [item.value, item.count]).sort(), [['国有', 1], ['民营', 1]], 'own-dimension selection must not hide OR alternatives');
  assert.equal(filtered.facets.locations.find(item => item.value === '北京')?.count, 1, 'location facet ignores only its own selection');
  for (const key of companyFilterKeys) assert.ok(Array.isArray(filtered.facets[key]));
  assert.equal(filtered.access, 'authenticated-test');
  assert.equal('score' in filtered.items[0], false);
  assert.equal('availability' in filtered.items[0], false);
  assert.deepEqual(query('q=不存在').facets, Object.fromEntries(companyFilterKeys.map(key => [key, []])));
});

test('company pagination is stable, has no duplicate items, and supports explicit name and update sorting', async t => {
  const root = await directory(t), path = join(root, 'company-catalog.json');
  await writeFile(path, JSON.stringify({ version: 1, records: records().reverse() }));
  const snapshot = await new CompanyCatalogRepository(path).load();
  const first = searchCompanies(snapshot, { q: 'Acme', page: 1, pageSize: 2 });
  const second = searchCompanies(snapshot, { q: 'Acme', page: 2, pageSize: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), ['synthetic-alpha', 'synthetic-beta', 'synthetic-gamma']);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3);
  assert.deepEqual(searchCompanies(snapshot, { sort: 'name' }).items.map(item => item.id), ['synthetic-alpha', 'synthetic-beta', 'synthetic-gamma']);
  assert.equal(searchCompanies(snapshot, { sort: 'updated' }).items[0].id, 'synthetic-beta');
  assert.deepEqual(searchCompanies(snapshot, { page: 500, pageSize: 50 }).items, []);
  assert.equal(first.catalogRevision, second.catalogRevision);
});

test('ownership keyword synonyms apply only to explicit source nature labels and never manufacture classifications', async t => {
  const root = await directory(t), path = join(root, 'company-catalog.json');
  const supplied = ['国有企业', '国有控股', '央企', '中央企业', '省属国有企业', '民营企业', '私营', '外资', '外商独资', '省属事业单位', '市属事业单位', '非国有企业'];
  const values = supplied.map((nature, i) => company({ id: `nature-${i}`, name: `合成性质资料${i}`, aliases: [], nature, locations: ['北京'] }));
  values.push(company({ id: 'name-only', name: '国企xx', aliases: [], nature: '', locations: ['北京'] }));
  values.push(company({ id: 'central-name-only', name: '央企服务合成名称', aliases: [], nature: '', locations: ['北京'] }));
  await writeFile(path, JSON.stringify({ version: 1, records: values }));
  const snapshot = await new CompanyCatalogRepository(path).load();
  const state = searchCompanies(snapshot, { q: '国企 北京' });
  assert.deepEqual(new Set(state.items.map(item => item.id)), new Set(['nature-0', 'nature-1', 'nature-2', 'nature-3', 'nature-4', 'name-only']));
  assert.ok(state.items.find(item => item.id === 'nature-0')!.matchedFields.includes('nature'));
  assert.deepEqual(searchCompanies(snapshot, { q: '民企 北京' }).items.map(item => item.id).sort(), ['nature-5', 'nature-6']);
  assert.deepEqual(searchCompanies(snapshot, { q: '外企 北京' }).items.map(item => item.id).sort(), ['nature-7', 'nature-8']);
  const nameOnly = state.items.find(item => item.id === 'name-only')!;
  assert.equal(nameOnly.nature, '');
  assert.ok(nameOnly.matchedFields.includes('name'));
  assert.equal(nameOnly.matchedFields.includes('nature'), false);
  assert.deepEqual(snapshot.records.map(item => item.nature), values.map(item => item.nature), 'source classifications must remain unchanged');
  assert.equal(searchCompanies(snapshot, { filters: { natures: ['国企'] } }).total, 0, 'facet filters continue to select original labels exactly');
});

test('company APIs require a trusted premium membership, share reference data and reject client identity or membership assertions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/career/companies')).status, 401);
  assert.equal((await f.request('/career/companies/synthetic-alpha')).status, 401);
  const owner = await f.account('company-owner'), other = await f.account('company-reader');
  const missing = await owner('/career/companies');
  assert.equal(missing.status, 200); assert.equal(missing.body.data.catalogState, 'empty');
  assert.deepEqual(missing.body.data.items, []);
  await f.catalog(records());
  const a = await owner('/career/companies?q=ACME&pageSize=1'), b = await other('/career/companies?q=ACME&pageSize=1');
  assert.deepEqual(a.body.data, b.body.data);
  assert.equal(a.body.data.total, 3); assert.equal(a.body.data.items.length, 1);
  const detail = await other('/career/companies/synthetic-alpha');
  assert.equal(detail.status, 200); assert.equal(detail.body.data.name, 'ＡＣＭＥ');
  assert.equal('userId' in detail.body.data, false); assert.equal('matchedFields' in detail.body.data, false);
  const before = await readFile(f.catalogPath, 'utf8');
  assert.equal((await owner('/career/companies', 'POST', company())).status, 405);
  assert.equal((await owner('/career/companies/synthetic-alpha', 'DELETE')).status, 405);
  for (const route of ['/career/companies?userId=other', '/career/companies?membership=premium', '/career/companies?pageSize=100', '/career/companies/synthetic-alpha?userId=other', '/career/companies/%ZZ', '/career/companies/%2Fprivate']) {
    assert.equal((await owner(route)).status, 400, route);
  }
  assert.equal((await owner('/career/companies/missing')).status, 404);
  assert.equal(await readFile(f.catalogPath, 'utf8'), before);
  const personal = await owner('/career/jobs', 'POST', { company: '合成私人岗位公司', title: '测试岗位', major: '测试', location: '测试', description: '仅供测试的私有岗位描述。' });
  assert.equal(personal.status, 201);
  assert.equal((await other('/career/companies')).body.data.total, 3, 'private jobs must never enter the reference catalogue');
});

test('company API distinguishes damaged catalogues from normal absence and recovers after correction without a restart', async t => {
  const f = await fixture(t), request = await f.account('company-recovery');
  await f.catalog([company()]);
  assert.equal((await request('/career/companies')).body.data.catalogState, 'ready');
  await writeFile(f.catalogPath, JSON.stringify({ version: 1, records: [{ ...company(), sources: [] }] }));
  const broken = await request('/career/companies');
  assert.equal(broken.status, 200); assert.equal(broken.body.data.catalogState, 'unavailable');
  assert.equal(broken.body.data.total, 0); assert.deepEqual(broken.body.data.items, []);
  assert.equal(JSON.stringify(broken.body).includes(f.root), false);
  assert.equal((await request('/career/companies/synthetic-alpha')).status, 503);
  await f.catalog([company({ name: '修复后的合成资料' })]);
  assert.equal((await request('/career/companies')).body.data.catalogState, 'ready');
  assert.equal((await request('/career/companies/synthetic-alpha')).body.data.name, '修复后的合成资料');
  await rm(f.catalogPath);
  assert.equal((await request('/career/companies')).body.data.catalogState, 'empty');
  assert.equal((await request('/career/companies/synthetic-alpha')).status, 404);
});
