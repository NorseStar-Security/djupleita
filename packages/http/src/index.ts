/** Policy-gated HTTP with checked redirects and DNS-pinned sockets. */
export { ModelFetchBroker } from './model-fetch.ts';
import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { PentestError, id, canonical, digest } from '@dsh-pentest/contracts';
import type { Action, Effect, Evidence, IdentityId, Json, SessionId, Purpose } from '@dsh-pentest/contracts';
import type { EngagementService } from '@dsh-pentest/engagement';
import type { IdentityService } from '@dsh-pentest/identities';
import type { ApprovalAnswerer, PolicyService } from '@dsh-pentest/policy';
import type { ConnectionGrant, ScopeService } from '@dsh-pentest/scope';
import type { EvidenceStore, Redactor, TrajectoryStore } from '@dsh-pentest/trajectory';

export const HttpInputSchema = z.object({
  url: z.url(), method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']),
  headers: z.record(z.string(), z.string()).default({}), body: z.string().optional(), bodyEncoding: z.enum(['utf8', 'base64']).optional(), identityId: z.string().uuid().optional(),
});
export type HttpInput = Omit<z.infer<typeof HttpInputSchema>, 'identityId'> & { identityId?: IdentityId };
export interface HttpResult {
  url: string; status: number; headers: Record<string, string>; body: string;
  evidence: Evidence; actionId: string; durationMs: number;
}
export interface HttpConfig { timeoutMs: number; maxRedirects: number; maxRequestBytes: number }
export interface RawResponse { status: number; headers: Record<string, string>; body: string; bytes?: Buffer }
export interface DeliveredResponse { result: HttpResult; response: RawResponse }
export interface HttpObserver {
  before(input: HttpInput, session: SessionId, actionId: string): void;
  after(input: HttpInput, session: SessionId, result: HttpResult | undefined, actionId: string): void;
  signal?(session: SessionId): AbortSignal | undefined;
}
export type Transport = (grant: ConnectionGrant, input: HttpInput, headers: Record<string, string>, limit: number, signal: AbortSignal) => Promise<RawResponse>;

/** Metadata is derived by the adapter; callers cannot label a delete as a read. */
export function classifyHttp(input: HttpInput): { effects: Effect[]; reversible: boolean } {
  const parsed = new URL(input.url);
  let path = `${parsed.pathname}${parsed.search}`;
  try { path = decodeURIComponent(path); } catch { /* Preserve malformed input for policy review. */ }
  const semantics = `${path}\n${input.bodyEncoding === 'base64' ? Buffer.from(input.body ?? '', 'base64').toString('utf8') : input.body ?? ''}`;
  if (endsSession(input)) return { effects: ['disrupt'], reversible: false };
  if (input.method === 'DELETE' || /(?:\b|[_/])(?:delete|remove|destroy|drop|truncate|purge|wipe)(?:[A-Z_\s/(]|\b)/i.test(semantics)) {
    return { effects: ['delete'], reversible: false };
  }
  if (input.method === 'PUT') return { effects: ['overwrite'], reversible: false };
  if (['GET', 'HEAD', 'OPTIONS'].includes(input.method)) return { effects: ['read'], reversible: true };
  return { effects: ['modify'], reversible: true };
}

/** Method/effect metadata comes from the adapter, never from a caller's research label. */
export function httpDestination(input: HttpInput, access: 'read' | 'active' = 'read') {
  const read = access === 'read' && input.body === undefined && classifyHttp(input).effects.every(effect => effect === 'read');
  return { url: input.url, purpose: 'target' as const, access: read ? 'read' as const : 'active' as const };
}

/** Applies to routed page scripts too; a GET can revoke a session. */
export function endsSession(input: HttpInput): boolean {
  const url = new URL(input.url);
  let text = `${url.pathname}${url.search}\n${input.bodyEncoding === 'base64' ? Buffer.from(input.body ?? '', 'base64').toString('utf8') : input.body ?? ''}`;
  for (let i = 0; i < 2; i++) { try { text = decodeURIComponent(text); } catch { break; } }
  return /(?:^|[^a-z])(?:log[\s_-]?out|sign[\s_-]?out|revoke|invalidate[\s_-]?(?:session|token)|destroy[\s_-]?session)(?:[^a-z]|$)/i.test(text);
}

function publicHeaders(headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)
      || /^(authorization|cookie|proxy-authorization|host|connection|content-length|transfer-encoding)$/i.test(key)) {
      throw new PentestError('UNSAFE_HEADER', 'Use an identity reference for credentials; routing headers are broker-owned');
    }
  }
}

