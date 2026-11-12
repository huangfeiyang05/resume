import type { ImportSignal } from '../../shared/resume-import';
export type { ImportSignal } from '../../shared/resume-import';

export function createImportController(): { signal: ImportSignal; abort: () => void } {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: ImportSignal = {
    get aborted() { return aborted; },
    addEventListener(_type, listener) { if (!aborted) listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  return {
    signal,
    abort() {
      if (aborted) return;
      aborted = true;
      const callbacks = [...listeners];
      listeners.clear();
      for (const callback of callbacks) {
        try { callback(); } catch { /* One cleanup must not prevent another task from stopping. */ }
      }
    },
  };
}
