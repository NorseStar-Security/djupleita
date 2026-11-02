import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error The bootstrap helper is plain JavaScript.
import { applyBranding } from '../scripts/branding.mjs';

it('reproduces the replay feature from the pinned commit and applies all overlays idempotently', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'djupleita-replay-overlay-'));
  const upstream = resolve('vendor/deepseek-harness'), checkout = join(scratch, 'vendor/deepseek-harness');
  const patches = ['djupleita-branding.patch', 'djupleita-provider-trust.patch', 'djupleita-replay.patch'];
  try {
    await mkdir(checkout, { recursive: true }); await mkdir(join(scratch, 'patches'));
    const paths = new Set<string>();
    for (const patch of patches) {
      const bytes = await readFile(join('patches', patch)); await writeFile(join(scratch, 'patches', patch), bytes);
      for (const row of execFileSync('git', ['apply', '--numstat', resolve('patches', patch)], { encoding: 'utf8' }).trim().split('\n')) paths.add(row.split('\t')[2]!);
    }
    for (const path of paths) {
      let bytes: Buffer;
      try { bytes = execFileSync('git', ['show', `HEAD:${path}`], { cwd: upstream, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { continue; } // Added overlay files have no upstream blob.
      await mkdir(dirname(join(checkout, path)), { recursive: true }); await writeFile(join(checkout, path), bytes);
    }
    applyBranding(scratch); applyBranding(scratch);
    for (const path of paths) expect(await readFile(join(checkout, path))).toEqual(await readFile(join(upstream, path)));
    const target = join(checkout, 'packages/client/ui-chat/src/client/chat/MessageItem.tsx');
    const edited = (await readFile(target, 'utf8')).replace("t('message.editReplay')", "t('copy')");
    await writeFile(target, edited);
    expect(() => applyBranding(scratch)).toThrow(/replay.patch conflicts/);
    expect(await readFile(target, 'utf8')).toBe(edited);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
