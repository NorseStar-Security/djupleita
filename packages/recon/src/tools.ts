/** Executables supported by the managed ProjectDiscovery adapters. */
import { z } from 'zod';
export const ReconToolSchema = z.enum(['subfinder', 'asnmap', 'uncover', 'httpx', 'katana']);
export type ReconTool = z.infer<typeof ReconToolSchema>;
