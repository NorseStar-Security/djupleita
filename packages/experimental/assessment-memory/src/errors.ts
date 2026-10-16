/** Stable structured failures for rejected writes and unavailable capture. */
export class MemoryError extends Error {
  override readonly name = 'MemoryError'
  constructor(readonly code: 'MEMORY_CONFIG' | 'MEMORY_BINDING' | 'MEMORY_EXPIRED' | 'MEMORY_CONFLICT' | 'MEMORY_REFERENCE' | 'MEMORY_LIMIT' | 'MEMORY_CAPTURE' | 'MEMORY_CLOSED', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
  }
}
