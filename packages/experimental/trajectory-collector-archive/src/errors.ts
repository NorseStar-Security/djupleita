/** Archive failures leave source sessions untouched and stop the polling owner. */

/** A failed archive operation may have committed a prefix; replay verifies collector receipts. */
export class ArchiveError extends Error {
  constructor(readonly code: 'ARCHIVE_ATTACHMENT' | 'ARCHIVE_LIMIT' | 'ARCHIVE_SOURCE', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'ArchiveError'
  }
}
