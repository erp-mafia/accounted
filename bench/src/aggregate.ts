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
import { GATE_TARGET, GATE_FOLDS, FIXED_GATE_THRESHOLD } from './scoring-config'
export { GATE_TARGET, GATE_FOLDS, FIXED_GATE_THRESHOLD } from './scoring-config'

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
export interface CoverageResult {
  // Share of all transactions the gate would auto-commit.
  coverage: number
  // How many transactions that is, and how many of them the model got wrong.
  selected: number
  errors: number
  // 95% Wilson lower bound on the precision actually achieved on those
  // selected transactions. This is the number that matters: at these sample
  // sizes an observed 100% is compatible with a true precision far below the
  // target, and the threshold was chosen on the same data it is scored on,
  // so the observed figure is optimistic by construction.
  precisionLo: number
  threshold: number
}

// The published gate. The threshold is FIXED in advance rather than fitted to
// the sample: 0.90 is the round number a practitioner would pick for
// "book it without asking me", chosen without reference to which model it
// favours and recorded in bench/freeze.json. Nothing here is optimised, so
// the precision it reports is an unbiased estimate, unlike coverageAtPrecision
// below, whose threshold is chosen on the same data it is scored on.
export interface FixedGateResult {
  threshold: number
  // Share of all transactions whose stated confidence clears the threshold.
  coverage: number
  selected: number
  errors: number
  // Precision on the selected transactions, observed and as a 95% Wilson
  // lower bound. The bound is the number to quote.
  precision: number
  precisionLo: number
}

function coverageAtThreshold(
  samples: { confidence: number; correct: boolean }[],
  threshold: number,
): FixedGateResult | null {
  if (samples.length < 10) return null
  const sel = samples.filter((s) => s.confidence >= threshold)
  const errors = sel.filter((s) => !s.correct).length
  const ok = sel.length - errors
  return {
    threshold,
    coverage: Math.round((sel.length / samples.length) * 1000) / 1000,
    selected: sel.length,
    errors,
    precision: sel.length ? Math.round((ok / sel.length) * 1000) / 1000 : 0,
    precisionLo: sel.length ? Math.round(wilson(ok, sel.length, 1.96).lo * 1000) / 1000 : 0,
  }
}

// The published gate: a per-model threshold fitted OUT OF SAMPLE.
//
// The deployment question is "if we auto-commit above a confidence threshold
// tuned for this model, what share is automated and how often is it wrong?"
// The v1 metric answered it by fitting the threshold on the same tasks it
// then scored, which is optimistic by construction. A single fixed threshold
// (kept below as gateFixed) removes the bias but measures the wrong thing:
// whether a model's confidence SCALE happens to sit near the number chosen,
// so a model that separates its errors cleanly at 0.6 vs 0.85 scores zero.
//
// Cross-fitting does neither. Tasks are split into two deterministic folds by
// id; the threshold is fitted on one fold to reach the precision target and
// applied to the other, then the roles swap. Every scored transaction was
// selected by a threshold that never saw it. The pooled out-of-sample
// selection gives coverage, precision and a Wilson lower bound that are
// honest estimates, at the cost of noise that the bound then reports.

export interface GateResult {
  method: 'cross_fitted'
  target: number
  folds: number
  // The threshold fitted on each fold's complement, for the record.
  thresholds: number[]
  // Share of all transactions selected out of sample.
  coverage: number
  selected: number
  errors: number
  // Precision on the pooled out-of-sample selection, observed and as a 95%
  // Wilson lower bound. The bound is the number to quote.
  precision: number
  precisionLo: number
}

function fitThreshold(
  fit: { confidence: number; correct: boolean }[],
  target: number,
): number | null {
  let best: { t: number; cov: number } | null = null
  for (const t of [...new Set(fit.map((s) => s.confidence))].sort()) {
    const sel = fit.filter((s) => s.confidence >= t)
    if (sel.length === 0) continue
    const precision = sel.filter((s) => s.correct).length / sel.length
    if (precision >= target && (!best || sel.length > best.cov)) best = { t, cov: sel.length }
  }
  return best ? best.t : null
}

