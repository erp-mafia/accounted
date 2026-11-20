/**
 * The decision-side mirror of a storno of a kundförlust voucher.
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) is the sanctioned way back from a
 * kundförlust decision booked by mistake. Before it posts the storno it asks
 * assertCustomerLossReversible() whether the voucher is the invoice's latest
 * live decision (a konstaterad write-off with a recovery after it is undone
 * recovery first); after, syncCustomerLossAfterReversal() records the
 * annulment, which gives a written-off invoice its open status back and makes
 * the momsdeklaration add the ruta 05 base back in the storno's period.
 *
 * Kept free of engine imports so the engine can import it without a cycle
 * (the services import the engine).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { liveRows } from './amounts'
import { CustomerLossReversalRefusedError } from './errors'
import { decisionId } from './ids'
import { loadWriteOffRows, type WriteOffRow } from './state'
import { recordInvoiceWriteOff } from './write-off-rpc'

const log = createLogger('customer-loss/reversal')

async function decisionForVoucher(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<{ row: WriteOffRow; rows: WriteOffRow[] } | null> {
  const { data, error } = await supabase
    .from('invoice_write_offs')
    .select('invoice_id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .neq('kind', 'annulled')
    .maybeSingle()
  if (error) throw new Error(`customer loss: decision lookup by voucher failed: ${error.message}`)
  if (!data) return null
  const rows = await loadWriteOffRows(supabase, companyId, data.invoice_id as string)
  const row = rows.find((r) => r.journal_entry_id === journalEntryId && r.kind !== 'annulled')
  return row ? { row, rows } : null
}

/** Throws CustomerLossReversalRefusedError when a later live decision stands on the invoice. */
export async function assertCustomerLossReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const found = await decisionForVoucher(supabase, companyId, journalEntryId)
  // A voucher with no decision (its row was never recorded) reverses freely.
  if (!found) return
  const later = liveRows(found.rows).some(
    (r) => r.id !== found.row.id && r.decided_at > found.row.decided_at,
  )
  if (later) throw new CustomerLossReversalRefusedError()
}

export async function syncCustomerLossAfterReversal(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  storno: { id: string; entry_date: string },
): Promise<void> {
  try {
    const found = await decisionForVoucher(supabase, companyId, originalEntryId)
    if (!found) return
    const { row, rows } = found
    const ordinal = rows.filter((r) => r.kind === 'annulled').length
    const { error } = await recordInvoiceWriteOff(companyId, userId, {
      p_id: await decisionId(row.invoice_id, 'annulled', ordinal),
      p_invoice_id: row.invoice_id,
      p_kind: 'annulled',
      p_entry_date: storno.entry_date,
      p_amount: row.amount,
      p_net_amount: row.net_amount,
      p_vat_amount: row.vat_amount,
      p_vat_by_rate: row.vat_by_rate,
      p_reserve_released: row.reserve_released,
      p_journal_entry_id: storno.id,
      p_evidence_document_id: null,
      p_reason: 'Verifikationen återförd (storno)',
      p_case_id: null,
      p_reverses_id: row.id,
    })
    if (error) throw new Error(error.message)
  } catch (error) {
    // The storno stands (BFL); the decision row and the invoice status now
    // disagree with it until an operator records the annulment.
    log.error('customer loss annulment not recorded after a storno', error as Error, {
      companyId,
      originalEntryId,
      stornoEntryId: storno.id,
    })
  }
}
