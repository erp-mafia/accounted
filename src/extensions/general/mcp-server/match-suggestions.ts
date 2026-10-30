import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'

/**
 * Accounted's own match suggestion on an unbooked bank row (crm#1510).
 *
 * The invoice matchers write a pointer (potential_supplier_invoice_id,
 * potential_invoice_id) and the bank matcher another
 * (potential_journal_entry_id); Att göra shows them to a person as the
 * match to approve. gnubok_list_uncategorized_transactions read none of
 * them, so an agent saw the row without its suggestion, called the supplier
 * invoice it paid overdue and staged its own booking beside Accounted's.
 *
 * A pointer is a suggestion only while its target is still open: an invoice
 * paid or credited since (the pointer is cleared on settlement, but not on
 * every path) or a verifikat that is no longer posted is left out.
 */

export interface SuggestionPointerRow {
  id: string
  potential_supplier_invoice_id?: string | null
  potential_invoice_id?: string | null
  potential_journal_entry_id?: string | null
  potential_match_confidence?: number | string | null
}

export type SuggestedMatch =
  | { kind: 'supplier_invoice'; supplier_invoice_id: string; invoice_number: string | null; remaining_amount: number | null }
  | { kind: 'customer_invoice'; invoice_id: string; invoice_number: string | null; remaining_amount: number | null }
  | { kind: 'journal_entry'; journal_entry_id: string; voucher: string | null; confidence: number | null }

// The statuses the match routes accept (match-supplier-invoice and
// match-invoice): anything else is settled, credited or not yet sent.
const OPEN_SUPPLIER_STATUSES = new Set(['registered', 'approved', 'partially_paid', 'overdue'])
const OPEN_CUSTOMER_STATUSES = new Set(['sent', 'overdue', 'partially_paid'])

/** The SELECT columns the pointers live in, to add to a transactions read. */
export const SUGGESTION_POINTER_COLUMNS =
  'potential_supplier_invoice_id, potential_invoice_id, potential_journal_entry_id, potential_match_confidence'

const amountOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))

/**
 * One read per pointer kind for the whole page, only for the kinds a row on
 * the page carries. A supplier invoice wins over a customer invoice, and an
 * invoice over a verifikat, as on the Att göra card. Throws on a failed read:
 * a silently missing suggestion is the bug this exists to fix.
 */
export async function loadSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly SuggestionPointerRow[],
): Promise<Map<string, SuggestedMatch>> {
  const out = new Map<string, SuggestedMatch>()
  const ids = (key: 'potential_supplier_invoice_id' | 'potential_invoice_id' | 'potential_journal_entry_id') => [
    ...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string' && v.length > 0)),
  ]
  const supplierIds = ids('potential_supplier_invoice_id')
  const invoiceIds = ids('potential_invoice_id')
  const entryIds = ids('potential_journal_entry_id')

  const suppliers = new Map<string, { supplier_invoice_number: string | null; remaining_amount: unknown }>()
  if (supplierIds.length > 0) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, remaining_amount, status')
      .eq('company_id', companyId)
      .in('id', supplierIds)
    if (error) throw dbError(error)
    for (const s of (data ?? []) as Array<{ id: string; supplier_invoice_number: string | null; remaining_amount: unknown; status: string }>) {
      if (OPEN_SUPPLIER_STATUSES.has(s.status)) suppliers.set(s.id, s)
    }
  }

  const invoices = new Map<string, { invoice_number: string | null; remaining_amount: unknown }>()
  if (invoiceIds.length > 0) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, remaining_amount, status')
      .eq('company_id', companyId)
      .in('id', invoiceIds)
    if (error) throw dbError(error)
    for (const i of (data ?? []) as Array<{ id: string; invoice_number: string | null; remaining_amount: unknown; status: string }>) {
      if (OPEN_CUSTOMER_STATUSES.has(i.status)) invoices.set(i.id, i)
    }
  }

  const entries = new Map<string, { voucher_series: string | null; voucher_number: number | null }>()
  if (entryIds.length > 0) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, status')
      .eq('company_id', companyId)
      .in('id', entryIds)
    if (error) throw dbError(error)
    for (const e of (data ?? []) as Array<{ id: string; voucher_series: string | null; voucher_number: number | null; status: string }>) {
      if (e.status === 'posted') entries.set(e.id, e)
    }
  }

  for (const row of rows) {
    const si = row.potential_supplier_invoice_id ? suppliers.get(row.potential_supplier_invoice_id) : undefined
    if (si && row.potential_supplier_invoice_id) {
      out.set(row.id, {
        kind: 'supplier_invoice',
        supplier_invoice_id: row.potential_supplier_invoice_id,
        invoice_number: si.supplier_invoice_number ?? null,
        remaining_amount: amountOrNull(si.remaining_amount),
      })
      continue
    }
    const inv = row.potential_invoice_id ? invoices.get(row.potential_invoice_id) : undefined
    if (inv && row.potential_invoice_id) {
      out.set(row.id, {
        kind: 'customer_invoice',
        invoice_id: row.potential_invoice_id,
        invoice_number: inv.invoice_number ?? null,
        remaining_amount: amountOrNull(inv.remaining_amount),
      })
      continue
    }
    const je = row.potential_journal_entry_id ? entries.get(row.potential_journal_entry_id) : undefined
    if (je && row.potential_journal_entry_id) {
      out.set(row.id, {
        kind: 'journal_entry',
        journal_entry_id: row.potential_journal_entry_id,
        voucher: je.voucher_number ? formatVoucher(je) : null,
        confidence: amountOrNull(row.potential_match_confidence),
      })
    }
  }
  return out
}