function crossFittedGate(
  samples: { taskId: string; confidence: number; correct: boolean }[],
  target: number,
  folds: number,
): GateResult | null {
  if (samples.length < 10) return null
  const ordered = samples.slice().sort((a, b) => (a.taskId < b.taskId ? -1 : 1))
  const foldOf = new Map(ordered.map((s, i) => [s.taskId, i % folds]))
  const thresholds: number[] = []
  const pooled: { correct: boolean }[] = []
  for (let k = 0; k < folds; k++) {
    const fit = ordered.filter((s) => foldOf.get(s.taskId) !== k)
    const evalSet = ordered.filter((s) => foldOf.get(s.taskId) === k)
    const t = fitThreshold(fit, target)
    // No threshold reaches the target on the fitting fold: the gate selects
    // nothing on this fold, which is the honest answer, not a failure.
    thresholds.push(t ?? Infinity)
    if (t === null) continue
    for (const s of evalSet) if (s.confidence >= t) pooled.push({ correct: s.correct })
  }
  const errors = pooled.filter((s) => !s.correct).length
  const ok = pooled.length - errors
  return {
    method: 'cross_fitted',
    target,
    folds,
    thresholds,
    coverage: Math.round((pooled.length / samples.length) * 1000) / 1000,
    selected: pooled.length,
    errors,
    precision: pooled.length ? Math.round((ok / pooled.length) * 1000) / 1000 : 0,
    precisionLo: pooled.length ? Math.round(wilson(ok, pooled.length, 1.96).lo * 1000) / 1000 : 0,
  }
}

