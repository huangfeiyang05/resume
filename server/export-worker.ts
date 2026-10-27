import { parentPort, workerData } from 'node:worker_threads';
import { renderResumeFile } from './export-renderer.js';
try {
  const buffer = await renderResumeFile(workerData.resume, workerData.format, workerData.template);
  parentPort!.postMessage({ bytes: buffer });
} catch {
  parentPort!.postMessage({ error: 'EXPORT_RENDER_FAILED' });
}
