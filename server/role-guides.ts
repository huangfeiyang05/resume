import { readFileSync } from 'node:fs';
import type { RoleGuide } from '../shared/types.js';

const guides = JSON.parse(readFileSync(new URL('./assets/career/role-guides.json', import.meta.url), 'utf8')) as Array<Omit<RoleGuide, 'terms'>>;
const profiles: Record<string, { roles: RegExp; terms: string[] }> = {
  'cs-software': { roles: /前端|后端|全栈|软件|\bJava\b.*开发|应用程序开发|运维|测试开发|小程序|backend|frontend|software/i, terms: ['JavaScript', 'TypeScript', 'React', 'Vue', 'Java', 'Go', 'Spring Boot', 'Linux', 'Docker', 'Electron', '微服务', '分布式系统', '接口联调', '单元测试', '自动化测试', 'Git', 'CI/CD'] },
  'data-statistics': { roles: /数据分析|数据科学|统计|算法|数据工程|风控分析|data analyst|data scientist/i, terms: ['SQL', 'Python', 'R', 'Excel', '数据清洗', '指标体系', '数据可视化', '统计建模', 'A/B 测试', '数据挖掘', '机器学习', 'Power BI', 'Tableau'] },
  'mechanical-electrical': { roles: /机械|电气|自动化|机电|工艺工程|设备工程|试验开发|机器人.*测试|嵌入式/, terms: ['SolidWorks', 'AutoCAD', 'PLC', 'ROS', 'ROS2', 'Linux', '机械设计', '电气设计', '故障排查', '可靠性验证', '试验报告', '数据采集', '设备调试', '嵌入式'] },
  'civil-architecture': { roles: /土木|建筑|造价|城市规划|施工|工程测量/, terms: ['BIM', 'AutoCAD', 'Revit', '工程测量', '施工组织', '工程量清单', '工程造价', '图纸会审', '现场管理'] },
  'materials-environment': { roles: /材料|化工|环境|碳核算|能源|环保/, terms: ['材料表征', '环境监测', '工艺验证', '过程控制', '碳核算', '实验设计', '样品检测', '化学分析'] },
  'business-finance': { roles: /财务|会计|审计|银行|金融|税务|咨询顾问|风控(?!数据)/, terms: ['Excel', 'SAP', '财务分析', '财务报表', '财务建模', '预算', '成本核算', '内控', '审计底稿', '对账', 'CPA', 'CFA'] },
  'marketing-communication': { roles: /市场|运营|增长|产品经理|产品助理|新闻|品牌营销|公关/, terms: ['用户调研', '内容策划', '活动策划', '用户增长', '投放', '转化分析', '数据复盘', '达人营销', '竞品分析', '需求分析', 'A/B 测试', 'Excel', 'SQL'] },
  'law-public-policy': { roles: /法务|律师|法律|合规|政策研究|公共事务/, terms: ['合同审查', '法律检索', '尽职调查', '合规审查', '政策分析', '法规研究', '法律职业资格'] },
  'languages-international': { roles: /翻译|口译|外贸|国际业务|国际项目|跨境电商/, terms: ['笔译', '口译', '术语库', '跨境电商', '外贸单证', '国际贸易', '商务英语', 'CATTI'] },
  education: { roles: /教师|教研|师范|教学|课程研发/, terms: ['教学设计', '教师资格证', '普通话', '试讲', '课程设计', '课堂管理', '教案', '学情分析'] },
  'life-sciences-research': { roles: /生物|实验技术|实验员|科研助理|研究助理/, terms: ['实验记录', '文献检索', '实验设计', '样本管理', '数据整理', '质量控制', '统计分析'] },
  'nursing-public-health': { roles: /护理|护士|公共卫生|流行病|健康研究/, terms: ['护士执业证书', '健康教育', '护理记录', '临床实习', '感染防控', '流行病学', '病历管理', '健康档案'] },
  'psychology-social-work': { roles: /心理|社工|社会工作|社区项目/, terms: ['访谈', '问卷设计', '需求评估', '个案服务', '小组活动', '社区服务', '项目评估', '社会工作者职业资格'] },
  'design-arts': { roles: /交互设计|视觉设计|平面设计|工业设计|UI设计|设计师|ux designer|product designer/i, terms: ['Figma', 'Sketch', 'Adobe', 'Axure', 'ProtoPie', '用户研究', '交互原型', '视觉设计', '设计系统', '可用性测试', '作品集'] },
  'agriculture-food': { roles: /农业|农学|食品|农艺|园艺|植物保护/, terms: ['食品检测', 'HACCP', '田间试验', '样品检测', '质量追溯', '生产质量', '质量控制'] },
  'supply-chain-logistics': { roles: /供应链|物流|仓储|采购|运输运营|工业工程|计划运营/, terms: ['Excel', 'SQL', 'WMS', 'ERP', '库存盘点', '库容', '运输调度', '供应商管理', '履约', '流程优化', '库存周转', '成本分析', '精益改善'] },
};

