/** Read-only dependency inventory; installing is a separate owner action. */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { browserExecutable } from '@dsh-pentest/browser';
import { checkReaNode } from '@dsh-pentest/rea';
import type { Json } from '@dsh-pentest/contracts';
import type { PluginConfig } from './runtime.ts';

export interface SetupEntry {
  id: string; group: string; status: 'ready' | 'configured' | 'missing' | 'optional'; reason: string; command?: string;
}
export interface ToolSetup { installing: boolean; installAvailable: boolean; entries: SetupEntry[]; bannerDismissed?: boolean }
async function exists(path: string | undefined, executable = false): Promise<boolean> {
  if (!path) return false;
  try { await access(path, executable ? constants.X_OK : constants.R_OK); return true; } catch { return false; }
}
export async function inspectTools(config: PluginConfig, recon: Json, ffuf: Json): Promise<SetupEntry[]> {
  const entries: SetupEntry[] = Object.entries(recon as Record<string, { ready: boolean; reason?: string }>).map(([id, result]) => ({
    id, group: 'recon', status: result.ready ? 'ready' : 'missing',
    reason: result.ready ? 'Executable and SHA-256 verified.' : result.reason ?? 'Not installed.', command: 'pnpm setup:tools --only recon',
  }));
  if (process.platform === 'linux') {
    entries.push({ id: 'Bubblewrap', group: 'core', status: await exists('/usr/bin/bwrap', true) ? 'configured' : 'missing',
      reason: 'Required for isolated workers, browser and REA. Unprivileged user namespaces must be enabled. See docs/linux.md.' });
    entries.push({ id: 'Secret Service', group: 'core', status: await exists('/usr/bin/secret-tool', true) ? 'configured' : 'missing',
      reason: 'Identity storage requires libsecret-tools and an unlocked user-session keyring. See docs/linux.md.' });
  }
  const fuzz = ffuf as { ready: boolean; reason?: string };
  entries.push({ id: 'ffuf', group: 'ffuf', status: fuzz.ready ? 'ready' : 'missing',
    reason: fuzz.ready ? 'Executable and SHA-256 verified. URL fuzzing uses the scoped HTTP broker.' : fuzz.reason ?? 'Not installed.', command: 'pnpm setup:tools --only ffuf' });
  const browser = await exists(browserExecutable(config.browser), true);
  entries.push({ id: 'Playwright Chromium', group: 'browser', status: browser ? 'configured' : 'missing',
    reason: browser ? 'Executable found; the browser starts when first used.' : 'Install the Chromium revision pinned by Playwright.', command: 'pnpm setup:tools --only browser' });
  let rea = false, reaReason = 'Install REA and its supported local Node runtime. Archive/DMG inventory does not require Ghidra.';
  if (config.rea && await exists(join(config.rea.packageRoot, 'package.json'))) {
    try { const node = await checkReaNode(config.rea.node, AbortSignal.timeout(10000)); rea = true;
      reaReason = `REA package and supported Node ${node} found. Use the doctor for engine diagnostics; catalog search for exact tools.`;
    } catch (error) { reaReason = error instanceof Error ? error.message : 'REA runtime check failed'; }
  }
  entries.push({ id: 'REA', group: 'rea', status: rea ? 'configured' : 'missing', reason: reaReason, command: 'pnpm setup:tools --only rea' });
  const ghidra = config.rea?.ghidra, java = config.rea?.javaHome;
  const native = `${process.platform === 'linux' ? 'linux' : 'mac'}_${process.arch === 'arm64' ? 'arm_64' : 'x86_64'}`;
  const ghidraConfigured = ghidra && await exists(join(ghidra, 'support/analyzeHeadless'), true) && await exists(join(ghidra, `Ghidra/Features/Decompiler/os/${native}/decompile`), true);
  const javaConfigured = java && await exists(join(java, 'bin/java'), true);
  entries.push({ id: 'Ghidra / JDK', group: 'rea', status: ghidraConfigured && javaConfigured ? 'configured' : ghidra || java ? 'missing' : 'optional',
    reason: `Needed for native decompilation, not archive/DMG inventory. Ghidra 12.1.4 uses JDK 21; 12.2 uses JDK 25. Include the ${native} decompiler. Run pentest_rea_doctor after configuring both paths.`,
    command: `pnpm setup:tools --only rea --rea-node /absolute/path/to/node --ghidra /absolute/ghidra --java-home /absolute/jdk${process.platform === 'darwin' ? '/Contents/Home' : ''}` });
  const learning = config.learning && await exists(config.learning.python, true) && await exists(config.learning.script);
  entries.push({ id: 'Optuna / GEPA', group: 'learning', status: learning ? 'configured' : 'optional',
    reason: learning ? config.learning?.gepaScript && await exists(config.learning.gepaScript) ? 'Ranking and procedure runners found. GEPA uses the selected model; no target requests.' : 'Optuna configured. Re-run learning setup to add GEPA.' : 'Optional Python environment for offline learning studies.', command: 'pnpm setup:tools --only learning' });
  return entries;
}
