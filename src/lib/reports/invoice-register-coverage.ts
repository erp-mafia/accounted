import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isRegisteredFromBooks } from '@/lib/bookkeeping/registered-from-books'

/**
 * Coverage of the invoice register (the `invoices` table) relative to the
 * company's bookkeeping. The register holds invoices issued in Accounted and
 * invoices registered from the books: a company migrated mid-year (SIE import)
 * or backfilled through manual/API verifikat can still have customer invoices
 * that exist ONLY as journal entries. Every surface that answers "which invoices do we have" from the
 * register alone looks complete while silently omitting that period; this
 * helper computes the disclosure those surfaces show.
 *
 * Detection is AR-based, not import-based: `fetchMigrationCoverageEnd()`
 * keys on source_type='import', which misses invoice history recreated as
 * plain manual verifikat (the 2026-09-01 user report: a full spring of
 * "Kundfakturor" with source_type='manual'). An invoice booked as a
 * verifikat DEBITS the receivable on 1510/1513, so posted pre-boundary AR
 * debit lines from outside the invoice engine are the signal. Credits are
 * deliberately not counted (a manually booked advance payment before the
 * first invoice credits 1510 and says nothing about register coverage), and
 * every invoice-engine source type is excluded, storno/correction included:
 * a rättelse of an engine entry may be re-dated before the boundary
 * (storno-service newEntryDate) and must not flag its own register invoice
 * as external. Kontantmetod invoice history booked straight against 1930
 * stays undetected; accepted, because widening to all class-3 revenue would
 * flag cash sales (webshop orders, kassa) that were never register material.
 *
 * The probe is driven from journal_entries (company-indexed) with the line
 * condition as an inner embed, never from journal_entry_lines with entry
 * filters on the embed: that inverted shape compiles to a lateral scan of
 * the whole lines table across tenants (see lib/bookkeeping/entry-lines.ts).
 */
export interface InvoiceRegisterCoverage {
  /**
   * Earliest invoice_date of a real, non-draft invoice in the register, i.e.
   * where register-backed answers start being complete. Drafts, proformas
   * and delivery notes are excluded: a backdated one would move the boundary
   * and suppress the disclosure for exactly the period it exists to cover.
   * So are invoices registered from the books (isRegisteredFromBooks): the
   * open items of an older reskontra, not the start of a complete history;
   * a register holding only those is complete from no date yet, so the
   * boundary is today. Null when the register is empty (the empty state
   * already routes the user to migration) OR when the lookup failed: null
   * always means "unknown", never "complete".
   */
  covers_from: string | null
  /**
   * True when posted non-invoice-engine verifikat carry AR (1510/1513)
   * debit lines dated before covers_from: invoices likely exist outside the
   * register for that period. False only when the probe RAN and found
   * nothing; a failed probe returns NO_INVOICE_REGISTER_COVERAGE instead,
   * so a DB error can never assert completeness.
   */
  has_pre_register_invoices: boolean
}

export const NO_INVOICE_REGISTER_COVERAGE: InvoiceRegisterCoverage = {
  covers_from: null,
  has_pre_register_invoices: false,
}

/**
 * Every source_type the invoice engine (and its correction paths) writes.
 * Pre-boundary AR debits from these are the register's own bookkeeping, not
 * evidence of register-external invoices.
 */
export const INVOICE_ENGINE_SOURCE_TYPES = [
  'invoice_created',
  'invoice_paid',
  'invoice_cash_payment',
  'credit_note',
  'reminder_fee',
  'rot_rut_payout',
  'rot_rut_reclaim',
  'customer_loss',
  'counterparty_setoff',
  'rot_rut_reclassification',
  'storno',
  'correction',
] as const

/** PostgREST `in` literal for the NOT-IN filter. */
const INVOICE_ENGINE_SOURCE_TYPES_FILTER =
  '(' + INVOICE_ENGINE_SOURCE_TYPES.map((t) => `"${t}"`).join(',') + ')'

/** The receivables an invoice verifikat debits (SE pack: 1510, and 1513 for a ROT/RUT invoice's Skatteverket share). */
const AR_ACCOUNTS = [
  resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable'),
  resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable'),
]

/**
 * True when a posted, non-engine verifikat with an AR debit line exists
 * before `coversFrom`. Optionally scoped to one fiscal period (used by the
 * 1510 reconciliation, which compares period-scoped balances: a settled
 * pre-boundary residual in an EARLIER period cannot explain this period's
 * difference and must not be offered as an explanation).
 * Returns null when the probe itself failed (unknown, not false).
 */
