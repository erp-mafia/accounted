import type { SupabaseClient } from '@supabase/supabase-js'
import {
  runReconciliation,
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
  type ReconciliationOptions,
} from './bank-reconciliation'
import { createLogger } from '@/lib/logger'

const log = createLogger('reconciliation.unattended-sweep')

/** Per-account outcome of one unattended sweep. */
export interface SweepAccountResult {
  /** null on the legacy fallback run for companies with no cash_accounts rows. */
  cashAccountId: string | null
  accountNumber: string
  currency: string
  /** Matches auto-linked at or above the unattended confidence floor. */
  applied: number
  /** Apply failures (optimistic-lock conflicts, DB errors) plus a whole-account
   *  run failure, which counts as 1 without aborting the other accounts. */
  errors: number
  /** Matches proposed below the floor: candidate suggestions for human review. */
  skippedBelowThreshold: number
  /** Below-floor matches persisted onto potential_journal_entry_id. */
  suggested: number
  /** Unmatched transactions the run considered on this account. */
  candidates: number
  /** Total matches the matcher proposed for this account. */
  proposed: number
}

export interface UnattendedSweepResult {
  accounts: SweepAccountResult[]
  applied: number
  errors: number
  skippedBelowThreshold: number
  suggested: number
  /** Candidate transactions the sweep left neither linked nor suggested. */
  unmatched: number
}

export interface UnattendedSweepOptions {
  dateFrom?: string
  dateTo?: string
  /**
   * Confidence floor for auto-apply. Defaults to
   * DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD: these sweeps run with nobody
   * reviewing a dry-run first, so fuzzy / date-range matches must never be
   * committed automatically.
   */
  confidenceThreshold?: number
  /**
   * Persist the below-floor band as reviewable suggestions (default true:
   * every unattended caller feeds the "Granska migrerad historik" surface).
   */
  persistSuggestions?: boolean
}

/**
 * The JSONB stamped on bank_connections.last_sie_sweep /
 * bank_file_imports.sie_sweep so the UI can render the sweep outcome without
 * recomputing. snake_case: it lives in the DB and crosses the API boundary.
 */
export interface SieSweepSummary {
  auto_linked: number
  suggested: number
  unmatched: number
  /**
   * Apply/run failures across the sweep. NOT decoration: a whole-account run
   * that threw contributes 0 candidates, so its transactions are absent from
   * `unmatched` too. errors > 0 means the other three numbers describe an
   * INCOMPLETE sweep, and any UI reading this summary must not present it as
   * "all done".
   */
  errors: number
  date_from: string | null
  date_to: string | null
  ran_at: string
}

export function toSweepSummary(
  result: UnattendedSweepResult,
  options: { dateFrom?: string; dateTo?: string } = {},
): SieSweepSummary {
  return {
    auto_linked: result.applied,
    suggested: result.suggested,
    unmatched: result.unmatched,
    errors: result.errors,
    date_from: options.dateFrom ?? null,
    date_to: options.dateTo ?? null,
    ran_at: new Date().toISOString(),
  }
}

/**
 * Run the unattended post-sync reconciliation sweep once per cash account
 * instead of once per company (issue #1298).
 *
 * The pooled form (`runReconciliation` with no cashAccountId) filtered the
 * transaction side by currency alone while the GL side stayed on '1930', so a
 * company with two same-currency accounts (checking 1930 + savings 1931) could
 * auto-link a savings transaction to an unlinked 1930 voucher and persist a
 * wrong journal_entry_id. Only a log warning guarded it
 * (warnIfUnscopedAcrossCashAccounts). Here every enabled cash account gets its
 * own scoped run: its BAS code on the GL side, its cash_account_id on the
 * transaction side, and NULL-cash_account_id rows claimed only by the primary
 * account (same rule as Bankavstamning).
 *
 * Companies with no cash_accounts rows at all keep the legacy single
 * 1930/SEK run: with no rows there is no per-account scope to apply, and
 * scopeTransactionsToAccount's currency-only path is the supported mode there.
 *
 * One account's run failing (thrown) is counted as one error on that account
 * and the sweep continues: an unattended sweep must not let one broken account
 * block matching on the others. The initial cash_accounts lookup failing throws
 * instead: silently degrading to the pooled run would re-create exactly the
 * cross-linking this helper exists to remove (same fail-closed contract as
 * resolveCashAccountScope).
 */
export async function runUnattendedReconciliationSweep(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  options: UnattendedSweepOptions = {},
): Promise<UnattendedSweepResult> {
  const { dateFrom, dateTo, persistSuggestions = true } = options
  const confidenceThreshold =
    options.confidenceThreshold ?? DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD

  const { data: cashAccounts, error } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account, currency, is_primary')
    .eq('company_id', companyId)
    .eq('enabled', true)
    .order('ledger_account')

  if (error) {
    throw new Error('Kunde inte hämta kassakonton för avstämningssvepet')
  }

  type Scope = {
    cashAccountId: string | null
    accountNumber: string
    currency: string
    includeUnassigned: boolean
  }

  const rows = (cashAccounts ?? []) as Array<{
    id: string
    ledger_account: string
    currency: string | null
    is_primary: boolean | null
  }>

  const scopes: Scope[] =
    rows.length > 0
      ? rows.map((row) => ({
          cashAccountId: row.id,
          accountNumber: row.ledger_account,
          currency: row.currency ?? 'SEK',
          includeUnassigned: Boolean(row.is_primary),
        }))
      : [
          {
            cashAccountId: null,
            accountNumber: '1930',
            currency: 'SEK',
            includeUnassigned: true,
          },
        ]

  const accounts: SweepAccountResult[] = []

  for (const scope of scopes) {
    const runOptions: ReconciliationOptions = {
      dateFrom,
      dateTo,
      accountNumber: scope.accountNumber,
      currency: scope.currency,
      cashAccountId: scope.cashAccountId ?? undefined,
      includeUnassigned: scope.includeUnassigned,
      confidenceThreshold,
      persistSuggestions,
    }
    try {
      const result = await runReconciliation(supabase, companyId, userId, runOptions)
      accounts.push({
        cashAccountId: scope.cashAccountId,
        accountNumber: scope.accountNumber,
        currency: scope.currency,
        applied: result.applied,
        errors: result.errors,
        skippedBelowThreshold: result.skippedBelowThreshold,
        suggested: result.suggested,
        candidates: result.candidates,
        proposed: result.matches.length,
      })
    } catch (err) {
      log.warn('per-account sweep run failed; continuing with remaining accounts', {
        companyId,
        entityType: 'cash_account',
        details: {
          accountNumber: scope.accountNumber,
          cashAccountId: scope.cashAccountId,
          message: err instanceof Error ? err.message : String(err),
        },
      })
      accounts.push({
        cashAccountId: scope.cashAccountId,
        accountNumber: scope.accountNumber,
        currency: scope.currency,
        applied: 0,
        errors: 1,
        skippedBelowThreshold: 0,
        suggested: 0,
        candidates: 0,
        proposed: 0,
      })
    }
  }

  const applied = accounts.reduce((sum, a) => sum + a.applied, 0)
  const suggested = accounts.reduce((sum, a) => sum + a.suggested, 0)
  const candidates = accounts.reduce((sum, a) => sum + a.candidates, 0)

  return {
    accounts,
    applied,
    errors: accounts.reduce((sum, a) => sum + a.errors, 0),
    skippedBelowThreshold: accounts.reduce((sum, a) => sum + a.skippedBelowThreshold, 0),
    suggested,
    unmatched: Math.max(0, candidates - applied - suggested),
  }
}
