/**
 * The fixed identities seed.sql creates, shared by the runner and its cases.
 * Everything else (fiscal period ids, opening-balance entries, cursors) the
 * runner looks up in the database at start, so the seed stays the one place
 * that decides the data.
 */

/** Prestanda AB: 150 000 verifikat over 2024-2026, the company every case reads. */
export const MEASURED_COMPANY_ID = 'c0000000-0000-4000-8000-000000000001'
export const MEASURED_USER_ID = 'a0000000-0000-4000-8000-000000000001'
export const MEASURED_USER_EMAIL = 'bench@bench.invalid'

/** Bygget AB: the company mixed mode rebuilds onto the ledger summaries while the readers run. */
export const BUILD_COMPANY_ID = 'c0000000-0000-4000-8000-000000000002'

/** The seed's "today": the open year 2026 runs up to this day, and every date parameter is taken from it. */
export const BENCH_TODAY = '2026-10-22'

/** The fiscal years seed.sql creates; the last is open. */
export const FISCAL_YEARS = ['2024', '2025', '2026'] as const
export type FiscalYear = (typeof FISCAL_YEARS)[number]
