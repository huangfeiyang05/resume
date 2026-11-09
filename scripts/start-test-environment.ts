import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { preview, type PreviewServer } from 'vite';
import { AuthService } from '../server/auth.js';
import { createApiServer } from '../server/http.js';
import { ResumeService } from '../server/service.js';
import { JsonStore } from '../server/store.js';

const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.test-data');
const site = join(directory, 'www');
const loginFile = join(directory, 'admin-login.json');
const database = join(directory, 'resumes.json');
const host = '127.0.0.1';
const apiPort = 3002;
const webPort = 5175;
const origin = `http://${host}:${webPort}`;
const email = 'admin@example.test';

async function safePath(path: string, kind: 'directory' | 'file') {
  try {
    const info = await lstat(path);
    if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`Invalid test path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

await safePath(directory, 'directory');
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
await safePath(database, 'file');
await safePath(loginFile, 'file');
await safePath(site, 'directory');
await safePath(join(site, 'admin'), 'directory');

const store = new JsonStore(database, 'test');
await store.read();
const auth = new AuthService(store, { requireEmailVerification: false });
const adminIds = new Set<string>();
const api = createApiServer(new ResumeService(store), { auth, adminUserIds: adminIds, secureCookies: false, trustedOrigins: [origin] });
let web: PreviewServer | undefined;
function stop() {
  web?.httpServer.close();
  api.closeAllConnections();
  api.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await new Promise<void>((resolve, reject) => {
    api.once('error', reject);
    api.listen(apiPort, host, () => { api.off('error', reject); resolve(); });
  });
  const existing = (await store.read()).users.find(user => user.email === email);
  let credentials: { email: string; password: string };
  try {
    credentials = JSON.parse(await readFile(loginFile, 'utf8'));
    if (credentials.email !== email || typeof credentials.password !== 'string') throw new Error('Invalid test admin file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (existing) throw new Error('Test administrator exists but its local login file is missing.');
    credentials = { email, password: `T3!${randomBytes(6).toString('hex')}` };
    await writeFile(loginFile, `${JSON.stringify(credentials, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  await chmod(loginFile, 0o600);
  const id = existing?.id ?? (await auth.register(credentials)).session.user.id;
  await store.mutate(data => { data.users.find(user => user.id === id)!.emailVerified = true; });
  adminIds.add(id);

  const buildEnv = { ...process.env, VITE_API_BASE_URL: '', VITE_TEMPLATE_BASE_URL: '', UNI_OUTPUT_DIR: site };
  for (const args of [['run', 'build:h5'], ['run', 'build:admin', '--', '--outDir', join(site, 'admin')]]) {
    const build = spawnSync('npm', args, { cwd: root, env: buildEnv, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('Test frontend build failed.');
  }
  web = await preview({ configFile: false, root: directory, build: { outDir: 'www' },
    preview: { host, port: webPort, strictPort: true, proxy: { '/api': `http://${host}:${apiPort}` } } });
  console.log(`测试版 ${origin}/ · 测试后台 ${origin}/admin/\n测试账号密码文件 ${loginFile}`);
} catch (error) {
  stop();
  throw error;
}
