import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { inspectTrajectory } from '../packages/dsh-plugin/src/inspection.ts';
import { id } from '../packages/contracts/src/index.ts';

it('pages verified event metadata and bounds individual payload previews without modifying the archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-inspection-')), session = id<'SessionId'>();
  const store = new TrajectoryStore(root, id<'EngagementId'>(), new Redactor());
  try {
    for (let index = 0; index < 6; index++) await store.append(session, 'harness/tool-result', { previousResult: '🧪'.repeat(10000), index });
    const page = await inspectTrajectory(store, session, { limit: 2 });
    expect(page).toMatchObject({ totalEvents: 6, nextBefore: 4, events: [ { seq: 4 }, { seq: 5 } ] });
    expect(JSON.stringify(page)).not.toContain('previousResult'); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2048);
    expect(await inspectTrajectory(store, session, { before: 4, limit: 2 })).toMatchObject({ nextBefore: 2, events: [{ seq: 2 }, { seq: 3 }] });
    const detail = await inspectTrajectory(store, session, { eventSeq: 0 });
    expect(detail).toMatchObject({ event: { seq: 0 }, truncated: true });
    expect(JSON.stringify(detail)).not.toContain('�'); expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(8192);
    expect((await store.read(session))[0]!.data).toMatchObject({ previousResult: '🧪'.repeat(10000) });
    await expect(inspectTrajectory(store, session, { limit: 51 })).rejects.toThrow();
    await expect(inspectTrajectory(store, session, { eventSeq: 99 })).rejects.toThrow('No trajectory event');
  } finally { await rm(root, { recursive: true, force: true }); }
});
