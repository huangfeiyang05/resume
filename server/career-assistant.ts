import type { CareerAssistantInput, CareerAssistantResult } from '../shared/career-assistant.js';
import type { CompanyCatalogSnapshot } from './company-catalog.js';
import type { CompanyFilters } from '../shared/company.js';
import type { CareerJob } from '../shared/career.js';
import { careerJobIsStale } from '../shared/career.js';
import type { Resume } from '../shared/types.js';
import { CompanyCatalogRepository } from './company-catalog.js';
import { normalizeCompanyLabel, normalizeCompanyLabels } from './company-labels.js';
import { normalizeCompanyText, searchCompanies } from './company-search.js';
import { validateCompanyId } from './company-validation.js';
import { resumeContentHash } from './resume-history.js';
import { HttpError, invalid } from './errors.js';
import type { ResumeService } from './service.js';
import { reviewJobDescription } from './job-review.js';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('求职助手请求必须是 JSON 对象。');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid('求职助手请求含不支持的字段。');
  return result;
}
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须是文本。`);
  const result = value.replace(/\r\n?/g, '\n').trim();
  if ((!allowEmpty && !result) || result.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) invalid(`${label}为空、过长或含无效字符。`);
  return result;
}
export function validateCareerAssistantInput(value: unknown): CareerAssistantInput {
  const input = object(value, ['resumeId', 'resumeRevision', 'requirements', 'message', 'history']);
  if (Object.hasOwn(input, 'resumeId') !== Object.hasOwn(input, 'resumeRevision')) invalid('选择简历时必须同时提供简历 ID 和修订号。');
  if (input.resumeRevision !== undefined && (!Number.isSafeInteger(input.resumeRevision) || (input.resumeRevision as number) < 1)) invalid('简历修订号必须是正整数。');
  if (input.history !== undefined && (!Array.isArray(input.history) || input.history.length > 10)) invalid('对话历史最多保留 10 条。');
  const history = (input.history as unknown[] | undefined)?.map(item => {
    const message = object(item, ['role', 'content']);
    if (message.role !== 'user' && message.role !== 'assistant') invalid('对话历史角色无效。');
    return { role: message.role as 'user' | 'assistant', content: text(message.content, '历史消息') };
  });
  return {
    ...(input.resumeId === undefined ? {} : { resumeId: validateCompanyId(input.resumeId), resumeRevision: input.resumeRevision as number }),
    requirements: text(input.requirements, '求职要求', true), message: text(input.message, '问题'), ...(history ? { history } : {}),
  };
}

// These dictionaries label search text only. They never confer a skill or qualification.
const terms = ['Spring Boot', 'JavaScript', 'TypeScript', 'Node.js', 'C++', 'C#', 'Java', 'Python', 'SQL', 'MySQL', 'React', 'Vue', 'Go', 'Linux', 'Excel',
  '数据分析', '产品经理', '机械设计', '电气工程', '嵌入式', '新能源', '半导体', '财务', '会计', '审计', '金融', '前端', '后端', '全栈', '软件', '测试', '算法', '设计', '产品', '运营', '市场', '人力', '法务', '翻译', '教师', '教育', '生物', '护理', '供应链', '物流', '采购', '销售'] as const;
const cities = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '无锡', '常州', '南通', '扬州', '镇江', '徐州', '宁波', '温州', '绍兴', '嘉兴', '金华', '湖州', '台州', '成都', '重庆', '武汉', '西安', '天津', '郑州', '长沙', '合肥', '济南', '青岛', '烟台', '厦门', '福州', '泉州', '佛山', '东莞', '珠海', '惠州', '中山', '大连', '沈阳', '长春', '哈尔滨', '昆明', '贵阳', '南宁', '南昌', '太原', '石家庄', '兰州', '海口', '乌鲁木齐', '呼和浩特', '西宁', '银川', '拉萨'] as const;
const natureWords = ['外商独资企业', '国有控股企业', '中央企业', '国有企业', '外商独资', '民营企业', '私营企业', '外资企业', '国有控股', '事业单位', '央企', '国企', '国有', '民企', '民营', '私营', '外企', '外资'] as const;
const educationWords = ['博士及以上', '硕士及以上', '研究生及以上', '本科及以上', '大专及以上', '专科及以上', '博士', '硕士', '研究生', '本科', '大专', '专科', '中专', '高中'] as const;
const recruitmentWords = ['暑期实习', '日常实习', '校园招聘', '社会招聘', '实习', '校招', '春招', '秋招', '社招', '提前批'] as const;
const officialAudience: Record<string, CareerJob['audience']> = { 校招: 'campus', 校园招聘: 'campus', 实习: 'internship', 社招: 'experienced', 社会招聘: 'experienced' };
const ownershipLabels: Record<string, readonly string[]> = {
  国企: ['国企', '国有', '国有企业', '国有控股', '国有控股企业', '国有独资', '国有独资企业', '央企', '中央企业'],
  央企: ['央企', '中央企业'], 民企: ['民企', '民营', '民营企业', '私营', '私营企业'],
  外企: ['外企', '外资', '外资企业', '外商独资', '外商独资企业'], 事业单位: ['事业单位', '省属事业单位', '市属事业单位'],
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termPattern(term: string): RegExp {
  return /[a-z]/i.test(term) ? new RegExp(`(?<![a-z0-9])${escape(term)}(?![a-z0-9])`, 'gi') : new RegExp(escape(term), 'g');
}
function negative(value: string, position: number): boolean {
  const prefix = value.slice(0, position);
  const boundary = [...prefix.matchAll(/[，,。；;！？\n]|但是|但|而是|改成|换成|换到|改到|只看|只要/g)].at(-1);
  const local = prefix.slice(boundary ? boundary.index! + boundary[0].length : 0);
  return /不要|不想|不考虑|不去|排除|避开|不在|不选|不投|不找|不做|不接受|除了|别去|未掌握|不会|未使用|没用过|待学习|不含|不包括|不包含/.test(local);
}
function mentions(value: string, dictionary: readonly string[]) {
  const found: Array<{ term: string; index: number; negative: boolean }> = [];
  for (const term of dictionary) for (const match of value.matchAll(termPattern(term))) found.push({ term, index: match.index!, negative: negative(value, match.index!) });
  // Keep the longest phrase at overlapping positions (JavaScript is not Java).
  const accepted: typeof found = [];
  for (const item of found.sort((a, b) => b.term.length - a.term.length || a.index - b.index)) {
    if (!accepted.some(other => item.index < other.index + other.term.length && item.index + item.term.length > other.index)) accepted.push(item);
  }
  return accepted.sort((a, b) => a.index - b.index);
}
const unique = (values: string[]) => [...new Set(values)];
const natureGroup = (word: string) => /中央企业|央企/.test(word) ? '央企' : /国企|国有/.test(word) ? '国企' : /民企|民营|私营/.test(word) ? '民企' : /外企|外资|外商/.test(word) ? '外企' : '事业单位';
function matchesNature(value: string, groups: string[]): boolean {
  const labels = normalizeCompanyText(value).split(/[、,，;；/|()（）\s]+/);
  return groups.some(group => Object.hasOwn(ownershipLabels, group) && labels.some(label => ownershipLabels[group].includes(label) || ownershipLabels[group].includes(label.replace(/^(?:中央|地方|省属|市属|区属|县属)/, ''))));
}

export function assistantLocationMatches(value: string, city: string): boolean {
  const normalized = normalizeCompanyText(value), term = normalizeCompanyText(city);
  let index = normalized.indexOf(term);
  while (index >= 0) {
    const suffix = normalized.slice(index + term.length), prefix = normalized.slice(Math.max(0, index - 10), index);
    if (!negative(normalized, index) && !/(?:除|非)\s*$/.test(prefix) && !/^[市省区]?[\s(（]*(?:以外|之外|除外)/.test(suffix)) return true;
    index = normalized.indexOf(term, index + term.length);
  }
  return false;
}
interface Parsed { cities: string[]; natures: string[]; queryTerms: string[]; companyTerms: string[]; facetTerms: Partial<CompanyFilters>; noRoleFallback: boolean; unverified: string[] }
function parse(input: CareerAssistantInput, catalog: CompanyCatalogSnapshot, officialJobs: CareerJob[]): Parsed {
  const result: Parsed = { cities: [], natures: [], queryTerms: [], companyTerms: [], facetTerms: {}, noRoleFallback: false, unverified: [] };
  const add = (value: string) => { if (!result.unverified.includes(value) && result.unverified.length < 10) result.unverified.push(value.slice(0, 240)); };
  const sourceCities = unique(catalog.records.flatMap(record => record.locations).filter(value => /^[\u4e00-\u9fff]{2,8}$/.test(value) && !/全国|不限|海外|国内|国外|其他|多地/.test(value)).map(value => value.replace(/市$/, '')));
  const industryWords = unique(catalog.records.flatMap(record => record.industries).filter(value => value.length >= 2 && value.length <= 30 && !/^(?:其他|不限|未知|未提供)$/.test(value)).map(normalizeCompanyText));
  const companyNamesInSources = unique([...catalog.records.flatMap(record => [record.name, ...record.aliases]), ...officialJobs.map(job => job.company)]);
  const turns = [input.requirements, ...(input.history ?? []).filter(item => item.role === 'user').map(item => item.content), input.message].filter(Boolean);
  for (const turn of turns) {
    const normalizedTurn = normalizeCompanyText(turn);
    const companyNames = companyNamesInSources.filter(name => name.length >= 2 && normalizedTurn.includes(normalizeCompanyText(name)));
    const positiveNames = companyNames.filter(name => !negative(normalizedTurn, normalizedTurn.indexOf(normalizeCompanyText(name)))).sort((a, b) => b.length - a.length);
    if (positiveNames.length) result.companyTerms = [positiveNames[0]];
    for (const name of companyNames.filter(name => !positiveNames.includes(name))) {
      result.companyTerms = result.companyTerms.filter(value => value !== name);
      add(`尚未执行排除企业名称“${name}”，未将它作为正向企业条件。`);
    }
    // A company name is an identity, not evidence of its city, ownership or role.
    // Mask matched names with equal-length spaces before extracting other criteria.
    let criterionText = normalizedTurn;
    for (const name of [...companyNames].sort((a, b) => b.length - a.length)) {
      const normalizedName = normalizeCompanyText(name);
      criterionText = criterionText.replaceAll(normalizedName, ' '.repeat(normalizedName.length));
    }
    const location = mentions(criterionText, unique([...cities, ...sourceCities])), nature = mentions(criterionText, natureWords), role = mentions(criterionText, terms);
    const education = mentions(criterionText, educationWords), recruitment = mentions(criterionText, recruitmentWords), industry = mentions(criterionText, industryWords);
    const cohorts = [...criterionText.matchAll(/(?<!\d)(20\d{2}|\d{2})\s*届/g)].map(match => ({ term: match[0], value: `${match[1].length === 2 ? `20${match[1]}` : match[1]}届`, index: match.index!, negative: negative(criterionText, match.index!) }));
    const graduate = /应届(?:生|毕业生)?/.exec(criterionText);
    if (graduate && !cohorts.length) cohorts.push({ term: graduate[0], value: '应届生', index: graduate.index, negative: negative(criterionText, graduate.index) });
    for (const [key, selections] of [
      ['educationLevels', education], ['recruitmentTypes', recruitment], ['industries', industry], ['cohorts', cohorts.map(item => ({ ...item, term: item.value }))],
    ] as const) {
      const positive = unique(selections.filter(item => !item.negative).map(item => item.term));
      if (positive.length) result.facetTerms[key] = positive;
      for (const item of selections.filter(item => item.negative)) {
        result.facetTerms[key] = (result.facetTerms[key] ?? []).filter(value => value !== item.term);
        add(`尚未执行排除条件“${item.term}”，没有将其作为正向筛选条件。`);
      }
    }
    const positiveCities = unique(location.filter(item => !item.negative).map(item => item.term));
    if (positiveCities.length) result.cities = positiveCities.slice(0, 30);
    if (positiveCities.length > 30) add('本次最多使用 30 个地区条件，未完整执行超出部分。');
    for (const item of location.filter(item => item.negative)) { result.cities = result.cities.filter(city => city !== item.term); add(`尚未执行排除地区“${item.term}”，请在企业资料中进一步核对。`); }
    const positiveNatures = unique(nature.filter(item => !item.negative).map(item => natureGroup(item.term)));
    if (positiveNatures.length) result.natures = positiveNatures;
    for (const item of nature.filter(item => item.negative)) { const group = natureGroup(item.term); result.natures = result.natures.filter(value => value !== group); add(`尚未执行排除企业性质“${item.term}”，请进一步核对候选资料。`); }
    const positiveTerms = unique(role.filter(item => !item.negative).map(item => item.term));
    const alternatives = positiveTerms.length > 1 && /或|任选|任一|二选一/.test(turn);
    if (alternatives) { result.queryTerms = []; result.noRoleFallback = true; add('岗位方向的“或/任选”组合尚未执行，本次未将它们合并为必须同时具备的条件。'); }
    else if (positiveTerms.length) { result.queryTerms = positiveTerms.slice(0, 3); result.noRoleFallback = false; }
    for (const item of role.filter(item => item.negative)) { result.queryTerms = result.queryTerms.filter(value => value !== item.term); result.noRoleFallback = true; add(`尚未执行排除方向“${item.term}”，未把它作为正向检索条件。`); }
    for (const [pattern, note] of [
      [/薪资|薪水|工资|年薪|月薪|月入|待遇|收入/, '薪资或收入条件：资料没有可统一验证的薪资字段，本次未据此筛选。'],
      [/融资|[A-FＡ-Ｆ]轮|天使轮|上市时间/i, '融资或经营轮次：当前资料不能据此核实，本次未据此筛选。'],
      [/加班|双休|996|995|955|远程|食堂|班车|住房|五险|福利/, '工时、办公方式或福利：当前资料无法统一验证，本次未保证满足。'],
      [/在招|正在招|还招|最新招聘|现在能投|截止日期|实时/, '当前招聘时效：请到官方岗位页核对能否申请及截止日期。'],
    ] as const) if (pattern.test(turn)) add(note);
    let remainder = criterionText;
    for (const item of [...location, ...nature, ...role, ...education, ...recruitment, ...industry, ...cohorts, ...companyNames.map(term => ({ term }))].sort((a, b) => b.term.length - a.term.length)) remainder = remainder.replace(termPattern(item.term), ' ');
    remainder = remainder.replace(/根据|按照|结合|我的|这份|已保存|简历|帮我|给我|请|希望|想要|想找|寻找|查找|找|筛选|公司|企业|行业|岗位|工作|机会|目标|要求|继续|看看|换成|改为|改成|换到|改到|只看|只要|不要|不考虑|排除|推荐|适合|诊断|分析|优化|修改|润色|改写|一下|调整|表达|怎么|如何|你好|谢谢|以及|一些|几个|可以|最好|优先|必须|需要|一家|的|和|在|就好/g, '').replace(/[\s，,。；;！？、/|()（）“”"'：:]+/g, '').trim();
    if (remainder.length > 1 && !/^(?:继续|帮忙|您好|好呀|好的)$/.test(remainder)) add(`尚未解析或验证的要求：${remainder.slice(0, 180)}`);
  }
  return result;
}

function evidence(resume?: Resume): CareerAssistantResult['evidence'] {
  if (!resume) return [];
  const found = mentions(resume.text, terms).filter(item => !item.negative);
  const result: CareerAssistantResult['evidence'] = [];
  for (const item of found) {
    if (result.some(previous => previous.term === item.term)) continue;
    const start = resume.text.lastIndexOf('\n', item.index) + 1;
    const end = resume.text.indexOf('\n', item.index + item.term.length);
    const line = resume.text.slice(start, end < 0 ? resume.text.length : end);
    if (/@|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)/.test(line)) continue;
    const excerpt = resume.text.slice(Math.max(start, item.index - 100), Math.min(end < 0 ? resume.text.length : end, item.index + 220));
    result.push({ term: item.term, excerpt });
    if (result.length === 3) break;
  }
  return result;
}
function criteria(parsed: Parsed, catalog: CompanyCatalogSnapshot) {
  const filters: Partial<CompanyFilters> = {};
  if (parsed.cities.length) {
    // Expose the user's city intent, not hundreds of differently written source labels.
    // The complete location predicate is applied to catalogue records before search.
    filters.locations = [...parsed.cities];
  }
  if (parsed.natures.length) {
    const labels = unique(catalog.records.map(record => record.nature).filter(value => value && matchesNature(value, parsed.natures)));
    filters.natures = (labels.length ? labels : parsed.natures).slice(0, 30);
  }
  for (const key of ['industries', 'educationLevels', 'recruitmentTypes', 'cohorts'] as const) if (parsed.facetTerms[key]?.length) {
    const requested = parsed.facetTerms[key]!;
    const matches = (label: string, wanted: string) => {
      const normalized = normalizeCompanyText(label);
      if (key === 'cohorts') {
        const cohort = normalizeCompanyLabel(key, normalized);
        if (wanted === '应届生') return /应届|(?:20)?\d{2}\s*届/.test(cohort);
        if (cohort === wanted) return true;
        const year = wanted.slice(0, 4);
        const match = new RegExp(`(?<!\\d)(?:${year}|${year.slice(2)})\\s*(?:届|年毕业|$)`).exec(normalized);
        return !!match && assistantLocationMatches(normalized, match[0]);
      }
      if (key === 'educationLevels' && /(?:及以上|以上)$/.test(wanted)) {
        const levels = ['高中', '中专', '大专', '本科', '硕士', '博士'];
        const minimum = wanted.replace(/(?:及以上|以上)$/, '').replace('研究生', '硕士').replace('专科', '大专');
        return levels.indexOf(minimum) >= 0 && levels.slice(levels.indexOf(minimum)).some(level => assistantLocationMatches(normalized, level) || level === '硕士' && assistantLocationMatches(normalized, '研究生'));
      }
      if (key === 'recruitmentTypes' && /校招|校园招聘/.test(wanted)) return assistantLocationMatches(normalized, '校招') || assistantLocationMatches(normalized, '校园招聘');
      return assistantLocationMatches(normalized, normalizeCompanyText(wanted));
    };
    const labels = unique(catalog.records.flatMap(record => record[key]).filter(value => requested.some(wanted => matches(value, wanted))));
    filters[key] = normalizeCompanyLabels(key, labels.length ? labels : requested).slice(0, 30);
  }
  return filters;
}

function findOfficialJobs(jobs: CareerJob[], parsed: Parsed, now: number): CareerJob[] {
  const { recruitmentTypes, cohorts, educationLevels, industries } = parsed.facetTerms;
  if (parsed.natures.length || industries?.length) return [];
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const educationLabel = (value: string) => value.replace(/(?:及以上|以上)$/, '').replace('专科', '大专').replace('研究生', '硕士');
  const matchesTerm = (value: string, term: string) => termPattern(normalizeCompanyText(term)).test(normalizeCompanyText(value));
  return jobs.filter(job => job.origin === 'catalog' && job.sourceUrl?.startsWith('https://') && job.checkedAt && job.availability === 'open'
    && !careerJobIsStale(job, now) && (!job.deadline || job.deadline >= today))
    .filter(job => !parsed.cities.length || parsed.cities.some(city => assistantLocationMatches(job.location, city)))
    .filter(job => parsed.companyTerms.every(term => normalizeCompanyText(job.company).includes(normalizeCompanyText(term))))
    .filter(job => parsed.queryTerms.every(term => matchesTerm(`${job.title} ${job.major} ${job.description}`, term)))
    .filter(job => !cohorts?.length || cohorts.some(cohort => {
      if (cohort === '应届生') return job.audience === 'campus' || job.audience === 'early-career';
      const text = `${job.title} ${job.description}`;
      return [...text.matchAll(/(?<!\d)(20\d{2}|\d{2})\s*届(?:\s*(及以后|之后|以后))?/g)].some(match => {
        const year = Number(match[1].length === 2 ? `20${match[1]}` : match[1]);
        const requested = Number(cohort.slice(0, 4));
        return match[2] ? requested >= year : requested === year;
      });
    }))
    .filter(job => !recruitmentTypes?.length || recruitmentTypes.some(value => Object.hasOwn(officialAudience, value)
      ? officialAudience[value] === job.audience : `${job.title} ${job.description} ${job.sourceLabel}`.includes(value)))
    .filter(job => !educationLevels?.length || reviewJobDescription(job.description, '', [])?.items
      .some(item => item.priority === 'eligibility' && educationLevels.some(label => assistantLocationMatches(item.requirement, educationLabel(label)))))
    .map(job => ({ job, titleMatches: parsed.queryTerms.filter(term => matchesTerm(job.title, term)).length }))
    .sort((a, b) => b.titleMatches - a.titleMatches || Date.parse(b.job.checkedAt!) - Date.parse(a.job.checkedAt!) || a.job.id.localeCompare(b.job.id))
    .slice(0, 5).map(({ job }) => job);
}

/** Stateless, deterministic query help. It never invokes a model, sends data or mutates a resume. */
export async function answerCareerAssistant(service: ResumeService, companies: CompanyCatalogRepository, body: unknown, loadJobs?: () => Promise<CareerJob[]>): Promise<CareerAssistantResult> {
  const input = validateCareerAssistantInput(body);
  const resume = input.resumeId ? await service.getResume(input.resumeId) : undefined;
  if (resume && resume.revision !== input.resumeRevision) throw new HttpError(409, 'REVISION_CONFLICT', '简历版本已变化，请重新选择已保存的最新版本。');
  const [catalog, sharedJobs] = await Promise.all([companies.load(), loadJobs?.() ?? []]);
  const parsed = parse(input, catalog, sharedJobs), excerpts = evidence(resume);
  if (!parsed.queryTerms.length && !parsed.noRoleFallback && resume) {
    parsed.queryTerms = mentions(resume.targetRole, terms).filter(item => !item.negative).map(item => item.term).slice(0, 1);
    if (!parsed.queryTerms.length && excerpts.length) parsed.queryTerms = [excerpts[0].term];
  }
  const query = [...parsed.companyTerms, ...parsed.queryTerms].join(' ').slice(0, 200), filters = criteria(parsed, catalog);
  const generic = input.message.length <= 3 && !input.requirements && !(input.history ?? []).some(item => item.role === 'user') && !/找|查|搜|改|诊断|优化/.test(input.message);
  const lookingForJobs = !generic && !parsed.noRoleFallback && (query || parsed.cities.length || parsed.facetTerms.cohorts?.length || parsed.facetTerms.recruitmentTypes?.length);
  const officialJobs = lookingForJobs ? findOfficialJobs(sharedJobs, parsed, Date.now()) : [];
  const locationFiltered = parsed.cities.length ? { ...catalog, records: catalog.records.filter(record => record.locations.some(value => parsed.cities.some(city => assistantLocationMatches(value, city)))) } : catalog;
  const { locations: _locationIntent, ...exactFilters } = filters;
  const search = searchCompanies(locationFiltered, { q: query, filters: exactFilters, pageSize: 5 });
  const database = await service.store.read();
  const personalJobs: CareerJob[] = generic ? [] : database.careerJobs.filter(job => job.userId === service.userId)
    .filter(job => !parsed.cities.length || parsed.cities.some(city => assistantLocationMatches(job.location, city)))
    .filter(job => parsed.queryTerms.every(term => normalizeCompanyText(`${job.title} ${job.major} ${job.description} ${job.company}`).includes(normalizeCompanyText(term))))
    .filter(job => parsed.companyTerms.every(term => normalizeCompanyText(job.company).includes(normalizeCompanyText(term))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 5).map(({ userId: _owner, ...job }) => job);
  if (personalJobs.length && Object.keys(filters).some(key => key !== 'locations') && parsed.unverified.length < 10) parsed.unverified.push('个人岗位缺少统一核验字段，企业性质、行业、学历、届别和招聘类型请按来源核对。');
  if (resume && (await service.getResume(resume.id)).revision !== resume.revision) throw new HttpError(409, 'REVISION_CONFLICT', '问答期间简历已变化，请重新读取后再试。');
  const wantsAnalysis = /优化|修改|改写|润色|诊断|分析.*简历|改.*简历/.test(`${input.requirements}\n${input.message}`);
  const action = wantsAnalysis && resume ? { type: 'analyze-resume' as const, resumeId: resume.id, revision: resume.revision, targetRole: (parsed.queryTerms[0] ?? resume.targetRole).slice(0, 120) } : undefined;
  const replies = ['当前使用本地规则问答与文本检索，没有调用真实模型。'];
  if (generic) replies.push('你可以选择本人已保存的简历，填写城市、企业性质和岗位方向，例如“找北京国企的 Java 方向”；也可以要求进入简历诊断。');
  else {
    if (query || Object.keys(filters).length) replies.push(`本次按${query ? `关键词“${query}”` : '所选条件'}${parsed.cities.length ? `、地区“${parsed.cities.join('、')}”` : ''}${parsed.natures.length ? `、性质“${parsed.natures.join('、')}”` : ''}查询资料。文本覆盖只是查找线索，不证明能力或岗位适配。`);
    else replies.push('尚未识别明确筛选条件，先列出部分企业资料；补充城市和岗位方向可以进一步缩小范围。');
    if (catalog.state === 'unavailable') replies.push('企业资料暂时读取失败，本次没有返回企业候选，请重新查询。');
    else if (catalog.state === 'empty') replies.push('企业资料库暂无记录，本次没有编造企业或岗位；可继续查阅本人已添加的岗位。');
    else replies.push(`找到 ${search.total} 条企业参考资料，本次展示前 ${search.items.length} 条。`);
    if (personalJobs.length) replies.push(`另找到你本人添加的 ${personalJobs.length} 条岗位记录，信息仍需自行核实，不能视为官方在招职位。`);
    if (officialJobs.length) replies.push(`找到 ${officialJobs.length} 条近期核对过来源的岗位摘要。进入官方页面确认申请状态后，可以带入简历诊断。`);
    else if (lookingForJobs && loadJobs) replies.push('资料库暂未找到符合已识别条件的近期岗位。可以调整城市或岗位关键词，也可以添加自己找到的岗位并带入简历诊断。');
    if (filters.educationLevels?.length || filters.cohorts?.length || filters.recruitmentTypes?.length) replies.push('学历、届别和招聘类型仅按来源标签筛选，不表示你已满足该招聘的全部资格或当前仍可申请。');
  }
  replies.push('企业库是历史资料，不能确认当前仍在招聘、截止日期或申请资格；请自行核对最新官方招聘信息。');
  if (parsed.unverified.length) replies.push(`以下要求尚未解析或验证，结果不保证全部满足：\n${parsed.unverified.map(value => `• ${value}`).join('\n')}`);
  if (wantsAnalysis) replies.push(resume ? '已提供“诊断并修改简历”入口；此处未修改简历。进入后需对照建议、补充真实事实并确认，才能应用。' : '请先选择本人已保存的简历，再进入诊断与修改流程。');
  return {
    engine: 'local-rules', reply: replies.join('\n\n'), ...(resume ? { resume: { id: resume.id, title: resume.title, revision: resume.revision, inputHash: resumeContentHash(resume) } } : {}),
    criteria: { query, filters, unverifiedRequirements: parsed.unverified }, companies: generic ? [] : search.items,
    companyTotal: generic ? 0 : search.total, personalJobs, ...(officialJobs.length ? { officialJobs } : {}), evidence: excerpts, catalogState: catalog.state, ...(action ? { action } : {}),
  };
}
