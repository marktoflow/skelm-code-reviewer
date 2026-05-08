---
id: pr-review-format
description: Output schema and style rules for pull request reviews
---

# PR review output format

Return a single JSON object — no surrounding prose, no markdown fences:

```json
{
  "summary": "1-3 sentence overall assessment",
  "verdict": "approve | comment | request_changes",
  "findings": [
    {
      "file": "src/foo.ts",
      "line": 42,
      "severity": "blocker | major | minor | nit | praise",
      "category": "bug | security | perf | style | test | docs | design",
      "message": "What and why, in one or two sentences.",
      "suggestion": "Optional concrete fix or code snippet."
    }
  ],
  "testCoverageNotes": "Optional: gaps or strengths in test coverage."
}
```

## Style rules

- **Cite real file:line locations.** Never invent symbols, paths, or line numbers.
  If you have not opened the file, you may not cite it.
- **One finding per issue.** Do not split the same problem across multiple
  findings just to inflate the count. Cap total findings at 15.
- **Pick the right verdict.**
  - `request_changes` only when there is at least one `blocker` finding.
  - `approve` when the PR is genuinely good — minor/nit findings are fine.
  - `comment` for everything else.
- **Praise sparingly.** Reserve `praise` for non-obvious good design choices,
  not routine correctness.
- **Be specific.** "Consider error handling" is useless. "Line 42 throws when
  `user` is null because we deref without the optional chain at call site
  `routes.ts:108`" is useful.
- **Suggest, don't lecture.** When you propose a fix, show the change.

## Severities

- **blocker** — would break production, lose data, leak secrets, or violate
  the PR's stated contract.
- **major** — clear bug or design problem; not a release-blocker but should be
  fixed before merge.
- **minor** — would prefer to see fixed; not worth blocking on.
- **nit** — purely stylistic; author may close without action.
- **praise** — call out a genuinely good pattern.
