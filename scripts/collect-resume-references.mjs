import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Downloads only the reviewed public assets in this catalogue. Never executes them.
// Raw documents may contain identifiers and must stay in the ignored .data tree.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(await readFile(path.join(root, 'docs/resume-library/sources.json'), 'utf8'));
const output = path.join(root, '.data/resume-reference-corpus');
const limit = 16 * 1024 * 1024;
const wanted = process.argv.slice(2);
if (wanted.some((id) => !catalogue.sources.some((source) => source.id === id))) {
  throw new Error('Unknown source ID; select reviewed IDs from sources.json.');
}
const sources = catalogue.sources.filter((source) => source.assetUrl && (!wanted.length || wanted.includes(source.id)));
for (const source of sources) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.id) || source.id.length > 120 || !Array.isArray(source.allowedHosts)) {
    throw new Error('Invalid reviewed source ID or host list.');
  }
}
await mkdir(path.join(output, 'raw'), { recursive: true, mode: 0o700 });
const expectedOutput = path.join(await realpath(root), '.data/resume-reference-corpus');
if (await realpath(output) !== expectedOutput || await realpath(path.join(output, 'raw')) !== path.join(expectedOutput, 'raw')) {
  throw new Error('Reference storage or an ancestor redirects outside the project.');
}
await chmod(output, 0o700);
await chmod(path.join(output, 'raw'), 0o700);

async function getPublicAsset(source, url) {
  const approvedHosts = new Set(source.allowedHosts);
  let current = new URL(url);
  const signal = AbortSignal.timeout(40_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (current.protocol !== 'https:' || current.username || current.password || !approvedHosts.has(current.hostname)) {
      throw new Error('URL or redirect is outside the reviewed HTTPS hosts.');
    }
    const response = await fetch(current, {
      redirect: 'manual', signal, credentials: 'omit',
      headers: { 'User-Agent': 'ResumeReferenceResearch/1.0 (local reference review)' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Redirect has no location.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}; no login or access-control bypass attempted.`);
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('Asset exceeds the 16 MiB limit.');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) {
        throw new Error('Asset exceeds the 16 MiB limit.');
      }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), finalUrl: current.href, contentType: response.headers.get('content-type') };
  }
  throw new Error('Too many redirects.');
}

function checkSignature(format, bytes) {
  if (!bytes.length) throw new Error('Empty response.');
  if (format === 'pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Expected PDF; received a different file or an access page.');
  if (['docx', 'zip'].includes(format) && bytes.subarray(0, 2).toString() !== 'PK') throw new Error('Expected ZIP container; received a different file or an access page.');
  if (format === 'tex' && !bytes.toString('utf8').includes('documentclass')) throw new Error('Expected LaTeX template source.');
  if (!['pdf', 'docx', 'zip', 'tex'].includes(format)) throw new Error('Only reviewed PDF, DOCX, ZIP and TEX assets can be downloaded.');
}

const manifestPath = path.join(output, 'manifest.local.json');
const results = new Map();
let lock;
try {
  lock = await open(path.join(output, '.fetch.lock'), 'wx');
} catch {
  throw new Error('A collector is running, or .fetch.lock remains after interruption. Check before removing it.');
}

try {
  // Read after locking so another collector cannot invalidate this snapshot.
  try {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const item of previous.assets ?? []) results.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const source of sources) {
    const record = {
      id: source.id, sourceUrl: source.assetUrl, checkedAt: new Date().toISOString(),
      rightsStatus: source.rightsStatus, aiPromptIngestionAllowed: false,
    };
    try {
      const asset = await getPublicAsset(source, source.assetUrl);
      checkSignature(source.format, asset.bytes);
      const sha256 = createHash('sha256').update(asset.bytes).digest('hex');
      const name = `${source.id}-${sha256.slice(0, 12)}.${source.format}`;
      const rawPath = path.join(output, 'raw', name);
      if (path.dirname(rawPath) !== path.join(output, 'raw')) throw new Error('Asset path escaped the raw directory.');
      await writeFile(rawPath, asset.bytes, { mode: 0o600 });
      Object.assign(record, {
        status: 'downloaded', finalUrl: asset.finalUrl, contentType: asset.contentType,
        bytes: asset.bytes.length, sha256, rawPath: path.relative(root, rawPath),
      });
      if (source.licenseUrl) {
        const licence = await getPublicAsset(source, source.licenseUrl);
        if (!licence.bytes.toString('utf8').includes('MIT License')) throw new Error('Expected MIT license text was not found.');
        const licensePath = path.join(output, 'raw', `${source.id}.LICENSE.txt`);
        await writeFile(licensePath, licence.bytes, { mode: 0o600 });
        record.licensePath = path.relative(root, licensePath);
      }
      console.log(`${source.id}: downloaded (${asset.bytes.length} bytes)`);
    } catch (error) {
      const previous = results.get(source.id);
      Object.assign(record, { status: 'failed', error: error.message });
      const lastGood = previous?.status === 'downloaded' ? previous : previous?.previousSuccessfulSnapshot;
      if (lastGood) record.previousSuccessfulSnapshot = lastGood;
      console.log(`${source.id}: failed (${error.message})`);
    }
    results.set(source.id, record);
  }
  const manifest = {
    schemaVersion: 1, collectedFor: 'local-reference-review-only',
    generatedAt: new Date().toISOString(),
    note: 'Downloads are not commercial reuse, personal-data reuse or model-training permission. This collector does not call any model.',
    assets: [...results.values()],
  };
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(`${manifestPath}.tmp`, manifestPath);
  const selectedResults = sources.map((source) => results.get(source.id));
  console.log(`Selected ${selectedResults.length}; downloaded ${selectedResults.filter((x) => x.status === 'downloaded').length}; failed ${selectedResults.filter((x) => x.status === 'failed').length}.`);
  if (selectedResults.some((x) => x.status === 'failed')) process.exitCode = 1;
} finally {
  await lock.close();
  await rm(path.join(output, '.fetch.lock'));
}
