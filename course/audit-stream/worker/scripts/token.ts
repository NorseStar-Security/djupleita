/**
 * Mint audit-stream tokens or a new signing key.
 *
 *   node scripts/token.ts key
 *   node scripts/token.ts seat  --key-file F --cohort C --student S --installation I [--days N]
 *   node scripts/token.ts board --key-file F --cohort C|'*' [--days N]
 *   node scripts/token.ts admin --key-file F [--days N]
 *
 * The token prints to stdout; keep seat tokens outside every research-writable path.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { signToken, type TokenKind } from '../src/token.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'key-file': { type: 'string' },
    cohort: { type: 'string', default: '' },
    student: { type: 'string', default: '' },
    installation: { type: 'string', default: '' },
    days: { type: 'string', default: '30' },
  },
})
const command = positionals[0]
if (command === 'key') {
  process.stdout.write(`${randomBytes(32).toString('base64url')}\n`)
} else if (command === 'seat' || command === 'board' || command === 'admin') {
  const keyFile = values['key-file']
  if (keyFile === undefined) throw new Error('--key-file is required')
  const days = Number(values.days)
  if (!Number.isFinite(days) || days <= 0 || days > 400) throw new Error('--days must be between 0 and 400')
  const kind: TokenKind = command
  const token = await signToken(readFileSync(keyFile, 'utf8').trim(), {
    kind,
    cohort: kind === 'admin' ? '' : values.cohort,
    student: kind === 'seat' ? values.student : '',
    installation: kind === 'seat' ? values.installation : '',
    expiresAt: Math.floor(Date.now() / 1000 + days * 86_400),
    nonce: randomBytes(9).toString('base64url'),
  })
  process.stdout.write(`${token}\n`)
} else {
  throw new Error('usage: token.ts key | seat | board | admin (see the file header)')
}
