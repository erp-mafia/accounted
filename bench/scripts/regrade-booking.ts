// Re-grade stored booking run records against the CURRENT gold labels.
//
//   npx tsx bench/scripts/regrade-booking.ts
//
// Booking answers are stored verbatim in the JSONL records, so a gold
// remediation (e.g. accepting an equally valid account surfaced by review)
// can be applied to past runs without re-spending model calls. Rewrites the
// files in place and reports every flipped verdict.

import fs from 'node:fs'
import path from 'node:path'
import { loadTasks, BENCH_ROOT } from '../src/util'
import { VAT_TREATMENTS } from '../src/types'
import type { BookingTask, RunRecord } from '../src/types'

const tasks = new Map(loadTasks<BookingTask>('booking').map((t) => [t.id, t]))
const dir = path.join(BENCH_ROOT, 'results', 'runs')
let flipped = 0
for (const file of fs.readdirSync(dir)) {
  if (!file.includes('-booking-') || !file.endsWith('.jsonl')) continue
  const lines = fs
    .readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
  const out: string[] = []
  for (const line of lines) {
    const rec = JSON.parse(line) as RunRecord
    const task = tasks.get(rec.taskId)
    const answer = rec.answer as Record<string, unknown> | string | undefined
    if (!task || typeof answer !== 'object' || answer === null) {
      out.push(line)
      continue
    }
    const konto = typeof answer.konto === 'string' ? answer.konto.trim() : null
    const moms = typeof answer.moms === 'string' ? answer.moms.trim() : null
    const accepted = new Set([task.gold.account, ...(task.gold.acceptable_accounts ?? [])])
    const accountCorrect = konto !== null && accepted.has(konto)
    const vatCorrect =
      moms !== null &&
      (VAT_TREATMENTS as string[]).includes(moms) &&
      moms === task.gold.vat_treatment
    const pass = accountCorrect && vatCorrect
    if (pass !== rec.pass) {
      flipped++
      console.log(`${file} ${rec.taskId} ${rec.model}: ${rec.pass} -> ${pass} (konto ${konto})`)
    }
    rec.pass = pass
    rec.score.accountCorrect = accountCorrect
    rec.score.vatCorrect = vatCorrect
    rec.score.exactAccount = konto === task.gold.account
    out.push(JSON.stringify(rec))
  }
  fs.writeFileSync(path.join(dir, file), out.join('\n') + '\n')
}
console.log(`Re-graded; ${flipped} verdict(s) changed.`)
