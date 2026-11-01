import { it, expect } from 'vitest';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ReaService, observedUrls, reaEffects, reaCatalogPage, supportedReaNode } from '../packages/rea/src/index.ts';
import type { ReaTool as Tool } from '../packages/rea/src/index.ts';
import { AttackGraph } from '../packages/graph/src/index.ts';
import { EvidenceStore, Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';

it('treats REA output as discovery hints and independently classifies unknown and destructive tools', () => {
  expect(observedUrls({ strings: ['https://app.example/object/1', 'https://user:pass@outside.invalid/'] })).toEqual(['https://app.example/object/1']);
  expect(reaEffects('erase_everything').effects).toEqual(['unknown']);
  expect(reaEffects('delete_project').effects).toEqual(['delete']);
  expect(reaEffects('binary_session').reversible).toBe(true);
});
it('checks the pinned REA Node requirements at patch boundaries', () => {
  for (const value of ['22.23.4', 'v24.22.1', '26.12.1', '26.13.0', '27.0.0']) expect(supportedReaNode(value), value).toBe(true);
  for (const value of ['22.23.3', '24.13.0', '24.22.0', '26.12.0', '25.0.0', '24.22.1-rc.1', 'garbage']) expect(supportedReaNode(value), value).toBe(false);
});
it('pages and searches tool summaries instead of returning every full schema to the model', () => {
  const tools = Array.from({ length: 229 }, (_, index) => ({ name: index === 20 ? 'inspect_artifact' : `tool_${index}`,
    description: index === 20 ? 'Inspect archive or DMG inventory' : 'A test tool',
    inputSchema: { type: 'object', properties: { detail: { type: 'string' } } }, outputSchema: { type: 'object', description: 'x'.repeat(50000) } })) as Tool[];
  const first = reaCatalogPage(tools, {}) as Record<string, unknown>;
  expect(first.total).toBe(229); expect(first.nextOffset).toBe(15); expect(first.tools).toHaveLength(15);
  expect(JSON.stringify(first).length).toBeLessThan(16000);
  const search = reaCatalogPage(tools, { query: 'DMG' }) as Record<string, unknown>;
  expect(search.tools).toMatchObject([{ name: 'inspect_artifact' }]);
  const exact = reaCatalogPage(tools, { tool: 'inspect_artifact' }) as Record<string, unknown>;
  expect(exact.inputSchema).toEqual(tools[20]!.inputSchema); expect(exact).not.toHaveProperty('outputSchema');
  expect(reaCatalogPage(tools, { tool: 'invented_artifact' })).toHaveProperty('error');
});
it('bounds very large tool input schemas and supports focused schema navigation', () => {
  const tools = [{ name: 'inspect_analysis_view', description: 'View analysis', inputSchema: { type: 'object', properties: {
    huge: { description: 'x'.repeat(50000) }, path: { type: 'string' },
  } } }] as Tool[];
  expect(reaCatalogPage(tools, { tool: 'inspect_analysis_view' })).toMatchObject({ schemaOmitted: true, propertyNames: ['huge', 'path'] });
  expect(reaCatalogPage(tools, { tool: 'inspect_analysis_view', schemaPath: ['properties', 'path'] })).toMatchObject({ inputSchema: { type: 'string' } });
  expect(() => reaCatalogPage(tools, { tool: 'inspect_analysis_view', schemaPath: ['missing'] })).toThrow('does not exist');
});
it.skipIf(!process.env.DSH_TEST_REA_ROOT)('connects to the real confined REA MCP server and retains evidence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rea-test-'))), engagement = id<'EngagementId'>();
  const redactor = new Redactor(), graph = new AttackGraph(join(root, 'graph.sqlite'), engagement);
  const evidence = new EvidenceStore(root, redactor), trajectories = new TrajectoryStore(join(root, 'trajectory'), engagement, redactor);
  const service = new ReaService({ node: process.env.DSH_TEST_REA_NODE ?? process.execPath, packageRoot: resolve(process.env.DSH_TEST_REA_ROOT!), roots: [root], timeoutMs: 30000 },
    join(root, 'worker'), graph, evidence, trajectories, redactor, () => ({ observe: () => 0 }) as never);
  try {
    const catalog = await service.catalog(AbortSignal.timeout(40000)) as Record<string, unknown>[];
    expect(catalog.length).toBeGreaterThan(100); expect(catalog.some(tool => tool.name === 'binary_session')).toBe(true);
    const discovered = await service.discover({ tool: 'open_binary' }, AbortSignal.timeout(30000));
    expect(discovered).toMatchObject({ name: 'open_binary', inputSchema: { required: ['path'] } });
    const output = await service.call('binary_session', {}, id<'SessionId'>(), AbortSignal.timeout(30000)) as Record<string, unknown>;
    expect(output.evidence).toBeDefined(); expect((output.result as Record<string, unknown>).isError, JSON.stringify(output.result).slice(0, 4000)).not.toBe(true);
    expect(graph.snapshot().nodes.some(node => node.type === 'AnalysisObservation')).toBe(true);
    await expect(service.call('not_a_real_tool', {}, id<'SessionId'>(), AbortSignal.timeout(1000))).rejects.toThrow('advertised');
  } finally { await service.close(); graph.close(); }
}, 90000);
it.skipIf(!process.env.DSH_TEST_GHIDRA || !process.env.DSH_TEST_JAVA_HOME || !process.env.DSH_TEST_REA_ROOT)('decompiles a local Mach-O fixture with host-native Ghidra inside confinement', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ghidra-test-'))), engagement = id<'EngagementId'>();
  await writeFile(join(root, 'fixture.c'), 'int main(void) { return 42; }\n');
  execFileSync('/usr/bin/clang', ['-O0', '-o', join(root, 'fixture'), join(root, 'fixture.c')], {
    env: { PATH: '/usr/bin:/bin', DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
  });
  const redactor = new Redactor(), graph = new AttackGraph(join(root, 'graph.sqlite'), engagement);
  const service = new ReaService({ node: process.env.DSH_TEST_REA_NODE ?? process.execPath, packageRoot: resolve(process.env.DSH_TEST_REA_ROOT!), roots: [root],
    ghidra: process.env.DSH_TEST_GHIDRA!, javaHome: process.env.DSH_TEST_JAVA_HOME!, timeoutMs: 240000 },
    join(root, 'worker'), graph, new EvidenceStore(root, redactor), new TrajectoryStore(join(root, 'trajectory'), engagement, redactor), redactor, () => ({ observe: () => 0 }) as never);
  try {
    const doctor = await service.doctor(AbortSignal.timeout(120000)) as Record<string, unknown>;
    await writeFile(join(root, 'doctor.json'), JSON.stringify(doctor));
    expect(doctor.nodeSupported).toBe(true);
    expect(doctor.exitCode, JSON.stringify(doctor).slice(0, 5000)).toBe(0);
    const session = id<'SessionId'>();
    const opened = await service.call('open_binary', { path: join(root, 'fixture'), provider_id: 'ghidra' }, session, AbortSignal.timeout(240000)) as Record<string, unknown>;
    expect((opened.result as Record<string, unknown>).isError, JSON.stringify(opened).slice(0, 5000)).not.toBe(true);
    const decompiled = await service.call('procedure_pseudo_code', { procedure: '_main' }, session, AbortSignal.timeout(120000)) as Record<string, unknown>;
    await writeFile(join(root, 'decompiled.json'), JSON.stringify(decompiled));
    expect((decompiled.result as Record<string, unknown>).isError, JSON.stringify(decompiled).slice(0, 5000)).not.toBe(true);
    const result = decompiled.result as { structuredContent?: Record<string, unknown>; content: { text: string }[] };
    const analysis = result.structuredContent ?? JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(analysis.provider).toMatchObject({ id: 'ghidra' });
    expect(analysis.normalized_result).toMatch(/return\s+(?:0x2a|42)\s*;/);
    await service.call('close_binary', {}, session, AbortSignal.timeout(30000));
  } finally { await service.close(); graph.close(); }
}, 360000);
