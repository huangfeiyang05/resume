import type { Analysis, AnalysisInput, AnalysisJob, Health, ApplySuggestionInput, ApplySuggestionResult, Resume, ResumeExportFile, ResumeExportInput, ResumeInput, ResumeUpdateInput, ResumeVersionSummary, ResumeVersion, RestoreResumeInput, RestoreResumeResult } from '../../shared/types';

const base = import.meta.env?.VITE_API_BASE_URL || '';
export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export function isMiniProgramClient() {
  let nativeClient = false;
  // #ifdef MP-WEIXIN
  nativeClient = typeof (globalThis as { wx?: unknown }).wx !== 'undefined';
  // #endif
  return nativeClient;
}
let authToken = '';
let transportRevision = 0;
const unauthorizedListeners = new Set<() => void>();
export function setAuthToken(token: string) { authToken = token; ++transportRevision; }
export function onUnauthorized(listener: () => void) { unauthorizedListeners.add(listener); return () => unauthorizedListeners.delete(listener); }

export function request<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', data?: unknown, options: { notifyUnauthorized?: boolean } = {}): Promise<T> {
  const revision = transportRevision;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isMiniProgramClient()) {
    headers['X-Auth-Client'] = 'mp-weixin';
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
  }
  return new Promise((resolve, reject) => {
    uni.request({
      url: `${base}/api/v1${path}`, method, data: data as object,
      header: headers, timeout: 30000,
      // #ifdef H5
      withCredentials: true,
      // #endif
      success(response) {
        const body = response.data as { data?: T; error?: { message: string; code: string } };
        if (response.statusCode >= 200 && response.statusCode < 300 && body && typeof body === 'object' && 'data' in body) resolve(body.data as T);
        else {
          if (response.statusCode === 401 && options.notifyUnauthorized !== false && revision === transportRevision) {
            for (const listener of unauthorizedListeners) listener();
          }
          reject(new ApiError(body?.error?.message || '服务暂时不可用，请稍后重试。', body?.error?.code || 'SERVER_ERROR', response.statusCode));
        }
      },
      fail: () => reject(new ApiError('暂时无法连接服务，请检查网络或稍后重试。', 'NETWORK_ERROR', 0)),
    });
  });
}
export const api = {
  health: () => request<Health>('/health'),
  startAnalysis: (data: AnalysisInput) => request<AnalysisJob>('/analysis-jobs', 'POST', data),
  job: (id: string) => request<AnalysisJob>(`/analysis-jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => request<AnalysisJob>(`/analysis-jobs/${encodeURIComponent(id)}`, 'DELETE'),
  analysis: (id: string) => request<Analysis>(`/analyses/${encodeURIComponent(id)}`),
  resumes: () => request<Resume[]>('/resumes'),
  resume: (id: string) => request<Resume>(`/resumes/${encodeURIComponent(id)}`),
  versions: (id: string) => request<ResumeVersionSummary[]>(`/resumes/${encodeURIComponent(id)}/versions`),
  version: (id: string, revision: number) => request<ResumeVersion>(`/resumes/${encodeURIComponent(id)}/versions/${revision}`),
  restoreVersion: (id: string, sourceRevision: number, data: RestoreResumeInput) => request<RestoreResumeResult>(`/resumes/${encodeURIComponent(id)}/versions/${sourceRevision}/restore`, 'POST', data),
  createResume: (data: ResumeInput) => request<Resume>('/resumes', 'POST', data),
  updateResume: (id: string, data: ResumeUpdateInput) => request<Resume>(`/resumes/${encodeURIComponent(id)}`, 'PUT', data),
  deleteResume: (id: string) => request<{ id: string }>(`/resumes/${encodeURIComponent(id)}`, 'DELETE'),
  exportResume: (id: string, data: ResumeExportInput) => request<ResumeExportFile>(`/resumes/${encodeURIComponent(id)}/export`, 'POST', data),
  analyze: (data: AnalysisInput) => request<Analysis>('/analyses', 'POST', data),
  analyses: (id: string) => request<Analysis[]>(`/resumes/${encodeURIComponent(id)}/analyses`),
  apply: (analysisId: string, suggestionId: string, data: ApplySuggestionInput) => request<ApplySuggestionResult>(`/analyses/${encodeURIComponent(analysisId)}/suggestions/${encodeURIComponent(suggestionId)}/apply`, 'POST', data),
};
