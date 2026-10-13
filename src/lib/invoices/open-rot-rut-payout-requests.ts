import type { SupabaseClient } from '@supabase/supabase-js'
import {
  OPEN_ROT_RUT_PAYOUT_STATUSES,
  type RotRutPayoutRequestCandidate,
} from '@/lib/invoices/rot-rut-payout-matching'

/** An open ROT/RUT begäran with the invoices it covers, so the user sees
 *  which fakturor the payout settles. */
export interface OpenRotRutPayoutRequest extends RotRutPayoutRequestCandidate {
  invoices: Array<{ invoice_number: string | null; requested_amount: number | string }>
}

type OpenRequestRow = RotRutPayoutRequestCandidate & {
  items?: Array<{
    requested_amount: number | string
    invoice?: { invoice_number: string | null } | { invoice_number: string | null }[] | null
  }> | null
}

/**
 * The company's open begäran om utbetalning, newest first: the requests that
 * can still absorb Skatteverkets payout (an open status and no settlement
 * voucher). The one read behind the transactions list's ROT/RUT match hints
 * and the invoice picker's manual fallback, which each wrote it out before.
 * A handful of rows per company. A failed read answers no requests with the
 * error, for the caller to log: neither surface stops rendering on it.
 */
export async function loadOpenRotRutPayoutRequests(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ requests: OpenRotRutPayoutRequest[]; error: { message: string } | null }> {
  const { data, error } = await supabase
    .from('rot_rut_payout_requests')
    .select(
      'id, name, deduction_type, status, requested_total, decided_total, settlement_journal_entry_id, items:rot_rut_payout_request_items(requested_amount, invoice:invoices(invoice_number))',
    )
    .eq('company_id', companyId)
    .in('status', [...OPEN_ROT_RUT_PAYOUT_STATUSES])
    .is('settlement_journal_entry_id', null)
    .order('created_at', { ascending: false })
  if (error) return { requests: [], error }
  const requests = ((data as OpenRequestRow[] | null) ?? []).map((req) => ({
    id: req.id,
    name: req.name,
    deduction_type: req.deduction_type,
    status: req.status,
    requested_total: req.requested_total,
    decided_total: req.decided_total,
    settlement_journal_entry_id: req.settlement_journal_entry_id,
    invoices: (req.items ?? []).map((item) => {
      const invoice = Array.isArray(item.invoice) ? item.invoice[0] : item.invoice
      return { invoice_number: invoice?.invoice_number ?? null, requested_amount: item.requested_amount }
    }),
  }))
  return { requests, error: null }
}
