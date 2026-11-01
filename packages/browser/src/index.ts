/** Playwright contexts with all browser sockets disabled and every request brokered. */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir, writeFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { PentestError, id } from '@dsh-pentest/contracts';
import type { IdentityId, Json, SessionId } from '@dsh-pentest/contracts';
import type { HttpBroker, HttpInput } from '@dsh-pentest/http';
import type { IdentityService } from '@dsh-pentest/identities';
import type { ScopeService } from '@dsh-pentest/scope';
import { matchesHost } from '@dsh-pentest/scope';
import type { ApprovalAnswerer } from '@dsh-pentest/policy';
import type { EvidenceStore, Redactor, TrajectoryStore } from '@dsh-pentest/trajectory';
import type { CrawlService } from '@dsh-pentest/crawl';
import { sandboxProfile } from '@dsh-pentest/worker';

export const BrowserInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('navigate'), url: z.url() }),
  z.object({ operation: z.literal('snapshot') }),
  z.object({ operation: z.literal('click'), selector: z.string().min(1).max(1000) }),
  z.object({ operation: z.literal('fill'), selector: z.string().min(1).max(1000), value: z.string().max(65536) }),
]);
export type BrowserInput = z.infer<typeof BrowserInputSchema>;
export interface BrowserConfig { root: string; executable?: string | undefined; headless?: boolean | undefined }
/** Resolve the same pinned browser path for setup checks and launch. */
export function browserExecutable(config: Pick<BrowserConfig, 'executable' | 'headless'>): string {
  if (config.executable) return config.executable;
  const standard = chromium.executablePath();
  return (config.headless ?? true) ? standard.replace(/chromium-(\d+)\/chrome-mac-(arm64|x64)\/.+$/, 'chromium_headless_shell-$1/chrome-headless-shell-mac-$2/chrome-headless-shell') : standard;
}
interface Handle { context: BrowserContext; page: Page; identityId?: IdentityId; approve?: ApprovalAnswerer; signal: AbortSignal }
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class BrowserService {
  private browser?: Browser;
  private starting?: Promise<Browser>;
  private temporary?: string;
  private readonly busy = new Set<string>();
  private readonly handles = new Map<string, Promise<Handle>>();
  constructor(private readonly config: BrowserConfig, private readonly scope: ScopeService,
    private readonly http: (session: SessionId) => HttpBroker, private readonly identities: IdentityService,
    private readonly trajectories: TrajectoryStore, private readonly evidence: EvidenceStore,
    private readonly redactor: Redactor, private readonly crawl: (session: SessionId) => CrawlService,
    private readonly revocation: AbortSignal) {}

  async execute(input: BrowserInput, session: SessionId, identityId: IdentityId | undefined,
    signal: AbortSignal, approve?: ApprovalAnswerer): Promise<Json> {
    BrowserInputSchema.parse(input);
    const operation = new AbortController();
    const merged = AbortSignal.any([signal, this.revocation, operation.signal]); merged.throwIfAborted();
    const key = `${session}/${identityId ?? 'anonymous'}`;
    if (this.busy.has(key)) throw new PentestError('BROWSER_BUSY', 'This chat and identity already have a browser operation running');
    this.busy.add(key);
    try {
    let pending = this.handles.get(key);
    if (!pending) { pending = this.open(session, identityId, merged); this.handles.set(key, pending); pending.catch(() => this.handles.delete(key)); }
    const handle = await pending;
    handle.signal = merged; if (approve) handle.approve = approve; else delete handle.approve;
    const cancel = () => { this.handles.delete(key); void handle.context.close(); };
    merged.addEventListener('abort', cancel, { once: true });
    try {
      if (input.operation === 'navigate') { this.scope.check({ url: input.url, purpose: 'target' }); await handle.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      if (input.operation === 'click') await handle.page.locator(input.selector).click({ timeout: 5000 });
      if (input.operation === 'fill') {
        this.redactor.register(input.value);
        await handle.page.locator(input.selector).fill(input.value, { timeout: 5000 });
      }
      merged.throwIfAborted();
      const snapshot = await handle.page.evaluate(() => ({
        url: location.href, title: document.title, text: document.body?.innerText.slice(0, 100000) ?? '',
        links: [...document.querySelectorAll('a[href],form[action],script[src],iframe[src]')].slice(0, 2000).map(element => ({
          tag: element.tagName.toLowerCase(), text: element.textContent?.slice(0, 200) ?? '',
          url: new URL(element.getAttribute('href') ?? element.getAttribute('action') ?? element.getAttribute('src') ?? '', location.href).href,
        })),
      }));
      const clean = this.redactor.json(snapshot);
      const evidence = await this.evidence.put(clean, 'playwright', identityId);
      this.crawl(session).observe(snapshot.links.map(link => link.url), 'browser', {
        url: snapshot.url, source: 'browser', depth: 0, score: 1, ...(identityId ? { identityId } : {}),
      }, evidence.id);
      await this.trajectories.append(session, 'browser/observation', this.redactor.json({ operation: input.operation, evidence, url: snapshot.url }));
      return { snapshot: clean, evidence: { ...evidence } };
    } finally { merged.removeEventListener('abort', cancel); }
    } finally { operation.abort(new PentestError('BROWSER_SETTLED', 'Browser operation has finished')); this.busy.delete(key); }
  }

  private async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (process.platform !== 'darwin') throw new PentestError('BROWSER_SANDBOX', 'The browser worker requires the macOS sandbox backend');
      await mkdir(this.config.root, { recursive: true, mode: 0o700 });
      const root = await realpath(this.config.root);
      // macOS Unix socket names have a 103-byte limit. Keep the browser's
      // temporary socket directory private and short even for long engagement paths.
      const temporary = this.temporary ??= await mkdtemp('/private/tmp/dsh-chrome-');
      // Playwright's headless shell avoids Chromium's macOS process singleton,
      // which writes to the user's system-selected temp directory regardless of
      // TMPDIR. Its path is derived from the pinned Playwright browser revision.
      const executable = await realpath(browserExecutable(this.config));
      const wrapper = join(root, `chromium-${id<'ProcessId'>()}.sh`);
      await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${shell(sandboxProfile({ writableRoots: [root, temporary], unixSocketRoots: [temporary, root], readableRoots: [dirname(dirname(dirname(executable)))] }))} ${shell(executable)} "$@"\n`, { mode: 0o700, flag: 'wx' });
      const primary = await chromium.launchPersistentContext(join(root, 'profile'), { executablePath: wrapper, headless: this.config.headless ?? true,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, TMPDIR: temporary }, downloadsPath: root,
        args: ['--disable-crash-reporter', '--disable-background-networking', '--disable-component-update', '--disable-quic', '--disable-webrtc', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      this.browser = primary.browser()!;
      return this.browser;
    })();
    try { return await this.starting; } finally { delete this.starting; }
  }
  private async open(session: SessionId, identityId: IdentityId | undefined, signal: AbortSignal): Promise<Handle> {
    const browser = await this.launch(); signal.throwIfAborted();
    const identity = identityId ? this.identities.get(identityId) : undefined;
    let storageState: Exclude<NonNullable<Parameters<Browser['newContext']>[0]>['storageState'], string>;
    if (identityId && identity?.kind === 'browser-state') {
      const state = await this.identities.browserState(identityId, signal);
      const parsed = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
        expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']) })),
        origins: z.array(z.object({ origin: z.url(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })) })) }).parse(state);
      for (const cookie of parsed.cookies) {
        const hostname = cookie.domain.replace(/^\./, '');
        if (!identity.hosts.some(host => matchesHost(hostname, host))) throw new PentestError('COOKIE_SCOPE', 'Cookie domain is outside the identity host binding');
        this.scope.check({ url: `https://${hostname}${cookie.path}`, purpose: 'target' }); this.redactor.register(cookie.value);
      }
      for (const origin of parsed.origins) {
        this.scope.check({ url: origin.origin, purpose: 'target' });
        if (!identity.hosts.some(host => matchesHost(new URL(origin.origin).hostname, host))) throw new PentestError('STORAGE_SCOPE', 'Storage origin is outside the identity host binding');
        for (const item of origin.localStorage) if (item.value) this.redactor.register(item.value);
      }
      storageState = parsed;
    }
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [], ...(storageState ? { storageState } : {}) });
    const page = await context.newPage();
    const handle: Handle = { context, page, signal, ...(identityId ? { identityId } : {}) };
    await context.routeWebSocket('**/*', route => route.close({ code: 1008, reason: 'WebSocket transport needs an explicit scoped adapter' }));
    await context.route('**/*', async route => {
      try {
        handle.signal.throwIfAborted();
        const request = route.request(), url = new URL(request.url());
        if (!['http:', 'https:'].includes(url.protocol)) { await route.abort('blockedbyclient'); return; }
        const rawHeaders = await request.allHeaders(), headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(rawHeaders)) if (!/^(authorization|cookie|proxy-authorization|host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(name)) headers[name] = value;
        const bound = !identity || identity.hosts.some(host => matchesHost(url.hostname, host));
        const credentials: Record<string, string> = {};
        if (bound && rawHeaders.cookie) {
          credentials.cookie = rawHeaders.cookie;
          for (const item of rawHeaders.cookie.split(';')) { const value = item.slice(item.indexOf('=') + 1).trim(); if (value) this.redactor.register(value); }
        }
        const body = request.postDataBuffer();
        const input: HttpInput = { url: url.href, method: HttpMethod.parse(request.method()), headers,
          ...(body ? { body: body.toString('base64'), bodyEncoding: 'base64' } : {}),
          ...(bound && identityId && identity?.kind !== 'browser-state' ? { identityId } : {}) };
        const delivered = await this.http(session).deliver(input, session, handle.signal, handle.approve, credentials, false);
        for (const value of (delivered.response.headers['set-cookie'] ?? '').split('\n')) {
          const secret = value.split(';')[0]?.split('=').slice(1).join('='); if (secret) this.redactor.register(secret);
        }
        this.crawl(session).record(delivered.result, { url: url.href, source: 'browser', depth: 0, score: 1, ...(identityId ? { identityId } : {}) });
        const responseHeaders = { ...delivered.response.headers };
        delete responseHeaders['content-length']; delete responseHeaders['transfer-encoding'];
        await route.fulfill({ status: delivered.response.status, headers: responseHeaders, body: delivered.response.bytes ?? Buffer.from(delivered.response.body) });
      } catch (error) {
        await this.trajectories.append(session, 'browser/blocked', this.redactor.json({ url: route.request().url(), reason: error instanceof Error ? error.message : 'Browser request blocked' }));
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    page.on('popup', popup => { void popup.close(); });
    return handle;
  }
  async close(): Promise<void> { this.handles.clear(); if (this.starting) await this.starting.catch(() => undefined); await this.browser?.close(); delete this.browser;
    if (this.temporary) { await rm(this.temporary, { recursive: true, force: true }); delete this.temporary; } }
}
const HttpMethod = z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
