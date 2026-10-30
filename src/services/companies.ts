import { computed, onMounted, onUnmounted, ref } from 'vue';
import { companyFilterKeys } from '../../shared/company';
import type { CompanyFacet, CompanyFilterKey, CompanyFilters, CompanyMatchField, CompanyRecord, CompanySearchInput, CompanySearchResult, CompanySort, CompanySource } from '../../shared/types';
import { ApiError, request } from './api';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, allowEmpty = true): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && (allowEmpty || !!value.trim());
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const instant = (value: unknown): value is string => text(value, 50, false) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const url = (value: unknown): value is string => text(value, 2000, false) && /^https?:\/\/[^/\s@?#\\]+(?:[/?#][^\s\\]*)?$/.test(value);
const strings = (value: unknown, count: number, length = 100): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => text(item, length, false)) && new Set(value).size === value.length;
const matchFields: CompanyMatchField[] = ['name', 'aliases', 'industries', 'nature', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts', 'summary'];
const sorts: CompanySort[] = ['relevance', 'name', 'updated'];

function source(value: unknown): value is CompanySource {
  return record(value) && text(value.title, 200, false) && text(value.sheet, 160)
    && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 10_000 && value.rows.every(item => integer(item, 1)) && new Set(value.rows).size === value.rows.length
    && text(value.snapshotHash, 64) && /^[a-f0-9]{64}$/.test(value.snapshotHash) && instant(value.importedAt)
    && (value.url === undefined || url(value.url));
}
function company(value: unknown): value is CompanyRecord {
  return record(value) && text(value.id, 100, false) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.id)
    && text(value.name, 200, false) && strings(value.aliases, 100, 200) && strings(value.industries, 50)
    && text(value.nature, 100) && strings(value.locations, 200) && strings(value.directions, 100)
    && strings(value.educationLevels, 30) && strings(value.recruitmentTypes, 30) && strings(value.cohorts, 30)
    && text(value.summary, 20_000) && value.verification === 'source-provided' && instant(value.updatedAt)
    && (value.recruitmentUrl === undefined || url(value.recruitmentUrl))
    && Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 50 && value.sources.every(source);
}
function facet(value: unknown): value is CompanyFacet { return record(value) && text(value.value, 100, false) && integer(value.count, 0, 25_000); }
function validResult(value: unknown): value is CompanySearchResult {
  if (!record(value) || value.access !== 'authenticated-test' || !['empty', 'ready', 'unavailable'].includes(value.catalogState as string)
    || !text(value.catalogMessage, 2000) || !text(value.catalogRevision, 64)
    || (value.catalogRevision !== '' && !/^[a-f0-9]{64}$/.test(value.catalogRevision))
    || (value.catalogState === 'ready' && !value.catalogRevision)
    || !integer(value.total, 0, 25_000) || !integer(value.page, 1) || !integer(value.pageSize, 1, 50)
    || !Array.isArray(value.items) || value.items.length > value.pageSize || value.items.length > value.total
    || !value.items.every(item => company(item) && record(item) && Array.isArray(item.matchedFields) && item.matchedFields.every(field => matchFields.includes(field as CompanyMatchField)) && new Set(item.matchedFields).size === item.matchedFields.length)
    || new Set(value.items.map(item => item.id)).size !== value.items.length || !record(value.facets)) return false;
  if (value.catalogState !== 'ready' && (value.items.length !== 0 || value.total !== 0)) return false;
  return Object.keys(value.facets).every(key => companyFilterKeys.includes(key as CompanyFilterKey))
    && companyFilterKeys.every(key => {
      const list = (value.facets as Record<string, unknown>)[key];
      return Array.isArray(list) && list.length <= 25_000 && list.every(facet) && new Set(list.map(item => item.value)).size === list.length;
    });
}
function invalidResponse(): never { throw new ApiError('企业资料暂时不可用，请重新查询。', 'INVALID_COMPANY_RESPONSE', 502); }
function invalidInput(): never { throw new ApiError('查询条件无效，请减少关键词或筛选条件后重试。', 'INVALID_COMPANY_QUERY', 400); }

