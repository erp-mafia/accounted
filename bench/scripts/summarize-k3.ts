// Turn a k=3 reliability run into a measured summary the page can render.
//
//   BENCH_RESULTS_DIR=bench/results/k3-booking \
//     npx tsx bench/src/run.ts --suite booking --model <ids> --runs 3
//   npx tsx bench/scripts/summarize-k3.ts bench/results/k3-booking
//
// Reads the raw per-attempt records, and for each model reports the pass count
// in each of the three runs, pass^3 (the share of tasks solved on EVERY run,
// which is the number a firm relying on unattended booking should trust), and
// the run-to-run swing. All measured, nothing projected. Written to
// bench/results/variance/booking-k3.json.

import fs from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from '../src/util'

const dir = process.argv[2] ?? path.join(BENCH_ROOT, 'results', 'k3-booking')
if (!fs.existsSync(dir)) {
  console.error(`No such directory: ${dir}`)
  process.exit(1)
}

interface Rec {
  suite: string
  taskId: string
  model: string
  pass: boolean
  attempt?: number
  score?: { harnessError?: boolean }
  error?: unknown
}

// model -> taskId -> attempt -> pass
const byModel = new Map<string, Map<string, Map<number, boolean>>>()
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith('.jsonl')) continue
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line) as Rec
    if (r.suite !== 'booking' || r.error || r.score?.harnessError) continue
    const a = r.attempt ?? 0
    if (!byModel.has(r.model)) byModel.set(r.model, new Map())
    const tasks = byModel.get(r.model)!
    if (!tasks.has(r.taskId)) tasks.set(r.taskId, new Map())
    tasks.get(r.taskId)!.set(a, r.pass)
  }
}

const models: Record<string, unknown> = {}
let runsSeen = 0
for (const [model, tasks] of byModel) {
  const attempts = new Set<number>()
  for (const m of tasks.values()) for (const a of m.keys()) attempts.add(a)
  const runIdx = [...attempts].sort((a, b) => a - b)
  runsSeen = Math.max(runsSeen, runIdx.length)
  // Only tasks answered in every run count toward pass^k and the swing, so a
  // dropped call cannot inflate either.
  const complete = [...tasks.entries()].filter(([, m]) => runIdx.every((a) => m.has(a)))
  const n = complete.length
  const perRun = runIdx.map((a) => complete.filter(([, m]) => m.get(a) === true).length)
  const pass3 = n ? complete.filter(([, m]) => runIdx.every((a) => m.get(a) === true)).length / n : 0
  const swingPp = n ? ((Math.max(...perRun) - Math.min(...perRun)) / n) * 100 : 0
  const meanPass = n && perRun.length ? perRun.reduce((s, x) => s + x, 0) / perRun.length / n : 0
  models[model] = {
    runs: runIdx.length,
    n,
    perRun,
    pass3: Math.round(pass3 * 1000) / 1000,
    swingPp: Math.round(swingPp * 10) / 10,
    meanPass: Math.round(meanPass * 1000) / 1000,
  }
}

const out = {
  _comment:
    'Measured k=3 reliability on the booking suite. perRun = pass count in each run; pass3 = share of tasks passed in ALL runs; swingPp = spread between the best and worst run. Produced by bench/scripts/summarize-k3.ts from a run under BENCH_RESULTS_DIR.',
  generatedAt: new Date().toISOString().slice(0, 10),
  suite: 'booking',
  runs: runsSeen,
  models,
}
const outPath = path.join(BENCH_ROOT, 'results', 'variance', 'booking-k3.json')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
console.log(`Wrote ${outPath}`)
for (const [m, v] of Object.entries(models)) {
  const s = v as { perRun: number[]; n: number; pass3: number; swingPp: number }
  console.log(`  ${m.padEnd(20)} runs ${s.perRun.join('/')} of ${s.n}  pass^3 ${(s.pass3 * 100).toFixed(1)}%  swing ${s.swingPp}pp`)
}
