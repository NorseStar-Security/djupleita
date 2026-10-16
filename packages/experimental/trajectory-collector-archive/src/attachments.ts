/** Discover only structured image/file attachment parts; no local path or URL is opened. */
import { createHash } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { TrajectoryCollector } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { Config } from './index.ts'
import { ArchiveError } from './errors.ts'

type Reference = { type: 'image'; ref: ImageAttachmentRef } | { type: 'file'; ref: FileAttachmentRef }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function mediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function reference(value: Record<string, unknown>): Reference | undefined {
  if ((value.type !== 'image' && value.type !== 'file') || !object(value.attachment)) return
  const ref = value.attachment
  if (typeof ref.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(ref.attachmentId)
    || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    throw new ArchiveError('ARCHIVE_ATTACHMENT', 'A structured attachment reference has invalid identity or byte length.')
  }
  if (ref.name !== undefined && (typeof ref.name !== 'string' || ref.name.length === 0 || /[\\/\0]/u.test(ref.name))) {
    throw new ArchiveError('ARCHIVE_ATTACHMENT', 'An attachment display name is not a filename.')
  }
  const attachmentId = AttachmentId(ref.attachmentId)
  if (value.type === 'file') {
    if (typeof ref.name !== 'string') throw new ArchiveError('ARCHIVE_ATTACHMENT', 'A file attachment has no display name.')
    return { type: 'file', ref: { attachmentId, bytes: ref.bytes, name: ref.name } }
  }
  if (!mediaType(ref.mediaType) || !positive(ref.width) || !positive(ref.height)) {
    throw new ArchiveError('ARCHIVE_ATTACHMENT', 'An image attachment has invalid raster metadata.')
  }
  return { type: 'image', ref: { attachmentId, bytes: ref.bytes, mediaType: ref.mediaType, width: ref.width, height: ref.height,
    ...(typeof ref.name === 'string' ? { name: ref.name } : {}) } }
}

function discover(value: unknown, config: Config): Reference[] {
  const result: Reference[] = []
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let count = 0
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (++count > config.maxAttachmentNodes || current.depth > config.maxAttachmentDepth) {
      throw new ArchiveError('ARCHIVE_LIMIT', 'Attachment discovery exceeds its configured traversal budget; raise the budget before replaying.')
    }
    if (object(current.value)) {
      const found = reference(current.value)
      if (found !== undefined) result.push(found)
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 })
    } else if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
    }
    if (pending.length + count > config.maxAttachmentNodes) {
      throw new ArchiveError('ARCHIVE_LIMIT', 'Attachment discovery exceeds its configured value budget; raise the budget before replaying.')
    }
  }
  return result
}

/** Commit referenced binaries before their record can be acknowledged.
 * @param value - complete persisted event.
 * @param attachments - mounted attachment provider.
 * @param collector - durable archive destination.
 * @param identity - trusted local sender.
 * @param config - byte and traversal budgets.
 * @param signal - cancellation; collector commits already started are drained.
 */
export async function copyAttachments(value: unknown, attachments: Pick<AttachmentStore, 'readImage' | 'readFileStream'>, collector: Pick<TrajectoryCollector, 'putArtifact'>, identity: CollectorIdentity, config: Config, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  for (const item of discover(value, config)) {
    signal.throwIfAborted()
    if (item.ref.bytes > config.maxArtifactBytes) throw new ArchiveError('ARCHIVE_LIMIT', 'An attachment exceeds maxArtifactBytes; its record is not acknowledged.')
    let data: Uint8Array
    try {
      if (item.type === 'image') {
        data = (await attachments.readImage(item.ref, signal)).data
      } else {
        const chunks: Uint8Array[] = []
        let bytes = 0
        for await (const chunk of attachments.readFileStream(item.ref, signal)) {
          signal.throwIfAborted()
          bytes += chunk.byteLength
          if (bytes > config.maxArtifactBytes || bytes > item.ref.bytes) throw new ArchiveError('ARCHIVE_LIMIT', 'Attachment stream exceeds its declared or configured byte limit.')
          chunks.push(chunk)
        }
        data = Buffer.concat(chunks, bytes)
      }
    } catch (cause) {
      if (signal.aborted) throw cause
      if (cause instanceof ArchiveError) throw cause
      throw new ArchiveError('ARCHIVE_ATTACHMENT', 'A referenced attachment could not be read; its record is not acknowledged.', { cause })
    }
    signal.throwIfAborted()
    const sha256 = item.ref.attachmentId.slice('sha256:'.length)
    if (data.byteLength !== item.ref.bytes || data.byteLength > config.maxArtifactBytes
      || createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new ArchiveError('ARCHIVE_ATTACHMENT', 'Attachment bytes differ from the persisted reference; its record is not acknowledged.')
    }
    await collector.putArtifact(identity, { sha256, name: sha256, data })
  }
}
