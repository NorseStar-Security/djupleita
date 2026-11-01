/** Optional OTLP/HTTP JSON logs export with a durable, redacted retry outbox. */
import { mkdir, readFile, open, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, digest, id } from '@dsh-pentest/contracts';
import type { IdentityId, Json, TrajectoryEvent } from '@dsh-pentest/contracts';
import type { Redactor, TrajectoryStore } from '@dsh-pentest/trajectory';
import type { ServiceJsonClient } from '@dsh-pentest/http';

export const ExportConfigSchema = z.object({ enabled: z.boolean().default(false), endpoint: z.url(),
  identityId: z.string().uuid().optional(), maxQueued: z.number().int().positive().max(100000).default(10000),
  maxAttempts: z.number().int().min(1).max(100).default(12),
  courseAudit: z.object({ sourceId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    fragmentBytes: z.number().int().min(256).max(65536).default(32768) }).optional() });
export type ExportConfig = z.infer<typeof ExportConfigSchema>;
const QueueSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), attempts: z.number().int().nonnegative(),
  nextAt: z.number(), payload: z.json() });

/** Each event is an OTLP log linked to a stable chat trace. No original secrets reach the outbox. */
export function otlpLog(event: TrajectoryEvent): Json {
  return { resourceLogs: [{ resource: { attributes: [
    { key: 'service.name', value: { stringValue: 'dsh-pentest' } },
    { key: 'dsh.engagement.id', value: { stringValue: event.engagementId } },
  ] }, scopeLogs: [{ scope: { name: 'dsh.pentest.trajectory', version: '0.1.0' }, logRecords: [{
    timeUnixNano: (BigInt(Date.parse(event.timestamp)) * 1_000_000n).toString(),
    traceId: digest({ engagement: event.engagementId, session: event.sessionId }).slice(0, 32), spanId: event.hash.slice(0, 16),
    severityNumber: event.type.includes('error') || event.type.includes('blocked') ? 17 : 9,
    severityText: event.type.includes('error') || event.type.includes('blocked') ? 'ERROR' : 'INFO',
    body: { stringValue: canonical(event.data) }, attributes: [
      { key: 'event.name', value: { stringValue: event.type } }, { key: 'dsh.session.id', value: { stringValue: event.sessionId } },
      { key: 'dsh.event.hash', value: { stringValue: event.hash } }, { key: 'dsh.event.seq', value: { intValue: String(event.seq) } },
    ],
  }] }] }] };
}

/** Encode redacted records for Pedram Amini's authenticated course receiver, including fragments. */
export function courseAuditRequests(event: TrajectoryEvent, config: NonNullable<ExportConfig['courseAudit']>, redactor: Redactor): { filename: string; id: string; payload: Json }[] {
  const session = `${event.engagementId}.${event.sessionId}`;
  const records = event.seq === 0 ? [
    { seq: -1, type: 'session', body: canonical({ type: 'session', distribution: 'Djupleita', engagementId: event.engagementId }) },
    { seq: event.seq, type: event.type, body: canonical(redactor.json(event)) },
  ] : [{ seq: event.seq, type: event.type, body: canonical(redactor.json(event)) }];
  return records.flatMap(record => {
    const bytes = Buffer.from(record.body), sha = digest(JSON.parse(record.body));
    const recordId = digest({ source: config.sourceId, session, seq: record.seq, sha });
    const parts = Math.max(1, Math.ceil(bytes.length / config.fragmentBytes));
    if (parts > 4096) throw new Error('Course audit record exceeds the receiver fragment limit; local trajectory retained');
    return Array.from({ length: parts }, (_, part) => {
      const partId = digest({ recordId, part });
      const attributes = Object.entries({
        'dsh.trajectory.schema': 1, 'dsh.source.id': config.sourceId, 'dsh.session.id': session,
        'dsh.event.seq': record.seq, 'dsh.event.type': record.type, 'dsh.record.id': recordId,
        'dsh.record.sha256': sha, 'dsh.record.part': part, 'dsh.record.parts': parts,
        'dsh.record.encoding': parts === 1 ? 'json' : 'base64-json-utf8',
      }).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }));
      const payload: Json = { resourceLogs: [{ scopeLogs: [{ scope: { name: 'djupleita.course-audit', version: '1' }, logRecords: [{
        timeUnixNano: (BigInt(Date.parse(event.timestamp)) * 1_000_000n).toString(), eventName: record.type,
        body: { stringValue: parts === 1 ? record.body : bytes.subarray(part * config.fragmentBytes, (part + 1) * config.fragmentBytes).toString('base64') }, attributes,
      }] }] }] };
      return { filename: `${digest(session)}-${String(record.seq + 1).padStart(16, '0')}-${String(part).padStart(4, '0')}-${partId}.json`, id: partId, payload };
    });
  });
}
export class OtlpExporter {
  private queue = Promise.resolve();
  private draining?: Promise<{ sent: number; pending: number }>;
  private capturing = false;
  constructor(private readonly root: string, readonly config: ExportConfig,
    private readonly client: ServiceJsonClient, private readonly redactor: Redactor,
    private readonly now = () => Date.now()) { ExportConfigSchema.parse(config); }

