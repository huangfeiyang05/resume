import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CareerJob, CareerMaterial, CareerRecruitmentPortal } from '../shared/types.js';
import { careerObject, validateCatalogJob, validateCatalogMaterial, validateRecruitmentPortal } from './career-validation.js';

export const bundledCareerCatalogPath = fileURLToPath(new URL('./assets/career/catalog.json', import.meta.url));

export interface CareerCatalog {
  state: 'empty' | 'ready' | 'unavailable';
  message: string;
  jobs: CareerJob[];
  materials: CareerMaterial[];
  portals: CareerRecruitmentPortal[];
}

/** Both curated build inputs and local overrides use the same runtime validation. */
export function validateCareerCatalog(value: unknown) {
  const input = careerObject(value, ['version', 'jobs', 'materials', 'portals']);
  if (![1, 2].includes(input.version as number) || !Array.isArray(input.jobs) || !Array.isArray(input.materials)
    || (input.version === 2 && !Array.isArray(input.portals)) || (input.version === 1 && input.portals !== undefined)) throw new Error('Invalid catalog.');
  const jobs = input.jobs.map(item => validateCatalogJob(item));
  const materials = input.materials.map(item => validateCatalogMaterial(item));
  const portals = ((input.portals ?? []) as unknown[]).map(item => validateRecruitmentPortal(item));
  if (jobs.length + materials.length + portals.length > 2000) throw new Error('Catalog too large.');
  for (const records of [jobs, materials, portals]) if (new Set(records.map(item => item.id)).size !== records.length) throw new Error('Duplicate catalog IDs.');
  return { version: input.version as 1 | 2, jobs, materials, portals };
}

/** A missing default local override may use bundled public content; invalid overrides never silently fall back. */
export async function loadCareerCatalog(path: string, fallbackPath?: string): Promise<CareerCatalog> {
  try {
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('Catalog too large.');
    const bytes = await readFile(path);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Catalog too large.');
    const { jobs, materials, portals } = validateCareerCatalog(JSON.parse(bytes.toString('utf8')));
    const ready = jobs.length + materials.length + portals.length > 0;
    return { state: ready ? 'ready' : 'empty', message: ready ? '复习提纲与招聘入口可按专业查阅。入口不代表当前在招，岗位要求与截止日期以官方公告为准。' : '岗位库与复习资料尚待补充，可先添加个人目标岗位。', jobs, materials, portals };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (fallbackPath) return loadCareerCatalog(fallbackPath);
      return { state: 'empty', message: '岗位库与复习资料尚待补充，可先添加个人目标岗位。', jobs: [], materials: [], portals: [] };
    }
    return { state: 'unavailable', message: '岗位资料暂时无法读取，请稍后重试。个人岗位与投递记录仍可使用。', jobs: [], materials: [], portals: [] };
  }
}
