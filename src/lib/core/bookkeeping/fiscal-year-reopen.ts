import type { SupabaseClient } from '@supabase/supabase-js'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { CannotReverseNonPostedError, EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'
import { preparesArsredovisning, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import type {
  FiscalPeriod,
  FiscalYearReopenBlocker,
  FiscalYearReopenEligibility,
  FiscalYearReopenEntry,
  FiscalYearReopenRpcResult,
} from '@/types'

const log = createLogger('fiscal-year-reopen')

/**
 * The owner reopens a fiscal year closed with a bokslut in Accounted
 * (crm#1290). The self-service form of the support script
 * scripts/undo-year-end-closing.ts, in two halves:
 *
 *   1. reopen_closed_fiscal_year (migration 20261018120000) checks every gate
 *      under a row lock, supersedes an unsigned årsredovisning, opens and
 *      unlocks the year and writes the owner's confirmation to audit_log.
 *   2. Here, through the bookkeeping engine: a storno of the next year's
 *      omföring and IB, of the closing entry and of the year-end's currency
 *      revaluation, then closing_entry_id is detached. Nothing is edited or
 *      deleted (BFL 5 kap 5 §).
 *
 * The year can then take the missing booking, and the owner runs the bokslut
 * again. A run that stops between the halves leaves the year open with its
 * bokslut still attached; the next run resumes from there (the snapshot lists
 * only what is still posted).
 *
 * Gates beyond the database's: the form must prepare an årsredovisning (the
 * Bolagsverket check and the confirmation are about one), and the TIC
 * snapshot the database reads is refreshed first, so a stale or incomplete
 * one is fetched again instead of refusing. The refresh is the caller's
 * (`refreshRegistry`): the ledger kernel does not reach up into the TIC
 * feature (check:guards kernel-import).
 */

/**
 * Snapshot keys the database gate reads (fiscal_year_reopen_snapshot). The
 * caller's refresh must re-fetch a cached snapshot that lacks one of them.
 */
export const FISCAL_YEAR_REOPEN_REGISTRY_KEYS = ['financialReports', 'financialReportsComplete'] as const

export interface FiscalYearReopenDeps {
  /**
   * Re-fetch the company's TIC snapshot (companies.tic_snapshot) when it is
   * stale or lacks FISCAL_YEAR_REOPEN_REGISTRY_KEYS. Called only when the gate
   * reports the registry unusable. A throw keeps the gate closed.
   */
  refreshRegistry: () => Promise<unknown>
}

export type FiscalYearReopenFailureCode =
  | 'FISCAL_YEAR_REOPEN_NOT_FOUND'
  | 'FISCAL_YEAR_REOPEN_FORBIDDEN'
  | 'FISCAL_YEAR_REOPEN_INELIGIBLE'
  | 'FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED'
  | 'FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH'
  | 'FISCAL_YEAR_REOPEN_INCOMPLETE'
  | 'FISCAL_YEAR_REOPEN_FAILED'

const KNOWN_RPC_CODES = new Set<string>([
  'FISCAL_YEAR_REOPEN_NOT_FOUND',
  'FISCAL_YEAR_REOPEN_FORBIDDEN',
  'FISCAL_YEAR_REOPEN_INELIGIBLE',
  'FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED',
  'FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH',
])

export type FiscalYearReopenEligibilityOutcome =
  | { ok: true; eligibility: FiscalYearReopenEligibility }
  | { ok: false; code: FiscalYearReopenFailureCode }

export type FiscalYearReopenOutcome =
  | {
      ok: true
      periodName: string
      resumed: boolean
      reversed: FiscalYearReopenEntry[]
      supersededVersions: number
    }
  | {
      ok: false
      code: FiscalYearReopenFailureCode
      blockers?: FiscalYearReopenBlocker[]
      /** INCOMPLETE: the verifikat the run stopped on, for the log. */
      stoppedAt?: string
    }

function failureCode(code: string | undefined): FiscalYearReopenFailureCode {
  return code && KNOWN_RPC_CODES.has(code)
    ? (code as FiscalYearReopenFailureCode)
    : 'FISCAL_YEAR_REOPEN_FAILED'
}

function toEligibility(result: FiscalYearReopenRpcResult): FiscalYearReopenEligibility {
  return {
    eligible: result.eligible === true,
    blockers: result.blockers ?? [],
    resume: result.resume === true,
    period: result.period!,
    next_period: result.next_period ?? null,
    entries: result.entries ?? [],
    annual_report: result.annual_report ?? { versions_to_supersede: 0, pending_signatures: 0, agm_date: null },
    registry: result.registry ?? { fetched_at: null, reports: null },
  }
}

async function readEligibility(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<FiscalYearReopenRpcResult | null> {
  const { data, error } = await supabase.rpc('get_fiscal_year_reopen_eligibility', {
    p_company_id: companyId,
    p_period_id: periodId,
  })
  if (error) {
    log.error('reopen eligibility RPC failed', error, { companyId, periodId })
    return null
  }
  return (data as FiscalYearReopenRpcResult | null) ?? null
}

/**
 * The gate as the database sees it, with the registry refreshed when that is
 * what stands in the way. The snapshot is only fetched again when the gate
 * reports it unusable (missing, older than 7 days, for another org number, or
 * without a complete report list), so an owner opening the dialog twice does
 * not spend the TIC budget twice. A fetch that fails leaves the old snapshot,
 * and the gate refuses on it: fail closed.
 */
async function gate(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  deps: FiscalYearReopenDeps,
): Promise<FiscalYearReopenRpcResult | null> {
  const first = await readEligibility(supabase, companyId, periodId)
  if (!first?.ok) return first
  if (!(first.blockers ?? []).some((b) => b.code === 'registry_unavailable')) return first

  try {
    await deps.refreshRegistry()
  } catch (err) {
    log.warn('registry refresh for reopen failed; the gate stays closed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return first
  }
  return readEligibility(supabase, companyId, periodId)
}

/** The app's own gate: only a form that prepares an årsredovisning. */
async function formBlocker(
  supabase: SupabaseClient,
  companyId: string,
): Promise<FiscalYearReopenBlocker | null> {
  const entityType = await resolveCompanyEntityType(supabase, companyId)
  return preparesArsredovisning(entityType) ? null : { code: 'form_not_supported' }
}

/**
 * Owner-only preview for the dialog: every gate, what the reopen reverses,
 * and the årsredovisning it supersedes. The reopen checks it all again.
 */
export async function getFiscalYearReopenEligibility(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  deps: FiscalYearReopenDeps,
): Promise<FiscalYearReopenEligibilityOutcome> {
  const result = await gate(supabase, companyId, periodId, deps)
  if (!result) return { ok: false, code: 'FISCAL_YEAR_REOPEN_FAILED' }
  if (!result.ok) return { ok: false, code: failureCode(result.code) }

  const eligibility = toEligibility(result)
  const form = await formBlocker(supabase, companyId)
  if (form) {
    eligibility.blockers = [...eligibility.blockers, form]
    eligibility.eligible = false
  }
  return { ok: true, eligibility }
}

/** Post the storno of one verifikat unless it is already reversed. */
async function reverseIfPosted(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entry: FiscalYearReopenEntry,
): Promise<boolean> {
  try {
    await reverseEntry(supabase, companyId, userId, entry.id)
    return true
  } catch (err) {
    // A concurrent run (or the previous one) got there first: the storno
    // stands, which is what this step wants.
    if (err instanceof CannotReverseNonPostedError || err instanceof EntryAlreadyReversedError) {
      return false
    }
    throw err
  }
}

function voucherLabel(entry: FiscalYearReopenEntry): string {
  return `${entry.voucher_series ?? 'A'}${entry.voucher_number ?? ''}`
}

/**
 * Reopen the year. `confirmName` must restate the year's name and
 * `confirmNotAdopted` is the owner's statement that the årsredovisning was not
 * signed, adopted at a stämma or filed outside Accounted; both are checked in
 * the database again and recorded in audit_log.
 */
export async function reopenClosedFiscalYear(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  userId: string,
  confirmation: { confirmName: string; confirmNotAdopted: boolean },
  deps: FiscalYearReopenDeps,
): Promise<FiscalYearReopenOutcome> {
  const form = await formBlocker(supabase, companyId)
  if (form) return { ok: false, code: 'FISCAL_YEAR_REOPEN_INELIGIBLE', blockers: [form] }

  // Refresh the registry first when the gate needs it; the reopen re-reads it.
  const precheck = await gate(supabase, companyId, periodId, deps)
  if (!precheck) return { ok: false, code: 'FISCAL_YEAR_REOPEN_FAILED' }
  if (!precheck.ok) return { ok: false, code: failureCode(precheck.code) }

  const { data, error } = await supabase.rpc('reopen_closed_fiscal_year', {
    p_company_id: companyId,
    p_period_id: periodId,
    p_confirmed_name: confirmation.confirmName,
    p_confirm_not_adopted: confirmation.confirmNotAdopted,
  })
  if (error) {
    log.error('reopen RPC failed', error, { companyId, periodId })
    return { ok: false, code: 'FISCAL_YEAR_REOPEN_FAILED' }
  }
  const result = data as FiscalYearReopenRpcResult | null
  if (!result?.ok) {
    return { ok: false, code: failureCode(result?.code), blockers: result?.blockers }
  }

  // The engine's half. Each step is idempotent, so a stop anywhere resumes.
  const reversed: FiscalYearReopenEntry[] = []
  for (const entry of result.entries ?? []) {
    try {
      if (await reverseIfPosted(supabase, companyId, userId, entry)) reversed.push(entry)
    } catch (err) {
      log.error('reopen stopped on a storno; the year is open and resumable', err as Error, {
        companyId,
        periodId,
        entryId: entry.id,
        kind: entry.kind,
      })
      return { ok: false, code: 'FISCAL_YEAR_REOPEN_INCOMPLETE', stoppedAt: voucherLabel(entry) }
    }
  }

  // The closing entry is reversed by a posted storno now, the one state in
  // which enforce_opening_balance_immutability lets the period drop it.
  if (result.closing_entry_id) {
    const { error: detachError } = await supabase
      .from('fiscal_periods')
      .update({ closing_entry_id: null })
      .eq('id', periodId)
      .eq('company_id', companyId)
      .eq('closing_entry_id', result.closing_entry_id)
    if (detachError) {
      log.error('reopen could not detach the closing entry; resumable', detachError, { companyId, periodId })
      return { ok: false, code: 'FISCAL_YEAR_REOPEN_INCOMPLETE', stoppedAt: 'closing_entry_id' }
    }
  }

  const { data: period, error: readError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()
  if (readError || !period || period.is_closed || period.closing_entry_id) {
    log.error('reopen finished but the year does not read as open', readError ?? null, { companyId, periodId })
    return { ok: false, code: 'FISCAL_YEAR_REOPEN_INCOMPLETE', stoppedAt: 'verify' }
  }

  // Same transition listeners see for a plain unlock or a klarmarkera undo.
  await eventBus.emit({
    type: 'period.unlocked',
    payload: { period: period as FiscalPeriod, companyId, userId },
  })

  return {
    ok: true,
    periodName: result.period_name ?? (period as FiscalPeriod).name,
    resumed: result.resumed === true,
    reversed,
    supersededVersions: result.superseded_version_ids?.length ?? 0,
  }
}
