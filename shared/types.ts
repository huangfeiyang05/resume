export type IssueSeverity = 'high' | 'medium' | 'low';
export type { CompanyBatchEvent, CompanyBatchPreview, CompanyBatchState, CompanyEditDetail, CompanyEditInput, CompanyEditSearchResult } from './company-batch.js';
export type { CareerAttachment, CareerFileFormat } from './career-attachment.js';
export type { AdminOverview, AdminPage, AdminUser, AdminUserQuery, AdminTask, AdminTaskQuery, AdminUsageStatus, AdminOrder, AdminOrderQuery, AdminRefund, AdminRefundPreview, AdminPricePublication, AdminPricingState, AdminPricingPreview } from './admin.js';
export type { CareerAssistantInput, CareerAssistantResult } from './career-assistant.js';
export type { CompanySource, CompanyRecord, CompanyFilterKey, CompanyFilters, CompanySort, CompanySearchInput, CompanyMatchField, CompanySearchHit, CompanyFacet, CompanySearchResult, CompanyCatalogFile } from './company.js';
export type { ResumeExportTemplate } from './resume-layout.js';
export type ResumeExportFormat = 'docx' | 'pdf';
export type { ResumeVersionSource, ResumeVersionSummary, ResumeVersion, RestoreResumeInput, RestoreResumeResult } from './resume-history.js';
export interface ResumeExportInput {
  revision: number;
  format: ResumeExportFormat;
  template: import('./resume-layout.js').ResumeExportTemplate;
}
export interface ResumeExportFile extends ResumeExportInput {
  resumeId: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
}
export type { PlanId, PaidPlanId, Plan, MembershipPolicy, MembershipPreview, MembershipActive, MembershipState, CheckoutInput, MembershipPrices } from './membership.js';
export type { PaymentOrder, PaymentOrderStatus, PaymentChannel, WechatPaymentParams, NativePaymentParams, AlipayPaymentParams, CheckoutResult, MembershipQuote, WechatBindResult } from './payment.js';
export type { AiQuotaSummary } from './quota.js';
export type { WorkbenchAccess, WorkbenchFeature } from './workbench.js';
export type { ApplicationStatus, CareerJob, CareerMaterial, CareerRecruitmentPortal, CareerJobInput, ApplicationEvent, CareerApplication, ApplicationCreateInput, ApplicationUpdateInput, CareerWorkspace } from './career.js';
export type { CareerContentKind, CareerContentValue, CareerContentAction, CareerContentSummary, CareerContentHistory, CareerContentDetail, CareerContentDraft, SaveCareerContentDraft, ReviewCareerContent, CareerContentReview, ApplyCareerContent, CareerContentReceipt } from './career-content.js';
export type { AuthUser, AuthSession, AuthCapabilities, EmailPasswordInput, WechatLoginInput, PhoneLoginInput } from './auth.js';
export type { EmailCodePurpose, SendEmailCodeInput, EmailCodeChallenge, ResetPasswordInput, VerifyEmailInput } from './auth.js';
export type { PhoneCodePurpose, SendPhoneCodeInput, PhoneCodeChallenge, CurrentIdentityProof, BindPhoneInput, BindEmailInput } from './auth.js';
export type IssueCategory = 'impact' | 'structure' | 'keywords' | 'clarity';

export interface Resume {
  id: string;
  title: string;
  targetRole: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ResumeInput {
  title: string;
  targetRole: string;
  text: string;
}

export interface ResumeUpdateInput {
  title?: string;
  targetRole?: string;
  text?: string;
  /** Required optimistic concurrency guard. */
  revision: number;
}

export interface AnalysisDimension {
  key: 'impact' | 'structure' | 'relevance' | 'clarity';
  label: string;
  score: number;
  description: string;
}

export interface AnalysisIssue {
  id: string;
  title: string;
  severity: IssueSeverity;
  category: IssueCategory;
  description: string;
  evidence: string;
  suggestion: string;
  actionable: boolean;
}

export interface AnalysisSuggestion {
  id: string;
  title: string;
  original: string;
  replacement: string;
  reason: string;
  needsConfirmation: boolean;
  applied: boolean;
  appliedAt?: string;
  appliedRevision?: number;
}

export interface Analysis {
  id: string;
  resumeId: string;
  resumeRevision: number;
  inputHash: string;
  inputSnapshot: { text: string; targetRole: string; jobDescription: string };
  engine: 'rules' | 'bailian';
  /** AI annotations supplement deterministic rule scores and keyword coverage. */
  modelRun?: {
    model: string;
    promptVersion: string;
    workflowVersion: string;
    knowledgeScope: 'none';
    temperature: number;
    maxTokens: number;
    sentInputHash: string;
    privacyVersion: 'bailian-v1';
    consentAt: string;
  };
  score: number;
  summary: string;
  dimensions: AnalysisDimension[];
  issues: AnalysisIssue[];
  suggestions: AnalysisSuggestion[];
  keywords: { matched: string[]; missing: string[] };
  createdAt: string;
  status: 'completed';
}

export interface AnalysisInput {
  resumeId: string;
  /** Optional guard for the saved revision reviewed before starting diagnosis. */
  resumeRevision?: number;
  jobDescription?: string;
  targetRole?: string;
  /** Required for each real-model request; never grants access to other users. */
  aiConsent?: boolean;
  /** Reuse for a submission whose response is unknown; changed inputs require a new key. */
  idempotencyKey?: string;
}

export interface ApplySuggestionInput {
  /** Must be true when a replacement contains facts the user must supply. */
  confirmed?: boolean;
  /** User-reviewed replacement; factual placeholders must be resolved. */
  replacement?: string;
  /** Required optimistic concurrency guard; idempotent replays may carry the original value. */
  revision: number;
}

export interface ApplySuggestionResult {
  resume: Resume;
  analysis: Analysis;
  alreadyApplied: boolean;
}

export interface ApiResponse<T> { data: T }
export interface ApiErrorResponse { error: { code: string; message: string } }

export interface Health {
  status: 'ok';
  analysisEngine: 'rules' | 'bailian';
  aiConfigured: boolean;
  model?: string;
  persistence: 'local-json';
}

export interface AnalysisJob {
  id: string;
  resumeId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  analysisId?: string;
  error?: { code: string; message: string };
}
