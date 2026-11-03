/** Trusted classifications for the opt-in red-team profile. Unknown syntax goes to judgment. */
import { lstat, realpath, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { digest } from '@dsh-pentest/contracts';
import type { Action, Json } from '@dsh-pentest/contracts';
import type { ReconInput } from '@dsh-pentest/recon';
import type { PentestRuntime } from './runtime.ts';

/** Deliberately only literal argv: no expansions, redirects, pipelines, assignments or shell evaluation. */
export function literalArguments(command: string): string[] | undefined {
  const words: string[] = []; let word = '', started = false, quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue; }
    if (ch === '\\' && quote !== "'") {
      const next = command[++i]; if (next === undefined || next === '\n') return;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\';
      word += next; started = true; continue;
    }
    if (ch === quote && quote) { quote = ''; continue; }
    if (ch === '$' || ch === '`') return;
    if (quote) { word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (ch === '\n' || ch === '\r') return; if (started) { words.push(word); word = ''; started = false; } continue; }
    if (/[|&;<>(){}*?\[\]~#!]/.test(ch)) return;
    word += ch; started = true;
  }
  if (quote) return;
  if (started) words.push(word);
  return words.length ? words : undefined;
}
export interface ReconPlan { inputs: ReconInput[]; output?: string }
export function reconArguments(words: string[], sources: string[]): { tool: 'subfinder' | 'httpx'; target?: string; list?: string; output?: string; rate?: number; concurrency?: number } | undefined {
  const tool = basename(words[0]!); if (tool !== 'subfinder' && tool !== 'httpx') return;
  const result: NonNullable<ReturnType<typeof reconArguments>> = { tool };
  for (let i = 1; i < words.length; i++) {
    const flag = words[i]!;
    if (['-silent', '-json', '-jsonl', '-duc', '-disable-update-check'].includes(flag)
      || tool === 'httpx' && ['-title', '-sc', '-status-code', '-td', '-tech-detect', '-no-stdin', '-no-fallback-scheme'].includes(flag)) continue;
    const value = words[++i]; if (!value || value.startsWith('-')) return;
    if (tool === 'subfinder' && ['-d', '-domain'].includes(flag) || tool === 'httpx' && ['-u', '-target'].includes(flag)) {
      if (result.target || result.list) return; result.target = value;
    } else if (tool === 'httpx' && ['-l', '-list'].includes(flag)) { if (result.target || result.list) return; result.list = value; }
    else if (['-o', '-output'].includes(flag)) { if (result.output) return; result.output = value; }
    else if (tool === 'subfinder' && ['-s', '-sources'].includes(flag)) { if (value.split(',').sort().join(',') !== [...sources].sort().join(',')) return; }
    else if (['-rl', '-rate-limit'].includes(flag) || tool === 'httpx' && ['-threads', '-t'].includes(flag)) {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100000) return;
      if (flag === '-threads' || flag === '-t') result.concurrency = Number(value); else result.rate = Number(value);
    } else return;
  }
  return result.target || result.list ? result : undefined;
}
function protectedPath(path: string): boolean {
  return path.split(sep).some(part => /^\.(?:git|pentest|dsh|ssh|aws|config|gnupg|codex|security-tools)$/i.test(part)
    || /^\.(?:env|credentials)(?:\.|$)/i.test(part));
}
function within(root: string, path: string): boolean {
  const tail = relative(root, path); return tail === '' || !tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail);
}
/** Both lexical and canonical containment, including non-existent output leaves. */
export async function workspacePath(root: string | undefined, cwd: string | undefined, value: string): Promise<string | undefined> {
  if (!root || !cwd || !isAbsolute(root) || !isAbsolute(cwd) || root === sep || value.includes('\0')) return;
  const path = resolve(cwd, value);
  if (!within(root, path) || protectedPath(relative(root, path))) return;
  try {
    const canonicalRoot = await realpath(root);
    let existing = path;
    while (true) {
      try { const canonical = await realpath(existing); if (!within(canonicalRoot, canonical) || protectedPath(relative(canonicalRoot, canonical))) return; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) return; existing = dirname(existing); }
    }
    // Reject dangling links as well as links which leave the workspace.
    try { if ((await lstat(path)).isSymbolicLink()) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    return path;
  } catch { return; }
}
interface PreparedAction { action: Action; recon?: ReconPlan; cwd?: string }
export function actionProfileBinding(prepared: PreparedAction): string {
  const { action } = prepared;
  return digest({ plugin: action.plugin, destinations: action.destinations, effects: action.effects, reversible: action.reversible,
    activity: action.activity ?? null, cwd: prepared.cwd ?? null, recon: prepared.recon ?? null });
}
export async function prepareProfileAction(ctx: Context, runtime: PentestRuntime, exec: ToolExecution): Promise<PreparedAction> {
  const action = runtime.describe(exec);
  if (runtime.policyProfile !== 'red-team') return { action };
  const args = exec.arguments as Record<string, unknown> | null;
  const root = exec.agent?.session?.header.cwd;
  const directory = ctx.get('workingDirectory', false);
  const current: string | undefined = exec.agent?.session ? directory?.get(exec.agent.session) ?? root : root;
  const cwd = typeof args?.workdir === 'string' && current ? resolve(current, args.workdir) : current;
  if (['write', 'edit'].includes(exec.name) && typeof args?.file_path === 'string') {
    const path = await workspacePath(root, cwd, args.file_path);
    if (path) {
      const exists = await lstat(path).then(() => true, () => false);
      const boundedEdit = exec.name === 'edit' && typeof args.old_string === 'string' && args.old_string.length > 0
        && typeof args.new_string === 'string' && args.new_string.length > 0;
      if (!exists && exec.name === 'write' || exists && boundedEdit) {
        action.effects = [exists ? 'modify' : 'create']; action.reversible = true; action.activity = 'workspace';
      }
    }
  }
  if (exec.name !== 'bash' || typeof args?.command !== 'string') return { action, ...(cwd ? { cwd } : {}) };
  const words = literalArguments(args.command);
  const command = words && basename(words[0]!);
  if (words && ['rm', 'rmdir', 'shred', 'wipe', 'mkfs', 'mkfs.ext4', 'dd'].includes(command!)) { action.effects = ['delete']; action.reversible = false; }
  else if (words && ['reboot', 'shutdown', 'halt', 'poweroff', 'killall'].includes(command!)) { action.effects = ['disrupt']; action.reversible = false; }
  const parsed = words && runtime.inventory().some(item => item.tool === 'pentest_recon') ? reconArguments(words, runtime.recon().config.sources) : undefined;
  if (!parsed) return { action, ...(cwd ? { cwd } : {}) };
  let targets: string[];
  if (parsed.list) {
    const list = await workspacePath(root, cwd, parsed.list); if (!list) return { action };
    const file = await open(list, 'r');
    try { if ((await file.stat()).size > 256 * 1024) return { action }; targets = (await file.readFile('utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
    finally { await file.close(); }
  } else targets = [parsed.target!];
  if (!targets.length || targets.length > 1000) return { action };
  const inputs: ReconInput[] = targets.map(target => ({ tool: parsed.tool, target: parsed.tool === 'httpx' && !target.includes('://') ? `https://${target}` : target,
    depth: 3, ...(parsed.rate ? { rate: parsed.rate } : {}), ...(parsed.concurrency ? { concurrency: parsed.concurrency } : {}) }));
  const output = parsed.output ? await workspacePath(root, cwd, parsed.output) : undefined;
  if (parsed.output && !output) return { action };
  if (output && await lstat(output).then(() => true, () => false)) { action.effects = ['overwrite']; action.reversible = false; }
  else { action.effects = ['read']; action.reversible = true; action.activity = parsed.tool === 'subfinder' ? 'research' : 'recon'; }
  action.plugin = 'recon';
  action.destinations = inputs.map(input => ({ url: input.tool === 'httpx' ? input.target : `https://${input.target}/`, purpose: 'target',
    ...(input.tool === 'subfinder' ? { access: 'read' as const } : {}) }));
  for (const input of inputs) runtime.recon().check(input);
  return { action, recon: { inputs, ...(output ? { output } : {}) }, ...(cwd ? { cwd } : {}) };
}
/** Runs the pinned, confined adapter instead of the model's arbitrary executable or shell. */
export async function executeReconPlan(runtime: PentestRuntime, exec: ToolExecution, plan: ReconPlan): Promise<Json> {
  const results: Json[] = [];
  for (const input of plan.inputs) results.push(await runtime.recon().run(input, runtime.session(exec), runtime.signal(exec.signal)));
  if (plan.output) {
    // Creation is atomic and never overwrites a file which appeared after approval.
    const file = await open(plan.output, 'wx', 0o600);
    try { await file.writeFile(results.flatMap(result => (result as { records?: Json[] }).records ?? [result]).map(record => JSON.stringify(record)).join('\n') + '\n'); }
    finally { await file.close(); }
  }
  return { adapter: 'managed-recon', results, output: plan.output ?? null, note: 'Pinned managed reconnaissance; JSON records, engagement rate limits and scope checks apply.' };
}
