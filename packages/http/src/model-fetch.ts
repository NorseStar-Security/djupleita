/** Provider fetch confinement, scoped to the DSH llm/stream lifetime. */
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { PentestError } from '@dsh-pentest/contracts';
import type { ScopeService } from '@dsh-pentest/scope';
import type { Redactor } from '@dsh-pentest/trajectory';

interface ModelContext { scope: ScopeService; signal: AbortSignal; providerScope?: ScopeService }
/** Only fetches performed by a model stream enter this broker. Other DSH services
 * retain their normal transport. Native-HTTP provider plugins need their own adapter. */
export class ModelFetchBroker {
  private readonly context = new AsyncLocalStorage<ModelContext>();
  private readonly original = globalThis.fetch;
  private installed = false;
  constructor(private readonly redactor: Redactor) {}
  private readonly fetch: typeof globalThis.fetch = (input, init) => {
    const context = this.context.getStore();
    return context ? this.request(new Request(input, init), context) : this.original(input, init);
  };
  install(): () => void {
    if (this.installed) throw new PentestError('MODEL_TRANSPORT', 'Model fetch broker is already installed');
    this.installed = true; globalThis.fetch = this.fetch;
    return () => { if (globalThis.fetch === this.fetch) globalThis.fetch = this.original; this.installed = false; };
  }
  run<T>(scope: ScopeService, signal: AbortSignal, operation: () => T, providerScope?: ScopeService): T {
    return this.context.run({ scope, signal, ...(providerScope ? { providerScope } : {}) }, operation);
  }
  private async request(input: Request, context: ModelContext): Promise<Response> {
    const signal = AbortSignal.any([context.signal, input.signal]); signal.throwIfAborted();
    const destination = { url: input.url, purpose: 'model' as const };
    let scopes = context.scope;
    if (context.providerScope) {
      try { context.providerScope.check(destination); scopes = context.providerScope; }
      catch (error) { if (!(error instanceof PentestError) || error.code !== 'OUT_OF_SCOPE') throw error; }
    }
    const grant = await scopes.authorize(destination, signal);
    const address = grant.addresses[0]!;
    const headers = Object.fromEntries(input.headers);
    for (const [name, value] of input.headers) if (/authorization|api[-_]?key|cookie/i.test(name)) {
      this.redactor.register(value); if (/^Bearer /i.test(value)) this.redactor.register(value.slice(7));
    }
    delete headers.host; delete headers.connection; delete headers['content-length'];
    headers['accept-encoding'] = 'identity';
    return new Promise((resolve, reject) => {
      const request = (grant.url.protocol === 'https:' ? https : http).request(grant.url, {
        method: input.method, headers, signal, agent: false, family: address.family,
        lookup: (_name, _options, callback) => callback(null, address.address, address.family),
      }, incoming => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400 && incoming.headers.location) {
          incoming.destroy(); reject(new PentestError('MODEL_REDIRECT', 'Model endpoint redirects are refused; configure the final URL in Models')); return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(key, entry);
        }
        let body: Readable = incoming;
        const encoding = responseHeaders.get('content-encoding');
        if (encoding === 'gzip' || encoding === 'br' || encoding === 'deflate') {
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : createInflate();
          incoming.on('error', error => decoder.destroy(error)); body = incoming.pipe(decoder);
          responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
        }
        resolve(new Response(input.method === 'HEAD' || [204, 205, 304].includes(status) ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>,
          { status, headers: responseHeaders }));
      });
      request.once('error', reject);
      if (input.body) Readable.fromWeb(input.body as import('node:stream/web').ReadableStream).on('error', error => request.destroy(error)).pipe(request);
      else request.end();
    });
  }
}
