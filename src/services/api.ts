import type { Analysis, AnalysisInput, AnalysisJob, Health, ApplySuggestionInput, ApplySuggestionResult, CareerAttachment, Resume, ResumeExportFile, ResumeExportInput, ResumeInput, ResumeUpdateInput, ResumeVersionSummary, ResumeVersion, RestoreResumeInput, RestoreResumeResult } from '../../shared/types';
import { careerFileTypes, isCareerAttachment } from '../../shared/career-attachment';

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

export async function openCareerMaterialFile(materialId: string, file: CareerAttachment): Promise<'download-started' | 'document-opened'> {
  if (!isCareerAttachment(file) || !/^[A-Za-z0-9_-]{1,100}$/.test(materialId)) throw new Error('资料文件无效，请刷新后重试。');
  const url = `${base}/api/v1/career/materials/${encodeURIComponent(materialId)}/file/${file.id}`;
  const revision = transportRevision;
  function check(status: number) {
    if (revision !== transportRevision) throw new Error('账号会话已变化，请重新打开资料。');
    if (status === 200) return;
    if (status === 401) {
      for (const listener of unauthorizedListeners) listener();
      throw new Error('登录已失效，请重新登录后打开资料。');
    }
    if (status === 403) throw new Error('资料文件需要有效高级会员权益，请刷新权限后重试。');
    if (status === 404) throw new Error('资料文件已更新或下架，请重新读取工作台。');
    throw new Error('资料文件暂时无法读取，请稍后重试。');
  }
  // #ifdef H5
  if (typeof window === 'undefined') throw new Error('请在浏览器中下载资料。');
  const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(30000) })
    .catch(() => { throw new Error('资料文件下载失败，请检查网络后重试。'); });
  check(response.status);
  if (response.headers.get('content-type')?.split(';')[0] !== careerFileTypes[file.format]) {
    throw new Error('资料响应格式有误，请刷新后重试。');
  }
  const blob = await response.blob().catch(() => { throw new Error('资料文件下载未完成，请稍后重试。'); });
  check(response.status);
  if (blob.size !== file.bytes) throw new Error('资料文件下载未完成，请稍后重试。');
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = file.fileName;
  document.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000); }
  return 'download-started';
  // #endif
  // #ifdef MP-WEIXIN
  if (!/^https:\/\//i.test(url)) throw new Error('微信版资料下载需要已配置的 HTTPS 接口，请使用网页端。');
  return new Promise((resolve, reject) => {
    uni.downloadFile({
      url, timeout: 30000, header: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      success(result) {
        try {
          check(result.statusCode);
          if (!result.tempFilePath) throw new Error('资料文件下载未完成，请稍后重试。');
          uni.openDocument({
            filePath: result.tempFilePath, fileType: file.format, showMenu: false,
            success: () => resolve('document-opened'), fail: () => reject(new Error('微信暂时无法打开资料文件，可通过网页端下载。')),
          });
        } catch (error) { reject(error); }
      },
      fail: () => reject(new Error('资料文件下载失败，请检查网络后重试。')),
    });
  });
  // #endif
  // #ifndef H5
  // #ifndef MP-WEIXIN
  throw new Error('当前平台无法打开资料文件。');
  // #endif
  // #endif
}

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
