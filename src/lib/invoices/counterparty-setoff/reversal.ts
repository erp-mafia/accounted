/**
 * The set-off side of a storno of a kvittning voucher.
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) is the sanctioned way back from a
 * set-off booked by mistake. Before it posts the storno it asks
 * assertCounterpartySetoffReversible() whether the two invoices can take the
 * amount back (neither credited nor written off since); after, it calls
 * syncCounterpartySetoffAfterReversal(), which has reverse_counterparty_setoff
 * (migration 20261022130100) restore both invoices, remove the two payment
 * rows and mark the set-off reversed, in one transaction.
 *
 * Kept free of engine imports so the engine can reach it through the
 * composition seam without a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { SetoffReversalRefusedError } from './errors'

const log = createLogger('counterparty-setoff/reversal')

interface SetoffForVoucher {
  id: string
  status: 'booked' | 'reversed'
  invoice_id: string
  supplier_invoice_id: string
}

async function setoffForVoucher(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<SetoffForVoucher | null> {
  const { data, error } = await supabase
    .from('counterparty_setoffs')
    .select('id, status, invoice_id, supplier_invoice_id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .maybeSingle()
  if (error) throw new Error(`counterparty set-off: lookup by voucher failed: ${error.message}`)
  return (data as SetoffForVoucher | null) ?? null
}

const BLOCKING_INVOICE_STATUSES: ReadonlySet<string> = new Set(['written_off', 'credited', 'cancelled', 'draft'])
const BLOCKING_SUPPLIER_INVOICE_STATUSES: ReadonlySet<string> = new Set(['credited', 'reversed'])

/** Throws SetoffReversalRefusedError when an invoice of the set-off has been credited or written off since. */
export async function assertCounterpartySetoffReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const setoff = await setoffForVoucher(supabase, companyId, journalEntryId)
  // A voucher with no live set-off (its row was never written) reverses freely.
  if (!setoff || setoff.status !== 'booked') return
  const [invoiceRes, supplierRes] = await Promise.all([
    supabase.from('invoices').select('status').eq('company_id', companyId).eq('id', setoff.invoice_id).maybeSingle(),
    supabase.from('supplier_invoices').select('status').eq('company_id', companyId).eq('id', setoff.supplier_invoice_id).maybeSingle(),
  ])
  if (invoiceRes.error) throw new Error(`counterparty set-off: invoice lookup failed: ${invoiceRes.error.message}`)
  if (supplierRes.error) throw new Error(`counterparty set-off: supplier invoice lookup failed: ${supplierRes.error.message}`)
  const invoiceStatus = (invoiceRes.data as { status: string } | null)?.status
  const supplierStatus = (supplierRes.data as { status: string } | null)?.status
  if (
    !invoiceStatus ||
    !supplierStatus ||
    BLOCKING_INVOICE_STATUSES.has(invoiceStatus) ||
    BLOCKING_SUPPLIER_INVOICE_STATUSES.has(supplierStatus)
  ) {
    throw new SetoffReversalRefusedError()
  }
}

export async function syncCounterpartySetoffAfterReversal(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  storno: { id: string },
): Promise<void> {
  try {
    const setoff = await setoffForVoucher(supabase, companyId, originalEntryId)
    if (!setoff || setoff.status !== 'booked') return
    const { data, error } = await supabase.rpc('reverse_counterparty_setoff', {
      p_company_id: companyId,
      p_setoff_id: setoff.id,
      p_storno_entry_id: storno.id,
      // Honoured only for a service_role caller; a session caller is pinned
      // to its own auth.uid() by the function.
      p_user_id: userId,
    })
    if (error) throw new Error(error.message)
    const result = data as { ok?: boolean; code?: string } | null
    if (!result?.ok) throw new Error(`reverse_counterparty_setoff refused: ${result?.code ?? 'no answer'}`)
  } catch (error) {
    // The storno stands (BFL); both invoices and their payment rows now
    // disagree with it until an operator runs the reversal again.
    log.error('counterparty set-off not restored after a storno', error as Error, {
      companyId,
      originalEntryId,
      stornoEntryId: storno.id,
    })
  }
}
