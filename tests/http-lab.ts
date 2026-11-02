import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id } from '../packages/contracts/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { PolicyService } from '../packages/policy/src/index.ts';
import { Redactor, TrajectoryStore, EvidenceStore } from '../packages/trajectory/src/index.ts';
import { IdentityService } from '../packages/identities/src/index.ts';
import type { SecretProvider } from '../packages/identities/src/index.ts';
import { HttpBroker, classifyHttp } from '../packages/http/src/index.ts';
import { engagement, scope, policyConfig, testJudge } from './fixtures.ts';

export async function lab() {
  const observed: { path: string; authorization: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    observed.push({ path: req.url ?? '', authorization: req.headers.authorization });
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://excluded.example.test/private' }); res.end(); return; }
    if (req.url === '/large') { res.end('a'.repeat(4096)); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'alice-owned', owner: 'alice', authorization: req.headers.authorization }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Lab did not bind TCP');
  const root = await mkdtemp(join(tmpdir(), 'dsh-http-'));
  const config = engagement({ scope: scope('localhost', address.port) });
  config.scope.targets[0]!.schemes = ['http']; config.scope.networks = ['127.0.0.1/32'];
  config.scope.exclusions = ['excluded.example.test'];
  const scopes = new ScopeService(config.scope, async () => [{ address: '127.0.0.1', family: 4 }]);
  const redactor = new Redactor();
  const trajectories = new TrajectoryStore(join(root, 'trajectories'), config.id, redactor);
  const secretValues = new Map<string, string>();
  const secrets: SecretProvider = {
    async get(key) { return secretValues.get(key); }, async set(key, value) { secretValues.set(key, value); },
    async remove(key) { secretValues.delete(key); },
  };
  const identities = new IdentityService(config.id, secrets, redactor);
  const sessions = new EngagementService(config);
  const sessionId = id<'SessionId'>(); sessions.attach(sessionId);
  const policy = new PolicyService(policyConfig, scopes, testJudge, config.model, trajectories, redactor);
  const evidence = new EvidenceStore(root, redactor);
  const broker = new HttpBroker({ timeoutMs: 5000, maxRedirects: 3, maxRequestBytes: 4096 }, sessions, scopes,
    policy, identities, trajectories, evidence, redactor);
  return { broker, identities, trajectories, sessionId, observed, root, config, sessions, scopes, evidence, redactor, url: `http://localhost:${address.port}`,
    async close() { server.close(); await once(server, 'close'); } };
}
