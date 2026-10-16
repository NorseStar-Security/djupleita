/** The per-cohort Durable Object that fans committed activity out to live boards. */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.ts'
import type { Activity } from './ledger.ts'

/** Live totals for one Session on the board. */
export interface SessionCard {
  title: string | null
  model: string | null
  records: number
  reasoningChars: number
  toolCalls: number
  toolErrors: number
  scopeDenials: number
  lastSeq: number
  lastText: string
  lastMs: number
}

/** Live state for one seat on the board. */
export interface SeatCard {
  cohort: string
  student: string
  installation: string
  lastMs: number
  sessions: Record<string, SessionCard>
}

/** What a board receives when it connects. */
export interface RoomSnapshot {
  seats: SeatCard[]
  recent: Activity[]
}

/** Activities retained for a newly connected board. */
export const RECENT_ACTIVITIES = 300
/** Most recent Sessions kept per seat card; seat indexes keep every Session. */
export const SESSIONS_PER_SEAT = 20

/** Header the receiver sets on an authenticated board connection: `instructor` or `seat`. */
export const ROLE_HEADER = 'x-ns-audit-role'
/** Header naming the seat a `seat` connection may watch. */
export const INSTALLATION_HEADER = 'x-ns-audit-installation'

/** Keeps recent activity and seat totals for one cohort and broadcasts each committed batch. */
export class CohortRoom extends DurableObject<Env> {
  /**
   * Record and broadcast committed activities.
   * @param activities - Activities from one commit, all in this cohort.
   */
  async publish(activities: Activity[]): Promise<void> {
    const recent = [...(await this.ctx.storage.get<Activity[]>('recent')) ?? [], ...activities].slice(-RECENT_ACTIVITIES)
    const seats = (await this.ctx.storage.get<Record<string, SeatCard>>('seats')) ?? {}
    for (const activity of activities) {
      const seat = seats[activity.installation] ??= {
        cohort: activity.cohort, student: activity.student, installation: activity.installation, lastMs: 0, sessions: {},
      }
      seat.lastMs = Math.max(seat.lastMs, activity.receivedMs)
      const card = seat.sessions[activity.sessionId] ??= {
        title: null, model: null, records: 0, reasoningChars: 0, toolCalls: 0, toolErrors: 0, scopeDenials: 0, lastSeq: -2, lastText: '', lastMs: 0,
      }
      card.records++
      card.reasoningChars += activity.reasoningChars
      card.toolCalls += activity.toolCalls
      card.toolErrors += activity.toolErrors
      card.scopeDenials += activity.scopeDenials
      card.title = activity.title ?? card.title
      card.model = activity.model ?? card.model
      card.lastSeq = Math.max(card.lastSeq, activity.seq)
      card.lastText = activity.text
      card.lastMs = activity.receivedMs
      const sessions = Object.entries(seat.sessions)
      if (sessions.length > SESSIONS_PER_SEAT) {
        seat.sessions = Object.fromEntries(sessions.sort((a, b) => b[1].lastMs - a[1].lastMs).slice(0, SESSIONS_PER_SEAT))
      }
    }
    await this.ctx.storage.put({ recent, seats })
    for (const socket of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(socket)
      const visible = tags.includes('instructor') ? activities : activities.filter((activity) => tags.includes(`seat:${activity.installation}`))
      if (visible.length === 0) continue
      try {
        socket.send(JSON.stringify({ type: 'activity', activities: visible }))
      } catch (error) {
        // A closing socket cannot receive; its close handler finishes cleanup.
        console.warn('ns-audit board send failed', String(error))
      }
    }
  }

  /**
   * Read the board state, optionally restricted to one seat.
   * @param installation - Seat filter, or `undefined` for the whole cohort.
   * @returns Seats and recent activity.
   */
  async snapshot(installation?: string): Promise<RoomSnapshot> {
    const recent = (await this.ctx.storage.get<Activity[]>('recent')) ?? []
    const seats = Object.values((await this.ctx.storage.get<Record<string, SeatCard>>('seats')) ?? {})
    return installation === undefined
      ? { seats, recent }
      : { seats: seats.filter((seat) => seat.installation === installation), recent: recent.filter((activity) => activity.installation === installation) }
  }

  /**
   * Accept a board WebSocket that the receiver already authenticated.
   * @param request - Upgrade request carrying {@link ROLE_HEADER} and, for seats, {@link INSTALLATION_HEADER}.
   * @returns The 101 response, or 426 for a non-upgrade request.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 })
    const role = request.headers.get(ROLE_HEADER)
    const installation = request.headers.get(INSTALLATION_HEADER) ?? ''
    if (role !== 'instructor' && !(role === 'seat' && installation !== '')) return new Response('missing board role', { status: 403 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, role === 'instructor' ? ['instructor'] : [`seat:${installation}`])
    server.send(JSON.stringify({ type: 'snapshot', ...await this.snapshot(role === 'instructor' ? undefined : installation) }))
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Answer keep-alive pings.
   * @param socket - The board socket.
   * @param message - `ping`, or anything else to ignore.
   */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') socket.send('pong')
  }

  /**
   * Complete the close handshake.
   * @param socket - The board socket.
   * @param code - Close code.
   * @param reason - Close reason.
   */
  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason)
  }
}
