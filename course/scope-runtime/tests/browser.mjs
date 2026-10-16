import assert from 'node:assert/strict'
import { chromium } from '/opt/browser/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], proxy: { server: 'http://127.0.0.1:3128', bypass: '<-loopback>' } })
try {
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  const failed = new Set()
  context.on('requestfailed', request => failed.add(request.url()))
  const page = await context.newPage()
  await page.goto('https://acme.test:18443/page')
  await page.waitForFunction(() => window.results?.allowed === 'allowed' && window.results?.websocket === 'echo' && window.results?.outside === 'blocked' && window.results?.badWebsocket === 'blocked' && window.results?.worker === 'registered' && window.results?.workerOutside === 'blocked')
  const results = await page.evaluate(() => window.results)
  assert.equal(results.worker, 'registered')
  for (const path of ['frame', 'image', 'script', 'fetch']) assert(failed.has(`https://widgets.test:18443/${path}`), `missing failed browser request: ${path}`)
  const popupReady = page.waitForEvent('popup')
  const popupFailure = context.waitForEvent('requestfailed', { predicate: request => request.url() === 'https://widgets.test:18443/popup' })
  await page.click('#popup')
  const popup = await popupReady
  await popupFailure
  await popup.close()
  const clickFailure = context.waitForEvent('requestfailed', { predicate: request => request.url() === 'https://widgets.test:18443/click' })
  await page.click('#outside', { noWaitAfter: true })
  await clickFailure
  await assert.rejects(page.goto('https://acme.test:18443/redirect'))
  await assert.rejects(page.goto('https://widgets.test:18443/direct'))
  console.log(JSON.stringify({ browser: 'passed', results }))
} finally {
  await browser.close()
}
