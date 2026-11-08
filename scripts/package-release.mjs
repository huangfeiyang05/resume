import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'dist/release');
const runtimeDependencies = ['yaml', 'nodemailer', 'pdfkit', 'jszip', 'qrcode-generator'];
const runtimePackages = new Map();
/** Some packages block the package.json subpath, so locate the install directory from the entry point. */
async function packageDirectory(name) {
  try { return dirname(require.resolve(`${name}/package.json`)); } catch { /* fall through to the entry point */ }
  let directory = dirname(require.resolve(name));
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return directory;
    } catch { /* keep walking up to the install root */ }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate the installed package directory for ${name}.`);
}
async function collectRuntimePackage(name) {
  if (runtimePackages.has(name)) return;
  const directory = await packageDirectory(name);
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  runtimePackages.set(name, { name, directory, version: metadata.version });
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await collectRuntimePackage(dependency);
}
for (const name of runtimeDependencies) await collectRuntimePackage(name);
const packages = [...runtimePackages.values()];
const project = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
let gitCommit = null;
let gitDirty = null;
try {
  gitCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  gitDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().length > 0;
} catch { /* Source archives remain buildable without Git metadata. */ }

await rm(destination, { recursive: true, force: true });
await mkdir(resolve(destination, 'api/node_modules'), { recursive: true });
// Explicit allowlist: never copy local data, environment files, YAML credentials or resume originals.
await cp(resolve(root, 'dist/build/h5'), resolve(destination, 'www'), { recursive: true });
await cp(resolve(root, 'dist/admin'), resolve(destination, 'www/admin'), { recursive: true });
await cp(resolve(root, 'dist/server'), resolve(destination, 'api'), { recursive: true });
for (const dependency of packages) await cp(dependency.directory, resolve(destination, `api/node_modules/${dependency.name}`), { recursive: true });
await cp(resolve(root, 'deploy'), resolve(destination, 'ops'), { recursive: true });
await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(destination, 'THIRD_PARTY_NOTICES.md'));
await writeFile(resolve(destination, 'api/package.json'), `${JSON.stringify({
  name: `${project.name}-server`, version: project.version, private: true, type: 'module',
  engines: project.engines, dependencies: Object.fromEntries(packages.map(item => [item.name, item.version])),
}, null, 2)}\n`);
await writeFile(resolve(destination, 'release.json'), `${JSON.stringify({
  name: project.name, version: project.version, builtAt: new Date().toISOString(),
  gitCommit, gitDirty,
  mode: 'email-session-demo', persistence: 'local-json', modelEnabledByDefault: false,
}, null, 2)}\n`);
console.log(`Release prepared: ${destination}`);
