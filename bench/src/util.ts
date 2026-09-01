import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelSpec } from './models'
import type { Task } from './types'

export const BENCH_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

export const BENCH_VERSION = 'v1'

// Tolerant JSON object extraction: accepts raw JSON, fenced JSON, or JSON
// embedded in prose. Same policy for every model (fairness rule).
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(text)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start === -1) continue
    // Scan for the matching close brace, respecting strings.
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = !inString
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(candidate.slice(start, i + 1))
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>
            }
          } catch {
            // fall through to next candidate
          }
          break
        }
      }
    }
  }
  return null
}

// Staged tasks are authored and validated but not yet part of the board.
//
// A task only becomes comparable once EVERY model has answered it: adding one
// to a live suite would leave some models measured on 52 items and others on
// 112, and the paired McNemar tests that produce the tie groups need both
// models to have seen the same tasks. So new work lands with `staged: true`,
// is validated and reviewed like any other task, and is unstaged in one move
// after a full run. Pass includeStaged (or BENCH_INCLUDE_STAGED=1) to run them.
export function loadTasks<T extends Task>(suite: string, includeStaged = false): T[] {
  const dir = path.join(BENCH_ROOT, 'tasks', suite)
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const tasks: T[] = []
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const list: T[] = Array.isArray(raw) ? raw : [raw]
    tasks.push(...list)
  }
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`Duplicate task id ${t.id} in suite ${suite}`)
    ids.add(t.id)
  }
  const wantStaged = includeStaged || process.env.BENCH_INCLUDE_STAGED === '1'
  return wantStaged ? tasks : tasks.filter((t) => t.staged !== true)
}

// Every task on disk, staged or not. For validation and review tooling, which
// must check work that has not been run yet.
export function loadAllTasks<T extends Task>(suite: string): T[] {
  return loadTasks<T>(suite, true)
}

// Privacy rule: prod-derived task data may only be sent to the EU Bedrock
// deployment this product already trusts with customer data. Synthetic public
// tasks may go anywhere. Enforced here so no suite can forget it.
export function assertDataClassAllowed(task: Task, spec: ModelSpec): void {
  if (task.data_class === 'prod-derived' && spec.residency !== 'eu-bedrock') {
    throw new Error(
      `Task ${task.id} is prod-derived and cannot be sent to ${spec.id} ` +
        `(residency ${spec.residency}). Prod-derived tasks run only on eu-bedrock.`,
    )
  }
}

export function resultsDir(): string {
  const dir = path.join(BENCH_ROOT, 'results', 'runs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100
}
