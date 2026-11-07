import { importResumeFile, ResumeImportError, type ImportedResume } from './importResume';
import type { ImportSignal } from './importCancellation';

/** The picker and browser parsers stay outside the shared workspace and WeChat bundle. */
export async function selectResumeFile(options: { signal: ImportSignal; onParsing: () => void }): Promise<ImportedResume | undefined> {
  // #ifdef H5
  const file = await new Promise<File | undefined>((resolve, reject) => {
    if (options.signal.aborted) { reject(new ResumeImportError('cancelled', '已取消文件导入。')); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md';
    input.style.display = 'none';
    let settled = false;
    function cleanup() {
      input.removeEventListener('change', change);
      input.removeEventListener('cancel', cancel);
      options.signal.removeEventListener('abort', abort);
      input.remove();
    }
    function finish(file?: File) {
      if (settled) return;
      settled = true; cleanup(); resolve(file);
    }
    function change() { finish(input.files?.[0]); }
    function cancel() { finish(); }
    function abort() {
      if (settled) return;
      settled = true; cleanup(); reject(new ResumeImportError('cancelled', '已取消文件导入。'));
    }
    input.addEventListener('change', change);
    input.addEventListener('cancel', cancel);
    options.signal.addEventListener('abort', abort, { once: true });
    document.body.appendChild(input);
    try { input.click(); }
    catch { settled = true; cleanup(); reject(new ResumeImportError('unsupported-platform', '无法打开文件选择器，请重试或粘贴简历正文。')); }
  });
  if (!file) return;
  options.onParsing();
  return importResumeFile(file, { signal: options.signal });
  // #endif
  throw new ResumeImportError('unsupported-platform', '请粘贴简历正文；文件导入可在网页版本使用。');
}
