/** Follow the selected JDK's external configuration links (e.g. Debian /etc/java-*). */
import { lstat, readlink, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export async function jdkLinuxDependencies(javaHome: string): Promise<string[]> {
  const home = await realpath(javaHome), grants = new Set<string>(), seen = new Set<string>();
  let count = 0;
  const inside = (path: string) => { const tail = relative(home, path); return tail === '' || !tail.startsWith('..') && !isAbsolute(tail); };
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return; seen.add(path);
    if (++count > 100000) throw new Error('Selected JDK has too many linked configuration entries');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      // Optional source archives are often dangling links in packaged JDKs.
      if (!target) return;
      if (!inside(target)) {
        const alias = resolve(dirname(path), await readlink(path));
        if (target === '/' || alias === '/') throw new Error('JDK dependencies cannot grant the filesystem root');
        grants.add(alias); grants.add(target);
      }
      await visit(target);
    } else if (info.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  await visit(home); return [...grants];
}
