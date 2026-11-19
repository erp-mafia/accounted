/**
 * A key's categorization that a booking review rule matches is staged, never
 * booked (accounted#130 step 2): the v1 categorize door answers 202 with a
 * categorize_transaction pending operation instead of a refusal, the same
 * operation MCP's gnubok_categorize_transaction stages, so a person approves
 * it in the app (the approval gate makes that web-only).
 *
 * Staged from the booking's dry run, so the approver sees the exact lines.
 * A booking the staged operation cannot carry (a catalog or learned
 * template named by id) is not staged: the door answers the refusal, and the
 * client stages it through MCP or a person books it in the app.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { insertStagedOperation, type StagedOperationInserted } from '@/lib/pending-operations/stage'
import { categorizeTransaction, type CategorizeInput } from '@/lib/transactions/categorize-core'
import type { PendingOperationActorType } from '@/types'

export async function stageBlockedCategorization(
  supabase: SupabaseClient,
  input: {
    companyId: string
    userId: string
    transactionId: string
    booking: CategorizeInput
    actor: { type: PendingOperationActorType; id?: string | null; label?: string | null }
    log: Logger
  },
): Promise<StagedOperationInserted | null> {
  const { booking } = input
  if (booking.template_id || booking.counterparty_template_id) return null
  const dry = await categorizeTransaction(supabase, input.userId, input.companyId, input.transactionId, booking, {
    dryRun: true,
    onBooked: 'refuse',
    invoiceMatchIntercept: false,
    reverseChargeBoxParam: 'reverse_charge_kind',
    log: input.log,
  })
  if (!dry.ok || !dry.dryRun) return null
  const { preview } = dry
  const tx = preview.transaction
  const category = booking.is_business ? (booking.category ?? preview.category) : 'private'
  const reverseChargeKind = booking.reverse_charge_kind ?? preview.reverse_charge_kind
  return insertStagedOperation(
    supabase,
    {
      companyId: input.companyId,
      userId: input.userId,
      operationType: 'categorize_transaction',
      title: `Kategorisera: ${tx.merchant_name || tx.description || 'Transaktion'} ${tx.amount} ${tx.currency}`,
      params: {
        transaction_id: input.transactionId,
        category,
        vat_treatment: booking.vat_treatment ?? null,
        ...(reverseChargeKind ? { reverse_charge_kind: reverseChargeKind } : {}),
        vat_amount: booking.vat_amount ?? null,
        account_override: booking.account_override ?? null,
        notes: booking.notes?.trim() ? booking.notes.trim() : null,
        ...(booking.dimensions && Object.keys(booking.dimensions).length > 0 ? { dimensions: booking.dimensions } : {}),
        allow_duplicate: booking.allow_duplicate === true,
        ...(booking.confirm_foreign_seller_vat === true ? { confirm_foreign_seller_vat: true } : {}),
        ...(booking.proposal_id ? { proposal_id: booking.proposal_id.slice(0, 200) } : {}),
      },
      previewData: {
        debit_account: preview.mappingResult.debit_account,
        credit_account: preview.mappingResult.credit_account,
        ...(booking.account_override ? { account_override: booking.account_override } : {}),
        amount: Math.abs(tx.amount),
        currency: tx.currency,
        date: tx.date,
        lines: preview.lines.map((l) => ({
          account_number: l.account_number,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
          description: l.line_description ?? '',
        })),
        vat_lines: preview.mappingResult.vat_lines.map((v) => ({
          account_number: v.account_number,
          debit_amount: v.debit_amount,
          credit_amount: v.credit_amount,
          description: v.description,
        })),
        category: preview.category,
        underlag: preview.underlag ?? null,
        booking_review: { staged_because: 'booking_review_rule' },
      },
      actor: input.actor,
      dateForPeriodCheck: tx.date,
    },
    input.log,
  )
}
