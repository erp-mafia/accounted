/**
 * The report benchmark's results and how --check holds them against
 * budgets.json. Pure, so the unit suite checks them
 * (scripts/__tests__/perf-bench.test.ts) without a database.
 */

export type Mode = 'warm' | 'cold' | 'mixed'

/** One case in one mode, as run.ts prints it and writes it to --out. */
export interface CaseResult {
  id: string
  rpc: string
  usedBy: string
  n: number
  p50: number
  p95: number
  max: number
  kB: number
  /** Calls that failed (twice, for a statement timeout): not samples, and a failure of the run. */
  errors: number
  error?: string
  /** Calls that hit the statement timeout once and answered when repeated. */
  retried: number
}

/** budgets.json: a p95 budget in ms per case id and mode, and an optional note on why. */
export interface Budgets {
  cases: Record<string, Partial<Record<Mode, number>> & { note?: string }>
}

/** Nearest-rank percentile of an ascending array, as scripts/perf/log-percentiles.ts computes it. */
export function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

/**
 * What --check fails on: a case whose calls failed, a case with no budget for
 * the mode, and a p95 over its budget. Empty when the run passes.
 */
export function checkBudgets(mode: Mode, results: CaseResult[], budgets: Budgets, file = 'budgets.json'): string[] {
  const failures: string[] = []
  for (const r of results) {
    const budget = budgets.cases[r.id]?.[mode]
    if (r.errors > 0) {
      failures.push(`${r.id}: ${r.errors} call(s) failed: ${r.error}`)
    } else if (budget === undefined) {
      failures.push(`${r.id}: no ${mode} budget in ${file}`)
    } else if (r.p95 > budget) {
      failures.push(`${r.id}: p95 ${r.p95} ms is over its ${mode} budget of ${budget} ms`)
    }
  }
  return failures
}
