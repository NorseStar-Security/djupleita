/** Read-only graph acceptance in a private, authenticated production app. No model or target requests. */
import assert from 'node:assert/strict';

export async function checkEvidenceGraph(ctx, page) {
  page.setDefaultTimeout(8000);
  const { digest } = await import('../../packages/contracts/lib/index.js');
  const workspace = await ctx.workspaceRegistry.create(ctx.sessions.get('prompt-child-fixture').header.cwd, 'Graph fixture workspace');
  const created = await ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: 'pentest' });
  const session = ctx.sessions.get(created.sessionId);
  ctx.sessionTitle.rename(session, 'Evidence graph fixture');
  const { createUserMessage } = await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect saved local evidence.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await ctx.sessions.flush(session);
  await ctx.pentest.dismissSetupBanner(true, 'graph-fixture');
  await page.reload();
  const row = page.getByRole('treeitem', { name: /^Graph fixture workspace/ });
  // Initial blank-session selection can restore collapsed groups after the first workspace render.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await row.getAttribute('aria-expanded') === 'false') await row.click();
    try { await page.getByRole('treeitem', { name: /^Evidence graph fixture/ }).press('Enter', { timeout: 2000 }); break; }
    catch (error) { if (attempt === 2) throw error; }
  }
  for (const name of ['Chat', 'Trajectory', 'Evidence graph']) await page.getByRole('tab', { name, exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Evidence graph', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Evidence graph explorer', exact: true });
  await graph.getByText('No evidence collected yet.', { exact: false }).waitFor();
  const before = ctx.pentest.engagement.snapshot().requests;
  const now = new Date().toISOString();
  const evidence = tool => ({ id: `evidence-${tool}`, contentHash: digest(tool), pointer: `blobs/${digest(tool)}`,
    mediaType: 'application/json', tool, observedAt: now });
  for (const tool of ['subfinder', 'httpx']) ctx.pentest.graph.addEvidence(evidence(tool));
  const node = (id, type, name, tool) => ({ id, type, name, attributes: { fixture: true }, evidenceIds: [`evidence-${tool}`], observedAt: now });
  ctx.pentest.graph.putNode(node('target', 'ReconTarget', 'example.test', 'subfinder'));
  for (let i = 0; i < 105; i++) {
    const id = `host-${String(i).padStart(3, '0')}`;
    ctx.pentest.graph.putNode(node(id, 'Host', `host-${i}.example.test`, i === 104 ? 'httpx' : 'subfinder'));
    ctx.pentest.graph.putEdge({ id: `edge-${id}`, source: 'target', target: id, type: 'Discovered', status: i === 104 ? 'inferred' : 'observed',
      attributes: {}, evidenceIds: ['evidence-subfinder'], observedAt: now });
  }
  await graph.getByRole('button', { name: 'Inspect example.test', exact: true }).waitFor();
  await graph.getByText('105 relationships · Observed', { exact: false }).waitFor();
  await graph.getByRole('button', { name: 'Next relationships', exact: true }).click();
  await graph.getByText('31–60 / 105', { exact: true }).waitFor();
  await graph.getByRole('button', { name: 'Next nodes', exact: true }).click();
  await graph.getByText('101–106 / 106', { exact: true }).waitFor();
  await graph.getByRole('button', { name: 'Inspect host-104.example.test', exact: true }).click();
  await graph.getByRole('button', { name: 'Follow Discovered to example.test', exact: true }).waitFor();
  await graph.getByText('inferred', { exact: true }).waitFor();
  await graph.getByRole('button', { name: 'Follow Discovered to example.test', exact: true }).click();
  await graph.getByText('105 relationships · Observed', { exact: false }).waitFor();
  const search = graph.getByRole('searchbox', { name: 'Search nodes', exact: true });
  await search.fill('HOST-104.EXAMPLE.TEST');
  await graph.getByText('1 matching nodes', { exact: true }).waitFor();
  await graph.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('httpx');
  await graph.getByText('1 matching nodes', { exact: true }).waitFor();
  await graph.getByRole('combobox', { name: 'Node type', exact: true }).selectOption('Host');
  await graph.getByRole('button', { name: 'Inspect host-104.example.test', exact: true }).click();
  await graph.locator('summary').filter({ hasText: 'httpx ·' }).waitFor();
  await graph.locator('summary').filter({ hasText: 'httpx ·' }).click();
  await graph.getByText(digest('httpx'), { exact: true }).waitFor();
  await search.fill('no-match.example.test');
  await graph.getByText('No nodes match these filters.', { exact: true }).waitFor();
  await search.fill('');
  await graph.getByRole('button', { name: 'Inspect host-104.example.test', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click();
  await page.getByRole('tab', { name: 'Evidence graph', exact: true }).click();
  await graph.getByRole('button', { name: 'Inspect example.test', exact: true }).waitFor();
  if (process.env.DSH_TEST_GRAPH_SCREENSHOT) await page.screenshot({ path: process.env.DSH_TEST_GRAPH_SCREENSHOT });
  await page.setViewportSize({ width: 760, height: 1000 });
  assert(await graph.getByRole('searchbox').isVisible());
  assert(await graph.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Graph must fit a narrow viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
  const back = page.getByRole('button', { name: 'Back to plugins', exact: true });
  if (await back.count()) await back.click();
  await page.getByText('Djupleita · Evidence graph', { exact: true }).first().click();
  await graph.getByRole('button', { name: 'Inspect example.test', exact: true }).waitFor();
  assert.equal(ctx.pentest.engagement.snapshot().requests, before, 'Graph inspection must not consume target requests');
}
