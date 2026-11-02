import { z } from 'zod';
export const RankingSchema = z.object({ auth: z.number().min(0).max(8), object: z.number().min(0).max(8), query: z.number().min(0).max(8), novelty: z.number().min(0).max(8) }).strict();
export type Ranking = z.infer<typeof RankingSchema>;
const Split = z.enum(['train', 'validation', 'test']);
const Row = z.object({ id: z.string().min(1).max(128), split: Split, evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(32) });
export const DatasetSchema = z.object({ name: z.string(), requestBudget: z.number().int().positive().max(10000),
  rows: z.array(Row.extend({ features: z.object({ auth: z.number().min(0).max(1), object: z.number().min(0).max(1), query: z.number().min(0).max(1), novelty: z.number().min(0).max(1) }), reward: z.number().min(0), cost: z.number().positive() })).min(6).max(100000) });
/** Recorded, redacted observations only: the optimizer cannot invoke assessment tools. */
export const ProcedureDatasetSchema = z.object({ kind: z.literal('authz-procedure'), name: z.string().max(200),
  baseline: z.string().min(1).max(12000),
  rows: z.array(Row.extend({ appId: z.string().min(1).max(128), input: z.string().min(1).max(16000),
    expected: z.object({ verdict: z.enum(['vulnerable', 'safe', 'inconclusive']), requiredEvidence: z.array(z.string().max(128)).min(1).max(16) }).strict() }).strict()).min(6).max(300),
}).strict();
export const LearningConfigSchema = z.object({ python: z.string(), script: z.string(), datasets: z.string(), gepaScript: z.string().optional() });
export type LearningConfig = z.infer<typeof LearningConfigSchema>;
export const RunInputSchema = z.object({ datasetId: z.string().regex(/^[a-zA-Z0-9_-]+$/), backend: z.enum(['optuna', 'gepa']).default('optuna'),
  trials: z.number().int().min(2).max(1000).default(30) }).strict();
const Score = z.object({ baseline: z.number().finite(), candidate: z.number().finite() });
const Common = z.object({ runId: z.string().uuid(), datasetHash: z.string(), seed: z.number(), engine: z.string(),
  scores: z.object({ train: Score, validation: Score, test: Score }), limitation: z.string() });
export const RankingStudySchema = Common.extend({ parameters: RankingSchema,
  trials: z.array(z.object({ number: z.number(), value: z.number().nullable(), parameters: z.record(z.string(), z.number()), state: z.string() })) });
const Evaluation = z.object({ id: z.string(), split: Split, output: z.string().max(32768), score: z.number().min(0).max(1), feedback: z.string() });
export const ProcedureStudySchema = Common.extend({ kind: z.literal('authz-procedure'),
  procedure: z.object({ baseline: z.string().max(12000), candidate: z.string().min(1).max(12000) }),
  candidates: z.array(z.object({ procedure: z.string().max(12000), validationScore: z.number(), parents: z.array(z.number().nullable()) })).max(1000),
  evaluations: z.object({ baseline: z.array(Evaluation), candidate: z.array(Evaluation) }),
  budget: z.object({ searchEvaluations: z.number(), maxSearchEvaluations: z.number(), modelCalls: z.number(), maxModelCalls: z.number(), inputChars: z.number(), outputChars: z.number() }),
  model: z.object({ provider: z.string(), model: z.string() }), evaluatorVersion: z.literal('authz-evidence-v1'),
});
export const StudySchema = z.union([ProcedureStudySchema, RankingStudySchema]);
export const PromotionSchema = z.object({ runId: z.string().uuid(), datasetHash: z.string(), text: z.string().min(1).max(12000) }).strict();
export type ProcedurePromotion = z.infer<typeof PromotionSchema>;
export const ModelRequestSchema = z.object({ purpose: z.enum(['task', 'reflection']), system: z.string().max(16000), prompt: z.string().max(128000) }).strict();
export type LearningModel = (session: import('@dsh-pentest/contracts').SessionId, request: z.infer<typeof ModelRequestSchema>, signal: AbortSignal, selection: Readonly<import('@dsh-pentest/contracts').ModelSelection>) => Promise<string>;
