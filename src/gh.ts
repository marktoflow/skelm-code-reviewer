import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function ghJson<T>(args: readonly string[]): Promise<T> {
  const { stdout } = await exec('gh', args, { maxBuffer: 50 * 1024 * 1024 })
  return JSON.parse(stdout) as T
}

export async function gh(args: readonly string[], opts: { input?: string } = {}): Promise<string> {
  const child = exec('gh', args, { maxBuffer: 50 * 1024 * 1024 })
  if (opts.input !== undefined && child.child.stdin) {
    child.child.stdin.write(opts.input)
    child.child.stdin.end()
  }
  const { stdout } = await child
  return stdout
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })
  return stdout
}