/** The lookup callback returns the approved IP, while TLS retains the URL hostname. */
export const pinnedTransport: Transport = async (grant, input, headers, limit, signal) => {
  if (!['http:', 'https:'].includes(grant.url.protocol)) throw new PentestError('HTTP_PROTOCOL', 'HTTP transport requires an HTTP or HTTPS URL');
  const address = grant.addresses[0];
  if (!address) throw new PentestError('DNS_EMPTY', 'No approved connection address');
  return new Promise((resolve, reject) => {
    const transport = grant.url.protocol === 'https:' ? https : http;
    const request = transport.request(grant.url, {
      method: input.method, headers: { ...headers, 'accept-encoding': 'identity' }, signal, agent: false,
      family: address.family,
      lookup: (_name, _options, callback) => callback(null, address.address, address.family),
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { response.destroy(new PentestError('RESPONSE_LIMIT', 'Response exceeded the engagement byte limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const resultHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) resultHeaders[key] = Array.isArray(value) ? value.join('\n') : value;
        }
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: resultHeaders, body: bytes.toString('utf8'), bytes });
      });
    });
    request.on('error', reject);
    if (input.body !== undefined) request.end(Buffer.from(input.body, input.bodyEncoding ?? 'utf8')); else request.end();
  });
};

export class HttpBroker {
  constructor(private readonly config: HttpConfig, private readonly engagement: EngagementService,
    private readonly scope: ScopeService, private readonly policy: PolicyService,
    private readonly identities: IdentityService, private readonly trajectory: TrajectoryStore,
    private readonly evidence: EvidenceStore, private readonly redactor: Redactor,
    private readonly transport: Transport = pinnedTransport, private readonly revocation?: AbortSignal, private readonly defaultApproval?: ApprovalAnswerer,
    private readonly observer?: HttpObserver) {
    if (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 0 || config.timeoutMs <= 0 || config.maxRequestBytes <= 0) {
      throw new PentestError('HTTP_CONFIG', 'Invalid HTTP broker configuration');
    }
  }

  async request(raw: HttpInput, sessionId: SessionId, callerSignal: AbortSignal, approve?: ApprovalAnswerer, access: 'read' | 'active' = 'read'): Promise<HttpResult> {
    return (await this.deliver(raw, sessionId, callerSignal, approve, {}, true, access)).result;
  }

