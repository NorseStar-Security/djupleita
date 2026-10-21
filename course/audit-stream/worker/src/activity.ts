/**
 * Compact live-board summaries derived from complete DSH Session records (format v4 event shapes).
 *
 * Summaries are a display projection only. The verified record bytes in R2 remain the evidence;
 * unknown or unreadable event types summarize to their type name.
 */

/** Counters a record contributes to its Session totals. */
export interface ActivityCounters {
  reasoningChars: number
  toolCalls: number
  toolErrors: number
  scopeDenials: number
}

/** One record as the live board shows it. */
export interface ActivitySummary extends ActivityCounters {
  /** Short line for the feed. */
  text: string
  /** Up to {@link PREVIEW_CHARS} characters of reasoning text, when the record carries reasoning. */
  reasoning: string
  /** Session title, when this record sets one. */
  title: string | undefined
  /** `provider/model`, when this record names the request model. */
  model: string | undefined
}

/** Maximum characters kept in a feed line or reasoning preview. */
export const PREVIEW_CHARS = 400

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function blocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.map(object) : []
}

function textOf(content: unknown, type: string): string {
  return blocks(content).filter((block) => block['type'] === type && typeof block['text'] === 'string')
    .map((block) => block['text'] as string).join('\n')
}

const EMPTY: ActivityCounters = { reasoningChars: 0, toolCalls: 0, toolErrors: 0, scopeDenials: 0 }

/**
 * Summarize one complete record.
 * @param type - The record's `dsh.event.type` attribute.
 * @param json - The record's exact JSON text.
 * @returns The feed projection and the counters this record adds.
 */
export function summarize(type: string, json: string): ActivitySummary {
  const base: ActivitySummary = { ...EMPTY, text: type, reasoning: '', title: undefined, model: undefined }
  let record: Record<string, unknown>
  try {
    record = object(JSON.parse(json))
  } catch {
    // The receiver already verified the digest; a non-JSON body still lands in R2 and summarizes by type.
    return base
  }
  const data = object(record['data'])
  switch (type) {
    case 'session':
      return { ...base, text: `session started in ${String(record['cwd'] ?? 'an unknown directory')}` }
    case 'turn/start':
      return { ...base, text: `turn ${String(data['turn'] ?? '?')} started` }
    case 'turn/end':
      return { ...base, text: `turn ${String(data['turn'] ?? '?')} ended: ${String(object(data['reason'])['kind'] ?? 'unknown')}` }
    case 'user/message':
      return { ...base, text: `user: ${clip(textOf(data['content'], 'text'))}` }
    case 'request/context':
      return { ...base, text: `model ${String(data['provider'])}/${String(data['model'])}`, model: `${String(data['provider'])}/${String(data['model'])}` }
    case 'session/title':
      return { ...base, text: `title: ${clip(String(data['title'] ?? ''))}`, title: String(data['title'] ?? '') }
    case 'assistant/message': {
      const message = object(data['message'])
      const reasoning = textOf(message['content'], 'reasoning')
      const text = textOf(message['content'], 'text')
      const calls = blocks(message['content']).filter((block) => block['type'] === 'tool-call')
        .map((block) => String(block['name'] ?? block['toolName'] ?? 'tool'))
      const parts = [
        reasoning.length > 0 ? `thought ${reasoning.length} chars` : 'no reasoning returned',
        text.length > 0 ? `said: ${clip(text)}` : '',
        calls.length > 0 ? `calls ${calls.join(', ')}` : '',
      ].filter((part) => part !== '')
      return { ...base, text: `assistant: ${parts.join('; ')}`, reasoning: clip(reasoning), reasoningChars: reasoning.length }
    }
    case 'tool/call':
      return { ...base, text: `call ${String(data['name'] ?? 'tool')} ${clip(String(data['arguments'] ?? ''))}`, toolCalls: 1 }
    case 'tool/result': {
      const message = object(data['message'])
      const failed = message['isError'] === true
      return { ...base, text: `${failed ? 'tool error' : 'tool result'}: ${clip(textOf(message['content'], 'text'))}`, toolErrors: failed ? 1 : 0 }
    }
    case 'job/settled':
      return { ...base, text: `job ${String(data['status'] ?? '?')}: ${clip(String(data['label'] ?? ''))} (${String(data['detail'] ?? '')})` }
    case 'plugin:network-scope-guard/judge': {
      const allowed = data['allowed'] === true
      return { ...base, text: `scope ${allowed ? 'allowed' : 'DENIED'} ${String(data['tool'] ?? '')}: ${String(data['code'] ?? '')}`, scopeDenials: allowed ? 0 : 1 }
    }
    default:
      return base
  }
}
