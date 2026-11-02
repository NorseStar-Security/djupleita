/** Durable, redacted, hash-linked trajectories and content-addressed evidence. */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { PentestError, canonical, digest, id } from '@dsh-pentest/contracts';
import type { EngagementId, Evidence, IdentityId, Json, SessionId, TrajectoryEvent, TrajectorySink } from '@dsh-pentest/contracts';

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|token|access_token|refresh_token|(?:x[-_])?api[-_]?key|credential)$/i;

export class Redactor {
  private readonly secrets = new Map<string, number>();

  /** Keep the literal registered until every owning credential use ends. */
  register(secret: string): () => void {
    if (!secret) throw new PentestError('EMPTY_SECRET', 'Cannot register an empty secret');
    this.secrets.set(secret, (this.secrets.get(secret) ?? 0) + 1);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = this.secrets.get(secret) ?? 0;
      if (count <= 1) this.secrets.delete(secret); else this.secrets.set(secret, count - 1);
    };
  }

  text(value: string): string {
    let result = value;
    for (const secret of [...this.secrets.keys()].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join('[REDACTED]');
    }
    return result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, '$1 [REDACTED]')
      .replace(/([?&](?:token|access_token|refresh_token|api_key|password|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
  }

  json(value: unknown): Json {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.json(item));
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const result: Record<string, Json> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        Object.defineProperty(result, this.text(key), { value: SENSITIVE_KEY.test(key) ? '[REDACTED]' : this.json(item), enumerable: true });
      }
      return result;
    }
    throw new PentestError('NON_JSON_EVENT', 'Trajectory data must be JSON');
  }
}

function safeSession(session: SessionId): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session)) throw new PentestError('INVALID_SESSION', 'Invalid trajectory session identifier');
  return session;
}

/** Bound renderer data; the original JSON remains in its verified local event. */
export function previewData(value: Json, maxBytes = 4096): { data: Json; dataBytes: number; dataTruncated: boolean } {
  const text = JSON.stringify(value), dataBytes = Buffer.byteLength(text);
  return { data: dataBytes <= maxBytes ? value : { preview: text.slice(0, Math.floor(maxBytes / 4)) },
    dataBytes, dataTruncated: dataBytes > maxBytes };
}
export type TrajectoryPreview = TrajectoryEvent & { dataBytes: number; dataTruncated: boolean };
export interface TrajectoryPage { events: TrajectoryPreview[]; total: number; nextBefore: number | null; file: string }

/** One writer owns the directory; appends are flushed before an action proceeds. */
export class TrajectoryStore implements TrajectorySink {
  private readonly tails = new Map<SessionId, { seq: number; hash: string }>();
  private queue: Promise<void> = Promise.resolve();
  private poisoned: unknown;
  private readonly pages = new Map<string, { signature: string; result: Promise<TrajectoryPage> }>();
  readonly root: string;

  constructor(root: string, readonly engagementId: EngagementId, readonly redactor: Redactor,
    private readonly now = () => new Date()) {
    this.root = resolve(root);
  }

  async append(sessionId: SessionId, type: string, data: Json): Promise<TrajectoryEvent> {
    safeSession(sessionId);
    const clean = this.redactor.json(data);
    let event: TrajectoryEvent | undefined;
    const next = this.queue.then(async () => {
      if (this.poisoned) throw new PentestError('TRAJECTORY_UNAVAILABLE', 'Trajectory writes stopped after a durability failure', { cause: this.poisoned });
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      let tail = this.tails.get(sessionId);
      if (!tail) {
        const verified = await this.scan(sessionId, () => {});
        tail = { seq: verified.total - 1, hash: verified.hash };
      }
      const unsigned = { seq: tail.seq + 1, timestamp: this.now().toISOString(), engagementId: this.engagementId,
        sessionId, type, data: clean, previousHash: tail.hash };
      event = { ...unsigned, hash: digest(unsigned) };
      const file = await open(join(this.root, `${sessionId}.jsonl`), 'a', 0o600);
      try { await file.writeFile(`${canonical(event)}\n`); await file.sync(); }
      finally { await file.close(); }
      this.tails.set(sessionId, { seq: event.seq, hash: event.hash });
    });
    this.queue = next.catch(error => { this.poisoned = error; });
    await next;
    if (!event) throw new PentestError('TRAJECTORY_UNAVAILABLE', 'Trajectory event was not committed');
    return event;
  }

