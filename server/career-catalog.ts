import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CareerJob, CareerMaterial, CareerRecruitmentPortal } from '../shared/types.js';
import { careerObject, validateCatalogJob, validateCatalogMaterial, validateRecruitmentPortal } from './career-validation.js';
import { projectCareerContent, type CareerAttachmentIndex, type StoredCareerContent } from './career-content-storage.js';

export const bundledCareerCatalogPath = fileURLToPath(new URL('./assets/career/catalog.json', import.meta.url));
const catalogMaxBytes = 2 * 1024 * 1024;
const catalogMaxItems = 2000;

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
  if (jobs.length + materials.length + portals.length > catalogMaxItems) throw new Error('Catalog too large.');
  for (const records of [jobs, materials, portals]) if (new Set(records.map(item => item.id)).size !== records.length) throw new Error('Duplicate catalog IDs.');
  return { version: input.version as 1 | 2, jobs, materials, portals };
}

function catalogView({ jobs, materials, portals }: Pick<CareerCatalog, 'jobs' | 'materials' | 'portals'>): CareerCatalog {
  const ready = jobs.length + materials.length + portals.length > 0;
  return { state: ready ? 'ready' : 'empty', message: ready ? '复习提纲与招聘入口可按专业查阅。入口不代表当前在招，岗位要求与截止日期以官方公告为准。' : '岗位库与复习资料尚待补充，可先添加个人目标岗位。', jobs, materials, portals };
}

export function careerCatalogFits({ jobs, materials, portals }: CareerCatalog) {
  return jobs.length + materials.length + portals.length <= catalogMaxItems
    && Buffer.byteLength(JSON.stringify({ version: 2, jobs, materials, portals })) <= catalogMaxBytes;
}

export function publishedCareerCatalog(base: CareerCatalog, entries: StoredCareerContent[], attachments: CareerAttachmentIndex = {}): CareerCatalog {
  if (base.state === 'unavailable' || !entries.length) return base;
  const materials = new Map(base.materials.map(item => [item.id, item]));
  const portals = new Map(base.portals.map(item => [item.id, item]));
  for (const entry of entries) {
    const { published } = projectCareerContent(entry, attachments);
    if (published === undefined) continue;
    if (entry.kind === 'material') {
      if (published && 'title' in published) materials.set(entry.id, published);
      else materials.delete(entry.id);
    } else {
      if (published && 'organization' in published) portals.set(entry.id, published);
      else portals.delete(entry.id);
    }
  }
  return catalogView({ jobs: base.jobs, materials: [...materials.values()], portals: [...portals.values()] });
}

export function careerCatalogLocation(databasePath: string, customPath?: string) {
  return { path: customPath ?? join(dirname(databasePath), 'career-catalog.json'),
    fallback: customPath === undefined ? bundledCareerCatalogPath : undefined };
}

/** A missing default local override may use bundled public content; invalid overrides never silently fall back. */
export async function loadCareerCatalog(path: string, fallbackPath?: string): Promise<CareerCatalog> {
  try {
    if ((await stat(path)).size > catalogMaxBytes) throw new Error('Catalog too large.');
    const bytes = await readFile(path);
    if (bytes.length > catalogMaxBytes) throw new Error('Catalog too large.');
    return catalogView(validateCareerCatalog(JSON.parse(bytes.toString('utf8'))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (fallbackPath) return loadCareerCatalog(fallbackPath);
      return { state: 'empty', message: '岗位库与复习资料尚待补充，可先添加个人目标岗位。', jobs: [], materials: [], portals: [] };
    }
    return { state: 'unavailable', message: '岗位资料暂时无法读取，请稍后重试。个人岗位与投递记录仍可使用。', jobs: [], materials: [], portals: [] };
  }
}
