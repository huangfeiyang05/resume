/** Only the cancellation contract needed by local import; available in H5 and WeChat. */
export interface ImportSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

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