  async enqueue(event: TrajectoryEvent): Promise<void> {
    if (!this.config.enabled) return;
    const records = this.config.courseAudit ? courseAuditRequests(event, this.config.courseAudit, this.redactor)
      : [{ filename: `${event.hash}.json`, id: event.hash, payload: this.redactor.json(otlpLog(event)) }];
    const next = this.queue.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const files = new Set(await this.files());
      for (const record of records) {
        if (files.has(record.filename)) continue;
        if (files.size >= this.config.maxQueued) throw new Error('Telemetry outbox capacity reached; local trajectories remain available');
        await this.save(record.filename, { id: record.id, attempts: 0, nextAt: this.now(), payload: record.payload });
        files.add(record.filename);
      }
    });
    this.queue = next.catch(() => {}); return next;
  }
  /** A durable per-destination cursor recovers app crashes without resending every chat. */
  async capture(store: TrajectoryStore): Promise<void> {
    if (!this.config.enabled || this.capturing) return; this.capturing = true;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const cursorPath = join(this.root, 'cursors.json');
      const cursors = z.record(z.string(), z.object({ seq: z.number().int(), hash: z.string() })).parse(JSON.parse(await readFile(cursorPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error; })));
      for (const session of await store.sessions()) {
        const events = await store.read(session), cursor = cursors[session];
        if (cursor && events[cursor.seq]?.hash !== cursor.hash) throw new Error('Telemetry cursor no longer matches the verified trajectory');
        for (const event of events.slice((cursor?.seq ?? -1) + 1)) await this.enqueue(event);
        const tail = events.at(-1); if (tail) cursors[session] = { seq: tail.seq, hash: tail.hash };
      }
      await this.atomic('cursors.json', JSON.stringify(cursors));
    } finally { this.capturing = false; }
  }
  async drain(signal: AbortSignal): Promise<{ sent: number; pending: number }> {
    if (this.draining) return this.draining;
    this.draining = this.flush(signal);
    try { return await this.draining; } finally { delete this.draining; }
  }
  private async flush(signal: AbortSignal): Promise<{ sent: number; pending: number }> {
    await this.queue; let sent = 0;
    if (!this.config.enabled) return { sent, pending: (await this.files()).length };
    for (const filename of await this.files()) {
      signal.throwIfAborted();
      const record = QueueSchema.parse(JSON.parse(await readFile(join(this.root, filename), 'utf8')));
      if (record.nextAt > this.now() || record.attempts >= this.config.maxAttempts) {
        if (this.config.courseAudit) break;
        continue;
      }
      try {
        await this.client.send(this.config.endpoint, 'telemetry', record.payload, signal, this.config.identityId as IdentityId | undefined);
        await unlink(join(this.root, filename)); sent++;
      } catch (error) {
        signal.throwIfAborted();
        await this.save(filename, { ...record, attempts: record.attempts + 1,
          nextAt: this.now() + Math.min(3600000, 1000 * 2 ** record.attempts) });
        if (this.config.courseAudit) break;
      }
    }
    return { sent, pending: (await this.files()).length };
  }
  async status(): Promise<{ queued: number; exhausted: number }> {
    await this.queue; let exhausted = 0;
    const files = await this.files();
    for (const filename of files) { const record = QueueSchema.parse(JSON.parse(await readFile(join(this.root, filename), 'utf8'))); if (record.attempts >= this.config.maxAttempts) exhausted++; }
    return { queued: files.length, exhausted };
  }
  private async files(): Promise<string[]> { return (await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^(?:[a-f0-9]{64}-\d{16}-\d{4}-)?[a-f0-9]{64}\.json$/.test(name)).sort(); }
  private async save(filename: string, record: z.infer<typeof QueueSchema>): Promise<void> {
    await this.atomic(filename, `${canonical(record)}\n`);
  }
  private async atomic(filename: string, content: string): Promise<void> {
    const temporary = join(this.root, `${filename}.${id<'WriteId'>()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(this.root, filename));
    const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
}
