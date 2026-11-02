/** Managed REA MCP integration; static analysis remains offline inside OS confinement. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export type { Tool as ReaTool } from '@modelcontextprotocol/sdk/types.js';
import { mkdir, readFile, realpath, mkdtemp, rm, copyFile, chmod } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PentestError, digest } from '@dsh-pentest/contracts';
import type { Effect, Json, SessionId } from '@dsh-pentest/contracts';
import type { AttackGraph } from '@dsh-pentest/graph';
import { graphId } from '@dsh-pentest/graph';
import type { CrawlService } from '@dsh-pentest/crawl';
import type { EvidenceStore, Redactor, TrajectoryStore } from '@dsh-pentest/trajectory';
import { prepareSandbox, workerEnvironment, runWorker, validateExecutable } from '@dsh-pentest/worker';
import { REA_VERSION, supportedReaNode } from './install.ts';
import { jdkNativeDependencies } from './macos.ts';
import { jdkLinuxDependencies } from './linux.ts';
export { REA_VERSION, supportedReaNode, checkReaNode, installReaNode, installRea } from './install.ts';

export const ReaConfigSchema = z.object({ node: z.string(), packageRoot: z.string(), roots: z.array(z.string()).min(1),
  ghidra: z.string().optional(), javaHome: z.string().optional(), timeoutMs: z.number().int().min(1000).max(1800000).default(240000) });
export type ReaConfig = z.infer<typeof ReaConfigSchema>;
const STATIC = new Set(['binary_session', 'open_binary', 'close_binary', 'inspect_artifact', 'analyze_javascript_application',
  'analyze_web_bundle', 'get_evidence_bundle', 'inspect_analysis_view', 'list_procedures', 'list_strings', 'search_strings',
  'search_procedures', 'procedure_pseudo_code', 'procedure_assembly', 'analyze_function', 'get_call_graph', 'trace_call_path',
  'list_segments', 'read_bytes', 'address_to_file_offset', 'compare_artifacts', 'compare_functions', 'match_native_functions',
  'get_metadata', 'get_imports', 'get_exports', 'get_xrefs', 'list_symbols', 'inspect_managed_assembly']);
export const ReaCatalogInputSchema = z.object({
  query: z.string().max(120).optional(), tool: z.string().min(1).max(120).optional(),
  schemaPath: z.array(z.string().max(120)).max(16).default([]),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(15),
});
export function reaCatalogPage(tools: Tool[], input: unknown): Json {
  const options = ReaCatalogInputSchema.parse(input);
  if (options.tool) {
    const tool = tools.find(tool => tool.name === options.tool);
    if (!tool) return { error: 'Tool is not advertised by the pinned REA server', query: options.tool,
      suggestions: tools.filter(tool => tool.name.includes(options.tool!.split('_').at(-1)!)).slice(0, 15).map(tool => tool.name) };
    let schema: unknown = tool.inputSchema;
    for (const key of options.schemaPath) {
      if (!schema || typeof schema !== 'object' || !Object.hasOwn(schema, key)) throw new PentestError('REA_SCHEMA_PATH', 'Schema path does not exist');
      schema = (schema as Record<string, unknown>)[key];
    }
    const bytes = Buffer.byteLength(JSON.stringify(schema));
    return { name: tool.name, description: tool.description ?? '', effectPolicy: reaEffects(tool.name), schemaPath: options.schemaPath,
      ...(bytes <= 32768 ? { inputSchema: schema as Json } : { schemaBytes: bytes, schemaOmitted: true,
        schemaKeys: Object.keys(schema as object).slice(0, 50),
        propertyNames: Object.keys((schema as Record<string, object>).properties ?? {}).slice(0, 80),
        nextStep: 'Request a narrower schemaPath, such as ["properties", "path"].' }) };
  }
  const query = options.query?.toLowerCase();
  const matches = tools.filter(tool => !query || `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query));
  const page = matches.slice(options.offset, options.offset + options.limit);
  return { total: tools.length, matched: matches.length, offset: options.offset,
    nextOffset: options.offset + page.length < matches.length ? options.offset + page.length : null,
    tools: page.map(tool => ({ name: tool.name, description: (tool.description ?? '').slice(0, 500),
      required: (tool.inputSchema.required ?? []) as string[], parameters: Object.keys(tool.inputSchema.properties ?? {}) })),
    nextStep: 'Request tool with the exact advertised name for its inputSchema. For archives/DMG: open_binary({path}), then inspect_artifact({detail:"summary"}); Ghidra is needed only for native deep analysis.' };
}
export function reaEffects(name: string): { effects: Effect[]; reversible: boolean } {
  if (/delete|remove|clear|reset|discard|overwrite/i.test(name)) return { effects: ['delete'], reversible: false };
  return STATIC.has(name) ? { effects: ['read', 'create'], reversible: true } : { effects: ['unknown'], reversible: false };
}
export function observedUrls(value: unknown): string[] {
  const urls = new Set<string>(); let visited = 0;
  const walk = (item: unknown, depth: number) => {
    if (++visited > 100000 || depth > 30) return;
    if (typeof item === 'string') for (const match of item.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
      try { const url = new URL(match[0]); if (!url.username && !url.password) urls.add(url.href); } catch { /* Ignore invalid evidence hints. */ }
    }
    else if (Array.isArray(item)) for (const child of item) walk(child, depth + 1);
    else if (item && typeof item === 'object') for (const child of Object.values(item)) walk(child, depth + 1);
  }; walk(value, 0); return [...urls];
}
export class ReaService {
  private client?: Client;
  private transport?: StdioClientTransport;
  private opening?: Promise<void>;
  private temporary?: string;
  private ghidra?: string;
  private javaHome?: string;
  private ownershipHelper?: Promise<void>;
  private javaDependencies?: Promise<string[]>;
  private readonly tools = new Map<string, Tool>();
  private queue = Promise.resolve();
  constructor(readonly config: ReaConfig, private readonly root: string, private readonly graph: AttackGraph,
    private readonly evidence: EvidenceStore, private readonly trajectories: TrajectoryStore,
    private readonly redactor: Redactor, private readonly crawl: (session: SessionId) => CrawlService) { ReaConfigSchema.parse(config); }

