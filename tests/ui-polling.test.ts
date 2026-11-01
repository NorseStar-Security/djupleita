import { afterEach, expect, it, vi } from 'vitest';
import { pollingSource } from '../packages/ui/src/client/polling.ts';
import type { PollingState } from '../packages/ui/src/client/polling.ts';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let state: PollingState<string> = { loading: true };
  const listeners = new Set<() => void>();
  const store = { getSnapshot: () => state, set(value: PollingState<string>) { state = value; for (const listener of listeners) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const requests: { signal: AbortSignal; resolve(value: string): void; reject(error: Error): void }[] = [];
  const load = vi.fn((signal: AbortSignal) => new Promise<string>((resolve, reject) => requests.push({ signal, resolve, reject })));
  return { source: pollingSource(store, load), requests, load, store };
}

it('shares polling between visible consumers and releases data and in-flight reads when the last one closes', async () => {
  const f = fixture();
  expect(f.load).not.toHaveBeenCalled();
  const offA = f.source.subscribe(() => {}), offB = f.source.subscribe(() => {});
  expect(f.load).toHaveBeenCalledTimes(1);
  f.requests[0]!.resolve('large snapshot'); await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getSnapshot().snapshot).toBe('large snapshot');
  offA(); await vi.advanceTimersByTimeAsync(1500); expect(f.load).toHaveBeenCalledTimes(2);
  offB(); offB();
  expect(f.requests[1]!.signal.aborted).toBe(true);
  expect(f.store.getSnapshot()).toEqual({ loading: true });
  f.requests[1]!.resolve('stale snapshot'); await vi.advanceTimersByTimeAsync(60000);
  expect(f.store.getSnapshot()).toEqual({ loading: true }); expect(f.load).toHaveBeenCalledTimes(2);
  const offC = f.source.subscribe(() => {});
  expect(f.load).toHaveBeenCalledTimes(3);
  f.requests[2]!.resolve('fresh snapshot'); await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getSnapshot().snapshot).toBe('fresh snapshot');
  offC(); f.source.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it('never overlaps slow polls and stops retries on disposal', async () => {
  const f = fixture(), off = f.source.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(60000); expect(f.load).toHaveBeenCalledTimes(1);
  f.requests[0]!.reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getSnapshot().error).toBe('offline');
  await vi.advanceTimersByTimeAsync(1500); expect(f.load).toHaveBeenCalledTimes(2);
  f.source.dispose(); expect(f.requests[1]!.signal.aborted).toBe(true);
  f.requests[1]!.resolve('late'); await vi.advanceTimersByTimeAsync(60000);
  expect(f.store.getSnapshot()).toEqual({ loading: true }); expect(f.load).toHaveBeenCalledTimes(2);
  off(); expect(vi.getTimerCount()).toBe(0);
});
