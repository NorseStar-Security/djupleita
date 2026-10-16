import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CollectorIdentity, TrajectoryArtifactId } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import { copyAttachments } from '../src/attachments.ts'
import { Config } from '../src/index.ts'

const identity: CollectorIdentity = {
  installationId: brandString<CollectorIdentity['installationId']>('install'),
  studentId: brandString<CollectorIdentity['studentId']>('student'),
  cohortId: brandString<CollectorIdentity['cohortId']>('cohort'),
}
const data = new Uint8Array([1, 2, 3])
const digest = createHash('sha256').update(data).digest('hex')
const file: FileAttachmentRef = { attachmentId: AttachmentId('sha256:' + digest), name: 'fixture.txt', bytes: 3 }
const image: ImageAttachmentRef = { attachmentId: file.attachmentId, bytes: 3, mediaType: 'image/png', width: 1, height: 1 }

function fixture(extra = {}) {
  const readImage = vi.fn(async (ref: ImageAttachmentRef, _signal?: AbortSignal) => ({ ref, data }))
  const files = vi.fn(async function* (_ref: FileAttachmentRef, _signal?: AbortSignal) { yield data })
  const putArtifact = vi.fn(async (_identity: CollectorIdentity, artifact: { sha256: string; name: string; data: Uint8Array }) =>
    brandString<TrajectoryArtifactId>(artifact.sha256))
  const attachments = { readImage, readFileStream: files }
  // Resolve validates the raw fixture and materializes every configured default.
  const config = z.resolve({ ...identity, ...extra }, Config, {})[0] as Config
  const run = (value: unknown, signal = new AbortController().signal) =>
    copyAttachments(value, attachments, { putArtifact }, identity, config, signal)
  return { run, readImage, files, putArtifact }
}

