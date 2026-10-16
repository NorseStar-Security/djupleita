/** Verify protected launch retains the profile's selected model provider. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../..', import.meta.url))

test('protected launch preserves the provider configured in its own Web profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-protected-model-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const generate = `
import json, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(sys.argv[1]) / 'course/scope-runtime'))
from manage import Manager
manager = Manager(sys.argv[2], sys.argv[1], 'fixture-no-docker')
runtime = Path(sys.argv[1]) / 'course/scope-runtime'
review = json.loads((runtime / 'review.json').read_text())
review['evaluators'][0]['model'] = 'fixture-review-model'
request = {'revision': 1, 'publicUrl': 'http://127.0.0.1:3080/runtimes/course/', 'reconEnabled': True,
    'config': {'policy': {'domains': ['example.test'], 'operations': json.loads((runtime / 'scope.json').read_text())['operations']},
        'provider': {'socketPath': '/run/course-public/control.sock'}, 'guard': {}, 'recon': {},
        'forwardOpenAIKey': False, 'actionReview': review},
    'features': {'bundles': [], 'patches': [], 'credentials': {'version': 1, 'refs': {}, 'records': {}},
        'trajectories': True, 'reviewCredentials': {'OPENAI_API_KEY': 'private-review-fixture'}}}
with patch.object(manager, 'run', return_value='') as run:
    manager.configuration(request)
print(json.loads(run.call_args_list[-1].kwargs['data'])['profile.patch.yml'])
`
  const overlay = execFileSync('python3', ['-c', generate, source, join(root, 'state')], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const patchPath = join(root, 'protected.patch.yml')
  await writeFile(patchPath, overlay)
  const home = join(root, 'home')
  const profile = join(home, 'profiles/web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-experimental-network-scope-bundle', '@deepseek-ai/dsh-experimental-recon-bundle'] } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } } },
    { id: 'agent-default-model', config: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' } },
  ]))
  const output = execFileSync(process.execPath, [join(source, 'apps/cli/lib/bin.js'), 'web', '--patch', patchPath, '--dump-config'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home },
  })
  assert.ok(output.includes('apiKeyEnv: OPENROUTER_API_KEY'), 'the protected overlay must retain the selected provider credential reference')
  assert.ok(output.includes('model: deepseek/deepseek-v4.1-flash'), 'the selected model must survive deployment')
  assert.ok(output.includes('course-action-review-guard'), 'the generated deployment must retain mandatory review')
  assert.ok(!output.includes('private-review-fixture'), 'reviewer credentials must not enter the research profile')
})
