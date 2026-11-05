// Offline, trusted supplier-evidence reconciliation. Invoke through the guarded shell wrapper.
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Bounded input protects the offline operator too; never print the supplied JSON on failure. */
export async function readEvidence(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error('Evidence too large');
    chunks.push(bytes);
  }
  const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || Object.keys(evidence).some(key => !['userId', 'taskId', 'idempotencyKey', 'reason', 'usage', 'confirmedNoUsage'].includes(key))) throw new Error('Invalid evidence');
  return evidence;
}

async function main() {
  const database = '/var/lib/resume-youfang/.data/resumes.json';
  try {
    if (process.env.RESUME_QUOTA_OFFLINE !== 'service-stopped' || process.platform !== 'linux'
      || process.argv.length !== 2 || process.getuid?.() !== (await stat(database)).uid) throw new Error('Offline guard failed');
    const { userId, taskId, ...input } = await readEvidence(process.stdin);
    const root = resolve(import.meta.dirname, '../api/server');
    const [{ JsonStore }, { QuotaService }] = await Promise.all([
      import(pathToFileURL(resolve(root, 'store.js')).href), import(pathToFileURL(resolve(root, 'quota.js')).href),
    ]);
    const result = await new QuotaService(new JsonStore(database)).reconcile(userId, taskId, input);
    console.log(JSON.stringify({ reconciled: true, taskId: result.taskId, status: result.status }));
  } catch {
    console.error('reconciliation_failed: verify service state and trusted evidence; no automatic release or estimate was used');
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
