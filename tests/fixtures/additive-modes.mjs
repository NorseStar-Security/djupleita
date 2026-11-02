/** Boot the production profile in a private home; exercise native tools without a model call. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args); };
const root = await mkdtemp(join(tmpdir(), 'djupleita-modes-'));
process.env.DSH_HOME = join(root, 'home');
process.env.HOME = join(root, 'os-home');
process.env.DSH_PENTEST_ENGAGEMENT = join(root, 'engagement.json');
await mkdir(process.env.HOME, { recursive: true });
const { prepareProfile } = await import('../../scripts/profile.mjs');
const profile = join(process.env.DSH_HOME, 'profiles/pentest');
const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
let ctx;
try {
  await prepareProfile(profile);
  const path = join(profile, 'cordis.patch.yml');
  // Preserve executable platform expressions through a document edit.
  const doc = require('yaml').parseDocument(await readFile(path, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  for (const row of doc.contents.items) for (const entry of row.get('insert')?.items ?? []) {
    if (entry.get('id') === 'pentest') {
      entry.get('config').set('root', join(root, 'engagements'));
      entry.get('config').set('plugins', {});
      entry.get('config').set('keychainHelper', '/unused-fixture-helper');
    }
  }
  await writeFile(path, doc.toString({ lineWidth: 0 }));
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx = await bootProductionProfile({ binName: 'djupleita-fixture', profile: 'pentest', overlayPaths: [path], prepare(inner) {
    provideCmdline(inner, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit() {}, ready: { onReady() { return () => {}; } } });
  } });
  const { SessionId } = await import('../../vendor/deepseek-harness/packages/core/session/lib/index.js');
  const { ToolCallId } = await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
  const { executeModelToolFixture } = await import('../../vendor/deepseek-harness/packages/test-support/tool-testkit/lib/index.js');
  const { entryListSchema } = await import('../../vendor/deepseek-harness/vendor/include/lib/index.js');
  const { load: loadYaml } = createRequire(resolve('vendor/deepseek-harness/packages/preset/agent-preset-registry/package.json'))('js-yaml');
  await writeFile(join(root, 'known.txt'), 'additive fixture marker\n');
  const catalogs = {};
  for (const mode of ['pentest', 'standard', 'cordis', 'ptc']) {
    const agent = (await ctx.agents.create({ sessionId: SessionId(`fixture-${mode}`), meta: { cwd: root, agentPreset: mode },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, mode); } })).agent;
    const tools = ctx.tools.definitions(agent).map(tool => tool.name);
    catalogs[mode] = tools;
    const moved = ctx.pentest.describe({agent, name: 'working_directory', arguments: {cd: root}});
    assert.deepEqual(moved.effects, ['modify']); assert(!moved.trustedLocalRead);
    if (mode !== 'pentest') {
      const base = loadYaml(await readFile(resolve(`vendor/deepseek-harness/packages/bundle/web-app/presets/${mode}.patch.yml`), 'utf8'), { schema: entryListSchema })[0].insert[0].config;
      const baselineId = `fixture-base-${mode}`;
      const unregister = await ctx.agentPresets.register({ ...base, id: baselineId });
      try {
        const baseline = (await ctx.agents.create({ sessionId: SessionId(baselineId), meta: { cwd: root, agentPreset: baselineId },
          setup: async inner => { await ctx.agentPresets.mount(inner, baselineId); } })).agent;
        const expected = ctx.tools.definitions(baseline).map(tool => tool.name);
        for (const name of expected) assert(tools.includes(name), `${mode} lost upstream ${name}`);
        const baseCommands = ctx.commands.list(baseline).map(command => command.name);
        const composedCommands = ctx.commands.list(agent).map(command => command.name);
        for (const name of baseCommands) assert(composedCommands.includes(name), `${mode} lost command ${name}`);
      } finally { await unregister(); }
    }
    const child = (await ctx.agents.create({ sessionId: SessionId(`fixture-child-${mode}`), meta: { cwd: root, agentPreset: mode },
      setup: async inner => { assert.equal(ctx.agentPresets.composeFrom(inner, agent.ctx), mode); } })).agent;
    assert.deepEqual(ctx.tools.definitions(child).map(tool => tool.name).toSorted(), tools.toSorted(), `${mode} child capability mismatch`);
    for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'skill', 'subagent', 'pentest_status', 'pentest_trajectory']) assert(tools.includes(name), `${mode} lacks ${name}`);
    const prompt = await ctx.systemPrompt.assemble({ scope: agent });
    if (mode === 'ptc') {
      assert.deepEqual(prompt.tools.map(tool => tool.name), ['run_code']);
      const sdk = JSON.stringify(prompt.sections);
      for (const name of ['pentest_status', 'read', 'glob', 'grep']) assert(sdk.includes(name), `PTC SDK lacks ${name}`);
      const disconnect = ctx.pentest.review.connect();
      const approval = setInterval(() => {
        for (const item of ctx.pentest.review.snapshot().pending) {
          if (item.tool === 'run_code') void ctx.pentest.review.decide(item.id, item.sessionId, 'once');
        }
      }, 25);
      try {
        const result = await executeModelToolFixture(ctx, { agent, name: 'run_code', callId: ToolCallId('ptc-fixture'), signal: AbortSignal.timeout(15000),
          arguments: { description: 'Read the local acceptance fixture and engagement status', code: `return { file: await tools.read({file_path: ${JSON.stringify(join(root, 'known.txt'))}}), status: await tools.pentest_status({}) };` } });
        assert(!result.isError, `PTC invocation failed: ${JSON.stringify(result)}`);
        assert(JSON.stringify(result).includes('additive fixture marker'));
        assert(JSON.stringify(result).includes('availableTools'));
      } finally { clearInterval(approval); disconnect(); }
    } else {
      for (const [name, args] of [['read', { file_path: join(root, 'known.txt') }], ['glob', { pattern: '*.txt', path: root }], ['grep', { pattern: 'fixture marker', path: root }], ['pentest_status', {}], ['pentest_trajectory', {}], ['working_directory', {}]]) {
        const result = await executeModelToolFixture(ctx, { agent, name, arguments: args, callId: ToolCallId(`fixture-${mode}-${name}`), signal: AbortSignal.timeout(5000) });
        assert(!result.isError, `${mode}/${name}: ${JSON.stringify(result)}`);
        if (name === 'read') assert(JSON.stringify(result).includes('additive fixture marker'));
      }
    }
  }
  // Exercise actual shell and mutation dispatch in the shipped composition.
  const nativeAgent = ctx.agents.get(SessionId('fixture-pentest'));
  const mutationPath = join(root, 'native-write.txt');
  const disconnect = ctx.pentest.review.connect();
  const approvals = new Set();
  const approval = setInterval(() => {
    for (const item of ctx.pentest.review.snapshot().pending) {
      if (['bash', 'write', 'edit'].includes(item.tool)) {
        approvals.add(item.tool);
        void ctx.pentest.review.decide(item.id, item.sessionId, 'once');
      }
    }
  }, 25);
  try {
    for (const [name, args] of [
      ['bash', { command: 'printf native-shell-fixture', description: 'Print a local fixture marker', workdir: root }],
      ['write', { file_path: mutationPath, content: 'native-before' }],
      ['edit', { file_path: mutationPath, old_string: 'native-before', new_string: 'native-after' }],
    ]) {
      const result = await executeModelToolFixture(ctx, { agent: nativeAgent, name, arguments: args,
        callId: ToolCallId(`fixture-native-${name}`), signal: AbortSignal.timeout(15000) });
      assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
      if (name === 'bash') assert(JSON.stringify(result).includes('native-shell-fixture'));
    }
    assert.equal(await readFile(mutationPath, 'utf8'), 'native-after');
    assert.deepEqual([...approvals].sort(), ['bash', 'edit', 'write']);
  } finally { clearInterval(approval); disconnect(); }
  assert.deepEqual(catalogs.pentest.toSorted(), catalogs.standard.toSorted());
  console.log(JSON.stringify({ modes: Object.keys(catalogs), nativeInvocations: true, ptcCatalog: true, baseCatalogsPreserved: true, childCatalogsPreserved: true }));
} finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
