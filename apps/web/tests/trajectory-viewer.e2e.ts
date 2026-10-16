/** Collected recorded Session → durable projection → actual optional Web sidebar, without a model call. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const expected = fileURLToPath(new URL('./expected/trajectory-viewer/tree.expected.md', import.meta.url))
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let privateRoot: string | undefined

beforeAll(async () => {
  privateRoot = await mkdtemp(join(tmpdir(), 'dsh-trajectory-browser-'))
  if (webSnapshotMode() === 'refresh') await mkdir(dirname(expected), { recursive: true })
  vi.stubEnv('COURSE_COLLECTOR_DB', join(privateRoot, 'intake', 'collector.sqlite'))
  vi.stubEnv('COURSE_PROJECTION_DB', join(privateRoot, 'projection', 'projection.sqlite'))
  vi.stubEnv('COURSE_INSTALLATION_ID', 'viewer-fixture-installation')
  vi.stubEnv('COURSE_STUDENT_ID', 'viewer-fixture-student')
  vi.stubEnv('COURSE_COHORT_ID', 'viewer-fixture-course')
  scaffold = await launchWebScaffold({
    extraOverlayPath: [
      join(repository, 'apps/web/tests/pin-browse-picker.overlay.yml'),
      join(repository, 'course/trajectory-collector/native.overlay.yml'),
    ],
    extraInstallAnchors: ['trajectory-viewer', 'trajectory-projection', 'trajectory-collector-sqlite', 'trajectory-collector-archive',
      'trajectory-collector-http'].map(name => join(repository, 'packages/experimental', name, 'package.json')),
  })
  const fixture = await readFile(join(repository, 'snapshots/web/seeded-history/session.v3.jsonl'), 'utf8')
  await seedSession(scaffold, fixture, 'trajectory-viewer-recorded', undefined, { createdAt: 1783600629000 })
  browser = await chromium.launch()
}, 120_000)

afterAll(async () => {
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally {
      vi.unstubAllEnvs()
      if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
    }
  }
})

async function openViewer(page: Page): Promise<void> {
  await page.goto(scaffold!.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Trajectories', exact: true }).click()
  await page.getByRole('heading', { name: 'Trajectories', exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'Session', exact: true }).fill('trajectory-viewer-recorded')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  const trace = page.getByRole('button', { name: /Turn 1 · Completed · viewer-fixture-student/u })
  await trace.waitFor({ timeout: 20_000 })
  await trace.click()
  await page.getByRole('button', { name: 'Inspect source records', exact: true }).first().waitFor()
}

it('inspects a collected recording with tree/timeline, exact source, and bounded search', async () => {
  const page = await browser!.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } })
  const console = watchConsole(page)
  try {
    await openViewer(page)
    await page.getByRole('switch', { name: 'Live follow', exact: true }).click()
    await page.getByText('Paused', { exact: true }).waitFor()
    const tree = page.locator('[data-trajectory-viewer] ol').first()
    const snapshot = await captureStableAria(page, '[data-trajectory-viewer] ol', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(expected, snapshot, webSnapshotMode())
    expect(await tree.getByText('turn', { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    await page.getByRole('button', { name: 'Inspect source records', exact: true }).first().waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Original records', exact: true }).click()
    await page.getByText('Matches on this page only', { exact: true }).waitFor()
    await page.locator('[data-trajectory-viewer] section summary').filter({ hasText: 'turn/start' }).click()
    await page.locator('[data-trajectory-viewer] pre').filter({ hasText: '"type":"turn/start"' }).waitFor()
    expect(await page.locator('[data-trajectory-viewer] script').count()).toBe(0)
    await page.getByRole('textbox', { name: 'Search this record page', exact: true }).fill('no-such-record-590')
    await page.getByText('No records on this page.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close source records', exact: true }).click()
    expect(console.pageErrors).toEqual([])
  } finally { await page.close() }
}, 60_000)

it.each(['light', 'dark'] as const)('keeps the %s viewer inside a narrow viewport', async (colorScheme) => {
  const page = await browser!.newPage({ locale: 'en-US', colorScheme, viewport: { width: 390, height: 844 } })
  try {
    await openViewer(page)
    const geometry = await page.locator('[data-trajectory-viewer]').evaluate(element => ({
      width: element.getBoundingClientRect().width,
      viewport: document.documentElement.clientWidth,
      overflow: element.scrollWidth - element.clientWidth,
    }))
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport)
    expect(geometry.overflow).toBeLessThanOrEqual(1)
  } finally { await page.close() }
}, 60_000)
