import { agent, code, forEach, pipeline, pipelineStep } from '@skelm/core'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { gh, ghJson, git } from '../src/gh.ts'
import {
  DiscoveryOutputSchema,
  PrInfoSchema,
  PublishOutputSchema,
  ReviewSchema,
  SyncOutputSchema,
  type PrInfo,
  type PublishOutput,
  type Review,
  type SyncOutput,
} from '../src/schema.ts'

const repoSlug = (repo: string) => repo.replace(/[^a-zA-Z0-9._-]+/g, '__')

const REVIEWER_SYSTEM_PROMPT = [
  'You are a senior software engineer performing a code review on a GitHub pull request.',
  '',
  'Your working directory is a real git checkout of the PR branch. Use shell tools to',
  'explore: rg for finding symbols/call sites, cat/sed for reading files, ls/find for',
  'navigation. Always ground every claim in a real file:line — do not invent symbols or',
  'cite locations you have not actually opened.',
  '',
  'Be terse, specific, and respectful. Praise genuinely good patterns sparingly. Cap at',
  '15 findings; if there are more, pick the most important.',
  '',
  'Your final answer MUST be valid JSON conforming to the pr-review-format skill schema.',
  'No prose outside the JSON.',
].join('\n')

// ---------- Per-PR sub-pipeline ----------------------------------------------

