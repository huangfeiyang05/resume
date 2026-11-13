import type { Analysis, JobRequirementReview } from '../shared/types.js';
import { hasTerm, reviewTerms } from './role-guides.js';

const requirementHeading = /^(?:岗位要求|任职要求|任职资格|职位要求|招聘条件|申请条件|资格条件|岗位条件|要求)(?:\s*[：:]\s*|\s*$)/;
const preferredHeading = /^(?:加分项|优先条件|优先考虑)(?:\s*[：:]\s*|\s*$)/;
const otherHeading = /^(?:岗位职责|职位描述|岗位描述|工作职责|职责|薪资待遇|福利待遇|公司介绍|投递方式|申请方式)(?:\s*[：:]\s*|\s*$)/;
const priorityOrder = { eligibility: 0, required: 1, preferred: 2, review: 3 } as const;
const eligibility = /\d{2,4}\s*届|应届|毕业(?:时间|日期|生)|在校(?:大学生|学生)|(?:本科|硕士|博士|大专|专科)(?:及以上|以上|学历|学位|在读)|至少\s*\d+\s*年|\d+\s*年(?:以上|及以上)|每周[^，。；]{0,22}\d+\s*天|持有[^，。；]{0,22}(?:证书|资格证)|CET[\s-]*[46]|英语[四六]级|普通话[^，。；]{0,12}[等级]/i;
const privateLine = /@|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[\t -]?\d){8}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)/;

export function reviewJobDescription(jobDescription: string, resumeText: string, legacyTerms: string[]): Analysis['jobReview'] {
  if (!jobDescription.trim()) return;
  const resumeLines = resumeText.split(/\r?\n/).flatMap(line => line.split(/[。；;]+/)).map(line => line.trim())
    .filter(line => line && !privateLine.test(line) && !/^(?:目标岗位|求职意向|岗位要求|职位要求|招聘条件)\s*[:：]/.test(line));
  let section: JobRequirementReview['priority'] | 'other' = 'review';
  const requirements = new Map<string, JobRequirementReview['priority']>();
  for (const raw of jobDescription.split(/\r?\n|[；;。！？]+/)) {
    let clause = raw.trim().replace(/^(?:[-•·*]\s*|\d{1,2}[、.．)）]\s*|[一二三四五六七八九十]+、\s*)/, '');
    const heading = requirementHeading.exec(clause) ?? preferredHeading.exec(clause) ?? otherHeading.exec(clause);
    if (heading) {
      section = requirementHeading.test(clause) ? 'required' : preferredHeading.test(clause) ? 'preferred' : 'other';
      clause = clause.slice(heading[0].length).trim();
    }
    if (section === 'other' || !clause || /^(?:官网列示薪资|福利|薪资|投递|来源|大厂|成长型企业|初创团队)[：:\s·]/.test(clause)) continue;
    // Separate clearly marked preference clauses from mandatory clauses on the same line.
    const segments = clause.split(/[，,]\s*(?=(?:熟悉|掌握|熟练|具备|了解|至少|曾|必须|愿意|持有|能|可适应|有)[^，,]|[^，,]{1,30}相关专业优先)/);
    for (const segment of segments) {
      const preferred = section === 'preferred' || /优先|加分|更佳/.test(segment);
      const priority = preferred ? 'preferred' : eligibility.test(segment) ? 'eligibility'
        : section === 'required' || /必须|须具备|硬性|必备/.test(segment) ? 'required' : 'review';
      if (segment.trim()) {
        const previous = requirements.get(segment);
        if (!previous || priorityOrder[priority] < priorityOrder[previous]) requirements.set(segment, priority);
      }
    }
  }
  const ranked = [...requirements].sort((a, b) => priorityOrder[a[1]] - priorityOrder[b[1]]);
  if (!ranked.length) return;
  return {
    items: ranked.slice(0, 10).map(([requirement, priority]) => ({
      requirement: requirement.length > 500 ? `${requirement.slice(0, 500)}…` : requirement,
      priority,
      evidence: reviewTerms(requirement, legacyTerms).slice(0, 5).map(term => {
        const excerpt = resumeLines.find(line => line.length <= 300 && hasTerm(line, term));
        return { term, ...(excerpt ? { excerpt } : {}) };
      }),
    })),
    omitted: Math.max(0, ranked.length - 10),
  };
}
