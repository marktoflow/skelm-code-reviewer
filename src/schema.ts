import { z } from 'zod'

/**
 * One PR descriptor — produced by the discovery step, consumed by the
 * per-PR review sub-pipeline.
 */
export const PrInfoSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  headSha: z.string(),
  title: z.string(),
  headBranch: z.string(),
  baseBranch: z.string(),
  url: z.string().url(),
  author: z.string().optional(),
  body: z.string().optional(),
})
export type PrInfo = z.infer<typeof PrInfoSchema>

export const DiscoveryOutputSchema = z.object({
  items: z.array(PrInfoSchema),
})

/**
 * Output the reviewer agent must return. Findings are listed at the
 * file:line granularity; we keep them coarse rather than positioning
 * them inside the diff hunk because gh PR-comment tooling already
 * accepts file/line pairs and our line numbers come from the new
 * (post-PR) version of each file.
 */
export const FindingSchema = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  severity: z.enum(['blocker', 'major', 'minor', 'nit', 'praise']),
  category: z.enum(['bug', 'security', 'perf', 'style', 'test', 'docs', 'design']),
  message: z.string(),
  suggestion: z.string().optional(),
})
export type Finding = z.infer<typeof FindingSchema>

export const ReviewSchema = z.object({
  summary: z.string(),
  verdict: z.enum(['approve', 'comment', 'request_changes']),
  findings: z.array(FindingSchema).max(15),
  testCoverageNotes: z.string().optional(),
})
export type Review = z.infer<typeof ReviewSchema>

export const SyncOutputSchema = z.object({
  workspaceDir: z.string(),
  diffPath: z.string(),
  metaPath: z.string(),
  changedFiles: z.array(z.string()),
})
export type SyncOutput = z.infer<typeof SyncOutputSchema>

export const PublishOutputSchema = z.object({
  posted: z.boolean(),
  destination: z.string(),
})
export type PublishOutput = z.infer<typeof PublishOutputSchema>
