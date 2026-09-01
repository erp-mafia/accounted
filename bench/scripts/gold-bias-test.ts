// Test whether curating the gold favoured the family that authored it.
//
//   npx tsx bench/scripts/gold-bias-test.ts     (writes bench/results/gold-bias.json)
//
// The booking tasks and their answers were authored with Claude, and Claude
// models are then ranked on them. Part of that risk is testable rather than
// arguable. During curation some tasks had their acceptance lists extended
// after we read model answers and checked the alternative against the chart;
// the rest kept the answer they were written with. If curation had quietly
// bent the gold toward the authoring family, the Claude advantage would be
// larger on the tasks curation touched. This measures both, on the strict
// score, which ignores acceptance lists entirely.

import fs from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT, loadTasks } from '../src/util'
import { MODELS } from '../src/models'
import type { BookingTask } from '../src/types'

interface Rec {
  taskId: string
  model: string
  suite: string
  score?: { exactAccount?: boolean; vatCorrect?: boolean; harnessError?: boolean }
  error?: unknown
}

function loadBookingRecords(): Rec[] {
  const dir = path.join(BENCH_ROOT, 'results', 'runs')
  const out: Rec[] = []
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const rec = JSON.parse(line) as Rec
      // Harness errors never reached the model: they are not run, not failed.
      if (rec.suite === 'booking' && !rec.error && rec.score?.harnessError !== true) {
        out.push(rec)
      }
    }
  }
  // Last record wins per (model, task), matching the aggregator.
  const latest = new Map<string, Rec>()
  for (const r of out) latest.set(`${r.model}::${r.taskId}`, r)
  return [...latest.values()]
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

function main() {
  const tasks = loadTasks<BookingTask>('booking')
  const extended = new Set(
    tasks.filter((t) => (t.gold.acceptable_accounts?.length ?? 0) > 0).map((t) => t.id),
  )
  const untouched = new Set(tasks.filter((t) => !extended.has(t.id)).map((t) => t.id))

  const claude = new Set(
    MODELS.filter((m) => m.vendor === 'Anthropic').map((m) => m.id),
  )
  const records = loadBookingRecords()

  function edge(ids: Set<string>) {
    const subset = records.filter((r) => ids.has(r.taskId))
    const byModel = new Map<string, number[]>()
    for (const r of subset) {
      const strict = r.score?.exactAccount === true && r.score?.vatCorrect === true ? 1 : 0
      const arr = byModel.get(r.model) ?? []
      arr.push(strict)
      byModel.set(r.model, arr)
    }
    const perModel = [...byModel.entries()].map(([id, xs]) => ({
      id,
      isClaude: claude.has(id),
      strict: mean(xs),
      n: xs.length,
    }))
    const c = mean(perModel.filter((m) => m.isClaude).map((m) => m.strict))
    const o = mean(perModel.filter((m) => !m.isClaude).map((m) => m.strict))
    return {
      tasks: ids.size,
      models: perModel.length,
      claudeStrict: c,
      othersStrict: o,
      edgePp: (c - o) * 100,
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    method:
      'Strict pass (exact gold account and exact VAT treatment) per model, averaged within family, on tasks whose acceptance list was extended during curation vs tasks whose gold was never revisited. Circularity in favour of the authoring family predicts a LARGER Claude edge on the extended set.',
    extended: edge(extended),
    untouched: edge(untouched),
  }
  const out = path.join(BENCH_ROOT, 'results', 'gold-bias.json')
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n')

  const e = result.extended
  const u = result.untouched
  console.log(
    `extended gold  n=${e.tasks} tasks  Claude ${(e.claudeStrict * 100).toFixed(1)}%  others ${(e.othersStrict * 100).toFixed(1)}%  edge ${e.edgePp >= 0 ? '+' : ''}${e.edgePp.toFixed(1)} pp`,
  )
  console.log(
    `untouched gold n=${u.tasks} tasks  Claude ${(u.claudeStrict * 100).toFixed(1)}%  others ${(u.othersStrict * 100).toFixed(1)}%  edge ${u.edgePp >= 0 ? '+' : ''}${u.edgePp.toFixed(1)} pp`,
  )
  console.log(
    e.edgePp > u.edgePp
      ? 'Edge is larger where curation touched the gold: consistent with author-family bias.'
      : 'Edge is NOT larger where curation touched the gold: no evidence of author-family bias.',
  )
  console.log(`Wrote ${out}`)
}

main()
