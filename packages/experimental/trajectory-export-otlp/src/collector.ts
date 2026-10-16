/** Full-content OTLP export from a durable multi-installation collector. */
import type { Context } from '@deepseek-ai/cordis'
import { startWorker, type Config } from './worker.ts'

/** Cordis plugin identity for durable intake export. */
export const name = 'experimental-trajectory-export-otlp-collector'
/** Storage owns trusted identities, revocation, and durable export acknowledgement. */
export const inject = ['trajectoryCollector']
export { Config } from './worker.ts'

/** Export committed intake records; acknowledge storage only after every OTLP fragment succeeds.
 * @param ctx - Context with a durable collector provider.
 * @param config - Instructor-only credentials, destination, and delivery budgets.
 * @returns Completion after private credential and configuration validation.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await startWorker(ctx, config, 'collector')
}
