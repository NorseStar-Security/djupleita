/** Explicit local UI fixture: pauses before a simulated action and performs no I/O on any target. */
import { createHash, randomUUID } from 'node:crypto';
export const name = 'djupleita-review-ui-fixture';
export const inject = ['commands', 'pentest'];
export function apply(ctx) {
  ctx.commands.register({ name: 'review_test', description: 'Run the local approval UI acceptance fixture',
    async handler({ agent, signal, rawInput }) {
      const sessionId = agent.id;
      const args = { fixture: 'local-only', resource: rawInput.trim() || 'sample-1' };
      const origin = { sessionId, tool: 'acceptance_delete', callId: randomUUID(), arguments: args,
        argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), grants: new Set() };
      const action = { id: randomUUID(), engagementId: ctx.pentest.config.engagement.id, sessionId,
        tool: origin.tool, plugin: 'acceptance-fixture', arguments: args, destinations: [], effects: ['delete'], reversible: false };
      await ctx.pentest.review.run(origin, () => ctx.pentest.policy(sessionId).authorize({ action, signal }, ctx.pentest.approve));
      return { kind: 'success', text: 'Local approval fixture resumed. No target operation was performed.' };
    },
  });
}
