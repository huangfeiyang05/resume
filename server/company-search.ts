import { companyFilterKeys, type CompanyFacet, type CompanyFilterKey, type CompanyMatchField, type CompanyRecord, type CompanySearchInput, type CompanySearchResult } from '../shared/company.js';
import type { CompanyCatalogSnapshot } from './company-catalog.js';
import { companyCohortFacets, companyDirectoryRecord, normalizeCompanyLabel } from './company-labels.js';
import { recruitmentCohortYear } from '../shared/recruitment-cohort.js';

const fields: readonly CompanyMatchField[] = ['name', 'aliases', 'industries', 'nature', 'locations', 'directions', 'educationLevels', 'recruitmentTypes', 'cohorts', 'summary'];
const weights: Record<CompanyMatchField, number> = { name: 120, aliases: 100, industries: 35, nature: 35, locations: 30, directions: 30, educationLevels: 20, recruitmentTypes: 20, cohorts: 20, summary: 5 };
export const normalizeCompanyText = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const natureSynonyms: Record<string, readonly string[]> = {
  国企: ['国企', '国有', '国有企业', '国有控股', '国有控股企业', '国有独资', '国有独资企业', '央企', '中央企业'],
  民企: ['民企', '民营', '民营企业', '私营', '私营企业'],
  外企: ['外企', '外资', '外资企业', '外商独资', '外商独资企业'],
};
function natureMatches(value: string, term: string): boolean {
  const synonyms = Object.hasOwn(natureSynonyms, term) ? natureSynonyms[term] : undefined;
  if (!synonyms) return value.includes(term);
  // Expand only explicit ownership labels. Regional public institutions and
  // company names are never used to infer ownership or added as classifications.
  return value.split(/[、,，;；/|()（）\s]+/).some(label => synonyms.includes(label)
    || synonyms.includes(label.replace(/^(?:中央|地方|省属|市属|区属|县属)/, '')));
}
interface IndexedCompany {
  record: CompanyRecord;
  values: Record<CompanyMatchField, string[]>;
  keywords: Record<CompanyMatchField, string[]>;
  cohortFacets: string[];
  name: string;
}
const indexes = new WeakMap<readonly CompanyRecord[], IndexedCompany[]>();
function indexedValues(record: CompanyRecord): IndexedCompany['values'] {
  return Object.fromEntries(fields.map(field => {
    const value = record[field];
    return [field, (Array.isArray(value) ? value : [value]).map(normalizeCompanyText).filter(Boolean)];
  })) as IndexedCompany['values'];
}
function index(records: readonly CompanyRecord[]): IndexedCompany[] {
  const cached = indexes.get(records);
  if (cached) return cached;
  const result = records.map(source => {
    const record = companyDirectoryRecord(source);
    const original = indexedValues(source), values = indexedValues(record);
    for (const field of fields) original[field] = [...new Set([...original[field], ...values[field]])];
    return {
      record, name: normalizeCompanyText(record.name), values, keywords: original,
      cohortFacets: companyCohortFacets(record.cohorts),
    };
  });
  // Repository snapshots are frozen. Mutable caller-owned arrays must not retain a stale index.
  if (Object.isFrozen(records)) indexes.set(records, result);
  return result;
}
function values(record: CompanyRecord, key: CompanyFilterKey): string[] { return key === 'natures' ? (record.nature ? [record.nature] : []) : record[key]; }
function compare(a: string, b: string) { return a.localeCompare(b, 'zh-CN') || (a < b ? -1 : a > b ? 1 : 0); }
const cohortYear = (label: string) => /^20\d{2}届$/.test(label) ? Number(label.slice(0, 4)) : 0;

