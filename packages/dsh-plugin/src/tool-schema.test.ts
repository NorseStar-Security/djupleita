import { expect, it } from 'vitest';
import { z } from 'zod';
import { toolSchema } from './tool-schema.ts';

it('keeps operation-specific validation while exposing union fields to property-only providers', () => {
  const input = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('read'), id: z.string() }),
    z.object({ operation: z.literal('write'), id: z.string(), value: z.string() }),
  ]);
  const schema = toolSchema(input);
  expect(schema).toMatchObject({ type: 'object', required: ['operation', 'id'],
    properties: { id: { type: 'string' }, value: { type: 'string' } } });
  expect(schema.oneOf).toHaveLength(2);
  expect(input.safeParse({ operation: 'write', id: 'fixture' }).success).toBe(false);
});

it('inlines shared shapes and refuses recursive schemas before provider projection drops definitions', () => {
  const shared = z.object({ value: z.string() });
  expect(JSON.stringify(toolSchema(z.object({ first: shared, second: shared })))).not.toContain('"$ref"');
  expect(() => toolSchema(z.object({ value: z.json() }))).toThrow();
});
