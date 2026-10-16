/** Log-only action admission and settlement records; no reviewer reasoning or credentials. */
import type { ActionReviewDecision } from '@deepseek-ai/dsh-experimental-action-review/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Committed before delegation; the external receipt acknowledges trusted durable storage. */
    'plugin:action-review-guard/decision': {
      callId: ToolCallId
      rootCallId: ToolCallId
      parentCallId?: ToolCallId
      tool: string
      allowed: boolean
      code: string
      review?: ActionReviewDecision
    }
    /** Actual final dispatch outcome, including calls denied before a body can run. */
    'plugin:action-review-guard/result': {
      callId: ToolCallId
      tool: string
      isError: boolean
      reviewed: boolean
      receipt?: number
    }
  }
}