  /** Verify the entire chain before returning any event to consumers. */
  async read(sessionId: SessionId): Promise<TrajectoryEvent[]> {
    const path = join(this.root, `${safeSession(sessionId)}.jsonl`);
    let source: string;
    try { source = await readFile(path, 'utf8'); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    if (source && !source.endsWith('\n')) throw new PentestError('TRAJECTORY_CORRUPT', 'Trajectory has an interrupted tail; the original file was preserved');
    const result: TrajectoryEvent[] = [];
    let previousHash = '0'.repeat(64);
    for (const line of source.split('\n').filter(Boolean)) {
      let value: TrajectoryEvent;
      try { value = JSON.parse(line) as TrajectoryEvent; }
      catch (cause) { throw new PentestError('TRAJECTORY_CORRUPT', 'Invalid trajectory JSON', { cause }); }
      if (!value || typeof value !== 'object') throw new PentestError('TRAJECTORY_CORRUPT', 'Invalid trajectory record');
      const { hash, ...unsigned } = value;
      if (value.seq !== result.length || value.previousHash !== previousHash || value.sessionId !== sessionId
        || value.engagementId !== this.engagementId || digest(unsigned) !== hash) {
        throw new PentestError('TRAJECTORY_CORRUPT', 'Trajectory integrity verification failed');
      }
      result.push(value);
      previousHash = hash;
    }
    return result;
  }

  /** Verify a fixed file prefix while retaining only the consumer's selected events. */
  private async scan(sessionId: SessionId, consume: (event: TrajectoryEvent) => void): Promise<{ total: number; hash: string }> {
    const path = join(this.root, `${safeSession(sessionId)}.jsonl`);
    let size: number;
    try { size = (await stat(path)).size; }
    catch (error) { if (isMissing(error)) return { total: 0, hash: '0'.repeat(64) }; throw error; }
    if (!size) return { total: 0, hash: '0'.repeat(64) };
    const file = await open(path, 'r');
    try {
      const end = Buffer.alloc(1); await file.read(end, 0, 1, size - 1);
      if (end[0] !== 10) throw new PentestError('TRAJECTORY_CORRUPT', 'Trajectory has an interrupted tail; the original file was preserved');
    } finally { await file.close(); }
    const stream = createReadStream(path, { end: size - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let total = 0, hash = '0'.repeat(64);
    try {
      for await (const line of lines) {
        if (!line) continue;
        let event: TrajectoryEvent;
        try { event = JSON.parse(line) as TrajectoryEvent; }
        catch (cause) { throw new PentestError('TRAJECTORY_CORRUPT', 'Invalid trajectory JSON', { cause }); }
        if (!event || typeof event !== 'object') throw new PentestError('TRAJECTORY_CORRUPT', 'Invalid trajectory record');
        const { hash: nextHash, ...unsigned } = event;
        if (event.seq !== total || event.previousHash !== hash || event.sessionId !== sessionId
          || event.engagementId !== this.engagementId || digest(unsigned) !== nextHash) {
          throw new PentestError('TRAJECTORY_CORRUPT', 'Trajectory integrity verification failed');
        }
        consume(event); total++; hash = nextHash;
      }
    } finally { lines.close(); stream.destroy(); }
    return { total, hash };
  }

  /** Latest/older verified previews, cached only while file identity and timestamps match. */
  async page(sessionId: SessionId, before?: number, limit = 100): Promise<TrajectoryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || before !== undefined && (!Number.isInteger(before) || before < 0)) throw new PentestError('TRAJECTORY_PAGE', 'Invalid trajectory page');
    const file = join(this.root, `${safeSession(sessionId)}.jsonl`), key = `${sessionId}:${before ?? 'latest'}:${limit}`;
    const info = await stat(file, { bigint: true }).catch(error => { if (isMissing(error)) return null; throw error; });
    if (!info) return { events: [], total: 0, nextBefore: null, file };
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = this.pages.get(key); if (cached?.signature === signature) return cached.result;
    const result = (async () => {
      const events: TrajectoryPreview[] = [];
      const { total } = await this.scan(sessionId, event => {
        if (before !== undefined && event.seq >= before) return;
        events.push({ ...event, ...previewData(event.data) });
        if (events.length > limit) events.shift();
      });
      return { events, total, nextBefore: events[0]?.seq ? events[0].seq : null, file };
    })();
    this.pages.delete(key); this.pages.set(key, { signature, result });
    while (this.pages.size > 8) this.pages.delete(this.pages.keys().next().value!);
    try { return await result; }
    catch (error) { if (this.pages.get(key)?.result === result) this.pages.delete(key); throw error; }
  }

  /** Read original event data in small text chunks after verifying the entire chain. */
  async detail(sessionId: SessionId, seq: number, offset = 0): Promise<{ text: string; offset: number; nextOffset: number | null; totalChars: number }> {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(offset) || offset < 0) throw new PentestError('TRAJECTORY_PAGE', 'Invalid event position');
    let text: string | undefined;
    await this.scan(sessionId, event => { if (event.seq === seq) text = JSON.stringify(this.redactor.json(event.data), null, 2); });
    if (text === undefined) throw new PentestError('TRAJECTORY_EVENT', 'Trajectory event does not exist');
    if (offset > text.length) throw new PentestError('TRAJECTORY_PAGE', 'Event position is beyond its saved data');
    const end = Math.min(offset + 16384, text.length);
    return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
  }

