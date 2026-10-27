import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Purely offline: inspect the catalogue and local snapshots; never fetch or edit them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const library = path.join(root, 'docs/resume-library');
const rawRoot = path.join(root, '.data/resume-reference-corpus/raw');
const issues = [];
const counts = { tracks: 0, sources: 0, templates: 0, downloaded: 0, failed: 0, previousSnapshots: 0 };
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const formats = new Set(['pdf', 'html', 'docx', 'tex', 'zip', 'md', 'txt']);
const rightsStatuses = new Set(['reference_only_unverified_license', 'licensed_code_only']);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function check(condition, label, message) { if (!condition) issues.push(`${label}: ${message}`); }
function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function json(file, optional = false) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    issues.push(`${path.relative(root, file)}: ${error.message}`);
    return undefined;
  }
}
function https(value, label, hosts) {
  try {
    const url = new URL(value);
    check(url.protocol === 'https:' && !url.username && !url.password, label, 'must be HTTPS without URL credentials');
    if (hosts) check(hosts.has(url.hostname), label, 'hostname is missing from allowedHosts');
    return url;
  } catch { issues.push(`${label}: must be an absolute HTTPS URL`); }
}
function stringArray(value, label, minimum = 1) {
  check(Array.isArray(value) && value.length >= minimum && value.every(nonempty), label, `must contain at least ${minimum} nonempty strings`);
  if (!Array.isArray(value)) return [];
  check(new Set(value).size === value.length, label, 'duplicate entries');
  return value;
}
function checkUnverifiedPermissions(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkUnverifiedPermissions(entry, `${label}[${index}]`));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === true && /(?:allowed|permission|reuse|redistribut|ingestion|training)/i.test(key)) {
      issues.push(`${label}.${key}: unverified rights cannot grant reuse, AI or redistribution permission`);
    }
    if (plainObject(entry) || Array.isArray(entry)) checkUnverifiedPermissions(entry, `${label}.${key}`);
  }
}

const catalogue = await json(path.join(library, 'sources.json'));
const playbooks = await json(path.join(library, 'playbooks.json'));
if (catalogue) {
  check(catalogue.schemaVersion === 1, 'sources', 'unsupported schemaVersion');
  check(/^\d{4}-\d{2}-\d{2}$/.test(catalogue.collectedOn ?? ''), 'sources.collectedOn', 'must be an ISO date');
  check(Array.isArray(catalogue.sources), 'sources', 'sources must be an array');
}
if (playbooks) {
  check(playbooks.schemaVersion === 1, 'playbooks', 'unsupported schemaVersion');
  check(Array.isArray(playbooks.tracks), 'playbooks', 'tracks must be an array');
}
const sources = Array.isArray(catalogue?.sources) ? catalogue.sources : [];
const tracks = Array.isArray(playbooks?.tracks) ? playbooks.tracks : [];
counts.sources = sources.length;
counts.tracks = tracks.length;
check(sources.length > 0, 'sources', 'catalogue is empty');
check(tracks.length === 16, 'playbooks', 'expected 16 tracks');
const trackIds = new Set();
for (const [index, track] of tracks.entries()) {
  if (!plainObject(track)) { issues.push(`tracks[${index}]: must be an object`); continue; }
  check(nonempty(track.id) && idPattern.test(track.id) && track.id.length <= 120, `tracks[${index}].id`, 'invalid ID');
  check(!trackIds.has(track.id), `tracks[${index}].id`, 'duplicate ID');
  trackIds.add(track.id);
}
const sourceById = new Map();
for (const [index, source] of sources.entries()) {
  if (!plainObject(source)) { issues.push(`sources[${index}]: must be an object`); continue; }
  const label = `sources[${index}] (${source.id ?? 'missing ID'})`;
  check(nonempty(source.id) && idPattern.test(source.id) && source.id.length <= 120, `${label}.id`, 'invalid ID');
  check(!sourceById.has(source.id), `${label}.id`, 'duplicate ID');
  sourceById.set(source.id, source);
  for (const field of ['title', 'publisher', 'language', 'verification', 'rightsNote', 'qualityCaveat']) {
    check(nonempty(source[field]), `${label}.${field}`, 'must be a nonempty string');
  }
  check(formats.has(source.format), `${label}.format`, 'unsupported format');
  check(['sample', 'template', 'guide', 'sample_collection', 'layout_code'].includes(source.kind), `${label}.kind`, 'unsupported kind');
  check(/^\d{4}-\d{2}-\d{2}$/.test(source.verifiedDate ?? ''), `${label}.verifiedDate`, 'must be an ISO date');
  const hosts = new Set(stringArray(source.allowedHosts, `${label}.allowedHosts`));
  for (const host of hosts) {
    check(typeof host === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host) && host === host.toLowerCase(), `${label}.allowedHosts`, 'hosts must be literal lowercase DNS names');
  }
  https(source.landingUrl, `${label}.landingUrl`, hosts);
  if (source.assetUrl !== null) https(source.assetUrl, `${label}.assetUrl`, hosts);
  if (source.licenseUrl !== undefined && source.licenseUrl !== null) https(source.licenseUrl, `${label}.licenseUrl`, hosts);
  const disciplines = stringArray(source.disciplines, `${label}.disciplines`);
  for (const id of disciplines) check(trackIds.has(id), `${label}.disciplines`, `unknown track ${id}`);
  const takeaways = stringArray(source.takeaways, `${label}.takeaways`, 2);
  check(takeaways.length <= 3, `${label}.takeaways`, 'expected 2–3 original summaries');
  check(rightsStatuses.has(source.rightsStatus), `${label}.rightsStatus`, 'unsupported rights status');
  check(source.aiPromptIngestionAllowed === false, label, 'external sources must explicitly disallow AI prompt ingestion');
  check(source.productRedistributionAllowed === false, label, 'product redistribution must be explicitly disabled');
  if (source.rightsStatus === 'reference_only_unverified_license') checkUnverifiedPermissions(source, label);
  if (source.rightsStatus === 'licensed_code_only') {
    check(source.codeReuseAllowed === true, label, 'licensed code must explicitly allow code reuse');
    check(nonempty(source.licenseUrl), label, 'licensed code requires licenseUrl');
    check(source.personalContentReuseAllowed === false, label, 'code licensing does not license personal content');
  }
}

