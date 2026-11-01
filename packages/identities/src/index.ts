/** Credential references, destination-bound delivery, and a macOS Keychain provider. */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { PentestError, id } from '@dsh-pentest/contracts';
import type { EngagementId, IdentityId } from '@dsh-pentest/contracts';
import { matchesHost } from '@dsh-pentest/scope';
import type { Redactor } from '@dsh-pentest/trajectory';

export interface SecretProvider {
  get(reference: string, signal?: AbortSignal): Promise<string | undefined>;
  set(reference: string, value: string, signal?: AbortSignal): Promise<void>;
  remove(reference: string, signal?: AbortSignal): Promise<void>;
}
export const IdentitySchema = z.object({
  id: z.string().uuid(), name: z.string().min(1), role: z.string().min(1), tenant: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
  kind: z.enum(['bearer', 'basic', 'headers', 'browser-state']),
});
export type Identity = Omit<z.infer<typeof IdentitySchema>, 'id'> & { id: IdentityId };

export class IdentityService {
  private readonly identities = new Map<IdentityId, Readonly<Identity>>();
  private readonly redactions = new Map<IdentityId, () => void>();
  constructor(private readonly engagementId: EngagementId, private readonly secrets: SecretProvider, private readonly redactor: Redactor) {}

  /** Restore non-secret metadata independently of its Keychain record. */
  restore(identity: Identity): void {
    IdentitySchema.parse(identity);
    for (const host of identity.hosts) matchesHost('validation.invalid', host);
    if (this.identities.has(identity.id)) throw new PentestError('IDENTITY_EXISTS', 'Identity already exists');
    this.identities.set(identity.id, Object.freeze(structuredClone(identity)));
  }

  async create(metadata: Omit<Identity, 'id'>, secret: string, signal?: AbortSignal): Promise<Readonly<Identity>> {
    const identity = { ...metadata, id: id<'IdentityId'>() };
    IdentitySchema.parse(identity);
    this.validateSecret(identity.kind, secret);
    for (const host of identity.hosts) matchesHost('validation.invalid', host);
    await this.secrets.set(this.reference(identity.id), secret, signal);
    this.identities.set(identity.id, Object.freeze(structuredClone(identity)));
    this.redactions.set(identity.id, this.redactor.register(secret));
    return this.identities.get(identity.id)!;
  }

  list(): Readonly<Identity>[] { return [...this.identities.values()].map(identity => structuredClone(identity)); }
  get(identityId: IdentityId): Readonly<Identity> {
    const identity = this.identities.get(identityId);
    if (!identity) throw new PentestError('IDENTITY_MISSING', 'Unknown engagement identity');
    return identity;
  }

  async headers(identityId: IdentityId, url: URL, signal?: AbortSignal): Promise<Record<string, string>> {
    const identity = this.get(identityId);
    if (!identity.hosts.some(host => matchesHost(url.hostname, host))) {
      throw new PentestError('CREDENTIAL_DESTINATION', 'Identity credentials are not authorized for this host');
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new PentestError('CREDENTIAL_TRANSPORT', 'Credentials require HTTPS outside a local test fixture');
    }
    const secret = await this.secret(identityId, signal);
    switch (identity.kind) {
      case 'bearer': return { authorization: `Bearer ${secret}` };
      case 'basic': {
        const encoded = Buffer.from(secret).toString('base64');
        this.redactor.register(encoded);
        return { authorization: `Basic ${encoded}` };
      }
      case 'headers': return z.record(z.string(), z.string()).parse(JSON.parse(secret));
      case 'browser-state': throw new PentestError('IDENTITY_KIND', 'Browser state must be delivered to an isolated browser context');
    }
  }

  async browserState(identityId: IdentityId, signal?: AbortSignal): Promise<unknown> {
    const identity = this.get(identityId);
    if (identity.kind !== 'browser-state') throw new PentestError('IDENTITY_KIND', 'Identity does not contain browser state');
    return JSON.parse(await this.secret(identityId, signal));
  }

  private async secret(identityId: IdentityId, signal?: AbortSignal): Promise<string> {
    const value = await this.secrets.get(this.reference(identityId), signal);
    if (value === undefined) throw new PentestError('CREDENTIAL_MISSING', 'Identity secret is not available in the credential provider');
    this.validateSecret(this.get(identityId).kind, value);
    if (!this.redactions.has(identityId)) this.redactions.set(identityId, this.redactor.register(value));
    return value;
  }

  private reference(identityId: IdentityId): string { return `${this.engagementId}/${identityId}`; }
  private validateSecret(kind: Identity['kind'], secret: string): void {
    if (!secret || secret.includes('\u0000')) throw new PentestError('INVALID_CREDENTIAL', 'Identity credential is empty or invalid');
    if ((kind === 'bearer' || kind === 'basic') && /[\r\n]/.test(secret)) throw new PentestError('INVALID_CREDENTIAL', 'Credential contains a header delimiter');
    if (kind === 'headers') {
      const headers = z.record(z.string(), z.string()).parse(JSON.parse(secret));
      for (const [key, value] of Object.entries(headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)
          || /^(host|connection|content-length|transfer-encoding|proxy-authorization)$/i.test(key)) {
          throw new PentestError('INVALID_CREDENTIAL', 'Credential header is not permitted');
        }
        this.redactor.register(value);
      }
    }
    if (kind === 'browser-state') z.object({ cookies: z.array(z.unknown()), origins: z.array(z.unknown()) }).parse(JSON.parse(secret));
  }
}

/** Secrets travel over stdin/stdout; neither argv nor shell expansion sees them. */
export class MacKeychainProvider implements SecretProvider {
  constructor(private readonly helperPath: string) {}
  async get(reference: string, signal?: AbortSignal): Promise<string | undefined> {
    const response = await this.call({ operation: 'get', reference }, signal);
    return z.object({ value: z.string().optional() }).parse(response).value;
  }
  async set(reference: string, value: string, signal?: AbortSignal): Promise<void> {
    await this.call({ operation: 'set', reference, value }, signal);
  }
  async remove(reference: string, signal?: AbortSignal): Promise<void> {
    await this.call({ operation: 'remove', reference }, signal);
  }
  private async call(input: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    if (process.platform !== 'darwin') throw new PentestError('KEYCHAIN_PLATFORM', 'The Keychain provider requires macOS');
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      child.on('error', error => finish(error));
      child.stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
        if (Buffer.byteLength(output) > 4 * 1024 * 1024) { child.kill(); finish(new PentestError('KEYCHAIN_OUTPUT', 'Keychain reply exceeded its size limit')); }
      });
      child.stderr.resume();
      child.on('close', code => {
        if (code !== 0) return finish(new PentestError('KEYCHAIN_FAILURE', 'Keychain operation failed; check access permissions'));
        try { finish(undefined, JSON.parse(output)); }
        catch (cause) { finish(new PentestError('KEYCHAIN_OUTPUT', 'Invalid Keychain helper reply', { cause })); }
      });
      child.stdin.on('error', error => finish(error));
      child.stdin.end(`${JSON.stringify(input)}\n`);
    });
  }
}