  private env(): Record<string, string> { return { HOME: this.root, TMPDIR: this.temporary ?? this.root,
    PATH: `${join(this.temporary ?? this.root, 'bin')}:${dirname(this.config.node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...(process.platform === 'darwin' ? { DEVELOPER_DIR: '/Library/Developer/CommandLineTools', CLANG_MODULE_CACHE_PATH: join(this.temporary ?? this.root, 'clang-cache'),
    SWIFT_MODULECACHE_PATH: join(this.temporary ?? this.root, 'swift-cache'),
    REA_DARWIN_SWIFTC_PATH: '/Library/Developer/CommandLineTools/usr/bin/swiftc',
    SDKROOT: '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk', REA_DARWIN_MODULE_CACHE_PATH: join(this.temporary ?? this.root, 'swift-cache'),
    } : {}), REA_MCP_INPUT_SCHEMA_PROFILE: 'full', REA_MCP_OUTPUT_SCHEMA_PROFILE: 'full', REA_MCP_MAX_RESPONSE_BYTES: '10485760',
    GHIDRA_HEADLESS_MAXMEM: '2G', REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: '60',
    ...(this.ghidra ? { GHIDRA_INSTALL_DIR: this.ghidra, REA_ANALYSIS_PROVIDER: 'ghidra' } : {}),
    ...(this.javaHome ? { JAVA_HOME: this.javaHome } : {}) }; }
  private async paths(): Promise<{ node: string; entry: string; readableRoots: string[] }> {
    if (!['darwin', 'linux'].includes(process.platform)) throw new PentestError('REA_PLATFORM', 'REA supports macOS and Linux hosts');
    const node = await validateExecutable(this.config.node), packageRoot = await realpath(this.config.packageRoot);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== 'rea-agents' || manifest.version !== REA_VERSION) throw new PentestError('REA_VERSION', `Expected rea-agents ${REA_VERSION}; configure its installed package root`);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.temporary ??= await mkdtemp(process.platform === 'darwin' ? '/private/tmp/dsh-rea-' : join(tmpdir(), 'dsh-rea-'));
    // macOS ships /bin/ps setuid; Seatbelt refuses launching a setuid image.
    // REA only needs an unprivileged process snapshot for ownership/cleanup.
    // Copy the trusted system utility privately and drop elevation on the copy.
    if (process.platform === 'darwin') await (this.ownershipHelper ??= (async () => {
      const bin = join(this.temporary!, 'bin'); await mkdir(bin, { recursive: true, mode: 0o700 });
      await copyFile('/bin/ps', join(bin, 'ps')); await chmod(join(bin, 'ps'), 0o700);
      // The platform signature kills a relocated ps image. Sign only our private
      // unprivileged copy; the system executable and its signature stay intact.
      await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', join(bin, 'ps')],
        { timeout: 10000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' } });
    })());
    const roots = await Promise.all(this.config.roots.map(path => realpath(path)));
    // Pass canonical paths to children as well as Seatbelt. Homebrew's opt links
    // otherwise leave Java trying to traverse an unreadable alias outside its grant.
    if (this.config.ghidra) this.ghidra = await realpath(this.config.ghidra);
    if (this.config.javaHome) this.javaHome = await realpath(this.config.javaHome);
    const javaDependencies = this.javaHome ? await (this.javaDependencies ??= process.platform === 'darwin' ? jdkNativeDependencies(this.javaHome) : jdkLinuxDependencies(this.javaHome)) : [];
    return { node, entry: join(packageRoot, 'scripts/rea.mjs'), readableRoots: [dirname(dirname(node)), dirname(packageRoot), ...roots,
      ...javaDependencies,
      ...(this.ghidra ? [this.ghidra] : []), ...(this.javaHome ? [this.javaHome,
        // macOS launches a JDK as an application bundle and reads Contents/Info.plist.
        ...(this.javaHome.endsWith('.jdk/Contents/Home') ? [dirname(dirname(this.javaHome))] : [])] : [])] };
  }
  async doctor(signal: AbortSignal): Promise<Json> {
    const paths = await this.paths();
    const result = await runWorker({ executable: paths.node, args: [paths.entry, 'doctor', '--json', ...(this.ghidra ? ['--provider', 'ghidra'] : [])], cwd: this.root,
      env: this.env(), timeoutMs: this.config.timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
      { writableRoots: [this.root, this.temporary!], unixSocketRoots: [this.temporary!], readableRoots: paths.readableRoots }, signal);
    let diagnostics: Json; try { diagnostics = this.redactor.json(JSON.parse(result.stdout)); } catch { diagnostics = this.redactor.text(result.stdout || result.stderr); }
    const version = await runWorker({ executable: paths.node, args: ['--version'], cwd: this.root,
      env: this.env(), timeoutMs: 10000, maxOutputBytes: 65536 },
      { writableRoots: [this.root, this.temporary!], readableRoots: paths.readableRoots }, signal);
    const native = typeof diagnostics === 'object' && diagnostics !== null && !Array.isArray(diagnostics)
      ? (diagnostics as Record<string, Json>).providerInspections : null;
    return { version: REA_VERSION, platform: `${process.platform}/${process.arch}`, node: version.stdout.trim(),
      nodeSupported: supportedReaNode(version.stdout.trim()), analysisRoots: this.config.roots, exitCode: result.exitCode, diagnostics,
      artifactInventoryReady: supportedReaNode(version.stdout.trim()), selectedProvider: this.ghidra ? 'ghidra' : null,
      nativeProviders: Array.isArray(native) ? native.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.configured)
        .map(item => { const provider = item as Record<string, Json>; return { id: provider.id ?? null, available: provider.available ?? false, version: provider.providerVersion ?? null }; }) : [],
      capabilities: { artifactInventory: process.platform === 'darwin' ? 'Built in; DMG inventory uses a read-only macOS mount. Does not require a native decompiler.' : 'Built-in archive inventory. DMG mounting requires macOS. Native analysis needs a Linux Ghidra/JDK.',
        nativeAnalysis: this.config.ghidra ? 'Ghidra configured; consult diagnostics for engine readiness.' : 'No native engine configured. Configure Ghidra and a host-native JDK for decompilation.' } };
  }
  async connect(signal: AbortSignal): Promise<void> {
    if (this.client) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const paths = await this.paths();
      const sandbox = await prepareSandbox({ executable: paths.node, args: [paths.entry, 'mcp'], cwd: this.root },
        { writableRoots: [this.root, this.temporary!], unixSocketRoots: [this.temporary!], readableRoots: paths.readableRoots }, signal);
      const transport = new StdioClientTransport({ command: sandbox.executable, args: sandbox.args,
        env: workerEnvironment({ cwd: this.root, env: this.env() }), cwd: this.root, stderr: 'pipe', maxBufferSize: 16 * 1024 * 1024 });
      let diagnostics = '';
      transport.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16384); });
      const client = new Client({ name: 'dsh-pentest', version: '0.1.0' });
      this.transport = transport;
      try {
        await client.connect(transport, { signal, timeout: this.config.timeoutMs });
        let cursor: string | undefined;
        do {
          const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: this.config.timeoutMs });
          for (const tool of result.tools) this.tools.set(tool.name, tool);
          cursor = result.nextCursor;
        } while (cursor);
        this.client = client;
      } catch (error) { await client.close(); this.tools.clear(); signal.throwIfAborted();
        throw new PentestError('REA_MCP', this.redactor.text(`REA MCP could not start: ${diagnostics || (error instanceof Error ? error.message : 'Connection failed')}`)); } finally { await sandbox.close(); }
    })();
    try { await this.opening; } finally { delete this.opening; }
  }
  async catalog(signal: AbortSignal): Promise<Json> { await this.connect(signal); return this.redactor.json([...this.tools.values()].map(tool => ({
    ...tool, effectPolicy: reaEffects(tool.name), confinement: 'offline; writes restricted to REA workspace',
  }))); }
  async discover(input: unknown, signal: AbortSignal): Promise<Json> {
    await this.connect(signal); return this.redactor.json(reaCatalogPage([...this.tools.values()], input));
  }
  async call(name: string, args: Record<string, unknown>, session: SessionId, signal: AbortSignal): Promise<Json> {
    let output: Json = null;
    const next = this.queue.then(async () => {
      signal.throwIfAborted(); await this.connect(signal);
      if (!this.tools.has(name)) throw new PentestError('REA_TOOL', `Tool ${name} is not advertised by the pinned REA server. Search pentest_rea_catalog with query, then request tool for the exact input schema. Do not guess tool names.`);
      await this.checkPaths(args);
      await this.trajectories.append(session, 'rea/start', this.redactor.json({ tool: name, arguments: args, version: REA_VERSION }));
      const result = await this.client!.callTool({ name, arguments: args }, undefined, { signal, timeout: this.config.timeoutMs });
      const clean = this.redactor.json(result);
      const evidence = await this.evidence.put(clean, `rea/${name}`); this.graph.addEvidence(evidence);
      const nodeId = graphId(this.graph.engagementId, 'rea-observation', evidence.contentHash);
      this.graph.putNode({ id: nodeId, type: 'AnalysisObservation', name: `REA ${name}`, evidenceIds: [evidence.id],
        attributes: { tool: name, error: result.isError === true }, observedAt: evidence.observedAt });
      const urls = result.isError ? [] : observedUrls(result.structuredContent ?? result.content);
      const accepted = this.crawl(session).observe(urls, 'rea', undefined, evidence.id);
      for (const url of urls) {
        const endpoint = graphId(this.graph.engagementId, 'url-hint', url);
        this.graph.putNode({ id: endpoint, type: 'URL', name: url, attributes: { url, discoveryOnly: true }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
        this.graph.putEdge({ id: digest({ nodeId, endpoint }), source: nodeId, target: endpoint, type: 'References', status: 'inferred',
          attributes: { walkable: false }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
      }
      await this.trajectories.append(session, 'rea/result', this.redactor.json({ tool: name, evidence, discovered: urls.length, queued: accepted, isError: result.isError ?? false }));
      output = { result: clean, evidence: { ...evidence }, queued: accepted };
    });
    this.queue = next.catch(() => {});
    try { await next; return output; }
    catch (error) { if (signal.aborted) await this.close(); throw error; }
  }
  private async checkPaths(value: unknown): Promise<void> {
    const roots = await Promise.all([...this.config.roots, this.root].map(path => realpath(path)));
    const walk = async (item: unknown, key = ''): Promise<void> => {
      if (typeof item === 'string' && /(?:path|file|directory|root|executable)$/i.test(key) && isAbsolute(item)) {
        const path = await realpath(item).catch(() => item);
        if (!roots.some(root => { const tail = relative(root, path); return tail === '' || !tail.startsWith('..') && !isAbsolute(tail); })) throw new PentestError('REA_PATH', 'REA path is outside the operator-selected analysis roots');
      } else if (Array.isArray(item)) for (const child of item) await walk(child, key);
      else if (item && typeof item === 'object') for (const [name, child] of Object.entries(item)) await walk(child, name);
    }; await walk(value);
  }
  async close(): Promise<void> { if (this.opening) await this.opening.catch(() => undefined);
    const client = this.client; delete this.client; this.tools.clear(); if (client) await client.close(); else await this.transport?.close(); delete this.transport;
    if (this.temporary) { await rm(this.temporary, { recursive: true, force: true }); delete this.temporary; delete this.ownershipHelper; } }
}
