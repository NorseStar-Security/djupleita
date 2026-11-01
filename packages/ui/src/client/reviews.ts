/** One owner-only inbox shared by every visible chat, including unobserved children. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ReviewQuestion, ReviewGrant } from '../../../dsh-plugin/src/review.ts';
import type { ToolSetup } from '../../../dsh-plugin/src/setup.ts';

export interface ReviewSnapshot {
  pending: ReviewQuestion[];
  grants: ReviewGrant[];
  setup?: ToolSetup;
}

export function reviewLoader(connection: Pick<ConnectionHandle, 'rpc'>) {
  // A renderer update may arrive while the old Host is still running a test.
  // Its existing owner snapshot already supports an engagement-wide read.
  let legacyHost = false;
  return async (signal: AbortSignal): Promise<ReviewSnapshot> => {
    if (!legacyHost) {
      try {
        const reply = await connection.rpc.call('/api', 'pentest/review/snapshot', {}, signal);
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.value as ReviewSnapshot;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith('pentest/review/snapshot: HTTP 404')) throw error;
        legacyHost = true;
      }
    }
    const reply = await connection.rpc.call('/api', 'pentest/snapshot', {}, signal);
    if (!reply.ok) throw new Error(reply.error.message);
    const value = reply.value as { review: ReviewSnapshot; setup: ToolSetup };
    return { ...value.review, setup: value.setup };
  };
}
