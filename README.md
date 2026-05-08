# skelm-code-reviewer

An autonomous GitHub pull-request reviewer built on the
[skelm](https://github.com/scottgl9/skelm) workflow framework.

The reviewer:

1. Polls a configured list of repos for open pull requests on a cron schedule.
2. Clones (or fast-forwards) each repo into a per-repo persistent workspace
   so the LLM has the **whole codebase** as reference, not just the diff.
3. Runs a multi-turn coding-agent step that explores the repo (`rg`, `cat`,
   `git log`) and produces a structured review — summary, verdict, and a
   prioritized list of file:line findings with severity and category.
4. Either writes the review to `reviews/<repo>__<pr>__<sha>.md` (dry-run)
   or posts it as a real PR review via `gh pr review` (real mode).
5. Dedupes on `repo#pr@headSha` so updates trigger a re-review but the
   same commit never gets reviewed twice.

## Layout

```
skelm-code-reviewer/
├── skelm.config.ts                   — backend + project-level permission defaults
├── workflows/review-prs.workflow.ts  — outer cron pipeline + per-PR sub-pipeline
├── src/{schema,gh}.ts                — shared schemas and gh/git helpers
├── skills/pr-review-format/SKILL.md  — output schema + style guide for the agent
├── .env.example                      — TARGET_REPOS, POST_MODE, PI_PROVIDER, PI_MODEL
├── reviews/                          — dry-run output (gitignored)
└── .skelm/                           — runs DB, state DB, repo workspaces (gitignored)
```

## Setup

```bash
pnpm install
cp .env.example .env   # then edit
```

The workflow uses the [pi](https://github.com/mariozechner/pi-coding-agent)
SDK backend. Pi must be installed and a model configured (`pi --list-models`).
The example config defaults to `llamacpp / qwen36`; a llama-server on
`localhost:8000` exposing the `qwen36` model is enough.

The `gh` CLI must be authenticated to whichever GitHub account should appear
as the review author (`gh auth status`).

## Run

**One-shot review of every open PR in `TARGET_REPOS`:**

```bash
pnpm run review:once
```

**One-shot review of an explicit PR list (bypasses dedupe):**

```bash
pnpm run review:once -- --input '{
  "items": [{
    "repo": "owner/repo", "number": 42,
    "headSha": "<sha>", "headBranch": "feature/x", "baseBranch": "main",
    "title": "...", "url": "https://github.com/owner/repo/pull/42"
  }]
}'
```

**Long-running autonomous gateway (cron-driven, every 5 min):**

```bash
pnpm run gateway
```

## Posting reviews

`POST_MODE=dry-run` (default) writes review markdown to `reviews/`. Set
`POST_MODE=real` to publish via `gh pr review` using the verdict:

| verdict          | gh flag             |
| ---------------- | ------------------- |
| approve          | `--approve`         |
| comment          | `--comment`         |
| request_changes  | `--request-changes` |

## Permissions model

`skelm.config.ts` declares project-level defaults; per-step `agent()` calls
narrow further. The pi-sdk backend enforces tool, executable, filesystem,
MCP, and skill permissions natively in-process. Network egress is **not**
enforced for in-process backends — switch to a subprocess backend (pi RPC,
opencode) under the long-running gateway if you need outbound traffic
gated by the egress proxy.