export function companyQuery(input: CompanySearchInput = {}): string {
  if (!record(input) || Object.keys(input).some(key => !['q', 'page', 'pageSize', 'sort', 'filters'].includes(key))) invalidInput();
  const raw = input as unknown as Record<string, unknown>;
  const q = raw.q ?? '', page = raw.page ?? 1, pageSize = raw.pageSize ?? 20, sort = raw.sort ?? 'relevance';
  if (!text(q, 200) || q.trim().split(/\s+/).filter(Boolean).length > 20 || !integer(page, 1) || !integer(pageSize, 1, 50) || typeof sort !== 'string' || !sorts.includes(sort as CompanySort)) invalidInput();
  const filters = raw.filters ?? {};
  if (!record(filters) || Object.keys(filters).some(key => !companyFilterKeys.includes(key as CompanyFilterKey))) invalidInput();
  const pairs: Array<[string, string]> = [['q', q.trim()], ['page', String(page)], ['pageSize', String(pageSize)], ['sort', sort]];
  for (const key of companyFilterKeys) {
    const values = filters[key] ?? [];
    if (!strings(values, 30)) invalidInput();
    for (const value of values) pairs.push([key, value]);
  }
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

export const companyApi = {
  async search(input: CompanySearchInput = {}): Promise<CompanySearchResult> {
    const value = await request<unknown>(`/career/companies?${companyQuery(input)}`);
    if (!validResult(value) || value.page !== (input.page ?? 1) || value.pageSize !== (input.pageSize ?? 20)) invalidResponse();
    return value;
  },
  async detail(id: string): Promise<CompanyRecord> {
    if (!text(id, 100, false) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) invalidInput();
    const value = await request<unknown>(`/career/companies/${encodeURIComponent(id)}`);
    if (!company(value) || value.id !== id) invalidResponse();
    return value;
  },
};

function emptyFilters(): CompanyFilters { return Object.fromEntries(companyFilterKeys.map(key => [key, []])) as unknown as CompanyFilters; }
function copyInput(input: CompanySearchInput): CompanySearchInput {
  return { q: input.q ?? '', page: input.page ?? 1, pageSize: input.pageSize ?? 20, sort: input.sort ?? 'relevance', filters: Object.fromEntries(companyFilterKeys.map(key => [key, [...(input.filters?.[key] ?? [])]])) };
}

export function useCompanyLibrary(options: { autoLoad?: boolean } = {}) {
  const query = ref(''), sort = ref<CompanySort>('relevance'), filters = ref<CompanyFilters>(emptyFilters());
  const result = ref<CompanySearchResult>(), loading = ref(false), error = ref(''), notice = ref('');
  const appliedInput = ref<CompanySearchInput>();
  const selectedId = ref(''), selected = ref<CompanyRecord>(), detailLoading = ref(false), detailError = ref('');
  const pages = computed(() => Math.max(1, Math.ceil((result.value?.total ?? 0) / (result.value?.pageSize ?? 20))));
  const filterCount = computed(() => companyFilterKeys.reduce((sum, key) => sum + filters.value[key].length, 0));
  let disposed = false, searchRequest = 0, detailRequest = 0;
  function message(cause: unknown) { return cause instanceof Error ? cause.message : '查询未完成，请稍后重试。'; }
  function closeDetail() { ++detailRequest; selectedId.value = ''; selected.value = undefined; detailLoading.value = false; detailError.value = ''; }
  async function runSearch(input: CompanySearchInput, allowReset = true) {
    if (disposed) return;
    const snapshot = copyInput(input);
    if (loading.value && JSON.stringify(snapshot) === JSON.stringify(appliedInput.value)) return;
    const requestId = ++searchRequest;
    closeDetail(); appliedInput.value = snapshot; loading.value = true; error.value = ''; notice.value = '';
    try {
      const response = await companyApi.search(snapshot);
      if (disposed || requestId !== searchRequest) return;
      const revisionChanged = result.value?.catalogRevision && response.catalogRevision !== result.value.catalogRevision;
      const pageMissing = response.page > Math.max(1, Math.ceil(response.total / response.pageSize));
      if (allowReset && response.catalogState === 'ready' && response.page > 1 && (revisionChanged || pageMissing)) {
        loading.value = false;
        await runSearch({ ...snapshot, page: 1 }, false);
        if (!disposed && requestId + 1 === searchRequest && !error.value) notice.value = '企业资料已更新，已回到第一页。';
        return;
      }
      result.value = response;
    } catch (cause) { if (!disposed && requestId === searchRequest) error.value = message(cause); }
    finally { if (!disposed && requestId === searchRequest) loading.value = false; }
  }
  function search() { return runSearch({ q: query.value, page: 1, pageSize: 20, sort: sort.value, filters: filters.value }); }
  function reload() { return runSearch(appliedInput.value ?? { q: query.value, sort: sort.value, filters: filters.value }); }
  function goToPage(page: number) {
    if (!integer(page, 1, pages.value)) return Promise.resolve();
    return runSearch({ ...(appliedInput.value ?? {}), page });
  }
  function toggleFilter(key: CompanyFilterKey, value: string) {
    if (!companyFilterKeys.includes(key) || !text(value, 100, false)) return Promise.resolve();
    const values = filters.value[key];
    if (!values.includes(value) && values.length >= 30) { notice.value = '同一分类最多选择 30 项，请先减少条件。'; return Promise.resolve(); }
    filters.value[key] = values.includes(value) ? values.filter(item => item !== value) : [...values, value];
    return search();
  }
  function setSort(next: CompanySort) { if (!sorts.includes(next)) return Promise.resolve(); sort.value = next; return search(); }
  function clear() { query.value = ''; sort.value = 'relevance'; filters.value = emptyFilters(); return search(); }
  async function openCompany(id: string) {
    if (disposed) return;
    const requestId = ++detailRequest;
    selectedId.value = id; selected.value = undefined; detailLoading.value = true; detailError.value = '';
    try {
      const company = await companyApi.detail(id);
      if (!disposed && requestId === detailRequest && selectedId.value === id) selected.value = company;
    } catch (cause) { if (!disposed && requestId === detailRequest) detailError.value = message(cause); }
    finally { if (!disposed && requestId === detailRequest) detailLoading.value = false; }
  }
  function dispose() { disposed = true; ++searchRequest; closeDetail(); result.value = undefined; }
  if (options.autoLoad !== false) { onMounted(search); onUnmounted(dispose); }
  return { query, sort, filters, result, appliedInput, loading, error, notice, pages, filterCount, selectedId, selected, detailLoading, detailError, search, reload, goToPage, toggleFilter, setSort, clear, openCompany, closeDetail, dispose };
}
