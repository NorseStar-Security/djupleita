/** Keyless Unix transport to the instructor-owned action reviewer and durable audit store. */
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ActionReview, ActionReviewError } from '@deepseek-ai/dsh-experimental-action-review'
import type { ActionReviewDecision, ActionReviewStatus, ReviewRequest } from '@deepseek-ai/dsh-experimental-action-review/types'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { decodeDecision, decodeStatus } from './protocol.ts'

/** Instructor-owned socket and whole-request resource budgets. */
export interface Config {
  /** Absolute path to the same gateway used by network-scope-linux. */
  socketPath: string
  /** Whole exchange deadline, including the complete response body, in milliseconds. */
  timeoutMs: number
  /** Maximum accepted JSON response bytes; no partial response is admitted. */
  maxResponseBytes: number
  /** Maximum complete serialized action request bytes; executable payloads are never truncated. */
  maxActionBytes: number
}

/** No model credentials, evaluator selection, policy editing, or arbitrary relay endpoint exists here. */
export default class LinuxActionReview extends ActionReview {
  static Config = z.object({
    socketPath: z.transform(z.string(), (value) => {
      if (!isAbsolute(value)) throw new Error('action review socketPath must be absolute')
      return value
    }).default('/run/course-public/control.sock'),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(30_000),
    maxResponseBytes: z.natural().min(1).default(1024 * 1024),
    maxActionBytes: z.natural().min(1).default(1024 * 1024),
  })

  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private identity: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.pending)
    })
  }

  override async status(signal: AbortSignal): Promise<ActionReviewStatus> {
    return this.exchange('/review/status', undefined, signal, decodeStatus)
  }

  override async review(request: ReviewRequest, signal: AbortSignal): Promise<ActionReviewDecision> {
    // This is a process wire boundary: refuse lossy schema/payload serialization.
    const value = snapshotJsonValue(request)
    if (value === undefined) throw new ActionReviewError('ACTION_REVIEW_INPUT')
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > this.config.maxActionBytes) throw new ActionReviewError('ACTION_REVIEW_INPUT')
    const inputHash = createHash('sha256').update(body).digest('hex')
    return this.exchange('/review', body, signal, value => decodeDecision(value, inputHash, request.policyHash))
  }

  private async exchange<T extends ActionReviewStatus | ActionReviewDecision>(path: string, body: string | undefined, signal: AbortSignal,
    decode: (input: unknown) => T): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)])
    combined.throwIfAborted()
    let closed: Promise<void> = Promise.resolve()
    const task = new Promise<T>((resolve, reject) => {
      const req = request({ socketPath: this.config.socketPath, path, method: body === undefined ? 'GET' : 'POST', signal: combined, agent: false,
        ...body === undefined ? {} : { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      }, (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('error', reject)
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > this.config.maxResponseBytes) req.destroy(new ActionReviewError('ACTION_REVIEW_INVALID_RESPONSE'))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new ActionReviewError('ACTION_REVIEW_UNAVAILABLE')
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = decode(value)
            const identity = `${result.instance}:${result.policyHash}:${result.reviewHash}`
            if (this.identity !== undefined && this.identity !== identity) throw new ActionReviewError('ACTION_REVIEW_CHANGED')
            this.identity = identity
            resolve(result)
          } catch (cause) { reject(cause instanceof ActionReviewError ? cause : new ActionReviewError('ACTION_REVIEW_INVALID_RESPONSE', { cause })) }
        })
      })
      closed = new Promise<void>((resolve) => { req.once('close', resolve) })
      req.on('error', reject)
      req.end(body)
    }).then(async (value) => { await closed; return value }, async (cause: unknown) => {
      await closed
      if (cause instanceof ActionReviewError) throw cause
      if (signal.aborted) throw signal.reason
      throw new ActionReviewError('ACTION_REVIEW_UNAVAILABLE', { cause })
    })
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }
}
