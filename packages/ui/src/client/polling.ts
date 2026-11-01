/** Poll only observed sources; release payloads and cancel reads on the last unsubscribe. */
export interface PollingState<T> { snapshot?: T; error?: string; loading: boolean }
interface Store<T> { getSnapshot(): PollingState<T>; set(value: PollingState<T>): void; subscribe(listener: () => void): () => void }
export function pollingSource<T>(store: Store<T>, load: (signal: AbortSignal) => Promise<T>, intervalMs = 1500) {
  let observers = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  const refresh = async (): Promise<void> => {
    if (disposed || !observers || request) return;
    if (timer) clearTimeout(timer); timer = undefined;
    const current = new AbortController(); request = current;
    try {
      const snapshot = await load(current.signal);
      if (!disposed && !current.signal.aborted) store.set({ snapshot, loading: false });
    } catch (error) {
      if (!disposed && !current.signal.aborted) store.set({ ...store.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false });
    } finally {
      if (request === current) {
        request = undefined;
        if (!disposed && observers) timer = setTimeout(() => { timer = undefined; void refresh(); }, intervalMs);
      }
    }
  };
  const stop = (): void => {
    if (timer) clearTimeout(timer); timer = undefined;
    request?.abort(); request = undefined;
    store.set({ loading: true });
  };
  return {
    get active() { return observers > 0; },
    getSnapshot: store.getSnapshot,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      const off = store.subscribe(listener); observers++;
      if (observers === 1) void refresh();
      let removed = false;
      return () => { if (removed) return; removed = true; off(); if (--observers === 0) stop(); };
    },
    refresh,
    dispose(): void { disposed = true; stop(); },
  };
}
