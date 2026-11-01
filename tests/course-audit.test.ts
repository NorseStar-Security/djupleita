import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportConfigSchema, OtlpExporter, courseAuditRequests } from '../packages/export/src/index.ts';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { canonical, id } from '../packages/contracts/src/index.ts';
import type { ServiceJsonClient } from '../packages/http/src/index.ts';
import { decodeLogsJson } from '../course/audit-stream/worker/src/otlp.ts';
import { commitRecords, migrate, readRecord, seatSummary } from '../course/audit-stream/worker/src/ledger.ts';
import { writerIdentity } from '../course/audit-stream/worker/src/writer.ts';
import { memoryStore } from '../course/audit-stream/worker/tests/helpers.ts';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('streams fragmented, redacted reasoning in sequence through Pedram’s actual receiver ledger after retry/restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-course-')); temporary.push(root);
  const redactor = new Redactor(); redactor.register('private-model-key');
  const engagement = id<'EngagementId'>(), session = id<'SessionId'>();
  const trajectories = new TrajectoryStore(join(root, 'trajectories'), engagement, redactor);
  const event = await trajectories.append(session, 'harness/session-event', { type: 'assistant/message', data: { message: { content: [
    { type: 'reasoning', text: 'Review candidate evidence. '.repeat(100) + 'private-model-key' }, { type: 'text', text: 'Continue with a bounded check.' },
  ] } } });
  await trajectories.append(session, 'policy/decision', { kind: 'deny', reason: 'Outside authorized scope' });
  const config = ExportConfigSchema.parse({ enabled: true, endpoint: 'https://audit.example.test/v1/logs', courseAudit: { sourceId: 'sans-lab01', fragmentBytes: 256 } });
  const ledger = memoryStore(); migrate(ledger);
  let now = 100, calls = 0, failOnce = true;
  const client = { async send(_url: string, purpose: string, payload: unknown) {
    expect(purpose).toBe('telemetry'); calls++;
    if (calls === 3 && failOnce) { failOnce = false; throw new Error('temporary outage'); }
    expect(JSON.stringify(payload)).not.toContain('private-model-key');
    const records = decodeLogsJson(JSON.stringify(payload));
    const identity = writerIdentity({ kind: 'course', cohort: 'sec590', student: '', installation: 'sans-', expiresAt: 2e9, nonce: 'test-nonce' }, records);
    await commitRecords(ledger, identity, records, now);
  } } as unknown as ServiceJsonClient;
  try {
    const first = new OtlpExporter(join(root, 'outbox'), config, client, redactor, () => now);
    await first.capture(trajectories); await first.drain(new AbortController().signal);
    expect(calls).toBe(3);
    const restarted = new OtlpExporter(join(root, 'outbox'), config, client, redactor, () => now);
    await restarted.capture(trajectories); await restarted.drain(new AbortController().signal);
    expect(calls).toBe(3);
    now += 2000;
    expect((await restarted.drain(new AbortController().signal)).pending).toBe(0);
    const summary = seatSummary(ledger);
    expect(summary.problems).toEqual([]);
    expect(summary.sessions[0]?.['records']).toBe(3);
    expect(Number(summary.sessions[0]?.['reasoning_chars'])).toBeGreaterThan(2000);
    expect(Number(summary.sessions[0]?.['scope_denials'])).toBe(1);
    expect(Buffer.from((await readRecord(ledger, `${engagement}.${session}`, 0))!).toString('utf8')).toBe(canonical(event));
    const replay = courseAuditRequests(event, config.courseAudit!, redactor).flatMap(request => decodeLogsJson(JSON.stringify(request.payload)));
    const accepted = await commitRecords(ledger, { cohort: 'sec590', student: 'sans-lab01', installation: 'sans-lab01' }, replay, now);
    expect(accepted.accepted).toBe(0); expect(accepted.duplicates).toBe(replay.length);
  } finally { ledger.close(); }
});

it('the preserved receiver refuses source impersonation and a modified record digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-course-deny-')); temporary.push(root);
  const redactor = new Redactor(), store = new TrajectoryStore(root, id<'EngagementId'>(), redactor);
  const event = await store.append(id<'SessionId'>(), 'test', { safe: true });
  const request = courseAuditRequests(event, { sourceId: 'seat-01', fragmentBytes: 32768 }, redactor)[0]!;
  const records = decodeLogsJson(JSON.stringify(request.payload)), ledger = memoryStore(); migrate(ledger);
  try {
    await expect(commitRecords(ledger, { cohort: 'lab', student: 'student', installation: 'seat-01' }, [{ ...records[0]!, attributes: { ...records[0]!.attributes, 'dsh.source.id': 'seat-02' } }], 100)).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    await expect(commitRecords(ledger, { cohort: 'lab', student: 'student', installation: 'seat-01' }, [{ ...records[0]!, body: '{"tampered":true}' }], 100)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  } finally { ledger.close(); }
});