const reviewOnePr = pipeline({
  id: 'review-one-pr',
  description: 'Sync the repo, run the reviewer agent, post or save the review.',
  input: PrInfoSchema,
  output: PublishOutputSchema,
  steps: [
    code({
      id: 'sync',
      run: async (ctx): Promise<SyncOutput> => {
        const pr = ctx.input as PrInfo
        const repoCacheRoot = resolve(process.env.REPO_CACHE_DIR ?? '.skelm/repos')
        const repoDir = join(repoCacheRoot, repoSlug(pr.repo))
        await mkdir(dirname(repoDir), { recursive: true })

        // Clone if missing, otherwise fetch.
        if (!existsSync(join(repoDir, '.git'))) {
          await mkdir(repoDir, { recursive: true })
          await git(dirname(repoDir), [
            'clone',
            '--quiet',
            `https://github.com/${pr.repo}.git`,
            repoDir,
          ])
        } else {
          await git(repoDir, ['fetch', '--quiet', 'origin', pr.baseBranch])
        }

        // Fetch the PR head into a non-branch ref so concurrent re-fetches do
        // not collide with the currently-checked-out branch. Then checkout
        // the SHA detached.
        const prRef = `refs/skelm-pr/${pr.number}`
        await git(repoDir, [
          'fetch',
          '--quiet',
          '--force',
          'origin',
          `pull/${pr.number}/head:${prRef}`,
        ])
        await git(repoDir, ['checkout', '--quiet', '--force', '--detach', pr.headSha])

        // Diff against the merge-base with the base branch — same as what GitHub shows.
        const baseRef = `origin/${pr.baseBranch}`
        const mergeBase = (await git(repoDir, ['merge-base', baseRef, 'HEAD'])).trim()
        const diff = await git(repoDir, ['diff', '--no-color', `${mergeBase}..HEAD`])
        const changedRaw = await git(repoDir, [
          'diff',
          '--name-only',
          `${mergeBase}..HEAD`,
        ])
        const changedFiles = changedRaw.split('\n').filter(Boolean)

        const reviewDir = join(repoDir, '.skelm-review')
        await mkdir(reviewDir, { recursive: true })
        const diffPath = join(reviewDir, 'diff.patch')
        const metaPath = join(reviewDir, 'pr-meta.json')
        const filesPath = join(reviewDir, 'changed-files.txt')
        await writeFile(diffPath, diff, 'utf8')
        await writeFile(metaPath, JSON.stringify({ ...pr, mergeBase }, null, 2), 'utf8')
        await writeFile(filesPath, changedFiles.join('\n'), 'utf8')

        return {
          workspaceDir: repoDir,
          diffPath,
          metaPath,
          changedFiles,
        }
      },
    }),
    agent({
      id: 'analyze',
      backend: 'pi',
      system: REVIEWER_SYSTEM_PROMPT,
      skills: ['pr-review-format'],
      workspace: (ctx) => {
        const sync = ctx.get<SyncOutput>('sync')!
        return { mode: 'mounted', path: sync.workspaceDir }
      },
      permissions: {
        allowedExecutables: ['git', 'rg', 'cat', 'ls', 'find', 'head', 'tail', 'wc', 'sed'],
        allowedTools: { star: true },
        allowedSkills: ['pr-review-format'],
        // pi-sdk runs in-process; egress can't be intercepted without the
        // gateway proxy. Tool/exec/fs/skill enforcement still apply.
        networkEgress: 'allow',
        fsRead: ['.'],
        fsWrite: ['.skelm-review'],
      },
      prompt: (ctx) => {
        const pr = ctx.input as PrInfo
        const sync = ctx.get<SyncOutput>('sync')!
        return [
          `You are reviewing pull request #${pr.number} on ${pr.repo}: "${pr.title}".`,
          `Branch: ${pr.headBranch} → ${pr.baseBranch}.  URL: ${pr.url}`,
          ``,
          `The repository has been cloned and the PR is checked out at HEAD in your working directory.`,
          `The diff is at ./.skelm-review/diff.patch`,
          `PR metadata at ./.skelm-review/pr-meta.json`,
          `Changed files (${sync.changedFiles.length}) at ./.skelm-review/changed-files.txt`,
          ``,
          `Method:`,
          `1. Read the diff.`,
          `2. For each changed file, read the surrounding context (the full file, callers, related types/tests).`,
          `   Use rg to find call sites; cat / sed -n to read line ranges.`,
          `3. Identify up to 15 of the most important findings — bugs, security, perf, design, missing tests, style.`,
          `   Cite real file:line locations. Do NOT invent symbols. Quote tiny snippets if helpful.`,
          `4. Return a structured review matching the pr-review-format skill schema.`,
          ``,
          `Be a senior reviewer: terse, specific, kind. Praise genuinely good patterns sparingly.`,
          `Pick "request_changes" only if there is a blocker; otherwise "comment".`,
        ].join('\n')
      },
      // No output schema: the model may not produce strict JSON. We extract
      // it ourselves in the next step and fall back gracefully.
      maxTurns: 40,
      timeoutMs: 600_000,
    }),
    code({
      id: 'publish',
      run: async (ctx): Promise<PublishOutput> => {
        const pr = ctx.input as PrInfo
        const raw = ctx.get<{ text?: string }>('analyze')
        const review = parseReview(raw?.text ?? '')
        const body = renderReviewMarkdown(pr, review)
        const mode = (process.env.POST_MODE ?? 'dry-run').toLowerCase()

        if (mode === 'real') {
          const event =
            review.verdict === 'approve'
              ? '--approve'
              : review.verdict === 'request_changes'
                ? '--request-changes'
                : '--comment'
          await gh(['pr', 'review', String(pr.number), '--repo', pr.repo, event, '--body', body])
          return { posted: true, destination: `${pr.url}#review` }
        }

        const outDir = resolve('reviews')
        await mkdir(outDir, { recursive: true })
        const file = join(
          outDir,
          `${repoSlug(pr.repo)}__${pr.number}__${pr.headSha.slice(0, 8)}.md`,
        )
        await writeFile(file, body, 'utf8')
        // biome-ignore lint/suspicious/noConsole: operator visibility for dry-runs
        console.log(`[review-prs] dry-run review written: ${file}`)
        return { posted: false, destination: file }
      },
    }),
  ],
  finalize: (ctx): PublishOutput =>
    ctx.get<PublishOutput>('publish') ?? { posted: false, destination: '' },
})

function parseReview(text: string): Review {
  // Try strict JSON first.
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) candidates.unshift(fence[1].trim())
  const objMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objMatch?.[0]) candidates.push(objMatch[0])

  for (const c of candidates) {
    try {
      const parsed = ReviewSchema.parse(JSON.parse(c))
      return parsed
    } catch {
      /* try next */
    }
  }
  // Fallback: treat the entire response as the summary so we still post
  // something useful.
  return {
    summary:
      'Reviewer model did not return structured JSON. Raw response below.\n\n' +
      (text.slice(0, 4000) || '(empty)'),
    verdict: 'comment',
    findings: [],
  }
}