describe('bounded canonical attachment copying', () => {
  it('copies nested image parts and exact file bytes without using path-like strings', async () => {
    const { run, readImage, files, putArtifact } = fixture({ maxArtifactBytes: 3 })
    await run({ data: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }], path: '/private/not-an-attachment', url: 'https://example.test/not-an-attachment' })
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(files).toHaveBeenCalledTimes(1)
    expect(putArtifact).toHaveBeenCalledTimes(2)
    expect(putArtifact).toHaveBeenCalledWith(identity, { sha256: digest, name: digest, data })
  })

  it('does not interpret unstructured objects or URLs as attachment reads', async () => {
    const { run, readImage, files } = fixture()
    await run([{ attachmentId: file.attachmentId }, { type: 'other', attachment: file }, { type: 'image', attachment: 'https://example.test/image.png' }, null, '/private/path'])
    expect(readImage).not.toHaveBeenCalled()
    expect(files).not.toHaveBeenCalled()
  })

  it.each([
    { ...file, attachmentId: '../escape' },
    { ...file, attachmentId: digest },
    { ...file, bytes: -1 },
    { ...file, bytes: 1.5 },
    { ...file, name: '../escape' },
    { ...file, name: 'C:\\escape' },
    { ...file, name: '' },
    { ...file, name: 1 },
    { attachmentId: file.attachmentId, bytes: file.bytes },
  ])('rejects invalid structured file references before reading: %j', async (attachment) => {
    const { run, files, putArtifact } = fixture()
    await expect(run({ type: 'file', attachment })).rejects.toHaveProperty('code', 'ARCHIVE_ATTACHMENT')
    expect(files).not.toHaveBeenCalled()
    expect(putArtifact).not.toHaveBeenCalled()
  })

  it.each([
    { ...image, width: 0 }, { ...image, height: 1.5 }, { ...image, mediaType: 'text/html' }, { ...image, name: '../escape' },
  ])('rejects invalid image references before reading: %j', async (attachment) => {
    const { run, readImage } = fixture()
    await expect(run({ type: 'image', attachment })).rejects.toHaveProperty('code', 'ARCHIVE_ATTACHMENT')
    expect(readImage).not.toHaveBeenCalled()
  })

  it('retains an optional image display name for the provider read', async () => {
    const { run, readImage } = fixture()
    await run({ type: 'image', attachment: { ...image, name: 'image.png' } })
    expect(readImage.mock.calls[0]?.[0].name).toBe('image.png')
  })

  it.each([{ maxAttachmentDepth: 1 }, { maxAttachmentNodes: 1 }])('rejects traversal exhaustion without reading any binary: %j', async (limits) => {
    const { run, readImage, putArtifact } = fixture(limits)
    await expect(run({ nested: { type: 'image', attachment: image } })).rejects.toHaveProperty('code', 'ARCHIVE_LIMIT')
    expect(readImage).not.toHaveBeenCalled()
    expect(putArtifact).not.toHaveBeenCalled()
  })

  it('bounds a wide pending traversal queue', async () => {
    const { run } = fixture({ maxAttachmentNodes: 2 })
    await expect(run([null, null, null])).rejects.toHaveProperty('code', 'ARCHIVE_LIMIT')
  })

  it('rejects declared bytes above the budget before reading', async () => {
    const { run, files } = fixture({ maxArtifactBytes: 2 })
    await expect(run({ type: 'file', attachment: file })).rejects.toHaveProperty('code', 'ARCHIVE_LIMIT')
    expect(files).not.toHaveBeenCalled()
  })

  it('rejects oversized chunks during a file stream and closes its iterator', async () => {
    const { run, files, putArtifact } = fixture()
    const closed = vi.fn()
    files.mockImplementation(async function* () { try { yield new Uint8Array(4) } finally { closed() } })
    await expect(run({ type: 'file', attachment: file })).rejects.toHaveProperty('code', 'ARCHIVE_LIMIT')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(putArtifact).not.toHaveBeenCalled()
  })

  it.each(['file', 'image'])('rejects missing %s bytes without committing an artifact', async (type) => {
    const { run, readImage, files, putArtifact } = fixture()
    readImage.mockRejectedValue(new Error('private provider diagnostic'))
    files.mockImplementation(async function* () { throw new Error('private provider diagnostic') })
    const result = run({ type, attachment: type === 'file' ? file : image })
    await expect(result).rejects.toHaveProperty('code', 'ARCHIVE_ATTACHMENT')
    await expect(result).rejects.toHaveProperty('cause.message', 'private provider diagnostic')
    expect(putArtifact).not.toHaveBeenCalled()
  })

  it.each([new Uint8Array([0, 0, 0]), new Uint8Array([1, 2])])('rejects corrupt or truncated image bytes', async (bytes) => {
    const { run, readImage, putArtifact } = fixture()
    readImage.mockImplementation(async ref => ({ ref, data: bytes }))
    await expect(run({ type: 'image', attachment: image })).rejects.toHaveProperty('code', 'ARCHIVE_ATTACHMENT')
    expect(putArtifact).not.toHaveBeenCalled()
  })

  it('cancels before traversal, during image reads, and during streamed file chunks', async () => {
    const { run, readImage, files, putArtifact } = fixture()
    const before = new AbortController()
    before.abort()
    await expect(run({ type: 'image', attachment: image }, before.signal)).rejects.toBe(before.signal.reason)
    const imageAbort = new AbortController()
    readImage.mockImplementation(async () => { imageAbort.abort(); throw imageAbort.signal.reason })
    await expect(run({ type: 'image', attachment: image }, imageAbort.signal)).rejects.toBe(imageAbort.signal.reason)
    const fileAbort = new AbortController()
    files.mockImplementation(async function* () { fileAbort.abort(); yield data })
    await expect(run({ type: 'file', attachment: file }, fileAbort.signal)).rejects.toBe(fileAbort.signal.reason)
    expect(putArtifact).not.toHaveBeenCalled()
  })
})
