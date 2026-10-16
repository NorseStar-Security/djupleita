/** Session storage and editor parsing cannot alias two backend identities. */
import { expect, it, vi } from 'vitest'
import { runtimeStorageKey } from '@deepseek-ai/dsh-client-store'
import { get, put, parse, scopeFields } from '../src/client/fields.ts'
import type { CourseConfiguration } from '../src/types.ts'

it('scopes equal session ids by runtime and retains native storage keys', () => {
  try {
    vi.stubGlobal('location', { pathname: '/' }); expect(runtimeStorageKey('dsh.conversation.same')).toBe('dsh.conversation.same')
    vi.stubGlobal('location', { pathname: '/runtimes/course/' }); expect(runtimeStorageKey('dsh.conversation.same')).toBe('dsh.runtime.course.dsh.conversation.same')
  } finally { vi.unstubAllGlobals() }
})
it('parses fields without expanding policy authorization implicitly', () => {
  const field = scopeFields.find(row => row.path === 'policy.domains')!
  expect(parse(field, 'example.test\n*.example.test\n')).toEqual(['example.test', '*.example.test'])
  expect(() => parse(scopeFields.find(row => row.path === 'policy.ports')!, '{bad')).toThrow()
  const config: CourseConfiguration = { policy: { domains: ['example.test'] }, provider: { socketPath: '/fixture', timeoutMs: 1, maxResponseBytes: 1 }, guard: { pollIntervalMs: 1, targetTools: [] }, recon: {}, forwardOpenAIKey: false }
  put(config, 'policy.domain_addresses', { 'example.test': ['192.0.2.1'] })
  expect(get(config, field)).toEqual(['example.test'])
})
it('edits operation restrictions inside policy and action review separately without broadening targets', () => {
  const config: CourseConfiguration = { policy: { domains: ['example.test'], exclude_ips: ['192.0.2.9'] },
    provider: { socketPath: '/fixture', timeoutMs: 1, maxResponseBytes: 1 }, guard: { pollIntervalMs: 1, targetTools: [] },
    recon: {}, forwardOpenAIKey: false }
  const operations = scopeFields.find(row => row.path === 'policy.operations')!
  const review = scopeFields.find(row => row.path === 'actionReview')!
  expect(operations.advanced).toBeUndefined(); expect(review.advanced).toBeUndefined()
  expect(get(config, operations)).toEqual({}); expect(get(config, review)).toEqual({})
  put(config, operations.path, parse(operations, '{"requireMediatedHttp":true}'))
  put(config, review.path, parse(review, '{"evaluators":[]}'))
  expect(config.policy).toEqual({ domains: ['example.test'], exclude_ips: ['192.0.2.9'], operations: { requireMediatedHttp: true } })
  expect(config.actionReview).toEqual({ evaluators: [] })
  expect('allowHostResearch' in config).toBe(false)
})
