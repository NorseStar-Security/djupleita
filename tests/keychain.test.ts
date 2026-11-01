import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { MacKeychainProvider } from '../packages/identities/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';

it.skipIf(process.platform !== 'darwin' || !process.env.DSH_TEST_KEYCHAIN)('round-trips a unique fixture through macOS Keychain and removes it', async () => {
  const provider = new MacKeychainProvider(resolve('native/keychain-helper')), reference = `test/${id<'FixtureId'>()}`, secret = `fixture-${id<'FixtureSecret'>()}`;
  try { await provider.set(reference, secret); expect(await provider.get(reference)).toBe(secret); }
  finally { await provider.remove(reference); }
  expect(await provider.get(reference)).toBeUndefined();
}, 30000);
