import { it, expect } from 'vitest';
import { classifyHttp } from '../packages/http/src/index.ts';
import { lab } from './http-lab.ts';

it('pins a scoped hostname to the approved local socket and keeps identities separate', async () => {
  const fixture = await lab();
  try {
    const alice = await fixture.identities.create({ name: 'Alice', role: 'member', tenant: 'a', hosts: ['localhost'], kind: 'bearer' }, 'alice-token');
    const bob = await fixture.identities.create({ name: 'Bob', role: 'member', tenant: 'b', hosts: ['localhost'], kind: 'bearer' }, 'bob-token');
    const signal = AbortSignal.timeout(5000);
    const a = await fixture.broker.request({ url: `${fixture.url}/objects/1`, method: 'GET', headers: {}, identityId: alice.id }, fixture.sessionId, signal);
    const b = await fixture.broker.request({ url: `${fixture.url}/objects/1`, method: 'GET', headers: {}, identityId: bob.id }, fixture.sessionId, signal);
    const anon = await fixture.broker.request({ url: `${fixture.url}/objects/1`, method: 'GET', headers: {} }, fixture.sessionId, signal);
    expect(fixture.observed.map(item => item.authorization)).toEqual(['Bearer alice-token', 'Bearer bob-token', undefined]);
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(anon.status).toBe(200);
    expect(a.body).not.toContain('alice-token');
    const recorded = JSON.stringify(await fixture.trajectories.read(fixture.sessionId));
    expect(recorded).not.toContain('alice-token'); expect(recorded).not.toContain('bob-token');
  } finally { await fixture.close(); }
});
it('blocks an excluded redirect and a deletion before their target receives a request', async () => {
  const fixture = await lab();
  try {
    await expect(fixture.broker.request({ url: `${fixture.url}/redirect`, method: 'GET', headers: {} }, fixture.sessionId, AbortSignal.timeout(5000))).rejects.toThrow(/Excluded/);
    await expect(fixture.broker.request({ url: `${fixture.url}/objects/1`, method: 'DELETE', headers: {} }, fixture.sessionId, AbortSignal.timeout(5000))).rejects.toThrow(/one-shot/);
    expect(fixture.observed).toHaveLength(1);
    expect((await fixture.trajectories.read(fixture.sessionId)).filter(event => event.type === 'policy/decision')).toHaveLength(3);
  } finally { await fixture.close(); }
});
it('detects deletion semantics outside the HTTP method', () => {
  expect(classifyHttp({ url: 'https://app.test/object?action=delete', method: 'GET', headers: {} }).effects).toContain('delete');
  expect(classifyHttp({ url: 'https://app.test/graphql', method: 'POST', headers: {}, body: 'mutation { deleteUser(id: "1") }' }).effects).toContain('delete');
});
