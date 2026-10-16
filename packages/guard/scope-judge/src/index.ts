/**
 * Pre-execution domain policy for course research tools. Unclassified tools and
 * indeterminate destinations are denied; reviewed adapters declare all targets.
 * @module @deepseek-ai/dsh-scope-judge
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createJudge } from './judge.ts'

export const name = 'scope-judge'
export const inject = ['tools']

/** Deployment-owned scope and reviewed tool adapters; never supplied by the model. */
export interface Config {
  /** Exact DNS names or explicit `*.domain` descendants; required and nonempty. */
  domains: string[]
  /** Tool names and required JSON-pointer paths to every destination string. */
  targetTools?: {
    /** Registered tool name whose implementation has been reviewed. */
    name: string
    /** Required JSON pointers covering every destination; * selects array members. */
    paths: string[]
  }[]
  /** One-shot Bash tools accepting only the documented literal command subset. */
  shellTools?: string[]
  /** Reviewed tools with no network or arbitrary execution capability. */
  localTools?: string[]
}

/** Validate parser-level fields; semantic validation completes before guard registration. */
export const Config: z<Config> = z.object({
  domains: z.array(z.string()).required(),
  targetTools: z.array(z.object({
    name: z.string().required(),
    paths: z.array(z.string()).required(),
  })).default([{ name: 'web_fetch', paths: ['/url'] }]),
  shellTools: z.array(z.string()).default([]),
  localTools: z.array(z.string()).default([]),
})

/**
 * Install one synchronous, monotonic judge on the tool executor. Denials reach
 * native and nested PTC callers as ordinary error results without running the tool.
 * @param ctx - plugin context owning the guard and its unload lifecycle.
 * @param config - instructor-controlled domains and tool classification.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.guard(createJudge(config))
}
