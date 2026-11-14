import { createHash } from 'node:crypto';
import type { CompanyDetail, CompanyRecord } from '../shared/company.js';
import { recruitmentCohortYear } from '../shared/recruitment-cohort.js';

const checkedAt = '2026-11-14T00:00:00+08:00';
const retired4399Url = 'https://hr.4399om.com/campus/graduate/?jobType=campus_chanpinlei&jobID=JO20250728002';

type AnnouncementReview = {
  name: string;
  review: NonNullable<CompanyDetail['sourceReview']>;
  originalCohorts?: readonly string[];
  correctedCohorts?: readonly string[];
};

const announcementReviews = new Map<string, AnnouncementReview>([
  ['https://zhaopin.szgzjg.com/company/2000000000000000015', {
    name: '苏州地铁',
    review: {
      status: 'historical', checkedAt,
      note: '江苏省高校招生就业指导服务中心存档确认，这是苏州地铁 2026 年度公开招聘第一批，报名已于 2026 年 6 月 30 日 17 点截止。公告同时列有应届生专门条件，具体资格按原岗位要求执行。',
      sourceUrl: 'https://zjzx.91job.org.cn/index.php?a=show&c=article&id=10730&m=home&site=1',
    },
  }],
  ['https://gzw.my.gov.cn/mysgzw/c101662/202606/054a8170245346ae9fc078a08a86c73b.shtml', {
    name: '绵阳市投资控股（集团）',
    review: {
      status: 'historical', checkedAt,
      note: '绵投集团官网存档确认，本批招聘面向 26 届应届生和择业期内未就业的 25 届毕业生。25 届还有社保与档案条件，见原公告。报名已于 2026 年 6 月 24 日截止。',
      sourceUrl: 'https://mtkg.cn/olerecruit.html',
    },
  }],
  ['https://xyzp.51job.com/tcrcb2026s', {
    name: '太仓农村商业银行', originalCohorts: ['2026届'], correctedCohorts: ['2026届', '部分往届'],
    review: {
      status: 'historical', checkedAt,
      note: '对外经济贸易大学就业网发布的同批简章确认，柜面服务岗同时接受符合条件的境内外往届生，要求 2024 年 1 月 1 日及以后取得毕业证、学位证。报名已于 2026 年 4 月 20 日 12 点截止。',
      sourceUrl: 'https://aeo.uibe.edu.cn/front/zpxx.jspa?tid=2038533491477446658',
    },
  }],
]);

function findAnnouncementReview(record: CompanyRecord): AnnouncementReview | undefined {
  const entry = record.recruitmentUrl ? announcementReviews.get(record.recruitmentUrl) : undefined;
  if (entry?.name === record.name) return entry;
}

export function reviewedCompanyCohorts(record: CompanyRecord): readonly string[] {
  if (matchesSeedCampusAnnouncement(record)) return ['2027届'];
  const entry = findAnnouncementReview(record);
  if (entry?.originalCohorts?.length === record.cohorts.length && entry.originalCohorts.every(label => record.cohorts.includes(label))) {
    return entry.correctedCohorts ?? record.cohorts;
  }
  return record.cohorts;
}

function matchesSeedCampusAnnouncement(record: CompanyRecord): boolean {
  return record.name === '字节跳动Seed-2027 届大模型人才校招'
    && record.recruitmentUrl === 'https://mp.weixin.qq.com/s/KbD0clq20SOkbQCaXSS0OA'
    && record.cohorts.length === 2 && record.cohorts.some(label => recruitmentCohortYear(label) === 2026)
    && record.cohorts.some(label => recruitmentCohortYear(label) === 2027);
}

export function companySourceReview(record: CompanyRecord): CompanyDetail['sourceReview'] {
  const { recruitmentUrl } = record;
  if (recruitmentUrl === retired4399Url && record.cohorts.some(label => recruitmentCohortYear(label) === 2026)) {
    return { status: 'historical', checkedAt, note: '这是 26 届历史招聘资料。原岗位编号已不在官网当前列表中，原链接在核对时显示 27 届岗位。可在“公司岗位”查看 4399 游戏的 27 届公告。' };
  }
  if (matchesSeedCampusAnnouncement(record)) {
    return {
      status: 'corrected',
      checkedAt,
      note: 'Seed 官网确认本次应届招聘面向 2026 年 9 月至 2027 年 8 月毕业的本硕博，按 27 届筛选。实习面向 2027 年 9 月及以后毕业的在校生。下方保留了导入时的招聘对象原文。',
      sourceUrl: 'https://seed.bytedance.com/zh/blog/bytedance-seed-2027-foundation-model-campus-recruitment-is-now-open-internships-included',
    };
  }
  if (recruitmentUrl === 'https://www.hzmetrojob.com/posts-school' && record.name === '杭州地铁运营有限公司(第二批)'
    && record.cohorts.some(label => recruitmentCohortYear(label) === 2026)) {
    return {
      status: 'historical', checkedAt,
      note: '高校就业网存档确认这是杭州地铁运营有限公司 26 届春招第二批，且该批公告已过期。原投递页在核对时已无法打开。',
      sourceUrl: 'https://jysd.bigc.edu.cn/campus/view/id/869029',
    };
  }
  if (recruitmentUrl === 'https://hr.sensetime.com/SU6522677e1c240e3d6825d64c/pb/school.html'
    && record.name === '商汤科技' && record.recruitmentTypes.includes('暑期实习')) {
    return {
      status: 'unavailable', checkedAt,
      note: '原暑期实习链接在核对时已无法打开。商汤另有 27 届校招公告，面向 2026 年 9 月至 2027 年 12 月毕业的本硕博。官网同时列有独立的实习招聘，投递条件以各岗位公告为准。',
      sourceUrl: 'https://hr.sensetime.com/campus/',
    };
  }
  const announcement = findAnnouncementReview(record);
  if (announcement) return announcement.review;
  if (recruitmentUrl && unavailableLinks.has(createHash('sha256').update(recruitmentUrl).digest('hex'))) {
    return { status: 'unavailable', checkedAt, note: '两次检查均未找到原链接指向的页面。请在招聘方官网查询该职位的最新公告。' };
  }
}

