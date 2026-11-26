import type { SupabaseClient } from '@supabase/supabase-js'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { creditNoteBookedOre, type CreditNoteVoucherLine } from '@/lib/invoices/credit-note-refund-plan'
import { dbError } from '@/lib/errors/db-error'
import { roundOre } from '@/lib/money'

/**
 * The öresavrundning a kreditfaktura's own verifikat booked
 * (creditNoteBookedOre), read off the verifikat as the ledger holds it now:
 * followed through a storno to its correction (live_journal_entry), struck
 * lines gone after an inline rättelse. The refund door and its dialog ask
 * here, so both pay back the same figure.
 *
 * Only a kronor credit note with öre in its total can have booked an
 * öresavrundning; any other costs no read. A verifikat that is not live
 * (reversed with no single correction) answers 0: the refund then pays back
 * the credit note's own figure, as it always did. Throws on a read error.
 * Browser-safe: the dialog reads with the browser client.
 */
export async function readCreditNoteBookedOre(
  supabase: Pick<SupabaseClient, 'rpc' | 'from'>,
  companyId: string,
  creditNote: {
    total: number | string | null
    currency?: string | null
    journal_entry_id?: string | null
  },
): Promise<number> {
  const total = Number(creditNote.total)
  if (!creditNote.journal_entry_id || !isKronorCurrency(creditNote.currency)) return 0
  if (!Number.isFinite(total) || Number.isInteger(roundOre(total))) return 0

  const { data: live, error } = await supabase.rpc('live_journal_entry', {
    p_company_id: companyId,
    p_entry_id: creditNote.journal_entry_id,
  })
  if (error) throw dbError(error, 'credit note verifikat')
  const liveRow = (Array.isArray(live) ? live[0] : live) as { entry_id?: string | null } | null | undefined
  const entryId = liveRow?.entry_id
  if (!entryId) return 0

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
    .eq('company_id', companyId)
    .eq('id', entryId)
    .maybeSingle()
  if (entryError) throw dbError(entryError, 'credit note verifikat lines')
  const row = entry as { status?: string; lines?: CreditNoteVoucherLine[] | null } | null
  if (!row || row.status !== 'posted') return 0
  return creditNoteBookedOre(total, row.lines ?? [])
}