for (const track of tracks.filter(plainObject)) {
  const label = `track ${track.id}`;
  const questions = stringArray(track.focusQuestions, `${label}.focusQuestions`, 3);
  check(questions.length === 3, label, 'expected exactly 3 focus questions');
  stringArray(track.evidenceFields, `${label}.evidenceFields`);
  stringArray(track.redFlags, `${label}.redFlags`);
  check(nonempty(track.bulletSkeleton) && /\[[^\]\r\n]+\]/.test(track.bulletSkeleton), label, 'bulletSkeleton requires a nonempty [placeholder]');
  for (const id of stringArray(track.sourceIds, `${label}.sourceIds`)) {
    const source = sourceById.get(id);
    check(Boolean(source), label, `unknown source ${id}`);
    if (source) check(Array.isArray(source.disciplines) && source.disciplines.includes(track.id), label, `source ${id} does not match this discipline`);
  }
  if (!nonempty(track.id) || !idPattern.test(track.id)) continue;
  try {
    const template = await readFile(path.join(library, 'templates', `${track.id}.md`), 'utf8');
    counts.templates++;
    check(/待确认|尚未确认|请先确认|核实|确认/.test(template), label, 'template needs a confirmation notice');
    check(/真实事实|真实信息|真实经历|真实资料|事实/.test(template), label, 'template needs a factual authenticity notice');
    check(/\[[^\]\r\n]+\]/.test(template), label, 'template needs factual placeholders');
  } catch (error) { issues.push(`${label}: missing or unreadable template (${error.message})`); }
}
try {
  const names = (await readdir(path.join(library, 'templates'))).filter((name) => name.endsWith('.md'));
  check(names.length === 16, 'templates', 'expected exactly 16 Markdown templates');
  for (const name of names) check(trackIds.has(name.slice(0, -3)), 'templates', `unexpected template ${name}`);
} catch (error) { issues.push(`templates: ${error.message}`); }
try {
  const rules = (await readFile(path.join(root, '.gitignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim());
  const dataRule = rules.findIndex((line) => /^(?:\/)?\.data\/$/.test(line));
  check(dataRule >= 0, '.gitignore', 'must ignore .data/');
  check(!rules.slice(dataRule + 1).some((line) => /^!\/?\.data(?:\/|$)/.test(line)), '.gitignore', 'a later rule reopens the .data/ directory');
} catch (error) { issues.push(`.gitignore: ${error.message}`); }

async function rawFile(value, label) {
  if (!nonempty(value)) { issues.push(`${label}: missing local path`); return; }
  const absolute = path.resolve(root, value);
  if (!within(rawRoot, absolute)) { issues.push(`${label}: path must stay inside .data/resume-reference-corpus/raw/`); return; }
  try {
    const canonicalRoot = await realpath(rawRoot);
    const canonicalProject = await realpath(root);
    if (canonicalRoot !== path.join(canonicalProject, '.data/resume-reference-corpus/raw')) {
      issues.push(`${label}: raw directory or an ancestor is redirected by a symlink`); return;
    }
    const canonical = await realpath(absolute);
    if (!within(canonicalRoot, canonical)) { issues.push(`${label}: symlink escapes the raw directory`); return; }
    const stat = await lstat(canonical);
    if (!stat.isFile() || stat.size === 0 || stat.size > 16 * 1024 * 1024) {
      issues.push(`${label}: must be a nonempty regular file no larger than 16 MiB`); return;
    }
    return await readFile(canonical);
  } catch (error) { issues.push(`${label}: ${error.message}`); }
}
async function snapshot(item, label, previous = false) {
  if (!plainObject(item)) { issues.push(`${label}: must be an object`); return; }
  const source = sourceById.get(item.id);
  check(Boolean(source), label, `unknown source ${item.id}`);
  check(item.aiPromptIngestionAllowed === false, label, 'snapshot must explicitly disable AI prompt ingestion');
  check(item.productRedistributionAllowed !== true, label, 'snapshot cannot grant product redistribution');
  if (source) check(item.rightsStatus === source.rightsStatus, label, 'snapshot rights status differs from source');
  if (source?.rightsStatus === 'reference_only_unverified_license') checkUnverifiedPermissions(item, label);
  check(['downloaded', 'failed'].includes(item.status), label, 'unsupported download status');
  if (nonempty(item.sourceUrl)) https(item.sourceUrl, `${label}.sourceUrl`);
  else issues.push(`${label}: missing sourceUrl`);
  if (!previous && source) check(item.sourceUrl === source.assetUrl, label, 'snapshot URL differs from reviewed assetUrl');
  if (item.finalUrl && source) https(item.finalUrl, `${label}.finalUrl`, new Set(Array.isArray(source.allowedHosts) ? source.allowedHosts : []));
  if (item.status === 'failed') {
    if (!previous) counts.failed++;
    check(nonempty(item.error), label, 'failed download requires an error explanation');
  }
  if (item.status === 'downloaded' || item.rawPath !== undefined) {
    const bytes = await rawFile(item.rawPath, `${label}.rawPath`);
    check(Number.isSafeInteger(item.bytes) && item.bytes > 0, label, 'invalid byte count');
    check(typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256), label, 'invalid SHA-256');
    if (bytes) {
      check(bytes.length === item.bytes, label, 'byte count does not match local file');
      check(createHash('sha256').update(bytes).digest('hex') === item.sha256, label, 'SHA-256 does not match local file');
      if (source?.format === 'pdf') check(bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')), label, 'missing PDF magic signature');
      if (['docx', 'zip'].includes(source?.format)) check(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), label, 'missing ZIP/DOCX magic signature');
      if (source?.format === 'docx') check(bytes.includes(Buffer.from('[Content_Types].xml')) && bytes.includes(Buffer.from('word/document.xml')), label, 'ZIP container lacks required DOCX entries');
      if (source?.format === 'tex') check(bytes.toString('utf8').includes('\\documentclass'), label, 'missing LaTeX documentclass');
    }
    if (item.status === 'downloaded' && source?.licenseUrl) await rawFile(item.licensePath, `${label}.licensePath`);
    if (item.status === 'downloaded') {
      if (previous) counts.previousSnapshots++;
      else counts.downloaded++;
    }
  }
  if (item.previousSuccessfulSnapshot !== undefined) {
    check(!previous, label, 'nested previous snapshots are not supported');
    check(item.status === 'failed', label, 'only failed current records may retain a previous snapshot');
    check(item.previousSuccessfulSnapshot?.id === item.id && item.previousSuccessfulSnapshot?.status === 'downloaded', label, 'previous snapshot must be a successful record for the same source');
    if (!previous) await snapshot(item.previousSuccessfulSnapshot, `${label}.previousSuccessfulSnapshot`, true);
  }
}
const manifest = await json(path.join(root, '.data/resume-reference-corpus/manifest.local.json'), true);
if (manifest !== undefined && !plainObject(manifest)) issues.push('manifest: must be an object');
if (plainObject(manifest)) {
  check(manifest.schemaVersion === 1, 'manifest', 'unsupported schemaVersion');
  check(Array.isArray(manifest.assets), 'manifest', 'assets must be an array');
  const seen = new Set();
  for (const [index, item] of (Array.isArray(manifest.assets) ? manifest.assets : []).entries()) {
    check(!seen.has(item?.id), `manifest.assets[${index}]`, 'duplicate source ID');
    seen.add(item?.id);
    await snapshot(item, `manifest.assets[${index}]`);
  }
}
console.log(`Resume library: ${counts.tracks} tracks; ${counts.sources} sources; ${counts.templates} templates.`);
console.log(`Local downloads: ${counts.downloaded} current downloaded records; ${counts.failed} failed records; ${counts.previousSnapshots} previous snapshots. Manifest ${manifest === undefined ? 'absent (optional)' : 'present'}.`);
if (counts.failed) console.log('Failed records are reported as failures and are not counted as current successful downloads.');
if (issues.length) {
  for (const issue of issues) console.error(`ERROR ${issue}`);
  console.error(`Offline checks failed: ${issues.length} error(s).`);
  process.exitCode = 1;
} else {
  console.log('Offline checks passed. Source availability, reuse licences and recruitment outcomes were not evaluated.');
}
