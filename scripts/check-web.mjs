/** Check an authenticated local web startup without exposing its session token. */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [log, rawPort = '19876'] = process.argv.slice(2), port = Number(rawPort);
if (!log || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Usage: node scripts/check-web.mjs <startup-log> [port]');
const origin = `http://127.0.0.1:${port}`;
let failure = 'The web launcher did not print its loopback URL';
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const output = await readFile(log, 'utf8').catch(() => '');
  const address = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)?.[1];
  if (address) {
    const url = new URL(address);
    if (url.origin !== origin) throw new Error('The web launcher used an unexpected address');
    try {
      const anonymous = await fetch(origin, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      await anonymous.body?.cancel();
      if (anonymous.status !== 401) throw new Error('The web page did not require authentication');
      const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const headers = { Cookie: login.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ') };
      const response = login.status === 303
        ? await fetch(origin, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) }) : login;
      const html = await response.text();
      if (!response.ok || !/<title>Djupleita<\/title>/i.test(html)) throw new Error('The branded web page was unavailable');
      const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(match => new URL(match[1], url));
      if (!assets.length) throw new Error('The web page did not include entry assets');
      for (const asset of assets) {
        if (asset.origin !== origin) throw new Error('The web page included an external entry asset');
        const result = await fetch(asset, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
        const type = asset.pathname.endsWith('.css') ? /text\/css/i : /(?:javascript|ecmascript)/i;
        if (!result.ok || !type.test(result.headers.get('content-type') ?? '') || !(await result.arrayBuffer()).byteLength)
          throw new Error('An entry asset was unavailable');
      }
      console.log('Authenticated Linux web page and entry assets served successfully.');
      process.exit(0);
    } catch { failure = 'The web page or its entry assets were unavailable'; }
  }
  await delay(1000);
}
// Never include the URL or raw startup log in a CI failure: they contain a token.
throw new Error(failure);