  /** Trusted adapter surface: raw bytes go only to a confined browser, never the model or an exporter. */
  async deliver(raw: HttpInput, sessionId: SessionId, callerSignal: AbortSignal, approve?: ApprovalAnswerer,
    credentialHeaders: Record<string, string> = {}, followRedirects = true, access: 'read' | 'active' = 'read'): Promise<DeliveredResponse> {
    if (followRedirects && Object.keys(credentialHeaders).length) throw new PentestError('CREDENTIAL_REDIRECT', 'Adapter credentials require individual redirect handling');
    HttpInputSchema.parse(raw);
    if (!this.engagement.hasSession(sessionId)) throw new PentestError('SESSION_UNBOUND', 'Session is not attached to this engagement');
    publicHeaders(raw.headers);
    if (Buffer.from(raw.body ?? '', raw.bodyEncoding ?? 'utf8').byteLength > this.config.maxRequestBytes) throw new PentestError('REQUEST_LIMIT', 'Request body exceeded the configured byte limit');
    const runSignal = this.observer?.signal?.(sessionId);
    const lifetime = AbortSignal.any([callerSignal, ...(this.revocation ? [this.revocation] : []), ...(runSignal ? [runSignal] : [])]);
    let signal = lifetime;
    let input = structuredClone(raw);
    let parentId: string | undefined;
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const action: Action = {
        id: id<'ActionId'>(), engagementId: this.engagement.engagement.id, sessionId,
        tool: 'http_request', plugin: 'http', arguments: this.redactor.json(input),
        destinations: [httpDestination(input, access)], ...classifyHttp(input),
        ...(input.identityId ? { identityId: input.identityId } : {}), ...(parentId ? { parentId } : {}),
      };
      signal = lifetime;
      const decision = await this.policy.authorize({ action, signal }, approve ?? this.defaultApproval);
      if (endsSession(input) && decision.kind !== 'ask') {
        const answer = approve ?? this.defaultApproval;
        const allowed = Boolean(answer && await answer(action, { kind: 'ask', reasons: ['This request may end or revoke a session'],
          source: 'session-protection', policyVersion: this.policy.version, actionHash: digest(action) }, signal));
        signal.throwIfAborted();
        await this.trajectory.append(sessionId, 'http/session-end-review', { actionId: action.id, actionHash: digest(action), allowed });
        if (!allowed)
          throw new PentestError('SESSION_END_REVIEW', 'Session-ending requests require explicit owner review');
      }
      const grant = await this.scope.authorize(httpDestination(input, access), signal);
      signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.config.timeoutMs)]);
      const credentials = input.identityId ? await this.identities.headers(input.identityId, grant.url, signal) : {};
      const reservation = await this.engagement.acquire(signal);
      const started = Date.now();
      let response: RawResponse;
      let observed = false;
      try {
        this.observer?.before(input, sessionId, action.id); observed = true;
        await this.trajectory.append(sessionId, 'tool/start', this.redactor.json({ actionId: action.id, input }));
        response = await this.transport(grant, input, { ...input.headers, ...credentials, ...credentialHeaders }, this.engagement.engagement.budget.maxResponseBytes, signal);
      } catch (error) {
        if (observed) this.observer?.after(input, sessionId, undefined, action.id);
        await this.trajectory.append(sessionId, 'tool/error', { actionId: action.id,
          error: this.redactor.text(error instanceof Error ? error.message : 'HTTP request failed'), outcome: 'unknown' });
        throw error;
      } finally { reservation.release(); }
      for (const cookie of (response.headers['set-cookie'] ?? '').split('\n')) {
        const value = cookie.split(';')[0]?.split('=').slice(1).join('=');
        if (value) this.redactor.register(value);
      }
      const record = this.redactor.json({ url: grant.url.href, status: response.status, headers: response.headers, body: response.body });
      const evidence = await this.evidence.put(record, 'http_request', input.identityId);
      await this.trajectory.append(sessionId, 'tool/result', this.redactor.json({ actionId: action.id, status: response.status,
        durationMs: Date.now() - started, evidence }));
      this.observer?.after(input, sessionId, { url: grant.url.href, status: response.status, headers: record && typeof record === 'object' && !Array.isArray(record) ? record.headers as Record<string, string> : {},
        body: this.redactor.text(response.body), evidence, actionId: action.id, durationMs: Date.now() - started }, action.id);
      const location = response.headers.location;
      if (followRedirects && [301, 302, 303, 307, 308].includes(response.status) && location) {
        if (redirects >= this.config.maxRedirects) throw new PentestError('REDIRECT_LIMIT', 'Redirect limit reached');
        const target = new URL(location, grant.url);
        const crossOrigin = target.origin !== grant.url.origin;
        const method = response.status === 303 && input.method !== 'HEAD'
          || [301, 302].includes(response.status) && input.method === 'POST' ? 'GET' : input.method;
        input = { url: target.href, method, headers: crossOrigin ? {} : input.headers,
          ...(!crossOrigin && input.identityId ? { identityId: input.identityId } : {}),
          ...(method !== 'GET' && input.body !== undefined ? { body: input.body, ...(input.bodyEncoding ? { bodyEncoding: input.bodyEncoding } : {}) } : {}) };
        parentId = action.id;
        continue;
      }
      return { response, result: { url: this.redactor.text(grant.url.href), status: response.status,
        headers: this.redactor.json(response.headers) as Record<string, string>, body: this.redactor.text(response.body),
        evidence, actionId: action.id, durationMs: Date.now() - started } };
    }
  }
}

/** Scoped auxiliary API transport; redirects are refused and identity secrets stay out of payloads. */
export class ServiceJsonClient {
  constructor(private readonly scope: ScopeService, private readonly identities: IdentityService,
    private readonly redactor: Redactor, private readonly transport: Transport = pinnedTransport) {}
  async send(url: string, purpose: Exclude<Purpose, 'target'>, body: Json, signal: AbortSignal,
    identityId?: IdentityId, method: 'GET' | 'POST' = 'POST'): Promise<Json> {
    const merged = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const grant = await this.scope.authorize({ url, purpose }, merged);
    const credentials = identityId ? await this.identities.headers(identityId, grant.url, merged) : {};
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...credentials };
    const response = await this.transport(grant, { url: grant.url.href, method, headers: {},
      ...(method === 'POST' ? { body: canonical(this.redactor.json(body)) } : {}) }, headers, 4 * 1024 * 1024, merged);
    if (response.status < 200 || response.status >= 300) throw new PentestError(`SERVICE_HTTP_${response.status}`, `Auxiliary service returned HTTP ${response.status}; redirects are not followed`);
    return response.body.trim() ? this.redactor.json(JSON.parse(response.body)) : null;
  }
}
