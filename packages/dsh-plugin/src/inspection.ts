/** Bounded model-facing trajectory inspection; full payloads stay in the owner UI/log. */
import { z } from 'zod';
import { PentestError } from '@dsh-pentest/contracts';
import type { Json, SessionId, TrajectoryEvent } from '@dsh-pentest/contracts';
import type { TrajectoryStore } from '@dsh-pentest/trajectory';

export const TrajectoryInputSchema = z.object({
  before: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).default(20),
  eventSeq: z.number().int().min(0).optional(),
}).strict();
function metadata(event: TrajectoryEvent): Json {
  return { seq: event.seq, timestamp: event.timestamp, type: event.type, hash: event.hash,
    payloadBytes: Buffer.byteLength(JSON.stringify(event.data)) };
}
export async function inspectTrajectory(store: TrajectoryStore, session: SessionId, raw: unknown): Promise<Json> {
  const input = TrajectoryInputSchema.parse(raw), events = await store.read(session);
  if (input.eventSeq !== undefined) {
    const event = events[input.eventSeq];
    if (!event) throw new PentestError('TRAJECTORY_EVENT', 'No trajectory event with that sequence number in this chat');
    const bytes = Buffer.from(JSON.stringify(event.data));
    const preview = new TextDecoder().decode(bytes.subarray(0, 4096), { stream: true });
    return { event: metadata(event), dataPreview: preview, truncated: bytes.length > 4096,
      fullData: 'View the complete event in Pentest → Trajectory or the local trajectory log.' };
  }
  const eligible = events.filter(event => input.before === undefined || event.seq < input.before), page = eligible.slice(-input.limit);
  return { events: page.map(metadata), totalEvents: events.length,
    nextBefore: eligible.length > page.length ? page[0]!.seq : null,
    detail: 'Use eventSeq to inspect one bounded payload preview. This list does not embed previous tool responses.' };
}
