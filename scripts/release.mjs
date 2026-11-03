/** Assemble a relocatable runtime from the installed production dependency graph. */
import { cp, mkdir, readFile, writeFile, realpath, readdir, symlink, readlink, mkdtemp, rm } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { scanRelease } from './security/release-scan.mjs';
import { scanner, privatePath } from './security/scan.mjs';
const root = resolve(import.meta.dirname, '..');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const inside = (parent, path) => { const rel = relative(parent, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const omitted = /^(?:node_modules|\.git|\.pentest|\.dsh|\.security-tools|\.desktop-build|\.cache|coverage|test-results|playwright-report|__pycache__|tests?|__tests__|fixtures|__fixtures__|examples?|benchmarks?)$/;
export function runtimeFile(path) {
  return !/(?:^|[\\/])\.(?:coveralls|travis|github|gitlab|circleci)(?:[\\/.]|$)/.test(path) && !path.split(/[\\/]/).some(part => omitted.test(part) || /^\.env(?:\.|$)/.test(part)) && !/\.(?:test|spec)\.[cm]?[jt]sx?(?:\.map)?$|\.d\.[cm]?ts$|\.map$|\.tsbuildinfo$|\.log$|\.(?:pem|key|p12|pfx)$/.test(path);
}
async function dependency(source, name) {
  for (let current = source; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    try { return await realpath(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) return;
  }
}
export async function copyProduction({ sourceRoot, destination, roots, workspaceDirectories }) {
  sourceRoot = await realpath(sourceRoot);
  const workspaces = new Set(await Promise.all(workspaceDirectories.map(path => realpath(path))));
  const copied = new Map();
  async function visit(input) {
    const source = await realpath(input);
    if (copied.has(source)) return copied.get(source);
    const manifest = await json(join(source, 'package.json'));
    const workspace = workspaces.has(source);
    if (workspace && !inside(sourceRoot, source)) throw new Error('Workspace escapes source tree');
    const target = join(destination, workspace ? relative(sourceRoot, source) : `.dependencies/${copied.size}`);
    const record = { source, target, name: manifest.name, version: manifest.version, license: manifest.license ?? 'SEE LICENSE', dependencies: [] };
    copied.set(source, record); // Register before walking cycles.
    await mkdir(target, { recursive: true });
    // Workspace publish directories include non-JS runtime assets (patches, locales,
    // skills and Python bridges). Third party packages retain their runtime source.
    const allowed = manifest.files?.map(value => value.replace(/^\.\//, '').split('/')[0]);
    for (const entry of await readdir(source)) {
      if (!runtimeFile(entry)) continue;
      if (workspace && entry !== 'package.json' && !/^(?:licen[cs]e|copying|notice|readme)/i.test(entry)) {
        if (allowed ? !allowed.some(pattern => pattern === entry || /[*?[]/.test(pattern)) : !['lib', 'dist', 'locale', 'python', 'cordis.patch.yml', 'assets', 'resources'].includes(entry)) continue;
      }
      await cp(join(source, entry), join(target, entry), { recursive: true, verbatimSymlinks: true,
        filter: path => runtimeFile(relative(source, path)) });
    }
    const required = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(required).sort()) {
      const found = await dependency(source, name);
      if (!found) {
        if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`Missing runtime dependency ${name} of ${manifest.name}`);
      }
      const installed = await json(join(found, 'package.json'));
      const supports = (values, actual) => !values || (!values.includes(`!${actual}`) && (values.every(value => value.startsWith('!')) || values.includes(actual)));
      if (manifest.optionalDependencies?.[name] && (!supports(installed.os, process.platform) || !supports(installed.cpu, process.arch))) continue;
      const child = await visit(found);
      const link = join(target, 'node_modules', name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), child.target), link, 'dir');
      record.dependencies.push(name);
    }
    return record;
  }
  for (const source of roots) await visit(source);
  return [...copied.values()].map(({ name, version, license, target }) => ({ name, version, license, path: relative(destination, target) }));
}
export async function auditTree(directory, referencePattern) {
  const base = await realpath(directory);
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name), rel = relative(base, file);
      if (privatePath(rel) || referencePattern?.test(rel)) throw new Error('Private file or confidential filename in release payload');
      if (entry.isSymbolicLink()) {
        const link = await readlink(file);
        if (isAbsolute(link) || !inside(base, await realpath(file))) throw new Error(`Nonportable symlink: ${rel}`);
      } else if (entry.isDirectory()) await walk(file);
      else if (!entry.isFile()) throw new Error(`Unsupported release file: ${rel}`);
    }
  }
  await walk(base);
}
export async function packageRelease(output = join(root, 'artifacts/release')) {
  const manifest = await json(join(root, 'package.json'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const target = `${process.platform}-${process.arch}`;
  const nodeLock = await json(join(root, 'configs/rea-node.lock.json'));
  const asset = nodeLock.assets[target];
  if (!asset || !['linux', 'darwin'].includes(process.platform)) throw new Error(`Unsupported release target ${target}`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const upstreamLock = await json(join(root, 'upstream.lock.json'));
  const upstream = join(root, upstreamLock.directory);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim() !== upstreamLock.commit) throw new Error('Unexpected harness revision');
  const name = `djupleita-${version}-${target.replace('darwin', 'macos')}`;
  const scratch = await mkdtemp(join(tmpdir(), 'djupleita-release-'));
  const payload = join(scratch, name), app = join(payload, 'app');
  try {
    await mkdir(app, { recursive: true });
    const workspaceDirectories = [...globSync(['packages/*/package.json', 'vendor/deepseek-harness/vendor/*/package.json', 'vendor/deepseek-harness/packages/*/*/package.json', 'vendor/deepseek-harness/apps/*/package.json', 'vendor/deepseek-harness/native/system/packages/*/package.json'], { cwd: root })].map(path => join(root, dirname(path)));
    const roots = [join(upstream, 'apps/cli'), ...globSync('packages/*/package.json', { cwd: root }).map(path => join(root, dirname(path)))];
    const dependencies = await copyProduction({ sourceRoot: root, destination: app, roots, workspaceDirectories });
    for (const file of ['package.json', 'upstream.lock.json', 'configs', 'vendor/deepseek-harness/package.json', 'vendor/deepseek-harness/LICENSE']) {
      await cp(join(root, file), join(app, file), { recursive: true });
    }
    for (const file of ['web.mjs', 'profile.mjs', 'profile-patch.mjs', 'pentest-presets.mjs', 'setup-tools.mjs', 'release-launch.mjs']) {
      await mkdir(join(app, 'scripts'), { recursive: true });
      await cp(join(root, 'scripts', file), join(app, 'scripts', file));
    }
    if (process.platform === 'darwin') {
      await mkdir(join(app, 'native'), { recursive: true });
      await cp(join(root, 'native/keychain-helper'), join(app, 'native/keychain-helper'));
    }
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`Runtime download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Runtime digest mismatch');
    const nodeTar = join(scratch, 'node.tar.gz');
    await writeFile(nodeTar, bytes);
    await mkdir(join(payload, 'runtime'));
    execFileSync('tar', ['-xzf', nodeTar, '--strip-components=1', '-C', join(payload, 'runtime')]);
    const metadata = { name: manifest.name, version, commit, target, node: nodeLock.version, harness: upstreamLock.commit, dependencies };
    await writeFile(join(payload, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await cp(join(root, 'LICENSE'), join(payload, 'LICENSE'));
    await cp(join(root, 'docs/release.md'), join(payload, 'README.md'));
    const launcher = '#!/bin/sh\nset -eu\nrelease_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$release_dir/runtime/bin/node" "$release_dir/app/scripts/release-launch.mjs" "$@"\n';
    await writeFile(join(payload, 'djupleita'), launcher, { mode: 0o755 });
    if (process.platform === 'darwin') await writeFile(join(payload, 'Djupleita.command'), launcher, { mode: 0o755 });
    // DevTools ships a public Google metrics key. Strip that optional telemetry
    // credential from the portable app; it is not needed for local inspection.
    for (const file of globSync('app/vendor/deepseek-harness/packages/experimental/inspector/lib/devtools/**/*.js', { cwd: payload })) {
      const path = join(payload, file), contents = await readFile(path, 'utf8');
      const clean = contents.replace(/(https:\/\/chromeuxreport\.googleapis\.com\/v1\/records:queryRecord\?key=)[A-Za-z0-9_-]+/g, '$1');
      if (clean !== contents) await writeFile(path, clean);
    }
    const scan = scanner();
    try { await auditTree(payload, scan.referencePattern); await scanRelease(payload, dependencies); } finally { scan.close(); }
    await mkdir(output, { recursive: true });
    const archive = join(output, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', scratch, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
    console.log(`Packaged ${basename(archive)} (${dependencies.length} runtime packages)`);
    return archive;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await packageRelease(process.argv[2] && resolve(process.argv[2]));
