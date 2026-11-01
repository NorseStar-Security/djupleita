import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PentestRuntime } from '../packages/dsh-plugin/src/runtime.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';

it('keeps desktop snapshots small when a tool records a multi-megabyte result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-snapshot-'));
  const runtime = await PentestRuntime.open({ engagement: engagement(), policy: policyConfig, root, keychainHelper: '/unused' }, testJudge);
  const session = id<'SessionId'>();
  try {
    const body = 'large-result-'.repeat(300000);
    await runtime.trajectories.append(session, 'harness/tool-result', { body });
    const snapshot = await runtime.snapshot(session) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(100000);
    expect(snapshot.trajectory).toMatchObject({ total: 1 });
    expect(snapshot.events).toMatchObject([{ dataTruncated: true }]);
    expect((await runtime.trajectories.read(session))[0]!.data).toEqual({ body });
    expect(await runtime.status(session)).toMatchObject({ trajectory: { events: 1, lastSeq: 0 } });
  } finally { await runtime.close(); }
});
