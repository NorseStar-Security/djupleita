import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('loads the shipped preset and automatically prunes a 9 MB archived result before resuming the real agent loop', () => {
  const result = execFileSync(process.execPath, ['tests/fixtures/compaction.mjs'], { cwd: resolve('.'), encoding: 'utf8' });
  const acceptance = JSON.parse(result.trim().split('\n').at(-1)!);
  expect(acceptance).toMatchObject({ preset: 'pentest', manualCompact: true, modelRequests: 1, originalBytes: 9600000 });
  expect(acceptance.resumedRequestBytes).toBeLessThan(32000);
});
