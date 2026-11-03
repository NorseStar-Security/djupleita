/** Render the architecture's Mermaid sources with local pinned dependencies. */
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';

const folder = import.meta.dirname;
const root = resolve(folder, '../..');
const { values } = parseArgs({ options: { 'preview-dir': { type: 'string' } } });
const preview = values['preview-dir'] ? resolve(values['preview-dir']) : undefined;
const upstreamRequire = createRequire(join(root, 'vendor/deepseek-harness/website/package.json'));
const workspaceRequire = createRequire(join(root, 'packages/browser/package.json'));
const mermaid = upstreamRequire.resolve('mermaid/dist/mermaid.min.js');
const { chromium } = workspaceRequire('playwright');
const sources = (await readdir(join(folder, 'mermaid'))).filter(name => name.endsWith('.mmd')).sort();
if (!sources.length) throw new Error('No Mermaid sources found.');

const browser = await chromium.launch({ headless: true });
const rendered = [];
try {
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 1 });
  await page.route('**/*', route => route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;background:white"><div id="diagram"></div></body></html>');
  await page.addScriptTag({ path: mermaid });
  await page.evaluate(() => window.mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
    fontFamily: 'Arial, Helvetica, sans-serif',
    deterministicIds: true, deterministicIDSeed: 'djupleita-architecture',
    htmlLabels: false,
    flowchart: { useMaxWidth: false, htmlLabels: false },
    sequence: { useMaxWidth: false },
  }));
  for (const name of sources) {
    const stem = basename(name, '.mmd');
    const source = await readFile(join(folder, 'mermaid', name), 'utf8');
    const diagram = await page.evaluate(async ({ source, stem }) => {
      await window.mermaid.parse(source);
      const { svg } = await window.mermaid.render(`diagram-${stem}`, source);
      const container = document.querySelector('#diagram');
      container.innerHTML = svg;
      const element = container.querySelector('svg');
      if (!element || element.querySelector('foreignObject, script, image')) {
        throw new Error('Expected a self-contained SVG with native text labels.');
      }
      return { svg, width: element.viewBox.baseVal.width, height: element.viewBox.baseVal.height };
    }, { source, stem });
    const png = preview ? await page.locator('#diagram svg').screenshot() : undefined;
    rendered.push({ stem, ...diagram, png });
    console.log(`Rendered ${name} (${Math.round(diagram.width)} × ${Math.round(diagram.height)})`);
  }
} finally {
  await browser.close();
}

// Validate every source before replacing any published image.
await mkdir(join(folder, 'images'), { recursive: true });
if (preview) await mkdir(preview, { recursive: true });
for (const { stem, svg, png } of rendered) {
  await writeFile(join(folder, 'images', `${stem}.svg`), `${svg}\n`);
  if (png) await writeFile(join(preview, `${stem}.png`), png);
}
console.log(`Saved ${rendered.length} SVG diagrams in docs/architecture/images/.`);
