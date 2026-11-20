/**
 * The I/O the three local stack scripts share: where the stack lives, its
 * state file, and how to stop each half of it. See scripts/local/up.ts.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEV_LOG_FILE, ENV_FILE, ENV_MARKER, LOCAL_DIR, SCREENSHOT_DIR, STATE_FILE, type Ports } from './lib'

export interface StackState {
  projectId: string
  appUrl: string
  supabaseUrl: string
  email: string
  password: string
  companyId: string
  ports: Ports
  /** Process group leader of `npm run dev` (its children share the group). */
  devPid: number
  startedAt: string
}

export function stackPaths(repoRoot: string) {
  const dir = path.join(repoRoot, LOCAL_DIR)
  return {
    dir,
    state: path.join(dir, STATE_FILE),
    devLog: path.join(dir, DEV_LOG_FILE),
    envFile: path.join(repoRoot, ENV_FILE),
  }
}

export function readState(repoRoot: string): StackState | null {
  try {
    return JSON.parse(fs.readFileSync(stackPaths(repoRoot).state, 'utf8')) as StackState
  } catch {
    return null
  }
}

export function writeState(repoRoot: string, state: StackState): void {
  fs.writeFileSync(stackPaths(repoRoot).state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

export async function isHealthy(appUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch {
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stop the dev server's whole process group (npm, next and its workers). */
export async function stopDevServer(pid: number): Promise<void> {
  if (!pid || !processAlive(pid)) return
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      // Already gone.
    }
  }
  signalGroup('SIGTERM')
  for (let i = 0; i < 50 && processAlive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  if (processAlive(pid)) signalGroup('SIGKILL')
}

/**
 * Stop this checkout's Supabase project and delete its volumes. Scoped to
 * the project id, so no other stack on the machine is touched.
 */
export function stopSupabase(projectId: string): void {
  const result = spawnSync('supabase', ['stop', '--project-id', projectId, '--no-backup'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('supabase stop failed; see its output above')
}

/** Delete the env file local:up wrote. A file it did not write is left alone. */
export function removeOwnEnvFile(repoRoot: string): void {
  const file = stackPaths(repoRoot).envFile
  if (!fs.existsSync(file)) return
  if (fs.readFileSync(file, 'utf8').startsWith(ENV_MARKER)) fs.rmSync(file)
  else console.warn(`Left ${ENV_FILE} in place: local:up did not write it.`)
}

/**
 * Everything local:up created except the screenshots, which are the evidence
 * local:check leaves behind, and sim/, the record of a company in the tool-pg
 * stack, which this stack's going does not touch.
 */
export function removeStackFiles(repoRoot: string): void {
  const { dir } = stackPaths(repoRoot)
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir)) {
    if (entry === SCREENSHOT_DIR || entry === 'sim') continue
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
  }
}
