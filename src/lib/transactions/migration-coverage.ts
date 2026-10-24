import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isBankRangeAccount } from '@/lib/transactions/booking-duplicate-detection'

/**
 * End of the company's SIE-migration data coverage: the latest entry_date
 * among posted imported verifikat. The outer bound of the quiet "från
 * perioden före din migrering" marker on inbox rows: only a row dated on or
 * before it can carry the marker, and only when the ledger also explains it
 * (fetchOpenPreMigrationRows below, crm#1239).
 *
 * Derived from journal_entries, NOT from sie_imports.fiscal_year_end: a SIE
 * file exported mid-year still declares the full fiscal year in #RAR 0, so
 * for a mid-year migrator fiscal_year_end is a FUTURE date and every new
 * bank transaction satisfied `date <= cutoff` until New Year (the 2026-08-30
 * user report). The imported vouchers themselves end where the old system's
 * data ends, which is the boundary the marker is about.
 *
 * Armed only when a completed sie_imports row exists: source_type='import'
 * is accepted from API clients too (CreateJournalEntrySchema), so without
 * the gate a third-party backfill labeled 'import' would paint a false
 * pre-migration marker across a company that never migrated. With the gate,
 * such entries can still stretch a real migrator's cutoff, but a company
 * labeling API entries 'import' post-migration is doing exactly what the
 * label says.
 *
 * The importer's omföringsverifikation (skipped-voucher adjustment) is
 * excluded by its hardcoded description prefix: it is deliberately dated at
 * fiscal year end (sie-import.ts) and would reintroduce the future-date bug
 * for any import with skipped vouchers. Excluding by description rather
 * than by its 'M' voucher series keeps genuine series-M vouchers from the
 * source file in the max (prod has companies whose files use series M for
 * ordinary vouchers, e.g. moms). Two accepted residuals: (1) bank movement
 * covered only by the omföring (skipped vouchers dated after the last
 * cleanly imported one) falls outside the cutoff and is mostly unmitigated:
 * the ledger duplicate guard only catches a single skipped movement within
 * 7 days of the omföring's fiscal-year-end date, never the mid-year or
 * aggregated-skip variants. Accepted because it needs a conjunction of
 * rare conditions, against the systematic all-year over-marking it
 * replaces. Exact closure needs skipped-voucher dates persisted at import
 * (skippedDetails in sie-import.ts has them; candidate follow-up: a
 * coverage_end column on sie_imports). (2) The exclusion keys on
 * description, which inline rättelse can edit: renaming the omföring
 * re-admits its fiscal-year-end date and degrades that one company to the
 * pre-fix over-marking, nothing worse.
 *
 * Undo/replace of an import deletes or recreates these entries, so the
 * cutoff self-corrects with no stored state to maintain. Returns null when
 * the company has no completed migration: callers render no marker.
 */
export async function fetchMigrationCoverageEnd(
  supabase: SupabaseDataClient,
  companyId: string,
): Promise<string | null> {
  const { data: completedImport } = await supabase
    .from('sie_imports')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .limit(1)
    .maybeSingle()
  if (!completedImport) return null

  const { data } = await supabase
    .from('journal_entries')
    .select('entry_date')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .eq('source_type', 'import')
    .not('description', 'like', 'Omföringsverifikation:%')
    .order('entry_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { entry_date?: string } | null)?.entry_date ?? null
}

/**
 * An open inbox row in the columns the explaining-set detector reads
 * (detectExplainingVoucherSets in lib/invoices/duplicate-payment-detection).
 */
export interface PreMigrationRow {
  id: string
  date: string
  amount: number
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}

/** The open pre-migration rows of one cash account and the ledger scope to search for them. */
export interface PreMigrationRowGroup {
  /** The ledger account the detector scans: null scans the whole bank range (1910-1949). */
  scanAccount: string | null
  rows: PreMigrationRow[]
}

/**
 * Pure: the ledger scope that can explain a row settling on `ledgerAccount`.
 *
 * A bank account (1910-1949) widens to the whole bank range: the cash
 * account's ledger mapping is set up here, after the old system booked, and
 * in production most marked rows that have a same-amount bank leg within a
 * week have it only on another bank account than the one the row is mapped
 * to (1930 against 1940). The marker claims the movement is already in the
 * imported bookkeeping, which holds on any bank account. Any other settlement account
 * (a 1686 payment provider, a 2890 card) stays exactly itself, like the
 * booking doors: a 1930 voucher never explains a card row.
 */
export function preMigrationScanAccount(ledgerAccount: string | null | undefined): string | null {
  const account = ledgerAccount?.trim() || null
  if (!account || isBankRangeAccount(account)) return null
  return account
}

type OpenRow = PreMigrationRow & { cash_account_id: string | null }

/**
 * The open inbox rows dated on or before the migration coverage end, grouped
 * per cash account with the ledger scope to search (crm#1239).
 *
 * WHY. The marker used to be date-only: every open row on or before the
 * latest imported voucher said "it most likely corresponds to an already
 * imported verifikat". The latest imported voucher is any voucher, so one
 * late customer payment stretched the window over weeks the old system never
 * booked, and rows the matcher had already found nothing for told the user
 * they were booked. The caller now asks the ledger per row, with the same
 * detector the booking doors and the reconciliation view use, and marks only
 * the rows it explains.
 *
 * One group per cash account (rows without one form their own group): the
 * detector lets a voucher explain one row per call, so separate calls keep an
 * own-account transfer explaining both of its rows, the 1930 one and the 1931
 * one. Same open-row filter as the inbox's pending fetch (not booked, not
 * ignored). A failed cash account lookup throws: the scope of a row would be
 * a guess.
 */
export async function fetchOpenPreMigrationRows(
  supabase: SupabaseDataClient,
  companyId: string,
  coverageEnd: string,
): Promise<PreMigrationRowGroup[]> {
  const rows = await fetchAllRows<OpenRow>(({ from, to }) =>
    supabase
      .from('transactions')
      .select('id, date, amount, currency, amount_sek, exchange_rate, cash_account_id')
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .is('is_business', null)
      .eq('is_ignored', false)
      .lte('date', coverageEnd)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (rows.length === 0) return []

  const ledgerByCashAccount = new Map<string, string | null>()
  if (rows.some((r) => r.cash_account_id)) {
    const { data, error } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account')
      .eq('company_id', companyId)
    if (error) throw new Error(`migration coverage: cash account lookup failed: ${error.message}`)
    for (const account of (data ?? []) as Array<{ id: string; ledger_account: string | null }>) {
      ledgerByCashAccount.set(account.id, account.ledger_account)
    }
  }

  const groups = new Map<string, PreMigrationRowGroup>()
  for (const { cash_account_id: cashAccountId, ...row } of rows) {
    const key = cashAccountId ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        scanAccount: preMigrationScanAccount(cashAccountId ? ledgerByCashAccount.get(cashAccountId) : null),
        rows: [],
      }
      groups.set(key, group)
    }
    group.rows.push({
      ...row,
      amount: Number(row.amount),
      amount_sek: row.amount_sek == null ? null : Number(row.amount_sek),
      exchange_rate: row.exchange_rate == null ? null : Number(row.exchange_rate),
    })
  }
  return Array.from(groups.values())
}
