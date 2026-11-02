import { expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jdkLinuxDependencies } from '../packages/rea/src/linux.ts';

it('grants external JDK configuration links without granting adjacent files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-linux-jdk-')));
  try {
    const home = join(root, 'jdk'), conf = join(root, 'conf');
    await mkdir(home); await mkdir(conf);
    await writeFile(join(conf, 'java.security'), 'fixture-security-properties');
    await writeFile(join(root, 'unrelated'), 'unrelated fixture');
    await symlink(conf, join(home, 'conf')); await symlink(home, join(home, 'internal-loop'));
    await symlink(join(root, 'optional-missing-src.zip'), join(home, 'src.zip'));
    const dependencies = await jdkLinuxDependencies(home);
    expect(dependencies).toContain(conf); expect(dependencies).not.toContain(root);
    expect(dependencies).not.toContain(join(root, 'unrelated'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
