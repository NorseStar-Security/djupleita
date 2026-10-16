/** Validated deployment cadence shared by the Host page injection and browser provider. */
import z from '@deepseek-ai/schemastery'

/** Resolved viewer deployment settings. */
export interface Config {
  /** Milliseconds between settled live page reads. */
  pollIntervalMs: number
  /** Relative backend API, or the native management API while viewing Protected. */
  apiBasePath: 'api/trajectory-viewer/' | '/api/trajectory-viewer/'
}

/** Live polling cadence; response and admission limits are fixed safety budgets. */
export const Config: z<Partial<Config>, Config> = z.object({
  pollIntervalMs: z.natural().min(1000).max(60000).default(1500).description('Milliseconds between settled live page reads.'),
  apiBasePath: z.union(['api/trajectory-viewer/', '/api/trajectory-viewer/']).default('api/trajectory-viewer/'),
})
