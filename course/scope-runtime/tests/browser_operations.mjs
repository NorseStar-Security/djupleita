/** Exercise operation admission with the image's real Chromium, never an HTTP-client stand-in. */
import assert from 'node:assert/strict'
import { chromium } from '/opt/browser/node_modules/playwright-core/index.mjs'

const config = JSON.parse(process.argv[2])
assert(['ordinary', 'denied', 'rule-removed'].includes(config.phase))
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium', headless: true, timeout: 30000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
  proxy: { server: config.proxy, bypass: '<-loopback>' },
})
let interrupted = false
const stop = () => {
  interrupted = true
  // Closing the browser causes outstanding Playwright operations to reject;
  // the fixture owner still waits for this Node process and its container.
  void browser.close().catch((error) => { console.error(error); process.exitCode = 1 })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  const context = await browser.newContext()
  // A denied text document has no fixture HTML to declare its data: favicon.
  // Exclude only this automatic browser resource from the TCP-count oracle;
  // every operation under test still crosses the real proxy unchanged.
  await context.route('**/favicon.ico', route => route.abort())
  const results = []
  for (const origin of config.origins) {
    const page = await context.newPage()
    const paths = config.phase === 'denied' ? config.paths : [config.phase === 'ordinary' ? '/research' : '/quitquitquit']
    for (const path of paths) {
      const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 10000 })
      assert(response, 'navigation must receive a gateway response')
      const expected = config.phase === 'denied' ? 403 : 200
      assert.equal(response.status(), expected, `${config.phase} GET ${origin}${path}`)
      const post = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { method: 'POST', body: 'private browser fixture', cache: 'no-store', redirect: 'error' })
          const text = await response.text()
          return { kind: 'response', status: response.status, text }
        } catch (error) {
          return { kind: 'failed', name: error.name }
        }
      }, origin + path)
      if (config.phase === 'denied') {
        // The proxy refuses the operation before consuming its untrusted body.
        // A transport close is also checked against the real gateway audit and
        // zero upstream counters by the independent Python fixture.
        assert(post.kind === 'failed' || post.status === 403, `forbidden POST reached a successful response: ${JSON.stringify(post)}`)
      } else {
        assert.equal(post.kind, 'response')
        assert.equal(post.status, 200)
        assert.match(post.text, /ordinary research capability/)
      }
      results.push({ origin, path, get: response.status(), post })
    }
    await page.close()
  }
  await context.close()
  assert(!interrupted, 'browser fixture was interrupted')
  console.log(JSON.stringify({ phase: config.phase, chromium: browser.version(), results }))
} finally {
  await browser.close()
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
