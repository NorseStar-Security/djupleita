/** Worker bindings declared in `wrangler.jsonc`. */
import type { CohortRoom } from './room.ts'
import type { SeatLedger } from './seat.ts'

/** Bindings and secrets available to the receiver and its Durable Objects. */
export interface Env {
  /** Exact record bytes, one object per stored part. */
  RAW: R2Bucket
  /** One ledger per course installation. */
  SEAT: DurableObjectNamespace<SeatLedger>
  /** One live room per cohort. */
  ROOM: DurableObjectNamespace<CohortRoom>
  /** HMAC key for seat, board, and admin tokens; set with `wrangler secret put AUDIT_TOKEN_KEY`. */
  AUDIT_TOKEN_KEY: string
  /** Largest accepted request body in bytes, as a decimal string. */
  MAX_REQUEST_BYTES: string
}