async function probePreRegisterArDebits(
  supabase: SupabaseClient,
  companyId: string,
  coversFrom: string,
  fiscalPeriodId?: string,
): Promise<boolean | null> {
  let query = supabase
    .from('journal_entries')
    .select('id, journal_entry_lines!inner(id)')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .lt('entry_date', coversFrom)
    .not('source_type', 'in', INVOICE_ENGINE_SOURCE_TYPES_FILTER)
    .in('journal_entry_lines.account_number', AR_ACCOUNTS)
    .gt('journal_entry_lines.debit_amount', 0)
  if (fiscalPeriodId) query = query.eq('fiscal_period_id', fiscalPeriodId)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error) return null
  return data != null
}

/** The real, non-draft invoices of the register, selecting `columns`. */
function registerInvoices(supabase: SupabaseClient, companyId: string, columns: string) {
  return supabase
    .from('invoices')
    .select(columns)
    .eq('company_id', companyId)
    .neq('status', 'draft')
    // Proformas and delivery notes are not register invoices (no AR posting);
    // an early one would move the boundary without covering anything.
    .eq('document_type', 'invoice')
}

interface FirstInvoiceRow {
  invoice_date?: string | null
  journal_entry_id?: string | null
  invoice_items?: unknown[] | null
}

/**
 * The earliest invoice_date among invoices NOT registered from the books:
 * unlinked (kontantmetoden, deferred booking, an unlinked migrated invoice)
 * or with lines. Null when there is none; undefined when a lookup failed.
 */
async function earliestCompleteInvoiceDate(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null | undefined> {
  const [unlinked, withLines] = await Promise.all([
    registerInvoices(supabase, companyId, 'invoice_date')
      .is('journal_entry_id', null)
      .order('invoice_date', { ascending: true })
      .limit(1)
      .maybeSingle(),
    registerInvoices(supabase, companyId, 'invoice_date, invoice_items!inner(id)')
      .order('invoice_date', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])
  if (unlinked.error || withLines.error) return undefined
  const dates = [unlinked.data, withLines.data]
    .map((row) => (row as { invoice_date?: string | null } | null)?.invoice_date)
    .filter((date): date is string => typeof date === 'string' && date !== '')
  return dates.length > 0 ? dates.sort()[0] : null
}

export async function fetchInvoiceRegisterCoverage(
  supabase: SupabaseClient,
  companyId: string,
  options: { today?: string } = {},
): Promise<InvoiceRegisterCoverage> {
  const { data: firstInvoice, error: firstError } = await registerInvoices(
    supabase,
    companyId,
    'invoice_date, journal_entry_id, invoice_items(id)',
  )
    .order('invoice_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (firstError) return NO_INVOICE_REGISTER_COVERAGE

  const first = firstInvoice as FirstInvoiceRow | null
  let coversFrom = first?.invoice_date ?? null
  if (!first || !coversFrom) return NO_INVOICE_REGISTER_COVERAGE

  // The earliest invoice is an open item registered from an older
  // reskontra: completeness starts at the first invoice the register holds
  // its whole history for, or nowhere yet. One the provider migration linked
  // but could not give lines reads the same way, which only widens the
  // disclosure.
  if (isRegisteredFromBooks(first, first.invoice_items)) {
    const complete = await earliestCompleteInvoiceDate(supabase, companyId)
    if (complete === undefined) return NO_INVOICE_REGISTER_COVERAGE
    coversFrom = complete ?? options.today ?? todayIsoStockholm()
  }

  const hasPreRegister = await probePreRegisterArDebits(supabase, companyId, coversFrom)
  // Probe failure means UNKNOWN: never report a confident "complete".
  if (hasPreRegister === null) return NO_INVOICE_REGISTER_COVERAGE

  return {
    covers_from: coversFrom,
    has_pre_register_invoices: hasPreRegister,
  }
}

/**
 * Period-scoped variant for the 1510/1513 reconciliation: does pre-boundary
 * non-engine AR debit activity exist INSIDE the given fiscal period? Only
 * then may the reconciliation offer "migrated/backfilled invoices" as an
 * explanation for its difference. Returns false on any lookup failure (no
 * explanation is the safe degrade: the red badge stands unqualified).
 */
export async function hasPreRegisterArInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const coverage = await fetchInvoiceRegisterCoverage(supabase, companyId)
  if (!coverage.has_pre_register_invoices || !coverage.covers_from) return false
  const inPeriod = await probePreRegisterArDebits(
    supabase,
    companyId,
    coverage.covers_from,
    fiscalPeriodId,
  )
  return inPeriod === true
}
