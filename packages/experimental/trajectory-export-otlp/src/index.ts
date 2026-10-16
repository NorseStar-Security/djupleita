/** Full-content OTLP export from a local persisted session archive. */
import type { Context } from '@deepseek-ai/cordis'
import { startWorker, type Config } from './worker.ts'

/** Cordis plugin identity. */
export const name = 'experimental-trajectory-export-otlp'
/** The persistence provider owns parsing, migration, and read handles. */
export const inject = ['sessionPersistence']
export { Config } from './worker.ts'

/** Start the archive exporter and drain delivery on unload.
 * @param ctx - Context with a read-only persistence provider.
 * @param config - Full-content consent, credentials, destination, and delivery budgets.
 * @returns Completion after private credential and configuration validation.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await startWorker(ctx, config, 'persistence')
}
