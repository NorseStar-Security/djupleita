import { it, expect } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OtlpExporter, ExportConfigSchema } from '../packages/export/src/index.ts';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import type { ServiceJsonClient } from '../packages/http/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';

it('recovers the redacted OTLP outbox and destination cursor across failure and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-export-')), redactor = new Redactor();
  redactor.register('outbox-secret');
  const store = new TrajectoryStore(join(root, 'trajectory'), id<'EngagementId'>(), redactor), session = id<'SessionId'>();
  await store.append(session, 'tool/result', { text: 'outbox-secret', authorization: 'Bearer outbox-secret' });
  let time = 100, fail = true; const sent: unknown[] = [];
  const client = { async send(_url: string, purpose: string, body: unknown) { expect(purpose).toBe('telemetry'); if (fail) throw new Error('offline'); sent.push(body); } } as unknown as ServiceJsonClient;
  const config = ExportConfigSchema.parse({ enabled: true, endpoint: 'https://collector.example/v1/logs' });
  const exporter = new OtlpExporter(join(root, 'outbox'), config, client, redactor, () => time);
  await exporter.capture(store); expect(await exporter.drain(new AbortController().signal)).toEqual({ sent: 0, pending: 1 });
  for (const name of await readdir(join(root, 'outbox'))) expect(await readFile(join(root, 'outbox', name), 'utf8')).not.toContain('outbox-secret');
  const restarted = new OtlpExporter(join(root, 'outbox'), config, client, redactor, () => time);
  fail = false; await restarted.capture(store);
  expect((await restarted.drain(new AbortController().signal)).sent).toBe(0);
  time += 1001; expect(await restarted.drain(new AbortController().signal)).toEqual({ sent: 1, pending: 0 });
  await restarted.capture(store); expect((await restarted.status()).queued).toBe(0);
  await store.append(session, 'next', { ok: true }); await restarted.capture(store);
  expect((await restarted.drain(new AbortController().signal)).sent).toBe(1); expect(sent).toHaveLength(2);
  expect(JSON.stringify(sent)).toContain('traceId'); expect(JSON.stringify(sent)).toContain('[REDACTED]');
});
