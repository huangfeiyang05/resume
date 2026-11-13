import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCareerCatalog } from '../server/career-catalog.js';
import type { CareerMaterial } from '../shared/types.js';

// Offline, deterministic compilation of reviewed public/original content. Never read private .data/.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'docs/career-library');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;
const playbooks = await readJson(resolve(root, 'docs/resume-library/playbooks.json')) as {
  schemaVersion: number; tracks: Array<{ id: string; name: string; roles: string[]; sectionOrder: string[]; focusQuestions: string[]; evidenceFields: string[]; redFlags: string[] }>;
};
if (playbooks.schemaVersion !== 1 || !Array.isArray(playbooks.tracks)) throw new Error('Invalid original resume playbooks.');
const inputs = await Promise.all(['tech-materials.json', 'general-materials.json', 'tech-portals.json', 'general-portals.json', 'jobs.json'].map(file => readJson(resolve(directory, file))));
if (inputs.some(value => !Array.isArray(value))) throw new Error('Career library source must contain arrays.');
const [techMaterials, generalMaterials, techPortals, generalPortals, jobs] = inputs as unknown[][];
const resumeMaterials: CareerMaterial[] = playbooks.tracks.map(track => ({
  id: `resume-guide-${track.id}`, title: `${track.name}：应届生简历准备清单`, major: track.name,
  role: track.roles.join('、'), summary: '从真实课程、项目、实习与作品中整理可核对的证据，缺少的事实先补充，再改写。',
  content: [
    '本项目原创整理，面向应届生。以下内容是准备与审核清单，不是已完成简历，也不证明你已具备相应经历或能力。',
    `一、整理栏目\n可按岗位需要调整：${track.sectionOrder.join(' → ')}。没有发生的经历或没有取得的资质直接省略，不为凑齐栏目补写。`,
    `二、先回答真实问题\n${track.focusQuestions.map(question => `• ${question}`).join('\n')}`,
    `三、准备可核对的证据\n${track.evidenceFields.map(field => `• ${field}：只填本人真实参与、可解释且获准披露的内容。`).join('\n')}`,
    `四、提交前逐项检查\n${track.redFlags.map(flag => `• 避免${flag}。`).join('\n')}\n区分本人贡献与团队结果；时间、单位、学校、数字和技能须逐项核对。没有量化依据时可以描述真实交付物与核验方法。`,
    '五、实践任务\n选一段真实课程、项目或实习经历，用“实际问题—本人行动—真实交付—核验依据”写成短段落。每句话都应能解释来源；缺失信息先提问，确认后再应用到简历。关键词只用于检查文本覆盖，不代表能力或录用结果。',
  ].join('\n\n'), sourceLabel: '简历有方原创专业提示卡（本次整理）', updatedAt: '2026-10-27T00:00:00+08:00',
}));
const catalog = validateCareerCatalog({ version: 2, jobs, materials: [...resumeMaterials, ...techMaterials, ...generalMaterials], portals: [...techPortals, ...generalPortals] });
for (const job of catalog.jobs) {
  if (!job.sourceUrl?.startsWith('https://') || !playbooks.tracks.some(track => track.name === job.major)) {
    throw new Error(`Job requires an HTTPS source and an existing major: ${job.id}`);
  }
}
for (const track of playbooks.tracks) {
  if (!catalog.materials.some(item => item.major === track.name && !item.id.startsWith('resume-guide-'))) throw new Error(`Missing preparation material: ${track.name}`);
}
for (const material of catalog.materials) {
  if (!playbooks.tracks.some(track => track.name === material.major)) throw new Error(`Unknown material major: ${material.id}`);
  if (!material.id.startsWith('resume-guide-') && (!material.sourceUrl?.startsWith('https://') || material.content.length < 250)) throw new Error(`Preparation material lacks source or substance: ${material.id}`);
}
for (const portal of catalog.portals) {
  if (portal.majors.some(major => !playbooks.tracks.some(track => track.name === major))) throw new Error(`Unknown recruitment portal major: ${portal.id}`);
}
const output = `${JSON.stringify(catalog, null, 2)}\n`;
const destination = resolve(root, 'server/assets/career/catalog.json');
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw new Error('Bundled career library is stale. Run npm run career:build.');
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output);
}
console.log(`Career library ${process.argv.includes('--check') ? 'verified' : 'built'}: ${playbooks.tracks.length} majors, ${catalog.materials.length} materials, ${catalog.portals.length} official entry points, ${catalog.jobs.length} sourced job records.`);
