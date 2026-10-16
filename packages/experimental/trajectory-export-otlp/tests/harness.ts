import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import protobuf from 'protobufjs'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Exporter from '../src/index.ts'
import * as CollectorExporter from '../src/collector.ts'
import CollectorSqlite from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'

// Standard OTLP wire field numbers; decoding is independent of the SDK serializer.
const root = protobuf.parse(`syntax = "proto3";
message Value { string stringValue = 1; int64 intValue = 3; }
message Attribute { string key = 1; Value value = 2; }
message Log { fixed64 timeUnixNano = 1; Value body = 5; repeated Attribute attributes = 6; string eventName = 12; }
message Scope { repeated Log logRecords = 2; }
message Resource { repeated Scope scopeLogs = 2; }
message Request { repeated Resource resourceLogs = 1; }
message Partial { int64 rejectedLogRecords = 1; string errorMessage = 2; }
message Response { Partial partialSuccess = 1; }`).root
interface WireValue { stringValue?: string; intValue?: string }
interface WireLog { body: WireValue; attributes: { key: string; value: WireValue }[]; eventName: string; timeUnixNano: string }
interface WireRequest { resourceLogs?: { scopeLogs: { logRecords: WireLog[] }[] }[] }
export interface Received { body: string; attributes: Record<string, string>; eventName: string }

export function decode(bytes: Uint8Array): Received[] {
  const type = root.lookupType('Request')
  const value = type.toObject(type.decode(bytes), { longs: String }) as WireRequest
  return (value.resourceLogs ?? []).flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords.map(log => ({
    body: log.body.stringValue ?? '', eventName: log.eventName,
    attributes: Object.fromEntries(log.attributes.map(attribute => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue ?? ''])),
  }))))
}

export function partialResponse(rejectedLogRecords: number): Uint8Array {
  return root.lookupType('Response').encode({ partialSuccess: { rejectedLogRecords, errorMessage: 'fixture rejection' } }).finish()
}

export const cleanups: (() => Promise<unknown>)[] = []

export function resolveConfig(value: unknown): Exporter.Config {
  return z.resolve(value, Exporter.Config, {})[0] as Exporter.Config
}

export async function fixture(config: Partial<Exporter.Config> = {}, onExit?: (code: number) => void, collectorSource = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-trajectory-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'sessions')
  const stateDir = join(directory, 'state')
  const tokenFile = join(directory, 'token')
  await mkdir(source)
  await writeFile(tokenFile, 'fixture-write-token\n', { mode: 0o600 })
  const records: Received[] = []
  const requests: { authorization: string | undefined; bytes: number; path: string | undefined }[] = []
  const state = { status: 200, response: Buffer.alloc(0), hang: false, disconnect: false, active: 0,
    redirect: '', retryAfter: '', contentType: 'application/x-protobuf', callback: undefined as (() => void) | undefined }
  const failures: unknown[] = []
  const receive = async (request: IncomingMessage, response: ServerResponse) => {
    state.active++
    response.once('close', () => { state.active-- })
    const chunks: Buffer[] = []
    for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    requests.push({ authorization: request.headers.authorization, bytes: bytes.length, path: request.url })
    records.push(...decode(bytes))
    state.callback?.()
    if (state.hang) return
    if (state.disconnect) { response.destroy(); return }
    response.statusCode = state.status
    response.setHeader('content-type', state.contentType)
    if (state.retryAfter) response.setHeader('retry-after', state.retryAfter)
    if (state.redirect) response.setHeader('location', state.redirect)
    response.end(state.response)
  }
  const server = createServer((request, response) => {
    void receive(request, response).catch((error: unknown) => { failures.push(error); response.destroy() })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    if (failures.length) throw new AggregateError(failures, 'fixture receiver failed')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address missing')
  const endpoint = `http://127.0.0.1:${address.port}/v1/logs`
  const writer = new Context()
  cleanups.push(() => writer.fiber.dispose())
  await writer.plugin(Jsonl, { root: source, compression: 'none', listConcurrency: 1 }).await()
  let collector: Context | undefined
  const boot = async (overrides: Partial<Exporter.Config> = {}) => {
    collector = new Context()
    const ctx = collector
    if (onExit !== undefined) ctx.provide('appExit', onExit)
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, jsonl: Jsonl, sqlite: CollectorSqlite,
      trajectory: collectorSource ? CollectorExporter : Exporter })
    const resolved = resolveConfig({ endpoint, tokenFile, stateDir, sourceId: 'course-fixture', allowFullContent: true,
      allowInsecureLoopback: true, pollIntervalMs: 20, retryInitialMs: 20, retryMaxMs: 40, timeoutMs: 1000, ...config, ...overrides })
    const path = join(directory, 'cordis.yml')
    const provider = collectorSource
      ? { name: 'cordis:sqlite', config: { path: join(directory, 'intake', 'collector.db'), minFreeBytes: 0 } }
      : { name: 'cordis:jsonl', config: { root: source, compression: 'none', listConcurrency: 1 } }
    await writeFile(path, `- name: ${provider.name}\n  config: ${JSON.stringify(provider.config)}\n- name: cordis:trajectory\n  config: ${JSON.stringify(resolved)}\n`)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    return ctx
  }
  const seed = async (id = 'trajectory', events: readonly SessionEvent[] = []) => {
    const handle = await writer.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false,
    })
    await handle.append(events)
    await handle.flush()
    cleanups.push(() => handle.close())
    const reader = await writer.sessionPersistence.open(handle.id, 'read')
    try { await reader.read() } finally { await reader.close() }
    return handle
  }
  return { directory, source, stateDir, tokenFile, records, requests, state, endpoint, writer, seed, boot,
    stop: async () => { await collector?.fiber.dispose() },
    health: async () => JSON.parse(await readFile(join(stateDir, 'health.json'), 'utf8')) as { state: string; code?: string },
    arrived: () => new Promise<void>((resolve) => { state.callback = resolve }),
  }
}

export function event(seq: number, title = `event-${seq}`): SessionEvent {
  return { seq: SessionSeq(seq), time: 1000 + seq, type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } }
}
