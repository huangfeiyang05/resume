import type { CompanyFilterKey, CompanyRecord } from '../shared/company.js';
import { matchesRecruitmentCohort, recruitmentCohortYear } from '../shared/recruitment-cohort.js';
import { matchesSeedCampusAnnouncement } from './company-source-reviews.js';

export const companyCities = [
  '北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '南京', '苏州', '武汉', '西安', '成都', '长沙', '合肥',
  '郑州', '济南', '青岛', '厦门', '福州', '宁波', '无锡', '佛山', '东莞', '珠海', '惠州', '南昌', '南宁', '昆明',
  '贵阳', '太原', '石家庄', '哈尔滨', '长春', '沈阳', '大连', '海口', '三亚', '兰州', '西宁', '银川', '乌鲁木齐', '拉萨',
  '香港', '澳门', '台北', '常州', '南通', '扬州', '镇江', '徐州', '盐城', '泰州', '淮安', '连云港', '温州', '嘉兴',
  '湖州', '绍兴', '金华', '台州', '舟山', '丽水', '衢州', '泉州', '漳州', '莆田', '龙岩', '赣州', '九江', '芜湖',
  '蚌埠', '洛阳', '新乡', '许昌', '焦作', '烟台', '潍坊', '淄博', '威海', '临沂', '泰安', '济宁', '德州', '东营',
  '聊城', '菏泽', '包头', '呼和浩特', '鄂尔多斯', '唐山', '保定', '廊坊', '秦皇岛', '邯郸', '沧州', '衡水', '淮南', '阜阳',
  '马鞍山', '襄阳', '宜昌', '荆州', '岳阳', '株洲', '湘潭', '衡阳', '绵阳', '德阳', '宜宾', '泸州', '乐山', '自贡',
  '达州', '南充', '遵义', '六盘水', '玉溪', '曲靖', '柳州', '桂林', '北海', '中山', '江门', '汕头', '湛江', '肇庆',
  '清远', '韶关', '茂名', '揭阳', '潮州', '梅州', '汕尾', '阳江', '河源', '云浮', '宝鸡', '咸阳', '榆林', '延安',
  '汉中', '渭南', '大庆', '齐齐哈尔', '牡丹江', '吉林', '锦州', '鞍山', '营口',
] as const;
const cities = new Set<string>([...companyCities, '吕梁', '宿迁', '日照', '晋城', '朔州', '盘锦', '邢台', '乌兰察布', '天长', '罗定', '吉安', '济源', '枝江', '郴州', '嘉峪关', '葫芦岛']);
const provincePrefix = /^(?:河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾)省|^(?:内蒙古|广西壮族|西藏|宁夏回族|新疆维吾尔)自治区/;
const aliases: Partial<Record<CompanyFilterKey, Record<string, string>>> = {
  natures: {
    国有: '国企', 国有企业: '国企', 中央企业: '央企', 国有控股企业: '国有控股', 国有独资企业: '国有独资',
    民企: '民营企业', 民营: '民营企业', 私营: '私营企业', 私企: '私营企业',
    外资: '外企', 外资企业: '外企', 外商独资: '外商独资企业',
  },
  recruitmentTypes: {
    校园招聘: '校招', 社会招聘: '社招', 实习招聘: '实习', 日常实习招聘: '日常实习',
    春季校园招聘: '春招', 夏季校园招聘: '夏招', 秋季校园招聘: '秋招',
    '实习(可转正)': '可转正实习', '可转正实习招聘': '可转正实习',
  },
  locations: {
    香港特别行政区: '香港', 澳门特别行政区: '澳门', 广西省: '广西壮族自治区',
  },
};

