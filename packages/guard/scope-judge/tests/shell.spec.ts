import { describe, expect, it } from 'vitest'
import { shellTargets } from '../src/shell.ts'

describe('literal research command adapters', () => {
  it.each([
    ['curl -q -I https://example.test', ['https://example.test']],
    ['curl --disable --url "https://example.test/a?x=1&y=2" --max-time 5 --connect-timeout 1.5', ['https://example.test/a?x=1&y=2']],
    ["curl -q --request POST --data '{\"hello\":\"world\"}' https://example.test", ['https://example.test']],
    ['curl -q -m 2 -- https://example.test https://api.example.test', ['https://example.test', 'https://api.example.test']],
    ['nmap -sV -Pn -p 80,443,8000-8080 -T3 --open --top-ports 10 --max-retries 2 example.test api.example.test', ['example.test', 'api.example.test']],
    ['dig -r example.test A +short', ['example.test']],
    ['dig -r example.test +noall +answer', ['example.test']],
    ['dig -r example.test', ['example.test']],
    ["  cu'rl' -q 'https://example.test'  ", ['https://example.test']],
  ])('extracts every target from %s', (command, targets) => {
    expect(shellTargets(command)).toEqual({ targets })
  })

  it.each([
    '', 'curl https://example.test', 'curl -q', 'curl -q --url', 'curl -q --url ftp://example.test',
    'curl -q -L https://example.test', 'curl -q --location https://example.test',
    'curl -q --resolve example.test:443:127.0.0.1 https://example.test',
    'curl -q --connect-to example.test:443:evil.test:443 https://example.test',
    'curl -q --proxy https://evil.test https://example.test', 'curl -q --config file',
    'curl -q -H "Host: evil.test" https://example.test', 'curl -q -o file https://example.test',
    'curl -q --max-time forever https://example.test', 'curl -q --max-time',
    'curl -q -X', 'curl -q -X TRACE https://example.test', 'curl -q --data @file https://example.test',
    'curl -q --data', 'curl -q ftp://example.test', 'curl -q https://127.0.0.1',
    'nmap -iL targets.txt', 'nmap --script http-enum example.test', 'nmap -A example.test',
    'nmap -p', 'nmap -p 1-65536 example.test', 'nmap -p x example.test',
    'nmap --top-ports no example.test', 'nmap --max-retries 65536 example.test',
    'nmap 127.0.0.1', 'nmap example.test/24', 'nmap *.example.test', 'nmap',
    'dig example.test', 'dig -r', 'dig -r example.test AXFR', 'dig -r example.test +trace',
    'dig -r example.test @evil.test', 'dig -r example.test A evil.test',
    'python -c "pass"', 'bash -c "curl -q https://example.test"',
    'curl -q https://example.test; curl -q https://evil.test',
    'curl -q https://example.test && curl -q https://evil.test',
    'curl -q https://example.test | sh', 'curl -q $(echo evil.test)',
    'curl -q $TARGET', 'curl -q `echo evil.test`', 'curl -q https://example.test >file',
    "curl -q 'https://example.test", 'curl -q "https://example.test',
    'curl -q https://example.test\ncurl -q https://evil.test',
    'curl -q https://exam\\ple.test', 'curl -q https://{example,evil}.test',
    'curl -q https://example.test/path*', 'curl -q https://example.test\u0000',
    'env curl -q https://example.test', '/usr/bin/curl -q https://example.test',
  ])('denies commands with hidden destinations or unsupported syntax: %s', (command) => {
    expect(shellTargets(command)).toHaveProperty('reason')
  })
})