/** Transparent text coverage and exact facets; this is not candidate or recruitment scoring. */
export function searchCompanies(catalog: CompanyCatalogSnapshot, input: CompanySearchInput = {}): CompanySearchResult {
  const q = normalizeCompanyText(input.q ?? '');
  const queryYear = recruitmentCohortYear(q);
  const terms = [...new Set(queryYear === undefined ? q.split(' ').filter(Boolean) : [q])]
    .map(text => ({
      text,
      cohortYear: queryYear ?? (text.endsWith('届') ? recruitmentCohortYear(text) : undefined),
      aliases: Object.fromEntries(companyFilterKeys.map(key => [
        key === 'natures' ? 'nature' : key, normalizeCompanyText(normalizeCompanyLabel(key, text)),
      ])) as Partial<Record<CompanyMatchField, string>>,
    }));
  const page = input.page ?? 1, pageSize = input.pageSize ?? 20;
  const filters = companyFilterKeys.map(key => ({
    key, values: (input.filters?.[key] ?? []).map(value => normalizeCompanyText(normalizeCompanyLabel(key, value))),
  })).filter(filter => filter.values.length);
  type Match = { entry: IndexedCompany; matchedFields: CompanyMatchField[]; tier: number; score: number };
  const keywordMatches: Match[] = [], matches: Match[] = [];
  const passesFilters = (entry: IndexedCompany, except?: CompanyFilterKey) => filters.every(filter => {
    if (filter.key === except) return true;
    if (filter.key === 'cohorts') return filter.values.some(value => {
      const year = recruitmentCohortYear(value);
      return year === undefined ? entry.keywords.cohorts.includes(value) : entry.cohortFacets.includes(`${year}届`);
    });
    return entry.values[filter.key === 'natures' ? 'nature' : filter.key].some(value => filter.values.includes(value));
  });
  for (const entry of index(catalog.records)) {
    const matched = new Set<CompanyMatchField>();
    let score = 0;
    if (!terms.every(({ text, aliases, cohortYear }) => {
      let found = false;
      for (const field of fields) {
        const alias = aliases[field];
        const fieldMatches = cohortYear !== undefined
          ? field === 'cohorts' && entry.cohortFacets.includes(`${cohortYear}届`)
          : entry.keywords[field].some(value => field === 'nature' ? natureMatches(value, text) : value.includes(text))
            || (!!alias && alias !== text && entry.values[field].includes(alias));
        if (fieldMatches) { found = true; matched.add(field); score += weights[field]; }
      }
      return found;
    })) continue;
    const tier = !q ? 0 : entry.name === q ? 4 : entry.values.aliases.includes(q) ? 3 : entry.name.startsWith(q) ? 2 : entry.values.aliases.some(alias => alias.startsWith(q)) ? 1 : 0;
    const match = { entry, matchedFields: fields.filter(field => matched.has(field)), tier, score };
    keywordMatches.push(match);
    if (passesFilters(entry)) matches.push(match);
  }
  matches.sort((a, b) => {
    const order = input.sort === 'updated' ? Date.parse(b.entry.record.updatedAt) - Date.parse(a.entry.record.updatedAt)
      : input.sort === 'name' ? 0 : b.tier - a.tier || b.score - a.score;
    return order || compare(a.entry.name, b.entry.name) || compare(a.entry.record.id, b.entry.record.id);
  });
  const facets = Object.fromEntries(companyFilterKeys.map(key => {
    const counts = new Map<string, CompanyFacet>();
    // Disjunctive facets retain alternatives in the selected dimension for OR selection.
    // Counts use the keyword query plus all filters except the dimension being counted.
    for (const { entry } of keywordMatches) {
      if (!passesFilters(entry, key)) continue;
      const seen = new Set<string>();
      for (const value of key === 'cohorts' ? entry.cohortFacets : values(entry.record, key)) {
        const canonical = normalizeCompanyText(value);
        if (!canonical || seen.has(canonical)) continue;
        seen.add(canonical);
        const previous = counts.get(canonical);
        if (previous) { previous.count++; if (compare(value, previous.value) < 0) previous.value = value; }
        else counts.set(canonical, { value, count: 1 });
      }
    }
    return [key, [...counts.values()].sort((a, b) => (key === 'cohorts' ? cohortYear(b.value) - cohortYear(a.value) : 0)
      || b.count - a.count || compare(a.value, b.value))];
  })) as Record<CompanyFilterKey, CompanyFacet[]>;
  return {
    access: 'authenticated-test', catalogState: catalog.state, catalogMessage: catalog.message, catalogRevision: catalog.revision,
    total: matches.length, page, pageSize, facets,
    items: matches.slice((page - 1) * pageSize, page * pageSize).map(({ entry, matchedFields }) => ({ ...entry.record, matchedFields })),
  };
}
