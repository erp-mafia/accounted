// Aggregate bench/results/runs/*.jsonl into bench/results/leaderboard.json.
//
//   npx tsx bench/src/aggregate.ts
//
// Keeps the LATEST record per (suite, taskId, model), so re-running a task
// supersedes earlier attempts. Reports pass rate with a Wilson score
// interval at z=1 (matching how Ramp SWE-Bench reports +-1 sigma), cost,
// turns, and suite-specific metrics (calibration ECE for booking, field
// accuracy for extraction, invariant telemetry for ledger-agent).

import fs from 'node:fs'
import path from 'node:path'
import { MODELS } from './models'
import type { RunRecord, SuiteId } from './types'
import { BENCH_ROOT } from './util'

function loadAllRecords(): RunRecord[] {
  const dir = path.join(BENCH_ROOT, 'results', 'runs')
  if (!fs.existsSync(dir)) return []
  const records: RunRecord[] = []
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      records.push(JSON.parse(line) as RunRecord)
    }
  }
  return records
}

function latestPerKey(records: RunRecord[]): RunRecord[] {
  const byKey = new Map<string, RunRecord>()
  for (const rec of records) {
    const key = `${rec.suite}::${rec.taskId}::${rec.model}`
    const existing = byKey.get(key)
    if (!existing || rec.startedAt > existing.startedAt) byKey.set(key, rec)
  }
  return [...byKey.values()]
}

function wilson(x: number, n: number, z = 1): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 }
  const phat = x / n
  const z2 = z * z
  const center = (phat + z2 / (2 * n)) / (1 + z2 / n)
  const half =
    (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { p: phat, lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

// Expected calibration error over 10 equal-width confidence bins.
function ece(samples: { confidence: number; correct: boolean }[]): number | null {
  if (samples.length < 5) return null
  const bins: { n: number; conf: number; acc: number }[] = Array.from(
    { length: 10 },
    () => ({ n: 0, conf: 0, acc: 0 }),
  )
  for (const s of samples) {
    const b = Math.min(9, Math.floor(s.confidence * 10))
    bins[b].n++
    bins[b].conf += s.confidence
    bins[b].acc += s.correct ? 1 : 0
  }
  let total = 0
  for (const b of bins) {
    if (b.n === 0) continue
    total += (b.n / samples.length) * Math.abs(b.acc / b.n - b.conf / b.n)
  }
  return Math.round(total * 1000) / 1000
}

interface SuiteRow {
  model: string
  label: string
  vendor: string
  open_weights: boolean
  n: number
  pass: number
  passRate: number
  wilsonLo: number
  wilsonHi: number
  totalCostUsd: number
  avgCostUsd: number
  avgTurns: number
  avgDurationMs: number
  extras: Record<string, unknown>
}

function suiteExtras(suite: SuiteId, records: RunRecord[]): Record<string, unknown> {
  if (suite === 'booking') {
    const accountAcc =
      records.filter((r) => r.score.accountCorrect === true).length / records.length
    const vatAcc = records.filter((r) => r.score.vatCorrect === true).length / records.length
    const calibration = records
      .filter((r) => typeof r.score.confidence === 'number')
      .map((r) => ({
        confidence: r.score.confidence as number,
        correct: r.score.accountCorrect === true,
      }))
    return {
      accountAccuracy: round3(accountAcc),
      vatAccuracy: round3(vatAcc),
      ece: ece(calibration),
      parseFailures: records.filter((r) => r.score.parseFailed === true).length,
    }
  }
  if (suite === 'reasoning') {
    const calibration = records
      .filter((r) => typeof r.score.confidence === 'number')
      .map((r) => ({ confidence: r.score.confidence as number, correct: r.pass }))
    return {
      ece: ece(calibration),
      parseFailures: records.filter((r) => r.score.parseFailed === true).length,
    }
  }
  if (suite === 'extraction') {
    const fieldAcc =
      records.reduce((s, r) => s + ((r.score.fieldAccuracy as number) ?? 0), 0) /
      records.length
    return { fieldAccuracy: round3(fieldAcc) }
  }
  if (suite === 'ledger-agent') {
    return {
      totalToolCalls: records.reduce((s, r) => s + ((r.score.toolCalls as number) ?? 0), 0),
      totalToolErrors: records.reduce((s, r) => s + ((r.score.toolErrors as number) ?? 0), 0),
      invariantRefusals: records.reduce(
        (s, r) => s + ((r.score.invariantRefusals as number) ?? 0),
        0,
      ),
    }
  }
  return {}
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

function main() {
  const latest = latestPerKey(loadAllRecords())
  const suites: SuiteId[] = ['booking', 'reasoning', 'extraction', 'ledger-agent']
  const leaderboard: Record<string, unknown> = {
    benchVersion: 'v1',
    generatedAt: new Date().toISOString(),
    suites: {},
  }

  for (const suite of suites) {
    const rows: SuiteRow[] = []
    for (const model of MODELS) {
      const records = latest.filter((r) => r.suite === suite && r.model === model.id)
      if (records.length === 0) continue
      const pass = records.filter((r) => r.pass).length
      const w = wilson(pass, records.length)
      rows.push({
        model: model.id,
        label: model.label,
        vendor: model.vendor,
        open_weights: model.open_weights,
        n: records.length,
        pass,
        passRate: round3(w.p),
        wilsonLo: round3(w.lo),
        wilsonHi: round3(w.hi),
        totalCostUsd: round3(records.reduce((s, r) => s + r.usage.costUsd, 0)),
        avgCostUsd:
          Math.round(
            (records.reduce((s, r) => s + r.usage.costUsd, 0) / records.length) * 100000,
          ) / 100000,
        avgTurns: round3(records.reduce((s, r) => s + r.turns, 0) / records.length),
        avgDurationMs: Math.round(
          records.reduce((s, r) => s + r.durationMs, 0) / records.length,
        ),
        extras: suiteExtras(suite, records),
      })
    }
    rows.sort((a, b) => b.passRate - a.passRate)
    ;(leaderboard.suites as Record<string, unknown>)[suite] = rows
  }

  const out = path.join(BENCH_ROOT, 'results', 'leaderboard.json')
  fs.writeFileSync(out, JSON.stringify(leaderboard, null, 2) + '\n')
  console.log(`Wrote ${out}`)
  for (const suite of suites) {
    const rows = (leaderboard.suites as Record<string, SuiteRow[]>)[suite] ?? []
    if (rows.length === 0) continue
    console.log(`\n${suite}:`)
    for (const row of rows) {
      console.log(
        `  ${row.label.padEnd(20)} ${(row.passRate * 100).toFixed(1).padStart(5)}% ` +
          `[${(row.wilsonLo * 100).toFixed(0)}-${(row.wilsonHi * 100).toFixed(0)}] ` +
          `n=${row.n} $${row.totalCostUsd.toFixed(3)}`,
      )
    }
  }
}

main()
