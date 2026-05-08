import { defineConfig } from '@skelm/core'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backend: 'pi',
  registries: {
    workflows: { glob: 'workflows/**/*.workflow.ts' },
    skills: { glob: 'skills/**/SKILL.md' },
  },
  defaults: {
    permissions: {
      // pi-sdk runs in-process; the gateway egress proxy can't intercept it.
      // We rely on tool/exec/fs/skill enforcement (which pi-sdk DOES support
      // natively) for sandboxing. Switch to a subprocess backend + the
      // gateway proxy for egress enforcement.
      networkEgress: 'allow',
      // The defaults intersect with each step's permissions. Allow the
      // capabilities our reviewer agent actually needs; per-step permissions
      // narrow further.
      allowedExecutables: ['git', 'rg', 'cat', 'ls', 'find', 'head', 'tail', 'wc', 'sed'],
      allowedTools: { star: true },
      allowedSkills: ['pr-review-format'],
      allowedMcpServers: [],
      fsRead: ['.'],
      fsWrite: ['.skelm-review'],
    },
  },
  storage: {
    runs: { driver: 'sqlite', path: '.skelm/runs.sqlite' },
    state: { driver: 'sqlite', path: '.skelm/state.sqlite' },
    workspaces: { base: '.skelm/workspaces' },
  },
  secrets: { driver: 'env' },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      maxConcurrent: 1,
      timeout: 600_000,
    }),
  ],
})
