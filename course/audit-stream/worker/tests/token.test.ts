import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bearer, signToken, TokenError, verifyToken, type TokenClaims } from '../src/token.ts'

const KEY = 'k'.repeat(48)
const NOW = 1_800_000_000
const seat: TokenClaims = { kind: 'seat', cohort: 'pilot', student: 'seat-01', installation: 'webtop-01', expiresAt: NOW + 3600, nonce: 'nonce-0001' }

test('a signed seat token verifies to its claims', async () => {
  assert.deepEqual(await verifyToken(KEY, await signToken(KEY, seat), NOW), seat)
})

test('a token signed with another key, edited claims, or a past expiry is refused', async () => {
  const token = await signToken(KEY, seat)
  await assert.rejects(verifyToken('x'.repeat(48), token, NOW), TokenError)
  const [prefix, , signature] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ k: 'seat', c: 'pilot', s: 'seat-02', i: 'webtop-01', x: NOW + 3600, n: 'nonce-0001' })).toString('base64url')
  await assert.rejects(verifyToken(KEY, `${prefix}.${forged}.${signature}`, NOW), TokenError)
  await assert.rejects(verifyToken(KEY, token, NOW + 3600), TokenError)
})

test('labels that could escape a storage key are refused at signing', async () => {
  await assert.rejects(signToken(KEY, { ...seat, installation: '../other' }), TokenError)
  await assert.rejects(signToken(KEY, { ...seat, cohort: '*' }), TokenError)
})

test('board tokens may name every cohort; admin tokens carry no labels', async () => {
  const board: TokenClaims = { kind: 'board', cohort: '*', student: '', installation: '', expiresAt: NOW + 60, nonce: 'nonce-0002' }
  assert.deepEqual(await verifyToken(KEY, await signToken(KEY, board), NOW), board)
  await assert.rejects(signToken(KEY, { ...board, kind: 'admin' }), TokenError)
})

test('short keys are refused', async () => {
  await assert.rejects(signToken('short', seat), TokenError)
})

test('bearer extracts only Bearer credentials', () => {
  assert.equal(bearer('Bearer abc.def.ghi'), 'abc.def.ghi')
  assert.equal(bearer('Basic abc'), undefined)
  assert.equal(bearer(null), undefined)
})