function coverageAtPrecision(
  samples: { confidence: number; correct: boolean }[],
  target: number,
): CoverageResult | null {
  if (samples.length < 10) return null
  let best: CoverageResult = {
    coverage: 0,
    selected: 0,
    errors: 0,
    precisionLo: 0,
    threshold: 1,
  }
  const thresholds = [...new Set(samples.map((s) => s.confidence))].sort()
  for (const t of thresholds) {
    const sel = samples.filter((s) => s.confidence >= t)
    if (sel.length === 0) continue
    const errors = sel.filter((s) => !s.correct).length
    const precision = (sel.length - errors) / sel.length
    const coverage = sel.length / samples.length
    if (precision >= target && coverage > best.coverage) {
      best = {
        coverage: Math.round(coverage * 1000) / 1000,
        selected: sel.length,
        errors,
        precisionLo:
          Math.round(wilson(sel.length - errors, sel.length, 1.96).lo * 1000) / 1000,
        threshold: t,
      }
    }
  }
  return best
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
    const confSamples = records
      .filter((r) => typeof r.score.confidence === 'number')
      .map((r) => ({ taskId: r.taskId, confidence: r.score.confidence as number, correct: r.pass }))
    const cov95 = coverageAtPrecision(confSamples, 0.95)
    const cov99 = coverageAtPrecision(confSamples, 0.99)
    const gate = crossFittedGate(confSamples, GATE_TARGET, GATE_FOLDS)
    const gateFixed = coverageAtThreshold(confSamples, FIXED_GATE_THRESHOLD)
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
      // Strict pass: the single gold account AND the right VAT treatment, with
      // no credit for chart-defensible alternatives. The acceptance lists grew
      // during curation partly in response to model answers, so the lenient
      // pass rate carries that bias and this one does not.
      strictPass: round3(
        records.filter((r) => r.score.exactAccount === true && r.score.vatCorrect === true)
          .length / records.length,
      ),
      vatAccuracy: round3(vatAcc),
      ece: ece(calibration),
      // Headline automation figure: out-of-sample coverage and precision at
      // a per-model threshold cross-fitted to 95%, with the Wilson lower
      // bound the page quotes.
      gate,
      // A single fixed 0.90 threshold, stored for the record. It measures
      // whether a model's confidence scale matches a naive policy, not
      // whether it separates its errors, and drives nothing on the page.
      gateFixed,
      // The v1 metric, kept for the record: coverage at a threshold fitted to
      // this sample so that observed precision reached 95% / 99%. Optimistic
      // by construction and no longer used for any verdict.
      fittedCoverage95: cov95,
      fittedCoverage99: cov99,
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
    benchVersion: 'v2.0',
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
      // Comparable cost: measured tokens at list price, uncached, for every
      // model. Provider-billed amounts (which can include provider-side
      // prompt-cache discounts, e.g. OpenAI via OpenRouter) stay in the raw
      // records but are not compared: a cache discount is a deployment
      // property, not a model property.
      const listCost = model.pricing
        ? records.reduce(
            (s2, r) =>
              s2 +
              (r.usage.inputTokens * model.pricing!.inputPerMTok +
                r.usage.outputTokens * model.pricing!.outputPerMTok) /
                1_000_000,
            0,
          )
        : records.reduce((s2, r) => s2 + r.usage.costUsd, 0)
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
        totalCostUsd: round3(listCost),
        avgCostUsd: Math.round((listCost / records.length) * 100000) / 100000,
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

  // Model output examples: the booking tasks where models most disagree are
  // the informative ones. For each, carry the task as posed, the gold answer,
  // and every model's stored answer verbatim from its run record.
  {
    const bookingTasks = suiteTasks.get('booking') as BookingTask[]
    const matrix =
      (leaderboard.taskMatrix as Record<
        string,
        { id: string; results: Record<string, number | null> }[]
      >).booking ?? []
    const split = matrix
      .map((row) => {
        const vals = Object.values(row.results).filter((v): v is number => v != null)
        const rate = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
        return { id: row.id, spread: Math.abs(0.5 - rate) }
      })
      .sort((a, b) => a.spread - b.spread)
      .slice(0, 3)
    leaderboard.examples = split.map(({ id }) => {
      const task = bookingTasks.find((t) => t.id === id)!
      const answers = MODELS.filter((m) => m.enabled)
        .map((m) => {
          const rec = latest.find(
            (r) =>
              r.suite === 'booking' &&
              r.taskId === id &&
              r.model === m.id &&
              !isHarnessError(r),
          )
          if (!rec) return null
          const a = rec.answer as Record<string, unknown> | string | undefined
          const obj = typeof a === 'object' && a !== null ? a : null
          return {
            model: m.id,
            label: m.label,
            vendor: m.vendor,
            pass: rec.pass,
            account: obj ? String(obj.konto ?? '') : '',
            vat: obj ? String(obj.moms ?? '') : '',
            confidence: obj && typeof obj.confidence === 'number' ? obj.confidence : null,
            accountCorrect: rec.score.accountCorrect === true,
            vatCorrect: rec.score.vatCorrect === true,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      return {
        id,
        probe: task.probe,
        difficulty: task.difficulty,
        company: task.input.company,
        transaction: task.input.transaction,
        gold: task.gold,
        rationale: task.rationale,
        law_ref: task.law_ref ?? null,
        answers,
      }
    })
  }

  // Routing decision per model, from published criteria (README). This is
  // how WE would route the model's bookings, not a certification of it:
  //   auto    : we would let it commit above the gate without a human
  //   assist  : it proposes, a human confirms
  //   review  : a human books; the model may be consulted
  //   not_assessed : too few clean runs for any opinion
  // Auto requires EVIDENCE of precision, not just a high observed figure:
  // the 95% lower bound must clear 0.85, which at zero errors needs at least
  // 24 selected transactions. A gate that selects three cannot be trusted
  // however clean those three were.
  const verdicts: Record<string, unknown> = {}
  const suitesObj = leaderboard.suites as Record<string, SuiteRow[]>
  const allModelIds = new Set(
    Object.values(suitesObj).flatMap((rows) => rows.map((r) => r.model)),
  )
  for (const id of allModelIds) {
    const booking = suitesObj['booking']?.find((r) => r.model === id)
    const reasoning = suitesObj['reasoning']?.find((r) => r.model === id)
    const agent = suitesObj['ledger-agent']?.find((r) => r.model === id)
    const gate = (booking?.extras.gate as GateResult | null) ?? null
    const bp = booking?.passRate ?? 0
    const rp = reasoning?.passRate ?? 0
    const agentClean = (agent?.passRate ?? 0) >= 0.999
    // No opinion without enough clean evidence: partial runs (rate limits,
    // credit exhaustion) must not produce verdicts in either direction.
    const assessed =
      (booking?.n ?? 0) >= 35 && (reasoning?.n ?? 0) >= 30 && (agent?.n ?? 0) >= 3
    const g = gate ?? {
      method: 'cross_fitted' as const, target: GATE_TARGET, folds: GATE_FOLDS, thresholds: [],
      coverage: 0, precision: 0, precisionLo: 0, selected: 0, errors: 0,
    }
    let verdict: 'auto' | 'assist' | 'review' | 'not_assessed' = 'review'
    if (!assessed) verdict = 'not_assessed'
    else if (
      bp >= 0.85 && rp >= 0.8 && agentClean &&
      g.coverage >= 0.5 && g.precision >= 0.95 && g.precisionLo >= 0.85
    ) verdict = 'auto'
    else if (bp >= 0.75 && rp >= 0.6 && g.coverage >= 0.2 && g.precision >= 0.9) {
      verdict = 'assist'
    }
    verdicts[id] = {
      verdict,
      gate: g,
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
