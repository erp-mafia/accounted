import type { SupabaseClient } from '@supabase/supabase-js'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { isCustomerReceivableAccount } from '@/lib/bookkeeping/customer-receivable-lines'
import { registrationOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { dbError } from '@/lib/errors/db-error'
import { roundOre, sumOre } from '@/lib/money'

/** Skatteverket's share of a ROT/RUT invoice (1513): never the customer's receivable. */
const ROT_RUT_RECEIVABLE = resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable')

/**
 * The öresavrundning a customer invoice's issue verifikat booked
 * (registrationOreRounding), read off the invoice row and the verifikat's
 * posted lines: 0 for a foreign invoice, one with no verifikat, one whose
 * verifikat is not posted (reversed), and one booked at the exact total
 * (every invoice issued before the issue verifikat booked the öre).
 *
 * journal_entry_id is the caller's: a credit that books its deferred original
 * first passes the verifikat it just booked.
 *
 * A kreditfaktura of the invoice books its own öresavrundning only when this
 * is not 0 (buildCreditNoteLines' companyOreRounding): it then takes off 1510
 * what the original put there. Works with the browser client (RLS) and the
 * server's. Throws on a read error.
 */
export async function readRegistrationOreRounding(
  supabase: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoice: {
    id: string
    journal_entry_id?: string | null
    /** The row's own fields when the caller holds them; otherwise they are read. */
    total?: number | string | null
    deduction_total?: number | string | null
    currency?: string | null
  },
): Promise<number> {
  if (!invoice.journal_entry_id) return 0
  const held = invoice.total != null && invoice.currency !== undefined
  // The entry first, on its own indexed columns, then its lines by id
  // (scripts/checks/lines-inner-embed.mjs).
  const [row, entry] = await Promise.all([
    held
      ? Promise.resolve({ data: invoice, error: null })
      : supabase
          .from('invoices')
          .select('total, deduction_total, currency')
          .eq('id', invoice.id)
          .eq('company_id', companyId)
          .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('id')
      .eq('id', invoice.journal_entry_id)
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .maybeSingle(),
  ])
  if (row.error) throw dbError(row.error, 'registration öresavrundning invoice')
  if (entry.error) throw dbError(entry.error, 'registration öresavrundning entry')
  const inv = row.data as { total?: number | string | null; deduction_total?: number | string | null; currency?: string | null } | null
  if (!inv || !entry.data || !isLedgerCurrency(inv.currency)) return 0
  const lines = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount')
    .eq('journal_entry_id', invoice.journal_entry_id)
  if (lines.error) throw dbError(lines.error, 'registration öresavrundning lines')
  const receivableLines = ((lines.data ?? []) as Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>)
    .filter((l) => isCustomerReceivableAccount(l.account_number) && l.account_number !== ROT_RUT_RECEIVABLE)
  if (receivableLines.length === 0) return 0
  const registered = sumOre(receivableLines.map((l) => roundOre(Number(l.debit_amount) - Number(l.credit_amount))))
  const share = Math.max(0, Number(inv.deduction_total) || 0)
  return registrationOreRounding(roundOre((Number(inv.total) || 0) - share), registered)
}