/** Keeps qualified source labels intact, and only merges equivalent standalone labels. */
export function normalizeCompanyLabel(key: CompanyFilterKey, value: string): string {
  const label = value.trim().replace(/\s+/g, ' ');
  const normalized = label.normalize('NFKC');
  if (key === 'cohorts') {
    const year = recruitmentCohortYear(normalized);
    if (year) return `${year}届`;
  } else if (key === 'educationLevels') {
    const level = /^(本科|大专|专科|硕士(?:研究生)?|博士(?:研究生)?)(?:\s*(及以上|以上))?$/.exec(normalized);
    if (level) {
      const degree = level[1].replace('研究生', '').replace('大专', '专科');
      return level[2] ? degree + '及以上' : degree;
    }
  } else if (key === 'locations') {
    const city = normalized.replace(provincePrefix, '').replace(/市$/, '');
    if (cities.has(city)) return city;
  }
  const mapping = aliases[key];
  return mapping && Object.hasOwn(mapping, normalized) ? mapping[normalized] : label;
}

export function normalizeCompanyLabels(key: CompanyFilterKey, values: readonly string[]): string[] {
  return [...new Set(values.map(value => normalizeCompanyLabel(key, value)))];
}

const otherRecruitmentAudiences = new Set(['海外往届', '部分往届']);
const cohortRange = /(?<!\d)(20\d{2}|\d{2})(?:\s*[年届])?\s*(?:[-–—~至到、及和]|以及)\s*(20\d{2}|\d{2})\s*届/g;
const cohortMention = /(?<!\d)(20\d{2}|\d{2})\s*届/g;
const graduationDates = /(?<!\d)(20\d{2})(?:\s*年(?:\s*\d{1,2}月(?:\d{1,2}日)?)?|\.\d{1,2}(?:\.\d{1,2})?)(?:\s*(?:[-–—~至到、及和]|以及)\s*(?:(20\d{2})(?:\s*年(?:\s*\d{1,2}月(?:\d{1,2}日)?)?|\.\d{1,2}(?:\.\d{1,2})?)|\d{1,2}(?:月(?:\d{1,2}日)?|\.\d{1,2})))?/g;

export function companyCohortFacets(labels: readonly string[]): string[] {
  const facets = new Set<string>();
  function addYears(first: string, last = first) {
    const start = recruitmentCohortYear(first)!;
    const end = recruitmentCohortYear(last)!;
    if (end < start || end - start > 10) return;
    for (let year = start; year <= end; year++) facets.add(`${year}届`);
  }
  for (const label of labels) {
    const normalized = label.normalize('NFKC').trim();
    if (otherRecruitmentAudiences.has(normalized)) {
      facets.add(normalized);
      continue;
    }
    if (recruitmentCohortYear(normalized) !== undefined) {
      addYears(normalized);
      continue;
    }
    // An explicit cohort takes precedence over its explanatory calendar window.
    const explicit = [...normalized.matchAll(cohortMention)];
    if (explicit.length) {
      for (const match of normalized.matchAll(cohortRange)) {
        if (matchesRecruitmentCohort(normalized, recruitmentCohortYear(match[2])!)) addYears(match[1], match[2]);
      }
      for (const match of explicit) {
        if (matchesRecruitmentCohort(normalized, recruitmentCohortYear(match[1])!)) addYears(match[1]);
      }
      continue;
    }
    for (const match of normalized.matchAll(graduationDates)) {
      const before = normalized.slice(0, match.index);
      const after = normalized.slice(match.index + match[0].length);
      if (/毕业(?:时间|日期)\s*(?:在|为|[:：])?\s*$/.test(before)
        || /^\s*(?:期间|之间|内|的|应届|预计|于)*\s*(?:毕业|取得学历学位的毕业生)/.test(after)) {
        addYears(match[1], match[2]);
      }
    }
  }
  return [...facets];
}

/** Read projection for search and details. Persisted source labels and revision hashes stay available to the administrator. */
export function companyDirectoryRecord(record: CompanyRecord): CompanyRecord {
  return {
    ...record,
    industries: normalizeCompanyLabels('industries', record.industries),
    nature: normalizeCompanyLabel('natures', record.nature),
    locations: normalizeCompanyLabels('locations', record.locations),
    directions: normalizeCompanyLabels('directions', record.directions),
    educationLevels: normalizeCompanyLabels('educationLevels', record.educationLevels),
    recruitmentTypes: normalizeCompanyLabels('recruitmentTypes', record.recruitmentTypes),
    cohorts: matchesSeedCampusAnnouncement(record) ? ['2027届'] : normalizeCompanyLabels('cohorts', record.cohorts),
  };
}
