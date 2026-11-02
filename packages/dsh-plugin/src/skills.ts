/** Read-only bundled skill catalog, also exposed through the native DSH skill registry. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { SkillCandidate } from '@deepseek-ai/dsh-skill';
import { z } from 'zod';
import { toolSchema } from './tool-schema.ts';
import { PentestError } from '@dsh-pentest/contracts';
import type {} from './index.ts';

const names = ['djupleita-assessment', 'djupleita-readiness', 'djupleita-coverage', 'djupleita-proof', 'djupleita-report'] as const;
export function bundledSkills(): { candidate: SkillCandidate; content: string }[] {
  return names.map(name => {
    const path = fileURLToPath(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url));
    const raw = readFileSync(path, 'utf8'), match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n([\s\S]+)$/.exec(raw);
    if (!match || match[1] !== name) throw new PentestError('SKILL_FORMAT', `Invalid bundled skill: ${name}`);
    return { candidate: { name, description: match[2]!, path, invocation: { modelInvocable: true, userInvocable: true },
      provider: 'djupleita-assessment', source: 'bundled', rank: 600, locator: name }, content: match[3]! };
  });
}
export const AssessmentSkills = {
  name: 'pentest-assessment-skills', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    const entries = bundledSkills();
    ctx.inject(['skills'], inner => {
      inner.skills.registerProvider(() => ({ name: 'djupleita-assessment',
        list: async () => entries.map(item => item.candidate),
        get: async candidate => { const entry = entries.find(item => item.candidate.name === candidate.name); if (!entry) return undefined;
          const { rank: _rank, locator: _locator, ...summary } = entry.candidate; return { ...summary, content: entry.content }; },
      }));
    });
    ctx.inject(['systemPrompt'], inner => {
      inner.systemPrompt.context({ name: 'djupleita-assessment-workflow', order: 810, required: true, interpolate: false,
        text: () => 'For a web/API assessment, load pentest_skill djupleita-assessment before testing. Plan bounded coverage, prove readiness and identity separation, retain unresolved leads, and validate candidate findings with owner assertions. Only owner-reviewed deterministic proofs enter reports. A paused, failed, cancelled or partial run never establishes target safety. Subagents must join the parent run before target actions. Bundled skills: ' + entries.map(entry => `${entry.candidate.name}: ${entry.candidate.description}`).join('\n') });
    });
    ctx.effect(() => ctx.pentest.registerDescriptor('pentest_skill', { plugin: 'assessment', confinement: 'local-read',
      describe: () => ({ destinations: [], effects: ['read'], reversible: true }) }), 'pentest: skill effects');
    ctx.effect(() => ctx.pentest.registerDescriptor('skill', { plugin: 'assessment', confinement: 'local-read',
      describe: () => ({ destinations: [], effects: ['read'], reversible: true }) }), 'pentest: native skill effects');
    const schema = z.object({ name: z.enum(names) });
    ctx.tools.register({ name: 'pentest_skill', description: 'Load a bundled Djupleita assessment skill. This reads trusted workflow instructions; it grants no target access or tool approvals.',
      parameters: toolSchema(schema), output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: (value as { content: string }).content }] },
      async execute(args) { const name = schema.parse(args).name; return { name, content: entries.find(entry => entry.candidate.name === name)!.content }; } });
  },
};
