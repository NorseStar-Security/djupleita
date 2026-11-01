import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';

it('redacts credentials before disk writes and preserves ordered concurrent appends across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trajectory-'));
  const engagementId = id<'EngagementId'>(), sessionId = id<'SessionId'>();
  const redactor = new Redactor(); redactor.register('private-secret');
  const store = new TrajectoryStore(root, engagementId, redactor);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.append(sessionId, 'tool/result', { i, authorization: 'Bearer credential', body: 'contains private-secret' })));
  const bytes = await readFile(join(root, `${sessionId}.jsonl`), 'utf8');
  expect(bytes).not.toContain('private-secret'); expect(bytes).not.toContain('Bearer credential');
  const restarted = new TrajectoryStore(root, engagementId, redactor);
  await restarted.append(sessionId, 'turn/end', {});
  expect((await restarted.read(sessionId)).map(event => event.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i));
});
it('detects tampering and interrupted tails without rewriting original evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trajectory-'));
  const engagementId = id<'EngagementId'>(), sessionId = id<'SessionId'>();
  const store = new TrajectoryStore(root, engagementId, new Redactor());
  await store.append(sessionId, 'policy/decision', { kind: 'deny' });
  const file = join(root, `${sessionId}.jsonl`), original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('deny', 'allow'));
  await expect(store.read(sessionId)).rejects.toThrow(/integrity/);
  const broken = original.slice(0, -1); await writeFile(file, broken);
  const restarted = new TrajectoryStore(root, engagementId, new Redactor());
  await expect(restarted.page(sessionId)).rejects.toThrow(/interrupted/);
  await expect(restarted.detail(sessionId, 0)).rejects.toThrow(/interrupted/);
  await expect(restarted.append(sessionId, 'next', {})).rejects.toThrow(/interrupted/);
  expect(await readFile(file, 'utf8')).toBe(broken);
  await expect(restarted.append(sessionId, 'next', {})).rejects.toThrow(/durability/);
});

it('pages verified previews without transferring large bodies and reads complete event data in bounded chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trajectory-page-'));
  const engagementId = id<'EngagementId'>(), sessionId = id<'SessionId'>();
  const store = new TrajectoryStore(root, engagementId, new Redactor());
  for (let i = 0; i < 125; i++) await store.append(sessionId, 'tool/result', { index: i });
  const body = { result: '界'.repeat(1000000) }; await store.append(sessionId, 'large/result', body);
  const file = join(root, `${sessionId}.jsonl`), original = await readFile(file, 'utf8');
  const latest = await store.page(sessionId);
  expect(latest.total).toBe(126); expect(latest.events).toHaveLength(100);
  expect(latest.events[0]!.seq).toBe(26); expect(latest.nextBefore).toBe(26);
  expect(latest.events.at(-1)).toMatchObject({ dataTruncated: true, dataBytes: 3000013 });
  expect(Buffer.byteLength(JSON.stringify(latest))).toBeLessThan(100000);
  expect(await store.page(sessionId)).toBe(latest);
  const older = await store.page(sessionId, latest.nextBefore!);
  expect(older.events.map(event => event.seq)).toEqual(Array.from({ length: 26 }, (_, i) => i)); expect(older.nextBefore).toBeNull();
  const first = await store.detail(sessionId, 125), second = await store.detail(sessionId, 125, first.nextOffset!);
  expect(first.text.length).toBe(16384); expect(second.offset).toBe(16384);
  expect(first.text + second.text).toBe(JSON.stringify(body, null, 2).slice(0, 32768));
  await expect(store.page(sessionId, -1)).rejects.toThrow('Invalid');
  await expect(store.detail(sessionId, 999)).rejects.toThrow('does not exist');
  expect(await readFile(file, 'utf8')).toBe(original);
  await store.append(sessionId, 'next', {});
  expect((await store.page(sessionId)).total).toBe(127);
  // An alteration outside the displayed page must invalidate the cache and fail verification.
  const changed = (await readFile(file, 'utf8')).replace('"index":0', '"index":9'); await writeFile(file, changed);
  await expect(store.page(sessionId)).rejects.toThrow('integrity');
  await expect(store.detail(sessionId, 125)).rejects.toThrow('integrity');
});
