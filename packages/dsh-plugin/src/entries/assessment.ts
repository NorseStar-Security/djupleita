import type { Context } from '@deepseek-ai/cordis';
import { AssessmentTools } from '../assessment.ts';
import { AssessmentSkills } from '../skills.ts';
export const name = 'pentest-assessment-bundle';
export const inject = ['tools', 'pentest'];
export function apply(ctx: Context): void { ctx.plugin(AssessmentTools); ctx.plugin(AssessmentSkills); }
