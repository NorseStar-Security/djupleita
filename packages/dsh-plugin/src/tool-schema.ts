/** Publish JSON Schema data without Zod's non-JSON Standard Schema validator. */
import { z } from 'zod';

export function toolSchema(schema: z.ZodType): ReturnType<typeof z.toJSONSchema> {
  // Zod adds non-enumerable ~standard metadata containing functions. The harness
  // snapshots tool schemas losslessly for PTC; publish the JSON representation.
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as ReturnType<typeof z.toJSONSchema>;
}
