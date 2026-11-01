import { expect, it, vi } from 'vitest';
import { reviewLoader } from '../packages/ui/src/client/reviews.ts';

it('reads all pending agents from the lightweight owner inbox without filtering to the visible chat', async () => {
  const value = { pending: [{ id: 'child-a' }, { id: 'child-b' }], grants: [] };
  const call = vi.fn().mockResolvedValue({ ok: true, value });
  const load = reviewLoader({ rpc: { call } }), signal = new AbortController().signal;
  expect(await load(signal)).toEqual(value);
  expect(call).toHaveBeenCalledExactlyOnceWith('/api', 'pentest/review/snapshot', {}, signal);
});

it('can update the renderer during an active test on an older host and discards unrelated snapshot data', async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error('transport failure for /api/pentest/review/snapshot: HTTP 404'))
    .mockResolvedValue({ ok: true, value: { review: { pending: [{ id: 'child-a' }], grants: [] }, setup: { entries: [] }, graph: { unrelated: 'data' } } });
  const load = reviewLoader({ rpc: { call } }), signal = new AbortController().signal;
  expect(await load(signal)).toEqual({ pending: [{ id: 'child-a' }], grants: [], setup: { entries: [] } });
  expect(await load(signal)).not.toHaveProperty('graph');
  expect(call.mock.calls.map(args => args[1])).toEqual(['pentest/review/snapshot', 'pentest/snapshot', 'pentest/snapshot']);
  expect(call.mock.calls.every(args => Object.keys(args[2]).length === 0)).toBe(true);
});

it('does not conceal authentication or host failures behind a fallback', async () => {
  for (const message of ['transport failure for /api/pentest/review/snapshot: HTTP 403', 'Host unavailable']) {
    const call = vi.fn().mockRejectedValue(new Error(message));
    await expect(reviewLoader({ rpc: { call } })(new AbortController().signal)).rejects.toThrow(message);
    expect(call).toHaveBeenCalledTimes(1);
  }
});
