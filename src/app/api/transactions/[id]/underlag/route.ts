import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { readUnderlagFacts, type TransactionUnderlag } from '@/lib/transactions/underlag-read'

/**
 * GET /api/transactions/[id]/underlag
 *
 * The underlag a transaction has, from either door: the document pinned to
 * the row (transactions.document_id) or the inbox item the matcher paired
 * with it (invoice_inbox_items.matched_transaction_id). Returns the document
 * to show, where it came from, and the facts read off it (supplier, date,
 * totals, moms), so the review and the drawer can put the receipt next to
 * the booking and use its moms.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.underlag.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const { data: tx, error: txError } = await supabase
      .from('transactions')
      .select('id, document_id')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()
    if (txError) throw txError
    if (!tx) return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })

    const { data: item, error: itemError } = await supabase
      .from('invoice_inbox_items')
      .select('id, document_id, extracted_data, kind_hint')
      .eq('company_id', companyId)
      .eq('matched_transaction_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (itemError) throw itemError

    const documentId: string | null = tx.document_id ?? item?.document_id ?? null
    const source: TransactionUnderlag['source'] = tx.document_id ? 'pinned' : item?.document_id ? 'matched' : null

    let document: TransactionUnderlag['document'] = null
    if (documentId) {
      const { data: doc, error: docError } = await supabase
        .from('document_attachments')
        .select('id, file_name, mime_type')
        .eq('company_id', companyId)
        .eq('id', documentId)
        .maybeSingle()
      if (docError) throw docError
      document = doc ?? null
    }

    const facts = readUnderlagFacts(item?.extracted_data)
    if (facts && !facts.kind && item?.kind_hint) facts.kind = item.kind_hint

    const data: TransactionUnderlag = { source, document, inbox_item_id: item?.id ?? null, facts }
    return NextResponse.json({ data })
  },
)
