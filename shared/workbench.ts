import type { PaidPlanId, PlanId } from './membership.js';

export const workbenchFeatures = ['resumeOptimization', 'careerAssistant', 'companyJobs', 'recruitmentPortals', 'studyMaterials', 'applications'] as const;
export type WorkbenchFeature = typeof workbenchFeatures[number];
export const workbenchRequiredPlan: Readonly<Record<WorkbenchFeature, PaidPlanId>> = {
  resumeOptimization: 'basic', careerAssistant: 'premium', companyJobs: 'premium',
  recruitmentPortals: 'premium', studyMaterials: 'premium', applications: 'premium',
};
export const workbenchFeatureNames: Readonly<Record<WorkbenchFeature, string>> = {
  resumeOptimization: '简历优化', careerAssistant: '求职助手', companyJobs: '公司岗位',
  recruitmentPortals: '招聘入口', studyMaterials: '复习资料', applications: '投递计划',
};
export interface WorkbenchAccess {
  planId: PlanId;
  expiresAt: string | null;
  features: Record<WorkbenchFeature, boolean>;
}
export function workbenchPermissions(planId: PlanId): Record<WorkbenchFeature, boolean> {
  return Object.fromEntries(workbenchFeatures.map(feature => [feature,
    planId === 'premium' || (planId === 'basic' && workbenchRequiredPlan[feature] === 'basic'),
  ])) as Record<WorkbenchFeature, boolean>;
}
