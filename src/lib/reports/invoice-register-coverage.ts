import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'

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
 * One read answers it: get_invoice_register_coverage
 * (supabase/migrations/20261023094000_invoice_register_coverage_rpc.sql). The
 * boundary walk stops at the first complete invoice instead of embedding
 * every invoice's lines, and the probe is driven from journal_entries
 * (company-indexed) with the line condition as an EXISTS, never from
 * journal_entry_lines with entry filters: that inverted shape scans the whole
 * lines table across tenants (see lib/bookkeeping/entry-lines.ts).
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

/** The receivables an invoice verifikat debits (SE pack: 1510, and 1513 for a ROT/RUT invoice's Skatteverket share). */
const AR_ACCOUNTS = [
  resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable'),
  resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable'),
]

interface CoverageRpcResult {
  covers_from: string | null
  has_pre_register_invoices: boolean
  pre_register_in_period: boolean
}

/**
 * The coverage read. The boundary (covers_from) is the earliest invoice_date
 * of a real, non-draft register invoice that is not registered from the
 * books (isRegisteredFromBooks: unlinked, or with lines); a register holding
 * only registrations is complete from no date yet, so the boundary is today.
 * The probe asks whether a posted, non-engine verifikat with an AR debit line
 * exists before the boundary, and, with a fiscal period, whether one exists
 * inside it. Null when the read failed: unknown, never "complete".
 */
async function readCoverage(
  supabase: SupabaseDataClient,
  companyId: string,
  today: string,
  fiscalPeriodId?: string,
): Promise<CoverageRpcResult | null> {
  const { data, error } = await supabase.rpc('get_invoice_register_coverage', {
    p_company_id: companyId,
    p_ar_accounts: AR_ACCOUNTS,
    p_engine_source_types: [...INVOICE_ENGINE_SOURCE_TYPES],
    p_today: today,
    p_fiscal_period_id: fiscalPeriodId ?? null,
  })
  if (error || !data) return null
  return data as CoverageRpcResult
}

export async function fetchInvoiceRegisterCoverage(
  supabase: SupabaseDataClient,
  companyId: string,
  options: { today?: string } = {},
): Promise<InvoiceRegisterCoverage> {
  const coverage = await readCoverage(supabase, companyId, options.today ?? todayIsoStockholm())
  // Null covers_from is the empty register (the empty state already routes
  // the user to migration); a failed read is unknown. Neither asserts
  // completeness.
  if (!coverage?.covers_from) return NO_INVOICE_REGISTER_COVERAGE
  return {
    covers_from: coverage.covers_from,
    has_pre_register_invoices: coverage.has_pre_register_invoices === true,
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
  supabase: SupabaseDataClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const coverage = await readCoverage(supabase, companyId, todayIsoStockholm(), fiscalPeriodId)
  if (!coverage?.covers_from || coverage.has_pre_register_invoices !== true) return false
  return coverage.pre_register_in_period === true
}
