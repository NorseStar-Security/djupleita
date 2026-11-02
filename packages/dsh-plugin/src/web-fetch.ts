/** Preserve native web_fetch output while using the engagement's checked transport. */
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { PentestError } from '@dsh-pentest/contracts';
import type { Json } from '@dsh-pentest/contracts';
import { z } from 'zod';
import type { PentestRuntime } from './runtime.ts';

export async function webFetch(runtime: PentestRuntime, exec: ToolExecution): Promise<Json> {
  const { url } = z.object({ url: z.url().max(2048) }).parse(exec.arguments);
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new PentestError('WEB_INVALID_URL', 'Native web fetch requires HTTP(S)');
  const session = runtime.session(exec);
  const { result, response } = await runtime.http(session).deliver({ url, method: 'GET',
    headers: { accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8' } },
  session, exec.signal, runtime.approve);
  const contentType = response.headers['content-type'] ?? '';
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const kind = mime === 'text/html' || mime === 'application/xhtml+xml' ? 'html'
    : mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime) || /\+(?:json|xml)$/.test(mime) ? 'text' : undefined;
  if (!kind) throw new PentestError('WEB_UNSUPPORTED_CONTENT_TYPE', 'Native web fetch requires a text, HTML, JSON or XML response');
  const charset = /;\s*charset\s*=\s*"?([^";]+)/i.exec(contentType)?.[1]?.trim();
  let content: string;
  try { content = response.bytes ? new TextDecoder(charset ?? 'utf-8').decode(response.bytes) : response.body; }
  catch (cause) { throw new PentestError('WEB_UNSUPPORTED_CONTENT_TYPE', 'Native web fetch received an unsupported charset', { cause }); }
  content = runtime.redactor.text(content);
  const maxChars = 100_000;
  return runtime.redactor.json({ url: result.url, statusCode: result.status,
    body: { kind, content: content.slice(0, maxChars) }, truncated: content.length > maxChars });
}
