/**
 * Pairs a human said no to.
 *
 * A "no" from any surface (a manual "Avbryt matchning", a rejected proposal,
 * a picker that offered the pair and got a different answer) retires that one
 * pairing without retiring the document or the purchase. The receipt hunt
 * already respected rejections recorded through pending_operations; this
 * table is the durable home for the rest, and the matcher consults both.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { pairKey } from '@/lib/receipt-hunt/select'
import { createLogger } from '@/lib/logger'

const log = createLogger('underlag/rejections')

export type RejectionSource = 'unmatch' | 'proposal_rejected' | 'picker'

export interface RecordRejectionInput {
  companyId: string
  userId: string
  documentId: string
  transactionId: string
  source: RejectionSource
}

/**
 * Remember that this document does not belong to this transaction.
 *
 * Idempotent: the pair is unique per company, and a second "no" changes
 * nothing. Best-effort by contract: callers are on a path the user already
 * completed (the unmatch itself), so a failure here is logged, never raised.
 */
export async function recordMatchRejection(
  supabase: SupabaseClient,
  input: RecordRejectionInput,
): Promise<void> {
  const { error } = await supabase.from('document_match_rejections').upsert(
    {
      company_id: input.companyId,
      user_id: input.userId,
      document_id: input.documentId,
      transaction_id: input.transactionId,
      source: input.source,
    },
    { onConflict: 'company_id,document_id,transaction_id', ignoreDuplicates: true },
  )
  if (error) {
    log.error('failed to record rejection', { message: error.message, ...input })
  }
}

/** Every rejected pair for a company, keyed like the hunt's suppression sets. */
export async function fetchRejectedPairs(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ document_id: string; transaction_id: string }>((range) =>
    supabase
      .from('document_match_rejections')
      .select('document_id, transaction_id')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  const pairs = new Set<string>()
  for (const row of rows) pairs.add(pairKey(row.transaction_id, row.document_id))
  return pairs
}
