import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Coverage of the invoice register (the `invoices` table) relative to the
 * company's bookkeeping. The register only holds invoices created in
 * Accounted: a company migrated mid-year (SIE import) or backfilled through
 * manual/API verifikat has real customer invoices that exist ONLY as journal
 * entries. Every surface that answers "which invoices do we have" from the
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
   * Earliest non-draft invoice_date in the register, i.e. where
   * register-backed answers start being complete. Drafts are excluded: a
   * backdated draft would move the boundary and suppress the disclosure for
   * exactly the period it exists to cover. Null when the register is empty
   * (the empty state already routes the user to migration) OR when the
   * lookup failed: null always means "unknown", never "complete".
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
const INVOICE_ENGINE_SOURCE_TYPES =
  '("invoice_created","invoice_paid","invoice_cash_payment","credit_note","reminder_fee","rot_rut_payout","storno","correction")'

const AR_ACCOUNTS = ['1510', '1513']

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
    .not('source_type', 'in', INVOICE_ENGINE_SOURCE_TYPES)
    .in('journal_entry_lines.account_number', AR_ACCOUNTS)
    .gt('journal_entry_lines.debit_amount', 0)
  if (fiscalPeriodId) query = query.eq('fiscal_period_id', fiscalPeriodId)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error) return null
  return data != null
}

export async function fetchInvoiceRegisterCoverage(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InvoiceRegisterCoverage> {
  const { data: firstInvoice, error: firstError } = await supabase
    .from('invoices')
    .select('invoice_date')
    .eq('company_id', companyId)
    .neq('status', 'draft')
    .order('invoice_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (firstError) return NO_INVOICE_REGISTER_COVERAGE

  const coversFrom = (firstInvoice as { invoice_date?: string } | null)?.invoice_date ?? null
  if (!coversFrom) return NO_INVOICE_REGISTER_COVERAGE

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