  async sessions(): Promise<SessionId[]> {
    try { return (await readdir(this.root)).filter(name => /^[a-zA-Z0-9_-]{1,128}\.jsonl$/.test(name)).map(name => name.slice(0, -6) as SessionId); }
    catch (error) { if (isMissing(error)) return []; throw error; }
  }
  async flush(): Promise<void> {
    await this.queue;
    if (this.poisoned) throw new PentestError('TRAJECTORY_UNAVAILABLE', 'Trajectory could not be flushed', { cause: this.poisoned });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class EvidenceStore {
  constructor(private readonly root: string, private readonly redactor: Redactor) {}

  /** Read only a content-addressed blob whose bytes still match the retained digest. */
  async read(evidence: Evidence): Promise<Json> {
    if (!/^[a-f0-9]{64}$/.test(evidence.contentHash) || evidence.pointer !== `blobs/${evidence.contentHash}`)
      throw new PentestError('EVIDENCE_POINTER', 'Invalid evidence pointer');
    const bytes = await readFile(join(this.root, evidence.pointer));
    if (createHash('sha256').update(bytes).digest('hex') !== evidence.contentHash)
      throw new PentestError('EVIDENCE_CORRUPT', 'Evidence digest verification failed');
    return this.redactor.json(JSON.parse(bytes.toString('utf8')));
  }

  /** Evidence is redacted before hashing, storage, graph import, or export. */
  async put(value: Json, tool: string, identityId?: IdentityId): Promise<Evidence> {
    const bytes = Buffer.from(canonical(this.redactor.json(value)));
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const pointer = `blobs/${contentHash}`;
    await mkdir(join(this.root, 'blobs'), { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(join(this.root, pointer), 'wx', 0o600); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    if (file) {
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
    }
    return { id: id<'EvidenceId'>(), contentHash, pointer, mediaType: 'application/json', tool,
      observedAt: new Date().toISOString(), ...(identityId ? { identityId } : {}) };
  }
}
