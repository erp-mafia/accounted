/**
 * Bounded fan-out over a set of companies.
 *
 * One MCP or v1 request may run the same read for N companies. This runner
 * keeps that inside every host's budget: a small concurrency pool (never one
 * database burst per company), a per-company timeout so one slow tenant
 * cannot stall the rest, and a total budget well under the route's
 * maxDuration. Results are collected with allSettled semantics: a failure in
 * one company is reported in its own row and never hides the others.
 *
 * Pure orchestration: no Supabase, no tool registry. The MCP tools and the
 * v1 portfolio routes supply `invoke`.
 */

export interface RunnerCompany {
  companyId: string
  name: string
}

export interface RunnerOptions {
  /** Parallel invocations at any time. Default 4, hard cap 4. */
  concurrency?: number
  /** Per-company budget in ms. Default 20 000. */
  perCompanyTimeoutMs?: number
  /** Whole-run budget in ms. Companies not started by then are marked skipped. Default 120 000. */
  totalTimeoutMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export type RunnerRow<T> =
  | { company: RunnerCompany; ok: true; data: T; elapsed_ms: number }
  | {
      company: RunnerCompany
      ok: false
      error: { code: string; message: string }
      elapsed_ms: number
    }

export interface RunnerResult<T> {
  results: RunnerRow<T>[]
  /** Companies that were never started because the total budget ran out. */
  skipped: RunnerCompany[]
  succeeded: number
  failed: number
  elapsed_ms: number
}

export const RUNNER_MAX_CONCURRENCY = 4
export const RUNNER_DEFAULT_PER_COMPANY_TIMEOUT_MS = 20_000
export const RUNNER_DEFAULT_TOTAL_TIMEOUT_MS = 120_000

export class CompanyRunTimeoutError extends Error {
  readonly code = 'TIMEOUT'
  constructor(companyId: string, ms: number) {
    super(`Company ${companyId} did not answer within ${ms} ms`)
    this.name = 'CompanyRunTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, companyId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CompanyRunTimeoutError(companyId, ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function errorShape(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const record = err as { code?: unknown; message?: unknown }
    const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : 'ERROR'
    const message =
      typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : 'Unknown error'
    return { code, message: message.slice(0, 500) }
  }
  return { code: 'ERROR', message: String(err).slice(0, 500) }
}

/**
 * Run `invoke` for every company with a bounded pool. Order of `results`
 * follows the input order regardless of completion order, so a caller can
 * zip it with its scope.
 */
export async function runAcrossCompanies<T>(
  companies: RunnerCompany[],
  invoke: (company: RunnerCompany) => Promise<T>,
  options: RunnerOptions = {}
): Promise<RunnerResult<T>> {
  const now = options.now ?? Date.now
  const concurrency = Math.max(
    1,
    Math.min(RUNNER_MAX_CONCURRENCY, Math.floor(options.concurrency ?? RUNNER_MAX_CONCURRENCY))
  )
  const perCompanyTimeoutMs = options.perCompanyTimeoutMs ?? RUNNER_DEFAULT_PER_COMPANY_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? RUNNER_DEFAULT_TOTAL_TIMEOUT_MS
  const startedAt = now()

  const results: Array<RunnerRow<T> | undefined> = new Array(companies.length).fill(undefined)
  const skipped: RunnerCompany[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < companies.length) {
      const index = nextIndex
      nextIndex += 1
      const company = companies[index]
      if (now() - startedAt >= totalTimeoutMs) {
        skipped.push(company)
        continue
      }
      const companyStartedAt = now()
      try {
        const data = await withTimeout(invoke(company), perCompanyTimeoutMs, company.companyId)
        results[index] = { company, ok: true, data, elapsed_ms: now() - companyStartedAt }
      } catch (err) {
        results[index] = {
          company,
          ok: false,
          error: errorShape(err),
          elapsed_ms: now() - companyStartedAt,
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker))

  const settled = results.filter((row): row is RunnerRow<T> => row !== undefined)
  return {
    results: settled,
    skipped,
    succeeded: settled.filter((row) => row.ok).length,
    failed: settled.filter((row) => !row.ok).length,
    elapsed_ms: now() - startedAt,
  }
}

/** Bytes a summarised per-company payload may take before it is trimmed. */
export const SUMMARY_MAX_CHARS = 4_000
/** Bytes a full per-company payload may take before it is trimmed. */
export const FULL_MAX_CHARS = 20_000
/** Rows kept from the first array in summary mode. */
export const SUMMARY_ROW_LIMIT = 5

/**
 * Reduce one company's tool result to what a cross-company answer needs.
 *
 * summary mode: keep scalar fields, a `summary` object when the tool has one,
 * and the first SUMMARY_ROW_LIMIT rows of the first array (with the array's
 * total length as `<key>_count`). full mode: the result unchanged. Both
 * modes then cap the serialised size and set `truncated` when the cap hits,
 * because a chat host cuts a tool result mid-JSON past roughly 25K tokens.
 */
export function summarizeCompanyResult(
  value: unknown,
  mode: 'summary' | 'full'
): { data: unknown; truncated: boolean } {
  const cap = mode === 'summary' ? SUMMARY_MAX_CHARS : FULL_MAX_CHARS
  let data = value
  if (mode === 'summary' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const compact: Record<string, unknown> = {}
    let firstArrayKept = false
    for (const [key, entry] of Object.entries(record)) {
      if (key === 'next') continue
      if (Array.isArray(entry)) {
        compact[`${key}_count`] = entry.length
        if (!firstArrayKept) {
          compact[key] = entry.slice(0, SUMMARY_ROW_LIMIT)
          firstArrayKept = true
        }
        continue
      }
      if (entry && typeof entry === 'object') {
        if (key === 'summary' || key === 'totals' || key === 'period') compact[key] = entry
        continue
      }
      compact[key] = entry
    }
    data = compact
  }
  const serialised = JSON.stringify(data) ?? ''
  if (serialised.length <= cap) return { data, truncated: false }
  return {
    data: { preview: serialised.slice(0, cap), note: 'Result trimmed to the per-company budget. Call the tool for this company alone for the full answer.' },
    truncated: true,
  }
}
