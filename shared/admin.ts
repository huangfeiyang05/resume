import type { Analysis, AnalysisJob, AiQuotaSummary, PaidPlanId, WorkbenchAccess } from './types.js';

export const adminTaskStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const satisfies readonly AnalysisJob['status'][];
export const adminUsageStatuses = ['reserved', 'dispatched', 'pending', 'settled', 'released'] as const;
export type AdminUsageStatus = typeof adminUsageStatuses[number];

export interface AdminOverview {
  users: number;
  newUsers7Days: number;
  activeMembers: number;
  failedTasks: number;
  pendingUsage: number;
}

export interface AdminPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminUserQuery { page?: number; query?: string }
export interface AdminTaskQuery extends AdminUserQuery {
  status?: AnalysisJob['status'];
  usageStatus?: AdminUsageStatus;
}

export interface AdminUser {
  id: string;
  createdAt: string;
  email: { masked: string; verified: boolean } | null;
  phoneMasked: string | null;
  wechat: boolean;
  membership: {
    planId: PaidPlanId;
    startsAt: string;
    expiresAt: string;
    latestEvent: 'purchase' | 'renewal' | 'upgrade';
  } | null;
  workbench: WorkbenchAccess;
  quota: AiQuotaSummary;
}

export interface AdminTask {
  id: string;
  userId: string;
  engine: Analysis['engine'];
  status: AnalysisJob['status'] | null;
  errorCode: string | null;
  resumeRevision: number | null;
  createdAt: string;
  updatedAt: string;
  usageStatus: AdminUsageStatus | null;
}
