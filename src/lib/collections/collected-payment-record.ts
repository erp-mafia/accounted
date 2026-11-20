import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsCase } from '@accounted/connect-contract'
import { roundOre } from '@/lib/money'
import type { CollectionCaseRow } from './case'

/**
 * The collected-payment rows (collection_collected_payments) and how a case
 * snapshot records them. Kept apart from the booking (collected-payments.ts)
 * so the case code that reads snapshots does not load the bookkeeping.
 */

export type CollectedPaymentStatus = 'pending' | 'booked' | 'needs_review' | 'ignored'

export interface CollectedPaymentRow {
  id: string
  company_id: string
  case_id: string
  invoice_id: string
  provider_payment_ref: string
  paid_at: string
  total: number | null
  capital_paid: number
  to_creditor_other: number
  to_agency: number
  status: CollectedPaymentStatus
  invoice_payment_id: string | null
  /** The recovered kundförlust decision it was booked as, on a written-off invoice (invoice_payment_id is null then). */
  write_off_id: string | null
  journal_entry_id: string | null
  payment_record_document_id: string | null
  review_reason: string | null
  booked_by: string | null
  booked_at: string | null
  booking_lease_until: string | null
  settlement_id: string | null
  /** Earlier C vouchers the rebook reversed, oldest first. */
  rebooked_entry_ids: string[]
  created_at: string
  updated_at: string
}

export function normalizeCollectedPaymentRow(raw: Record<string, unknown>): CollectedPaymentRow {
  const row = raw as unknown as CollectedPaymentRow
  return {
    ...row,
    total: row.total === null || row.total === undefined ? null : Number(row.total),
    capital_paid: Number(row.capital_paid),
    to_creditor_other: Number(row.to_creditor_other ?? 0),
    to_agency: Number(row.to_agency ?? 0),
    write_off_id: row.write_off_id ?? null,
    rebooked_entry_ids: Array.isArray(row.rebooked_entry_ids) ? row.rebooked_entry_ids : [],
  }
}

/**
 * Store the payments the provider says it collected on a case (its own
 * list), once each. Payments without capital (fees and interest the
 * provider keeps) are not stored: nothing of them reaches the company's
 * books. Idempotent: a payment already stored is left as it is.
 */
export async function recordCollectedPayments(
  db: Pick<SupabaseClient, 'from'>,
  caseRow: Pick<CollectionCaseRow, 'id' | 'company_id' | 'invoice_id'>,
  snapshot: Pick<CollectionsCase, 'collectedPayments'>,
): Promise<number> {
  const payments = snapshot.collectedPayments.filter((p) => p.paymentRef && roundOre(p.capitalPaid) > 0)
  let stored = 0
  // One object literal per payment, so the schema guard checks every column;
  // the conflict target leaves a payment already stored as it is.
  for (const p of payments) {
    const { data, error } = await db
      .from('collection_collected_payments')
      .upsert(
        {
          company_id: caseRow.company_id,
          case_id: caseRow.id,
          invoice_id: caseRow.invoice_id,
          provider_payment_ref: p.paymentRef.slice(0, 128),
          paid_at: p.paidAt,
          total: roundOre(p.total),
          capital_paid: roundOre(p.capitalPaid),
          to_creditor_other: roundOre(p.toCreditorOther),
          to_agency: roundOre(p.toAgency),
        },
        { onConflict: 'case_id,provider_payment_ref', ignoreDuplicates: true },
      )
      .select('id')
    if (error) throw new Error(`collection_collected_payments upsert failed: ${error.message}`)
    stored += (data ?? []).length
  }
  return stored
}
