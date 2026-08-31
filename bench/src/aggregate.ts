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
import type { BookingTask, RunRecord, SuiteId, Task } from './types'
import { BENCH_ROOT, loadTasks } from './util'

// Booking tasks split into evidence segments: 'underlag' tasks attach
// invoice/receipt text (which usually states the VAT: the metric there is
// evidence READING), 'bank_only' tasks show only what a bank feed shows
// (the metric there is domain KNOWLEDGE). Reported separately because the
// two questions have different answers.
function bookingSegment(task: BookingTask): 'underlag' | 'bank_only' {
  return task.input.transaction.underlag ? 'underlag' : 'bank_only'
}

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

// A record whose run never reached the model (rate limit, credit balance,
// network) is 'not run', never 'failed': counting it as a miss would let the
// harness's account state impersonate model quality.
export function isHarnessError(rec: RunRecord): boolean {
  return rec.score?.harnessError === true
}

function latestPerKey(records: RunRecord[]): RunRecord[] {
  const byKey = new Map<string, RunRecord>()
  for (const rec of records) {
    const key = `${rec.suite}::${rec.taskId}::${rec.model}::${rec.attempt ?? 0}`
    const existing = byKey.get(key)
    if (!existing || rec.startedAt > existing.startedAt) byKey.set(key, rec)
  }
  return [...byKey.values()]
}

// Selective automation: if bookings are auto-committed only when the model's
// stated confidence clears a threshold, what share of the work is automated
// while keeping precision at or above the target? This is the deployment
// question (auto/suggest/review routing) collapsed into one number.
function coverageAtPrecision(
  samples: { confidence: number; correct: boolean }[],
  target: number,
): number | null {
  if (samples.length < 10) return null
  let best = 0
  const thresholds = [...new Set(samples.map((s) => s.confidence))].sort()
  for (const t of thresholds) {
    const sel = samples.filter((s) => s.confidence >= t)
    if (sel.length === 0) continue
    const precision = sel.filter((s) => s.correct).length / sel.length
    if (precision >= target) best = Math.max(best, sel.length / samples.length)
  }
  return Math.round(best * 1000) / 1000
}

// Reliability: among tasks attempted more than once, the share where EVERY
// attempt passed (the pass^k stance: an agent you rerun monthly is only as
// good as its worst month).
function reliability(records: RunRecord[]): { value: number; k: number } | null {
  const byTask = new Map<string, RunRecord[]>()
  for (const r of records) {
    const list = byTask.get(r.taskId) ?? []
    list.push(r)
    byTask.set(r.taskId, list)
  }
  const multi = [...byTask.values()].filter((l) => l.length > 1)
  if (multi.length === 0) return null
  const allPass = multi.filter((l) => l.every((r) => r.pass)).length
  const k = Math.max(...multi.map((l) => l.length))
  return { value: Math.round((allPass / multi.length) * 1000) / 1000, k }
}

// Exact McNemar test on paired task outcomes (Anthropic, "Adding Error Bars
// to Evals": compare models on paired differences, not overlapping CIs).
// Returns the two-sided exact binomial p-value over discordant pairs.
function mcnemarP(discA: number, discB: number): number {
  const n = discA + discB
  if (n === 0) return 1
  const k = Math.min(discA, discB)
  // exact binomial tail via logs (n stays small; doubles are fine)
  let tail = 0
  for (let i = 0; i <= k; i++) {
    let logC = 0
    for (let j = 0; j < i; j++) logC += Math.log(n - j) - Math.log(j + 1)
    tail += Math.exp(logC - n * Math.LN2)
  }
  return Math.min(1, 2 * tail)
}

