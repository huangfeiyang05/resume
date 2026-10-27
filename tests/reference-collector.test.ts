import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const collector = fileURLToPath(new URL('../scripts/collect-resume-references.mjs', import.meta.url));
const pdf = Buffer.from('%PDF-1.4\n% Synthetic collector fixture only\n%%EOF\n');
const fixtureSource = {
  id: 'fixture-sample',
  assetUrl: 'https://example.org/sample.pdf',
  format: 'pdf',
  allowedHosts: ['example.org'],
  rightsStatus: 'reference_only_unverified_license',
};

async function makeFixture(t: TestContext, overrides: Partial<typeof fixtureSource> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'resume-reference-collector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'docs/resume-library'), { recursive: true });
  await copyFile(collector, path.join(root, 'scripts/collect-resume-references.mjs'));
  await writeFile(path.join(root, 'docs/resume-library/sources.json'), JSON.stringify({
    sources: [{ ...fixtureSource, ...overrides }],
  }));
  const logPath = path.join(root, 'fetch.log');
  const stubPath = path.join(root, 'stub.mjs');
  await writeFile(stubPath, `
import { appendFile } from 'node:fs/promises';
globalThis.fetch = async (input) => {
  await appendFile(${JSON.stringify(logPath)}, String(input) + '\\n');
  if (process.env.REFERENCE_TEST_SCENARIO === 'fail') {
    return new Response('Unavailable fixture', { status: 503 });
  }
  if (process.env.REFERENCE_TEST_SCENARIO === 'redirect') {
    return new Response(null, {
      status: 302, headers: { location: 'https://unapproved.invalid/never-fetch.pdf' },
    });
  }
  return new Response(Buffer.from(${JSON.stringify(pdf.toString())}), {
    status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '${pdf.length}' },
  });
};
`);
  const output = path.join(root, '.data/resume-reference-corpus');
  return { root, output, logPath, stubPath, manifestPath: path.join(output, 'manifest.local.json') };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;
type AssetRecord = {
  id: string;
  status: string;
  sourceUrl: string;
  finalUrl?: string;
  contentType?: string;
  sha256?: string;
  bytes?: number;
  rawPath?: string;
  error?: string;
  aiPromptIngestionAllowed: boolean;
  previousSuccessfulSnapshot?: AssetRecord;
};

function runCollector(fixture: Fixture, scenario = 'success') {
  const result = spawnSync(process.execPath, [
    '--import', fixture.stubPath, path.join(fixture.root, 'scripts/collect-resume-references.mjs'),
  ], {
    cwd: fixture.root,
    env: { ...process.env, REFERENCE_TEST_SCENARIO: scenario },
    encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  return result;
}

async function readAssets(fixture: Fixture): Promise<AssetRecord[]> {
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
  return manifest.assets;
}

async function fetchCalls(fixture: Fixture) {
  try {
    return (await readFile(fixture.logPath, 'utf8')).trim().split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function assertUnlocked(fixture: Fixture) {
  await assert.rejects(readFile(path.join(fixture.output, '.fetch.lock')), { code: 'ENOENT' });
}

test('collector records downloaded bytes and preserves the last success through consecutive failures', async (t) => {
  const fixture = await makeFixture(t);
  const success = runCollector(fixture);
  assert.equal(success.status, 0, success.stderr);
  const [downloaded] = await readAssets(fixture);
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.bytes, pdf.length);
  assert.equal(downloaded.sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(downloaded.finalUrl, fixtureSource.assetUrl);
  assert.equal(downloaded.contentType, 'application/pdf');
  assert.equal(downloaded.aiPromptIngestionAllowed, false);
  assert.ok(downloaded.rawPath);
  assert.deepEqual(await readFile(path.join(fixture.root, downloaded.rawPath)), pdf);
  await assertUnlocked(fixture);

  for (let attempt = 0; attempt < 2; attempt++) {
    const failure = runCollector(fixture, 'fail');
    assert.equal(failure.status, 1, failure.stderr);
    const [failed] = await readAssets(fixture);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /HTTP 503/);
    assert.deepEqual(failed.previousSuccessfulSnapshot, downloaded);
    assert.deepEqual(await readFile(path.join(fixture.root, downloaded.rawPath)), pdf);
    await assertUnlocked(fixture);
  }
});

test('a damaged manifest leaves no lock and a repaired manifest can be collected', async (t) => {
  const fixture = await makeFixture(t);
  await mkdir(fixture.output, { recursive: true });
  await writeFile(fixture.manifestPath, '{ damaged manifest');
  const failed = runCollector(fixture);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(await fetchCalls(fixture), []);
  assert.equal(await readFile(fixture.manifestPath, 'utf8'), '{ damaged manifest');
  await assertUnlocked(fixture);

  await writeFile(fixture.manifestPath, JSON.stringify({ assets: [] }));
  const recovered = runCollector(fixture);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal((await readAssets(fixture))[0].status, 'downloaded');
  await assertUnlocked(fixture);
});

test('a traversal source ID is rejected before fetching or writing an asset', async (t) => {
  const fixture = await makeFixture(t, { id: '../../../escaped' });
  const result = runCollector(fixture);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await fetchCalls(fixture), []);
  assert.equal((await readdir(fixture.root)).some((name) => name.startsWith('escaped')), false);
  await assert.rejects(readFile(fixture.manifestPath), { code: 'ENOENT' });
  await assertUnlocked(fixture);
});

test('an unapproved redirect host is rejected without requesting that host', async (t) => {
  const fixture = await makeFixture(t);
  const result = runCollector(fixture, 'redirect');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(await fetchCalls(fixture), [fixtureSource.assetUrl]);
  const [failed] = await readAssets(fixture);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.rawPath, undefined);
  assert.deepEqual(await readdir(path.join(fixture.output, 'raw')), []);
  await assertUnlocked(fixture);
});
