#!/usr/bin/env node
// A deterministic external CLI substitute; it never opens a network socket.
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
const control = JSON.parse(await readFile(join(root, 'control.json'), 'utf8'))
let input = ''
for await (const chunk of process.stdin) input += chunk
await appendFile(join(root, 'effects.jsonl'), JSON.stringify({ argv: process.argv.slice(2), input, home: process.env.HOME, key: process.env.DEEPSEEK_API_KEY, pid: process.pid }) + '\n')
if (control.hang) await new Promise(() => { setInterval(() => {}, 1000) })
process.stdout.write(control.stdout ?? '{"host":"example.test"}\n')
process.stderr.write(control.stderr ?? '')
process.exitCode = control.exit ?? 0