// Exact original URLs returned 404 in two checks. Hashes keep source parameters out of the repository.
const unavailableLinks = new Set([
  '005b37c225d00d23ed3e0803969334bd61b8dc856681e662b7be9da95dc94c68',
  '00a1cb0510cbfa1f2075e5d23e7c9f41dcec8483cfd8f9b53613acb0c62ca054',
  '0123b90a77c7255c31a227fac8455f39fc17755def0a2d4fd908393dcd8889fe',
  '0a9a1b280e7358819127b78845d9483ae6aa251b638f53eec9e8e5134e694796',
  '0dbccee4051482886613636e84383c84606d199c3a3a54b2b88198f9d2f52359',
  '131b806cfe1387ceb38d39c55091c1463617a65643727b3ddaa6fbd6bc33ebd8',
  '153dd65933a1cf6c3253877d89aa5f638355ba55e721f5db8e731216703c8854',
  '164a8d921132444ac7bf6f4678c06a31a7ac473405e812f0abbdb277b9e10848',
  '1f966e6be71a2d5f94a48681a7b4072c727d69cc7a56f941bb5c904fd3d8a602',
  '25a23319252d02242a7a4567827578145d9ec22da72fad68b7767476faab322b',
  '341028eb71bf5a7400ce4fb14b46a2a1d47f8358e61239689f02fa952ba89de4',
  '34c581e81ce03dfbf96c69199ba2cb52ba0bd15c9f0a2a6c134980d4bf25e5eb',
  '3bcea291dc7bf0a3c8aeb0f879d6699525595030fc97652a3965aed2850904a5',
  '3e711695c78ae0f4d79d86809fdaedf4d7c6e50df2df0c49c10a4215e64f10f1',
  '3e74dd8753a470c0cc2fbd013d4fae5b68a88c53cec69c7cb59e804f676d3e24',
  '3f449b4ab4aa846b6caab35e124db1eab3b20e26a1f22fc5693ef7221da873d9',
  '473c290f615ec20f1319f0d05f20de99068677153fce20b13b4ec27499e29f4b',
  '474ef69e9508f628d41dd20b9924c3d58d161764e35e72c997d7cd8101cd1761',
  '4aefb5d62eb0233f16df8fbe922dc002f538122309a2563df46aa057759550b7',
  '4b510919561d7c0a4bd769fd72263303ff2008a88ab07abf678691352ce96dfb',
  '519c547cd8af997064d06c006b3488388923d07ca10e7475bc8b4a77387e8737',
  '6b0bd5718e92c902601f1f26fe13408fb55489c00b192114e4e4a3c450b8a6d2',
  '7eee266983355a27ba055910012cc2ebbe850ee5cd9275ab7784fd7a414aa2fd',
  '8738a129bcf8f03ca3b8c6fa2a7fd18acb38ef8c3e2abc434ad45948d18655d8',
  '90189be5dc208093db795e5f6fd42a1e7768051548e86355077e38a7a1c207d5',
  '951655e42efef1b86d869fb270a1f57f57526a61d72ab51b7ab0326731929b61',
  '972947a803c63a93ac6c5156cc6738282c4272510d849fd3735dcbadc1f13efb',
  '9b795e7ded18b7e81ce7c31cda0d3f733de2e550583e95d6583042b273bed364',
  'a1917584870d99c7fd947e4ef00ca2149c00d477658fc863724606f70d2c4a75',
  'a89e97d0d0308e5b1f0292a4e1ec968df10c061401fddb1458a379c9159e4b25',
  'b9d04d393db01fe5deb261ce76bc1b2fcfcfbee549ad8402246aea9de3c9554a',
  'c1e9292770cfd3f8b9e88bed707a61429bad0d6d402ce1907725a076f69e9542',
  'cc868c3e326655568ec35954c40dcbca838060341cbfaca2d0535bdf297d864e',
  'cca49f9cfdca4ab4aeb3361a19d97f82b3e4b05caa600f7b71c14d68806ab310',
  'd700560083f47f503cceb8debfc2a739877ef75b2a10c302a6454e77e3cffd7d',
  'de4f262d5ef35aee5905418072f00977386f6683e161242f43980888c05a81ba',
  'e41cce2cd54d41d811af7693e4635ccea6275a0f23603560843e0c09d373179d',
  'e81b097a21047e3364c111867942db555ee33a42ce5b1b75a5542a2040e58af6',
  'e99d5462552da05cc392840402fec3c869e770423720c5446ff6268f34037884',
  'eb990b26c2aa0f1b9d85c39e1607fbdb35684107db68130077e57b508bab9434',
  'ebc6ea1a4911f878d20452be1e94912566c85ad72671b1fd70fc4416a89cd364',
  'f9bcbb5954b3102e912c6be200b54901c444189afb0dbb2ad748b24403b4b37d',
  'fc485b3b0031f5540c2489e1185365ae03b542975be7394e37739bb6290ecbb4',
]);
