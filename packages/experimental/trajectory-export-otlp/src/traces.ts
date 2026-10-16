/** Opt-in completed-span OTLP export, independent of full-content log acknowledgement. */
import type { Context } from '@deepseek-ai/cordis'
import { startTraceWorker, type Config } from './trace-worker.ts'

/** Cordis identity for the optional real trace signal. */
export const name = 'experimental-trajectory-export-otlp-traces'
/** The projection owns span IDs, relationships, completion, and trusted identity. */
export const inject = ['trajectoryProjection']
export { Config } from './trace-worker.ts'

/**
 * Export completed spans and drain requests on unload; log-export cursors are untouched.
 * @param ctx - Context with the durable trajectory projection provider.
 * @param config - Explicit full-content consent and private trace delivery settings.
 * @returns Completion after destination and credential validation.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await startTraceWorker(ctx, config)
}