function renderReviewMarkdown(pr: PrInfo, review: Review): string {
  const lines: string[] = []
  lines.push(`### Automated review — ${pr.repo}#${pr.number}`)
  lines.push('')
  lines.push(`**Verdict:** \`${review.verdict}\``)
  lines.push('')
  lines.push(review.summary)
  if (review.findings.length > 0) {
    lines.push('')
    lines.push('#### Findings')
    for (const f of review.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file
      lines.push(`- **[${f.severity}/${f.category}]** \`${loc}\` — ${f.message}`)
      if (f.suggestion) {
        lines.push(`  - _suggestion:_ ${f.suggestion}`)
      }
    }
  }
  if (review.testCoverageNotes) {
    lines.push('')
    lines.push('#### Test coverage')
    lines.push(review.testCoverageNotes)
  }
  lines.push('')
  lines.push(`<sub>Generated by skelm-code-reviewer for ${pr.headSha.slice(0, 8)}.</sub>`)
  return lines.join('\n')
}

// ---------- Outer pipeline (autonomous) --------------------------------------

const ListPrsInputSchema = z
  .object({
    items: z.array(PrInfoSchema).optional(),
    repos: z.array(z.string()).optional(),
  })
  .optional()

export default pipeline({
  id: 'review-prs',
  description: 'Discover open PRs across configured repos and review each one.',
  input: ListPrsInputSchema as unknown as z.ZodType<{ items?: PrInfo[]; repos?: string[] } | undefined>,
  triggers: [
    // Cron: every 5 minutes. Override with your own schedule via skelm schedule.
    { kind: 'cron', cron: '*/5 * * * *' },
  ],
  steps: [
    code({
      id: 'discover',
      run: async (ctx) => {
        const explicit = (ctx.input as { items?: PrInfo[] } | undefined)?.items
        if (explicit && explicit.length > 0) {
          return DiscoveryOutputSchema.parse({ items: explicit })
        }

        const repoList =
          (ctx.input as { repos?: string[] } | undefined)?.repos ??
          (process.env.TARGET_REPOS ?? '')
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)

        if (repoList.length === 0) {
          // biome-ignore lint/suspicious/noConsole: operator-facing diagnostic
          console.warn('[review-prs] no repos configured (set TARGET_REPOS or pass --input)')
          return { items: [] }
        }

        const items: PrInfo[] = []
        for (const repo of repoList) {
          const prs = await ghJson<
            Array<{
              number: number
              headRefOid: string
              headRefName: string
              baseRefName: string
              title: string
              url: string
              author?: { login?: string }
              body?: string
            }>
          >([
            'pr',
            'list',
            '--repo',
            repo,
            '--state',
            'open',
            '--limit',
            '20',
            '--json',
            'number,headRefOid,headRefName,baseRefName,title,url,author,body',
          ])

          for (const pr of prs) {
            const dedupeKey = `reviewed:${repo}#${pr.number}@${pr.headRefOid}`
            const already = await ctx.state.get<number>(dedupeKey)
            if (already) continue
            items.push({
              repo,
              number: pr.number,
              headSha: pr.headRefOid,
              headBranch: pr.headRefName,
              baseBranch: pr.baseRefName,
              title: pr.title,
              url: pr.url,
              ...(pr.author?.login ? { author: pr.author.login } : {}),
              ...(pr.body ? { body: pr.body } : {}),
            })
          }
        }
        // biome-ignore lint/suspicious/noConsole: operator-facing diagnostic
        console.log(`[review-prs] discovered ${items.length} PR(s) needing review`)
        return { items }
      },
    }),
    forEach({
      id: 'review',
      concurrency: 1,
      items: (ctx) => (ctx.get<{ items: PrInfo[] }>('discover')?.items ?? []) as readonly unknown[],
      step: (item, idx) =>
        pipelineStep({
          id: `pr-${idx}`,
          pipeline: reviewOnePr as unknown as Parameters<typeof pipelineStep>[0]['pipeline'],
          input: item as PrInfo,
        }),
    }),
    code({
      id: 'mark-reviewed',
      run: async (ctx) => {
        const items = ctx.get<{ items: PrInfo[] }>('discover')?.items ?? []
        const results = (ctx.get<PublishOutput[]>('review') ?? []) as PublishOutput[]
        for (let i = 0; i < items.length; i++) {
          const pr = items[i]!
          const r = results[i]
          if (r) {
            await ctx.state.set(`reviewed:${pr.repo}#${pr.number}@${pr.headSha}`, Date.now())
            await ctx.state.append('decisions', {
              at: Date.now(),
              pr: `${pr.repo}#${pr.number}`,
              sha: pr.headSha,
              destination: r.destination,
              posted: r.posted,
            })
          }
        }
        return { processed: items.length }
      },
    }),
  ],
})
