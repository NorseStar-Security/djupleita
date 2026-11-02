/** Publish self-contained object schemas for provider tool adapters. */
import { z } from 'zod';

export function toolSchema(schema: z.ZodType): z.core.JSONSchema.JSONSchema {
  // Some adapters keep only root properties/required, dropping $defs and root
  // unions. Inline reused shapes and fail on cycles rather than emit dangling
  // references. Execution still validates against the original Zod schema.
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { reused: 'inline', cycles: 'throw' }))) as z.core.JSONSchema.JSONSchema;
  const branches = json.oneOf ?? json.anyOf;
  if (!json.type && branches?.every(branch => typeof branch === 'object' && branch.type === 'object')) {
    const variants = branches;
    const names = [...new Set(variants.flatMap(branch => Object.keys(branch.properties ?? {})))];
    json.type = 'object';
    json.properties = Object.fromEntries(names.map(name => {
      const choices = [...new Map(variants.filter(branch => name in (branch.properties ?? {}))
        .map(branch => {
          const value = branch.properties![name]!;
          return [JSON.stringify(value), typeof value === 'boolean' ? (value ? {} : { not: {} }) : value] as const;
        })).values()];
      return [name, choices.length === 1 ? choices[0]! : { anyOf: choices }];
    }));
    json.required = names.filter(name => variants.every(branch => branch.required?.includes(name)));
  }
  return json;
}
