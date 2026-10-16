/** HTTP transport is owned by this resource provider, never by a rendering component. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { parsePage, type ViewerValue } from '../wire.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface ResourceProtocolMap { trajectory: ViewerValue } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface RemoteErrorDetailsMap { 'trajectory-viewer/unavailable': {} } }

async function read(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) throw new Error('VIEWER_UNAVAILABLE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, content = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 2097152) throw new Error('VIEWER_RESPONSE_TOO_LARGE')
      content += decoder.decode(chunk.value, { stream: true })
    }
    content += decoder.decode()
    const value: unknown = JSON.parse(content)
    return value
  } finally { await reader.cancel(); reader.releaseLock() }
}

function pause(signal: AbortSignal, interval: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, interval)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Create a same-origin, cookie-authenticated bounded live page provider.
 * @param pollIntervalMs - validated deployment cadence between settled live reads.
 * @param apiBasePath - validated same-origin API path, pinned to native management for Protected.
 * @returns provider whose stream ends on resource release; paused addresses perform only one read.
 */
export function provider(pollIntervalMs: number, apiBasePath = 'api/trajectory-viewer/'): ResourceProvider<'trajectory'> {
  return {
    protocol: 'trajectory',
    async *open(address, { signal }): AsyncIterable<RemoteResult<ViewerValue>> {
      const cancelled = (): boolean => signal.aborted
      const url = new URL(address)
      const kind = url.pathname.slice(1)
      const follow = url.searchParams.get('follow') === '1'
      url.searchParams.delete('follow')
      url.searchParams.delete('revision')
      if (!['traces', 'detail', 'records', 'status'].includes(kind)) {
        yield { ok: false, error: Object.assign(new Error('VIEWER_INVALID_ADDRESS'), { isDSHRemoteError: true as const, code: 'trajectory-viewer/unavailable' as const, details: {} }) }
        return
      }
      while (!cancelled()) {
        const deadline = new AbortController()
        const abort = (): void => { deadline.abort() }
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(abort, 10000)
        try {
          const response = await fetch(`${apiBasePath}${kind}${url.search}`, { credentials: 'same-origin', cache: 'no-store', signal: deadline.signal })
          const value = parsePage(kind, await read(response))
          if (!cancelled()) yield { ok: true, value }
        } catch {
          if (!cancelled()) yield { ok: false, error: Object.assign(new Error('VIEWER_UNAVAILABLE'), { isDSHRemoteError: true as const, code: 'trajectory-viewer/unavailable' as const, details: {} }) }
        } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
        if (!follow || cancelled()) return
        await pause(signal, pollIntervalMs)
      }
    },
  }
}
