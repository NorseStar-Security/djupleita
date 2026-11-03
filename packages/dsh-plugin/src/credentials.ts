/** Owner-only plugin credential setup. Values never enter plugin JSON or tool arguments. */
import { z } from 'zod';
import { PentestError } from '@dsh-pentest/contracts';
import type { IdentityId, SessionId } from '@dsh-pentest/contracts';
import type { PentestRuntime } from './runtime.ts';

export const CredentialSlot = z.string().regex(/^(pdcp|chaos|telemetry|jev|subfinder:[a-z][a-z0-9_-]{0,63}|uncover:shodan)$/);
export const CredentialInput = z.object({ slot: CredentialSlot, secret: z.string().min(1).max(16384),
  header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/).optional(), bearer: z.boolean().optional() }).strict();
export interface CredentialStatus { slot: string; label: string; configured: boolean; destination: string; }
export class PluginCredentials {
  private queue = Promise.resolve();
  private closing = false;
  async close(): Promise<void> { this.closing = true; await this.queue; }
  constructor(private readonly runtime: PentestRuntime) {}
  private binding(slot: string): string | undefined {
    const c = this.runtime.pluginConfig;
    if (slot === 'pdcp') return c.intelligence.pdcpIdentityId;
    if (slot === 'chaos') return c.intelligence.chaosIdentityId;
    if (slot === 'telemetry') return c.telemetry?.identityId;
    if (slot === 'jev') return this.runtime.policyConfig.judge?.identityId;
    const [tool, provider] = slot.split(':') as ['subfinder' | 'uncover', string];
    return c.recon.providerIdentities?.[tool]?.[provider];
  }
  private destination(slot: string): string {
    if (slot === 'pdcp') return 'api.projectdiscovery.io';
    if (slot === 'chaos') return 'dns.projectdiscovery.io';
    if (slot === 'jev') return 'api.typesafe.ai';
    if (slot === 'telemetry') {
      const endpoint = this.runtime.pluginConfig.telemetry?.endpoint;
      if (!endpoint) throw new PentestError('CREDENTIAL_CONFIG', 'Configure the telemetry endpoint first');
      const url = new URL(endpoint);
      if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
        throw new PentestError('CREDENTIAL_TRANSPORT', 'Telemetry credentials require HTTPS (or a loopback test endpoint)');
      return url.hostname;
    }
    return slot.split(':')[1]!;
  }
  status(): { storage: string; entries: CredentialStatus[] } {
    const slots = ['pdcp','chaos','telemetry','jev', 'uncover:shodan',
      ...Object.keys(this.runtime.pluginConfig.recon.providerIdentities?.subfinder ?? {}).map(key => `subfinder:${key}`)];
    return { storage: process.platform === 'darwin' ? 'macOS Keychain' : 'Linux Secret Service', entries: slots.map(slot => {
      let destination = ''; try { destination = this.destination(slot); } catch { /* Not configured yet. */ }
      return { slot, destination, label: ({pdcp:'ProjectDiscovery Cloud',chaos:'Chaos',telemetry:'Telemetry collector',jev:'Jev risk judge'} as Record<string,string>)[slot] ?? (slot.startsWith('subfinder:') ? `${slot.split(':')[1]} · Subfinder` : 'Shodan · Uncover'),
        configured: Boolean(this.binding(slot) && this.runtime.identities.list().some(identity => identity.id === this.binding(slot))) };
    }) };
  }
  save(raw: unknown, session: SessionId, signal?: AbortSignal): Promise<void> {
    // Register before validation: a schema or secure-store error must not echo a key.
    if (raw && typeof raw === 'object' && 'secret' in raw && typeof raw.secret === 'string') this.runtime.redactor.register(raw.secret);
    const parsed = CredentialInput.safeParse(raw);
    if (!parsed.success || /[\r\n\0]/.test(parsed.data.secret)) return Promise.reject(new PentestError('INVALID_CREDENTIAL', 'Use a nonempty, single-line API key and a supported plugin credential slot'));
    const input = parsed.data;
    return this.serial(async () => {
      const slot = input.slot, destination = this.destination(slot), cli = slot.includes(':');
      const old = this.binding(slot);
      const header = slot === 'pdcp' ? 'X-API-Key' : slot === 'chaos' ? 'Authorization' : input.header ?? 'Authorization';
      if (/^(host|connection|content-length|transfer-encoding|proxy-authorization|cookie)$/i.test(header)) throw new PentestError('INVALID_CREDENTIAL', 'Choose an API-key or authorization header');
      const bearer = slot === 'pdcp' || slot === 'chaos' ? false : input.bearer ?? true;
      const identity = await this.runtime.createIdentity({ name: `Plugin · ${slot}`, role:'plugin', tenant:'service',
        hosts:[cli ? 'credential.invalid' : destination], kind: cli ? 'api-key' : 'headers', pluginCredential: slot },
        cli ? input.secret : JSON.stringify({[header]: `${bearer ? 'Bearer ' : ''}${input.secret}`}), signal);
      try { await this.bind(slot, identity.id, session); }
      catch (error) { await this.runtime.removePluginIdentity(identity.id).catch(() => {}); throw error; }
      await this.retire(old);
    });
  }
  remove(raw: string, session: SessionId): Promise<void> {
    const slot = CredentialSlot.parse(raw);
    return this.serial(async () => {
      // A locked store must leave the reference connected so removal can be retried.
      const bindings = JSON.stringify([this.runtime.pluginConfig,this.runtime.policyConfig]), active = this.binding(slot);
      for (const record of this.runtime.identities.list().filter(item => item.pluginCredential && (item.pluginCredential === slot || item.id === active))) {
        const references = bindings.split(record.id).length - 1;
        if (!references || record.id === active && references === 1) await this.runtime.removePluginIdentity(record.id);
      }
      await this.bind(slot, undefined, session);
    });
  }
  private serial(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new PentestError('RUNTIME_CLOSED', 'Engagement is closing'));
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }
  private async retire(identity?: string): Promise<void> {
    if (!identity) return;
    const record = this.runtime.identities.list().find(item => item.id === identity);
    if (record?.pluginCredential && !JSON.stringify([this.runtime.pluginConfig,this.runtime.policyConfig]).includes(identity))
      await this.runtime.removePluginIdentity(identity as IdentityId);
  }
  private async bind(slot: string, identity: string | undefined, session: SessionId): Promise<void> {
    const c = structuredClone(this.runtime.pluginConfig);
    if (slot === 'jev') {
      const policy = { ...structuredClone(this.runtime.policyConfig), judge: { ...this.runtime.policyConfig.judge ?? {kind:'selected-model' as const,fallback:true} } };
      if (identity) policy.judge.identityId = identity; else delete policy.judge.identityId;
      await this.runtime.updateSettings(this.runtime.scope.scope, policy, session); return;
    }
    if (slot === 'pdcp' || slot === 'chaos') {
      const key = slot === 'pdcp' ? 'pdcpIdentityId' : 'chaosIdentityId';
      if (identity) c.intelligence[key] = identity; else delete c.intelligence[key];
    } else if (slot === 'telemetry') {
      if (!c.telemetry) throw new PentestError('CREDENTIAL_CONFIG', 'Configure the telemetry endpoint first');
      if (identity) c.telemetry.identityId = identity; else delete c.telemetry.identityId;
    } else {
      const [tool, provider] = slot.split(':') as ['subfinder'|'uncover',string];
      c.recon.providerIdentities ??= {}; c.recon.providerIdentities[tool] ??= {};
      if (identity) c.recon.providerIdentities[tool]![provider] = identity; else delete c.recon.providerIdentities[tool]![provider];
      if (tool === 'subfinder' && identity && !c.recon.sources.includes(provider)) c.recon.sources.push(provider);
      if (tool === 'subfinder' && !identity) c.recon.sources = c.recon.sources.filter(source => source !== provider);
      if (!c.recon.sources.length) c.recon.sources = ['crtsh'];
    }
    await this.runtime.updatePlugins(c, session);
  }
}