// Statistical tie groups per suite: walking the ranking top-down, a model
// joins the current group while McNemar vs the group's leader is not
// significant (p >= 0.05); a significant difference starts a new group.
// Leader-chaining is a simplification of a compact letter display and is
// documented as such in the README.
function tieGroups(
  ranking: string[],
  passByTaskModel: Map<string, Map<string, boolean>>,
): string[][] {
  const groups: string[][] = []
  for (const model of ranking) {
    const current = groups[groups.length - 1]
    if (!current) {
      groups.push([model])
      continue
    }
    const leader = current[0]
    let a = 0
    let b = 0
    for (const perModel of passByTaskModel.values()) {
      const pl = perModel.get(leader)
      const pm = perModel.get(model)
      if (pl === undefined || pm === undefined) continue
      if (pl && !pm) a++
      if (pm && !pl) b++
    }
    if (mcnemarP(a, b) >= 0.05) current.push(model)
    else groups.push([model])
  }
  return groups
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

function suiteExtras(
  suite: SuiteId,
  records: RunRecord[],
  segments?: Map<string, 'underlag' | 'bank_only'>,
  freshIds?: Set<string>,
): Record<string, unknown> {
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
    const seg = (name: 'underlag' | 'bank_only') => {
      const recs = records.filter((r) => segments?.get(r.taskId) === name)
      if (recs.length === 0) return null
      return {
        n: recs.length,
        pass: round3(recs.filter((r) => r.pass).length / recs.length),
        accountAccuracy: round3(
          recs.filter((r) => r.score.accountCorrect === true).length / recs.length,
        ),
        vatAccuracy: round3(
          recs.filter((r) => r.score.vatCorrect === true).length / recs.length,
        ),
      }
    }
    return {
      accountAccuracy: round3(accountAcc),
      strictAccountAccuracy: round3(
        records.filter((r) => r.score.exactAccount === true).length / records.length,
      ),
      vatAccuracy: round3(vatAcc),
      ece: ece(calibration),
      coverage95: coverageAtPrecision(
        records
          .filter((r) => typeof r.score.confidence === 'number')
          .map((r) => ({ confidence: r.score.confidence as number, correct: r.pass })),
        0.95,
      ),
      coverage99: coverageAtPrecision(
        records
          .filter((r) => typeof r.score.confidence === 'number')
          .map((r) => ({ confidence: r.score.confidence as number, correct: r.pass })),
        0.99,
      ),
      parseFailures: records.filter((r) => r.score.parseFailed === true).length,
      segments: { underlag: seg('underlag'), bank_only: seg('bank_only') },
    }
  }
  if (suite === 'reasoning') {
    const calibration = records
      .filter((r) => typeof r.score.confidence === 'number')
      .map((r) => ({ confidence: r.score.confidence as number, correct: r.pass }))
    const fresh = records.filter((r) => freshIds?.has(r.taskId))
    const stable = records.filter((r) => !freshIds?.has(r.taskId))
    return {
      ece: ece(calibration),
      // Regelverksfarskhet: rules that changed 2025 or later, vs stable law.
      freshness: fresh.length
        ? { n: fresh.length, pass: fresh.filter((r) => r.pass).length }
        : null,
      stablePass: stable.length
        ? round3(stable.filter((r) => r.pass).length / stable.length)
        : null,
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
    const rel = reliability(records)
    return {
      totalToolCalls: records.reduce((s, r) => s + ((r.score.toolCalls as number) ?? 0), 0),
      totalToolErrors: records.reduce((s, r) => s + ((r.score.toolErrors as number) ?? 0), 0),
      invariantRefusals: records.reduce(
        (s, r) => s + ((r.score.invariantRefusals as number) ?? 0),
        0,
      ),
      reliability: rel?.value ?? null,
      reliabilityK: rel?.k ?? null,
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
    benchVersion: 'v1.1',
    generatedAt: new Date().toISOString(),
    suites: {},
    taskMatrix: {},
  }

  const suiteTasks = new Map<SuiteId, Task[]>([
    ['booking', loadTasks('booking')],
    ['reasoning', loadTasks('reasoning')],
    ['extraction', loadTasks('extraction')],
    ['ledger-agent', loadTasks('ledger-agent')],
  ])
  const bookingSegments = new Map(
    (suiteTasks.get('booking') as BookingTask[]).map((t) => [t.id, bookingSegment(t)]),
  )
  const freshIds = new Set(
    (suiteTasks.get('reasoning') ?? []).filter((t) => t.fresh).map((t) => t.id),
  )

  for (const suite of suites) {
    // Per-task outcome matrix: which model passed which task.
    const matrix: Record<string, unknown>[] = []
    for (const task of suiteTasks.get(suite) ?? []) {
      // Fraction of attempts passed (1 = always, 0 = never, between = flaky).
      const results: Record<string, number | null> = {}
      for (const model of MODELS.filter((m) => m.enabled)) {
        const recs = latest.filter(
          (r) =>
            r.suite === suite &&
            r.taskId === task.id &&
            r.model === model.id &&
            !isHarnessError(r),
        )
        results[model.id] =
          recs.length === 0
            ? null
            : Math.round((recs.filter((r) => r.pass).length / recs.length) * 100) / 100
      }
      matrix.push({
        id: task.id,
        difficulty: task.difficulty,
        probe: task.probe,
        segment: suite === 'booking' ? bookingSegments.get(task.id) : undefined,
        results,
      })
    }
    // Task discrimination (point-biserial vs each model's suite total): the
    // IRT-lite audit. Negative values mean better models do WORSE on the
    // task, the signature of defective gold; those go to human review.
    {
      const totals = new Map<string, number>()
      for (const row of matrix) {
        for (const [m, v] of Object.entries(row.results as Record<string, number | null>)) {
          if (v != null) totals.set(m, (totals.get(m) ?? 0) + v)
        }
      }
      for (const row of matrix) {
        const xs: [number, number][] = []
        for (const [m, v] of Object.entries(row.results as Record<string, number | null>)) {
          if (v != null && totals.has(m)) xs.push([v, totals.get(m)!])
        }
        if (xs.length < 5) continue
        const n = xs.length
        const mx = xs.reduce((s2, [x]) => s2 + x, 0) / n
        const my = xs.reduce((s2, [, y2]) => s2 + y2, 0) / n
        const cov = xs.reduce((s2, [x, y2]) => s2 + (x - mx) * (y2 - my), 0) / n
        const sx = Math.sqrt(xs.reduce((s2, [x]) => s2 + (x - mx) ** 2, 0) / n)
        const sy = Math.sqrt(xs.reduce((s2, [, y2]) => s2 + (y2 - my) ** 2, 0) / n)
        ;(row as Record<string, unknown>).disc =
          sx > 0 && sy > 0 ? Math.round((cov / (sx * sy)) * 100) / 100 : null
      }
    }
    ;(leaderboard.taskMatrix as Record<string, unknown>)[suite] = matrix

    // Only records whose task still exists count: a task removed during
    // curation (defective gold) drops out of the aggregates for every model
    // equally, instead of lingering as stale verdicts.
    const currentIds = new Set((suiteTasks.get(suite) ?? []).map((t) => t.id))
    const rows: SuiteRow[] = []
    for (const model of MODELS) {
      const records = latest.filter(
        (r) =>
          r.suite === suite &&
          r.model === model.id &&
          currentIds.has(r.taskId) &&
          !isHarnessError(r),
      )
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
        extras: suiteExtras(
          suite,
          records,
          suite === 'booking' ? bookingSegments : undefined,
          suite === 'reasoning' ? freshIds : undefined,
        ),
      })
    }
    rows.sort((a, b) => b.passRate - a.passRate)
    ;(leaderboard.suites as Record<string, unknown>)[suite] = rows

    // Statistical tie groups over the ranking (paired McNemar vs group leader).
    {
      const passByTask = new Map<string, Map<string, boolean>>()
      for (const row of matrix) {
        const perModel = new Map<string, boolean>()
        for (const [m, v] of Object.entries(row.results as Record<string, number | null>)) {
          if (v != null) perModel.set(m, v >= 0.999)
        }
        passByTask.set(row.id as string, perModel)
      }
      ;(leaderboard.tieGroups ??= {} as Record<string, unknown>)
      ;(leaderboard.tieGroups as Record<string, unknown>)[suite] = tieGroups(
        rows.map((r) => r.model),
        passByTask,
      )
    }
  }

  // Verdict per model, revisor-style, from published criteria (README).
  // tillstyrks: fit for confidence-gated unattended booking today.
  // reservation: usable with human review of everything below the gate.
  // avstyrks: should not book unattended in any configuration.
  const verdicts: Record<string, unknown> = {}
  const suitesObj = leaderboard.suites as Record<string, SuiteRow[]>
  const allModelIds = new Set(
    Object.values(suitesObj).flatMap((rows) => rows.map((r) => r.model)),
  )
  for (const id of allModelIds) {
    const booking = suitesObj['booking']?.find((r) => r.model === id)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const reasoning = suitesObj['reasoning']?.find((r) => r.model === id)
    const agent = suitesObj['ledger-agent']?.find((r) => r.model === id)
    const cov99 = (booking?.extras.coverage99 as number | null) ?? 0
    const cov95 = (booking?.extras.coverage95 as number | null) ?? 0
    const bp = booking?.passRate ?? 0
    const rp = reasoning?.passRate ?? 0
    const agentClean = (agent?.passRate ?? 0) >= 0.999
    // No opinion without enough clean evidence: partial runs (rate limits,
    // credit exhaustion) must not produce verdicts in either direction.
    const assessed =
      (booking?.n ?? 0) >= 35 && (reasoning?.n ?? 0) >= 30 && (agent?.n ?? 0) >= 3
    let verdict: 'tillstyrks' | 'tillstyrks_med_reservation' | 'avstyrks' | 'ej_bedomd' =
      'avstyrks'
    if (!assessed) verdict = 'ej_bedomd'
    else if (bp >= 0.85 && cov99 >= 0.5 && rp >= 0.8 && agentClean) verdict = 'tillstyrks'
    else if (bp >= 0.75 && rp >= 0.6 && (cov99 >= 0.2 || cov95 >= 0.5)) {
      verdict = 'tillstyrks_med_reservation'
    }
    verdicts[id] = {
      verdict,
      coverage99: cov99,
      coverage95: cov95,
      booking: booking?.passRate ?? null,
      reasoning: reasoning?.passRate ?? null,
      agentClean,
    }
  }
  leaderboard.verdicts = verdicts

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
