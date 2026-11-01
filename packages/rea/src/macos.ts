/** Resolve only the native libraries linked by the selected JDK, not all of Homebrew. */
import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function jdkNativeDependencies(javaHome: string): Promise<string[]> {
  const libraries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.dylib')) libraries.push(path);
    }
  };
  await visit(join(javaHome, 'lib'));
  const seen = new Set<string>(), grants = new Set<string>();
  let pending = libraries;
  while (pending.length) {
    const batch = pending.filter(path => !seen.has(path)); pending = [];
    if (!batch.length) break;
    for (const path of batch) seen.add(path);
    if (seen.size > 1024) throw new Error('Selected JDK has too many native dependencies');
    const { stdout } = await promisify(execFile)('/usr/bin/otool', ['-L', ...batch], {
      timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
    });
    for (const line of stdout.split('\n')) {
      const path = /^\s+(\/.*?) \(compatibility version /.exec(line)?.[1];
      if (!path || path.startsWith('/System/') || path.startsWith('/usr/') || path.startsWith(`${javaHome}/`)) continue;
      const canonical = await realpath(path);
      if (canonical.startsWith(`${javaHome}/`)) continue;
      grants.add(path); grants.add(canonical);
      if (!seen.has(canonical)) pending.push(canonical);
    }
  }
  return [...grants];
}
