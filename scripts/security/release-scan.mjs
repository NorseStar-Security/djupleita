/** Scan every payload file; accept only individually reviewed, byte-pinned public dependency findings. */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { scanner } from './scan.mjs';
const root = resolve(import.meta.dirname, '../..');
export async function scanRelease(payload, dependencies) {
  const scan = scanner();
  const scratch = await mkdtemp(join(tmpdir(), 'djupleita-artifact-scan-'));
  try {
    const report = join(scratch, 'findings.json');
    const result = spawnSync(process.env.GITLEAKS_BIN || join(root, '.security-tools/gitleaks'), ['dir', payload, '--config', scan.config, '--redact=100', '--no-banner', '--log-level', 'error', '--ignore-gitleaks-allow', '--report-format', 'json', '--report-path', report], { encoding: 'utf8' });
    if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error('Artifact secret scan did not complete');
    const findings = JSON.parse(await readFile(report, 'utf8'));
    const reviewed = JSON.parse(await readFile(join(root, 'configs/release-scan-reviewed.json'), 'utf8'));
    const unknown = [];
    for (const finding of findings) {
      const absolute = resolve(finding.File);
      const file = relative(payload, absolute);
      if (file.startsWith('..') || scan.referencePattern.test(file)) throw new Error('Artifact finding has an unsafe or confidential filename');
      const owner = [...dependencies].sort((a, b) => b.path.length - a.path.length).find(item => file.startsWith(`app/${item.path}/`));
      const entry = { package: owner ? `${owner.name}@${owner.version}` : 'runtime', file: owner ? file.slice(`app/${owner.path}/`.length) : file,
        sha256: createHash('sha256').update(await readFile(absolute)).digest('hex'), rule: finding.RuleID,
        line: finding.StartLine, column: finding.StartColumn, endLine: finding.EndLine, endColumn: finding.EndColumn };
      if (!reviewed.some(item => Object.keys(entry).every(key => item[key] === entry[key]))) unknown.push(entry);
    }
    if (unknown.length) {
      // No matched text, keys, private terms or report contents are printed.
      console.error('Unreviewed artifact findings (metadata only):', JSON.stringify(unknown, null, 2));
      throw new Error('Artifact secret scan failed: unreviewed findings');
    }
    console.log(`Artifact secret scan passed (${findings.length} exact public-dependency false positives reviewed).`);
  } finally { scan.close(); await rm(scratch, { recursive: true, force: true }); }
}
