/**
 * Konstaterad kundförlust (build spec 4.2 G, product decision F3).
 *
 * The claim leaves the books: Dr 6351 for the open part net of VAT, Dr the
 * output VAT accounts for the open VAT per account (ML 8 kap 16 § lowers the
 * beskattningsunderlag, 7 kap 43 § the output tax, in the period the loss is
 * booked under god redovisningssed, 7 kap 44 §), Cr 1510 for the open part,
 * and any befarad reserve still held comes back (Dr 1519 / Cr 6352). The
 * invoice becomes 'written_off'. The momsdeklaration lowers ruta 05 by the
 * recorded per-rate bases (lib/reports/vat-declaration.ts).
 *
 * A konstaterad loss needs evidence that the customer cannot pay
 * (konkursbesked, beslut från Kronofogden, ...): BFL 5 kap 6 § underlag. The
 * document is linked to the voucher, which also keeps it from deletion for
 * the retention period.
 *
 * Under kontantmetoden an invoice that never reached the ledger as a fordran
 * gets no voucher: nothing was booked, no VAT was reported. The decision and
 * the status are still recorded.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { linkBasisColumns } from '@/lib/links/stamp'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { confirmedLines, totalVat, vatSharesOfPart, type VatShare } from './amounts'
import { openClaimRefusal } from './eligibility'
import type { CustomerLossOutcome } from './errors'
import { bookDecision } from './record'
import { loadCustomerLossState, type CustomerLossState } from './state'
import type { CreateJournalEntryLineInput } from '@/types'
import { decisionDescription, invoiceLabel } from './text'

const log = createLogger('customer-loss/confirmed')

export interface ConfirmedPlan {
  amount: number
  net: number
  vat: number
  shares: VatShare[]
  reserveReleased: number
  /** null: a never-booked kontantmetod invoice, no voucher. */
  lines: CreateJournalEntryLineInput[] | null
}

/** What a konstaterad decision books for an open claim that passed openClaimRefusal(). */
export function planConfirmed(state: CustomerLossState): ConfirmedPlan {
  const amount = state.invoice.remaining_amount
  if (!state.booked) {
    return { amount, net: amount, vat: 0, shares: [], reserveReleased: 0, lines: null }
  }
  const shares = vatSharesOfPart(state.openVat, state.basis, amount)
  const vat = totalVat(shares)
  return {
    amount,
    net: roundOre(amount - vat),
    vat,
    shares,
    reserveReleased: state.reserve,
    lines: confirmedLines({
      amount,
      shares,
      reserve: state.reserve,
      receivableAccount: state.receivableAccount,
      tag: invoiceLabel(state.invoice),
    }),
  }
}

export interface RecordConfirmedLossParams {
  invoiceId: string
  entryDate: string
  reason: string
  evidenceDocumentId: string | null | undefined
  decidedBy: string
}

export async function recordConfirmedLoss(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: RecordConfirmedLossParams,
): Promise<CustomerLossOutcome> {
  if (!params.evidenceDocumentId) return { ok: false, code: 'CUSTOMER_LOSS_EVIDENCE_REQUIRED' }

  const { data: evidence, error: evidenceError } = await supabase
    .from('document_attachments')
    .select('id, journal_entry_id')
    .eq('company_id', companyId)
    .eq('id', params.evidenceDocumentId)
    .maybeSingle()
  if (evidenceError) throw new Error(`customer loss: evidence lookup failed: ${evidenceError.message}`)
  if (!evidence) return { ok: false, code: 'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND' }

  const loaded = await loadCustomerLossState(supabase, companyId, params.invoiceId)
  if (!loaded.ok) return loaded
  const { state } = loaded
  const refusal = openClaimRefusal(state)
  if (refusal) return { ok: false, code: refusal }
  const plan = planConfirmed(state)
  const outcome = await bookDecision(supabase, companyId, userId, {
    state,
    kind: 'confirmed',
    entryDate: params.entryDate,
    description: decisionDescription('Konstaterad kundförlust', invoiceLabel(state.invoice), params.reason),
    lines: plan.lines,
    amount: plan.amount,
    net: plan.net,
    vat: plan.vat,
    shares: plan.shares,
    reserveReleased: plan.reserveReleased,
    evidenceDocumentId: params.evidenceDocumentId,
    reason: params.reason,
    caseId: state.latestCase?.id ?? null,
    decidedBy: params.decidedBy,
  })

  // The evidence becomes the voucher's underlag, unless it already belongs
  // to another voucher (a konkursbesked filed elsewhere stays where it is;
  // the decision row still names it).
  if (outcome.ok && outcome.journalEntryId && !evidence.journal_entry_id) {
    try {
      await linkToJournalEntry(
        supabase,
        companyId,
        params.evidenceDocumentId,
        outcome.journalEntryId,
        linkBasisColumns('user_created'),
      )
    } catch (error) {
      log.error('evidence not linked to the konstaterad voucher', error as Error, {
        companyId,
        invoiceId: params.invoiceId,
        journalEntryId: outcome.journalEntryId,
        documentId: params.evidenceDocumentId,
      })
    }
  }
  return outcome
}
