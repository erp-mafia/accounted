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

export function loadTasks<T extends Task>(suite: string): T[] {
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
  return tasks
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
