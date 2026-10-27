import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export const defaultModel = 'qwen-plus-2025-12-01';
export interface ModelConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
}
/** Server-only: neither YAML nor environment secrets are imported by Vite. */
export async function loadModelConfig(path = 'config/application-local.yaml', env = process.env): Promise<ModelConfig> {
  let source: Record<string, unknown> = {};
  try {
    const parsed = parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    source = parsed.bailian ?? {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('百炼配置文件格式无效，请检查本机 YAML（不输出文件内容）。');
  }
  const flag = env.BAILIAN_ENABLED ?? source.enabled ?? false;
  if (![true, false, 'true', 'false'].includes(flag as boolean | string)) throw new Error('BAILIAN_ENABLED 必须是 true 或 false。');
  const enabled = flag === true || flag === 'true';
  const apiKey = env.DASHSCOPE_API_KEY ?? source['api-key'] ?? '';
  const baseUrl = env.DASHSCOPE_BASE_URL ?? source['base-url'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = env.DASHSCOPE_MODEL ?? source.model ?? defaultModel;
  if (typeof apiKey !== 'string' || typeof baseUrl !== 'string' || typeof model !== 'string') throw new Error('百炼配置字段必须是文本。');
  if (enabled && (!/^sk-[A-Za-z0-9_-]+$/.test(apiKey) || !/^[A-Za-z0-9._-]{1,100}$/.test(model))) throw new Error('启用百炼需要有效的 API Key 和模型名称。');
  // Never send credentials to arbitrary endpoints or follow redirects.
  if (!/^https:\/\/(?:dashscope\.aliyuncs\.com|[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com)\/compatible-mode\/v1\/?$/.test(baseUrl)) throw new Error('百炼 Base URL 必须是北京地域的官方 HTTPS 接口。');
  return { enabled, apiKey, baseUrl: baseUrl.replace(/\/$/, ''), model };
}
