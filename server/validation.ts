import type { AnalysisInput, ApplySuggestionInput, ResumeInput, ResumeUpdateInput, RestoreResumeInput } from '../shared/types.js';
import { inputLimits } from '../shared/limits.js';
import { invalid } from './errors.js';

export const limits = inputLimits;

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求体必须是 JSON 对象。');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) invalid('请求体含不支持的字段。');
  return record;
}

function string(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须是文本。`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!allowEmpty && !normalized) invalid(`${label}不能为空。`);
  if (normalized.length > max) invalid(`${label}不能超过 ${max} 个字符。`);
  if (normalized.includes('\0')) invalid(`${label}不能包含空字符。`);
  return normalized;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('revision 必须是正整数。');
  return value as number;
}

export function validateResumeInput(value: unknown): ResumeInput {
  const input = object(value, ['title', 'targetRole', 'text']);
  return {
    title: string(input.title, '简历名称', limits.title),
    targetRole: string(input.targetRole ?? '', '目标岗位', limits.targetRole, true),
    text: string(input.text, '简历正文', limits.resumeText),
  };
}

export function validateResumeUpdate(value: unknown): ResumeUpdateInput {
  const input = object(value, ['title', 'targetRole', 'text', 'revision']);
  if (!['title', 'targetRole', 'text'].some((key) => Object.hasOwn(input, key))) invalid('至少提供一个要修改的简历字段。');
  return {
    ...(Object.hasOwn(input, 'title') ? { title: string(input.title, '简历名称', limits.title) } : {}),
    ...(Object.hasOwn(input, 'targetRole') ? { targetRole: string(input.targetRole, '目标岗位', limits.targetRole, true) } : {}),
    ...(Object.hasOwn(input, 'text') ? { text: string(input.text, '简历正文', limits.resumeText) } : {}),
    revision: revision(input.revision),
  };
}

export function validateAnalysisInput(value: unknown): AnalysisInput {
  const input = object(value, ['resumeId', 'resumeRevision', 'jobDescription', 'targetRole', 'aiConsent', 'idempotencyKey']);
  if (Object.hasOwn(input, 'aiConsent') && typeof input.aiConsent !== 'boolean') invalid('aiConsent 必须是布尔值。');
  if (Object.hasOwn(input, 'idempotencyKey') && (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey))) invalid('idempotencyKey 必须是 8 至 100 位字母、数字、下划线或短横线。');
  return {
    resumeId: string(input.resumeId, '简历 ID', 80),
    ...(Object.hasOwn(input, 'resumeRevision') ? { resumeRevision: revision(input.resumeRevision) } : {}),
    ...(Object.hasOwn(input, 'aiConsent') ? { aiConsent: input.aiConsent as boolean } : {}),
    ...(Object.hasOwn(input, 'idempotencyKey') ? { idempotencyKey: input.idempotencyKey as string } : {}),
    ...(Object.hasOwn(input, 'jobDescription') ? { jobDescription: string(input.jobDescription, '岗位描述', limits.jobDescription, true) } : {}),
    ...(Object.hasOwn(input, 'targetRole') ? { targetRole: string(input.targetRole, '目标岗位', limits.targetRole, true) } : {}),
  };
}

export function validateApplyInput(value: unknown): ApplySuggestionInput {
  const input = object(value, ['confirmed', 'replacement', 'revision']);
  if (Object.hasOwn(input, 'confirmed') && typeof input.confirmed !== 'boolean') invalid('confirmed 必须是布尔值。');
  return {
    ...(Object.hasOwn(input, 'confirmed') ? { confirmed: input.confirmed as boolean } : {}),
    ...(Object.hasOwn(input, 'replacement') ? { replacement: string(input.replacement, '修改后文本', limits.replacement) } : {}),
    revision: revision(input.revision),
  };
}

export function validateRestoreInput(value: unknown): RestoreResumeInput {
  const input = object(value, ['revision', 'confirmed', 'idempotencyKey']);
  if (typeof input.confirmed !== 'boolean') invalid('confirmed 必须是布尔值。');
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) invalid('idempotencyKey 必须是 8 至 100 位字母、数字、下划线或短横线。');
  return { revision: revision(input.revision), confirmed: input.confirmed as boolean, idempotencyKey: input.idempotencyKey as string };
}

export function validateVersionRevision(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) invalid('历史修订号必须是正整数。');
  return revision(Number(value));
}