const aliases: Record<string, string[]> = {
  JavaScript: ['JS'], TypeScript: ['TS'], 'Spring Boot': ['SpringBoot'], PostgreSQL: ['Postgres'],
  'Node.js': ['NodeJS', 'Node JS'], 'Next.js': ['NextJS'], HTML: ['HTML5'], CSS: ['CSS3'],
  'A/B 测试': ['AB 测试', 'AB测试', 'A/B测试', 'AB实验', 'A/B 实验'], 'Power BI': ['PowerBI'],
  '护士执业证书': ['护士执业资格证', '护士执业资格'], '法律职业资格': ['法考', '法律职业资格证书'],
  '分布式系统': ['分布式架构'], '教师资格证': ['教师资格证书'],
};

const normalized = (text: string) => text.normalize('NFKC').toLowerCase();
const termCounts = new Map<string, number>();
for (const profile of Object.values(profiles)) {
  for (const term of profile.terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
}
const terms = [...termCounts.keys()];
const matchers = new Map([...new Set([...terms, ...Object.keys(aliases)])].map(term => [term, termPattern(term)]));
function termPattern(term: string) {
  const pattern = (Object.hasOwn(aliases, term) ? [term, ...aliases[term]] : [term]).map(word => {
    const value = normalized(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /[a-z]/.test(value) && !/[\u3400-\u9fff]/.test(value) ? `(?<![a-z0-9])${value}(?![a-z0-9])` : value;
  }).join('|');
  return new RegExp(pattern);
}
export function hasTerm(text: string, term: string) {
  return (matchers.get(term) ?? termPattern(term)).test(normalized(text));
}
export function reviewTerms(text: string, legacyTerms: string[]) {
  const candidates = [...new Set([...terms, ...legacyTerms])].filter(term => hasTerm(text, term));
  return candidates.filter(term => !candidates.some(other => other !== term && normalized(other).includes(normalized(term)) && term.length > 1
    && !hasTerm(normalized(text).replace(new RegExp((matchers.get(other) ?? termPattern(other)).source, 'g'), ''), term)));
}

export function retrieveRoleGuide(targetRole: string, jobDescription = ''): RoleGuide | null {
  const ranked = guides.map(guide => {
    const profile = profiles[guide.id];
    const found = profile.terms.filter(term => hasTerm(jobDescription, term));
    const roleMatch = profile.roles.exec(targetRole);
    const distinctive = found.filter(term => termCounts.get(term) === 1);
    // Shared tools alone are too weak to select a professional track.
    return { guide, found, score: (roleMatch ? 10 + Math.min(6, roleMatch[0].length) * 2 : 0)
      + Math.min(6, distinctive.length * 2) + Math.min(3, found.length), eligible: !!roleMatch || distinctive.length >= 2 };
  }).filter(item => item.eligible).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score === ranked[1]?.score) return null;
  return { ...best.guide, terms: best.found.slice(0, 10) };
}

export const roleGuideReference = (guide: RoleGuide) => `${guide.id}@${guide.version}`;
