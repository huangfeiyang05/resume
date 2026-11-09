import type { Analysis, AnalysisJob, AiQuotaSummary, PaidPlanId, WorkbenchAccess } from './types.js';
import type { PaymentChannel, PaymentOrder, PaymentOrderStatus } from './payment.js';

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
export interface AdminOrderQuery extends AdminUserQuery {
  userId?: string;
  status?: PaymentOrderStatus;
  channel?: PaymentChannel;
}
type MembershipEventKind = 'purchase' | 'renewal' | 'upgrade';

export interface AdminOrder extends PaymentOrder {
  userId: string;
  /** The verified membership event for this payment, regardless of current membership. */
  membershipActivation: { kind: MembershipEventKind; startsAt: string; expiresAt: string } | null;
  refundable?: true;
  refund?: AdminRefund;
}

export const refundStatuses = ['requested', 'processing', 'unknown', 'succeeded', 'closed', 'abnormal'] as const;
export interface AdminRefund {
  id: string;
  status: typeof refundStatuses[number];
  amountCents: number;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}
export interface AdminRefundPreview {
  id: string;
  orderId: string;
  userId: string;
  channel: PaymentChannel;
  amountCents: number;
  before: WorkbenchAccess;
  after: WorkbenchAccess;
  remaining: { planId: PaidPlanId; startsAt: string; expiresAt: string }[];
}

export interface AdminUser {
  id: string;
  createdAt: string;
  email: { address: string; verified: boolean } | null;
  phone: string | null;
  wechat: boolean;
  membership: {
    planId: PaidPlanId;
    startsAt: string;
    expiresAt: string;
    latestEvent: MembershipEventKind;
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
