// The frozen test set: a content hash of every scored task, plus the pinned
// scoring parameters, so a reader can prove the board was not quietly changed.
//
//   npx tsx bench/scripts/freeze.ts            update bench/freeze.json
//   npx tsx bench/scripts/freeze.ts --check    fail if it is stale (CI)
//
// Why this exists. A benchmark that develops and reports on the same tasks,
// and edits its gold after seeing model answers, can move its own numbers
// without anyone noticing. This records a SHA-256 over the live (non-staged)
// tasks in a canonical form and over the scoring constants, and CI fails if
// the file does not match the working tree. A gold change is then a visible
// event in the diff of freeze.json, reviewed like any other, rather than a
// silent adjustment. Staged tasks are excluded on purpose: they are not part
// of the board until a full run promotes them, at which point the freeze
// updates in the same change.
//
// This is a tripwire, not a lock. It does not stop a change; it makes one
// impossible to make quietly.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { BENCH_ROOT, loadTasks } from '../src/util'
import { GATE_TARGET, GATE_FOLDS, FIXED_GATE_THRESHOLD } from '../src/scoring-config'
import type { Task } from '../src/types'

const SUITES = ['booking', 'reasoning', 'extraction', 'ledger-agent']

// Canonical JSON: keys sorted recursively, so formatting or key-order changes
// in the task files do not move the hash, but any change to a value does.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

function hashTasks(tasks: Task[]): { count: number; sha256: string; ids: string[] } {
  const ids = tasks.map((t) => t.id).sort()
  const ordered = tasks
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(canonical)
  const sha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered))
    .digest('hex')
  return { count: tasks.length, sha256, ids }
}

function buildManifest() {
  const suites: Record<string, { count: number; sha256: string; ids: string[] }> = {}
  for (const s of SUITES) suites[s] = hashTasks(loadTasks<Task>(s))
  // The scoring parameters are frozen alongside the tasks: a change to the
  // gate or the acceptance policy is as much a change to the instrument as a
  // change to a gold answer, so it belongs in the same tripwire.
  const scoring = {
    gate: { method: 'cross_fitted', target: GATE_TARGET, folds: GATE_FOLDS },
    fixedGateThreshold: FIXED_GATE_THRESHOLD,
    strict: 'exact gold account AND exact vat_treatment',
    lenient: 'gold account OR any listed acceptable_account, AND vat_treatment',
  }
  const combined = crypto
    .createHash('sha256')
    .update(JSON.stringify({ suites, scoring }))
    .digest('hex')
  return {
    _comment:
      'Frozen test set for Accounted Ledger-Bench. Regenerate with `npx tsx bench/scripts/freeze.ts`. A change to any hash here is a change to the instrument and must be reviewed as one. Staged tasks are excluded until a full run promotes them.',
    frozenAt: new Date().toISOString().slice(0, 10),
    suites,
    scoring,
    sha256: combined,
  }
}

const FREEZE_PATH = path.join(BENCH_ROOT, 'freeze.json')
const check = process.argv.includes('--check')
const next = buildManifest()

if (check) {
  if (!fs.existsSync(FREEZE_PATH)) {
    console.error('freeze.json is missing. Run: npx tsx bench/scripts/freeze.ts')
    process.exit(1)
  }
  const current = JSON.parse(fs.readFileSync(FREEZE_PATH, 'utf8'))
  if (current.sha256 !== next.sha256) {
    console.error('freeze.json is stale: the frozen test set or scoring has changed.')
    console.error(`  committed sha256 ${current.sha256}`)
    console.error(`  working  sha256 ${next.sha256}`)
    for (const s of SUITES) {
      const a = current.suites?.[s]?.sha256
      const b = next.suites[s].sha256
      if (a !== b) {
        const was = new Set<string>(current.suites?.[s]?.ids ?? [])
        const now = new Set<string>(next.suites[s].ids)
        const added = [...now].filter((x) => !was.has(x))
        const removed = [...was].filter((x) => !now.has(x))
        console.error(
          `  ${s}: changed` +
            (added.length ? `, added ${added.join(', ')}` : '') +
            (removed.length ? `, removed ${removed.join(', ')}` : '') +
            (!added.length && !removed.length ? ' (gold or scoring edited in place)' : ''),
        )
      }
    }
    console.error('If this change is intended, run `npx tsx bench/scripts/freeze.ts` and commit freeze.json in the same change.')
    process.exit(1)
  }
  console.log(`freeze.json current: ${next.sha256.slice(0, 16)}… (${SUITES.map((s) => `${s} ${next.suites[s].count}`).join(', ')})`)
} else {
  fs.writeFileSync(FREEZE_PATH, JSON.stringify(next, null, 2) + '\n')
  console.log(`Wrote ${FREEZE_PATH}`)
  console.log(`  sha256 ${next.sha256}`)
  for (const s of SUITES) console.log(`  ${s}: ${next.suites[s].count} tasks, ${next.suites[s].sha256.slice(0, 16)}…`)
}
