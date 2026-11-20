/**
 * Books one kundförlust decision: the voucher through the bookkeeping engine
 * (source_type customer_loss, source_id = the decision id), then the row and
 * the status through record_invoice_write_off() (as the service role, for
 * the acting person: write-off-rpc.ts).
 *
 * The voucher is the accounting record, so an engine refusal (a locked
 * period, an account missing from the chart) stops the whole decision and
 * reaches the caller as the engine's own typed error. If the row cannot be
 * recorded after the voucher posted, the voucher is stornoed through the
 * sanctioned path at once: a voucher with no decision behind it would move
 * 1510 or 26xx without the invoice or the momsdeklaration knowing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { createLogger } from '@/lib/logger'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { CreateJournalEntryLineInput } from '@/types'
import type { VatShare } from './amounts'
import type { CustomerLossOutcome } from './errors'
import { decisionId } from './ids'
import type { CustomerLossState, WriteOffRow } from './state'
import { isCustomerLossWriter, recordInvoiceWriteOff } from './write-off-rpc'

const log = createLogger('customer-loss/record')

export type DecisionKind = 'doubtful' | 'reversed_doubtful' | 'confirmed' | 'recovered'

export interface BookDecisionParams {
  state: CustomerLossState
  kind: DecisionKind
  entryDate: string
  description: string
  /** null: a konstaterad decision on a never-booked invoice (no voucher). */
  lines: CreateJournalEntryLineInput[] | null
  amount: number
  net: number
  vat: number
  shares: VatShare[]
  reserveReleased?: number
  evidenceDocumentId?: string | null
  reason: string
  caseId?: string | null
  /** The acting person: checked as a writer in the company and recorded as decided_by. */
  decidedBy: string
}

/** The next decision id of a kind: rows of that kind so far, annulled ones included. */
export function nextDecisionId(invoiceId: string, rows: WriteOffRow[], kind: DecisionKind): Promise<string> {
  return decisionId(invoiceId, kind, rows.filter((r) => r.kind === kind).length)
}

/**
 * A decision's business event for the posting port (sale.customer_loss),
 * dated its verifikat: the invoice is the subject, the amount what the
 * decision moves (the reserve, the claim written off or the sum recovered)
 * and the moms the utgående moms it reverses or books back. SEK only (the
 * eligibility check refuses another currency). No party: the decision's
 * state carries no customer id, and the invoice names the customer. Built
 * only while POSTING_EVENTS is on.
 */
export function customerLossBusinessEvent(
  params: Pick<BookDecisionParams, 'state' | 'entryDate' | 'amount' | 'vat' | 'evidenceDocumentId'>,
): BusinessEventDraft {
  const vat = Math.abs(params.vat)
  return {
    kind: 'sale.customer_loss',
    category: null,
    occurredOn: params.entryDate,
    subject: { type: 'invoice', id: params.state.invoice.id },
    currency: 'SEK',
    amount: Math.abs(params.amount),
    amountSek: Math.abs(params.amount),
    taxAmounts: vat > 0 ? [{ tax: 'vat', treatment: null, amount_sek: vat }] : [],
    evidence: { document_id: params.evidenceDocumentId ?? undefined },
    mappingVersion: mappingVersion('customerLoss'),
    jurisdiction: 'SE',
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof BookkeepingDatabaseError && error.pgCode === '23505'
}

export async function bookDecision(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: BookDecisionParams,
): Promise<CustomerLossOutcome> {
  const { state, kind } = params
  // The function's own rule for a signed-in caller, checked before anything
  // is booked: a member who is not a viewer.
  if (!(await isCustomerLossWriter(companyId, params.decidedBy))) {
    return { ok: false, code: 'CUSTOMER_LOSS_FORBIDDEN' }
  }
  const id = await nextDecisionId(state.invoice.id, state.rows, kind)

  let journalEntryId: string | null = null
  if (params.lines) {
    const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.entryDate)
    if (!fiscalPeriodId) {
      return { ok: false, code: 'CUSTOMER_LOSS_NO_FISCAL_PERIOD', details: { entry_date: params.entryDate } }
    }
    try {
      // Through the posting port (lib/posting): the engine gets this input
      // unchanged; while POSTING_EVENTS is on, the decision's event is
      // recorded and linked to the draft before a voucher number is drawn.
      const entry = await postingPort.postJournalEntry({
        supabase,
        companyId,
        userId,
        event: () => customerLossBusinessEvent(params),
        input: {
          fiscal_period_id: fiscalPeriodId,
          entry_date: params.entryDate,
          description: params.description,
          source_type: 'customer_loss',
          source_id: id,
          lines: params.lines,
        },
      })
      journalEntryId = entry.id
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, code: 'CUSTOMER_LOSS_RACE' }
      throw error
    }
  }

  const { data, error } = await recordInvoiceWriteOff(companyId, params.decidedBy, {
    p_id: id,
    p_invoice_id: state.invoice.id,
    p_kind: kind,
    p_entry_date: params.entryDate,
    p_amount: params.amount,
    p_net_amount: params.net,
    p_vat_amount: params.vat,
    p_vat_by_rate: params.shares,
    p_reserve_released: params.reserveReleased ?? 0,
    p_journal_entry_id: journalEntryId,
    p_evidence_document_id: params.evidenceDocumentId ?? null,
    p_reason: params.reason,
    p_case_id: params.caseId ?? null,
    p_reverses_id: null,
  })

  if (error) {
    log.error('customer loss decision not recorded after its voucher', new Error(error.message), {
      companyId,
      invoiceId: state.invoice.id,
      decisionId: id,
      kind,
      journalEntryId,
      pgCode: error.code,
    })
    if (journalEntryId) {
      await reverseOrphanedJournalEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt återförd: kundförlusten kunde inte registreras på fakturan efter bokföringen',
      )
    }
    if (/CUSTOMER_LOSS_FORBIDDEN/.test(error.message)) {
      return { ok: false, code: 'CUSTOMER_LOSS_FORBIDDEN' }
    }
    if (/CUSTOMER_LOSS_INVOICE_NOT_OPEN/.test(error.message)) {
      return { ok: false, code: 'CUSTOMER_LOSS_INVOICE_NOT_OPEN' }
    }
    if (/CUSTOMER_LOSS_NOT_WRITTEN_OFF/.test(error.message)) {
      return { ok: false, code: 'CUSTOMER_LOSS_NOT_WRITTEN_OFF' }
    }
    if (/CUSTOMER_LOSS_EVIDENCE_NOT_FOUND/.test(error.message)) {
      return { ok: false, code: 'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND' }
    }
    return { ok: false, code: 'CUSTOMER_LOSS_RECORD_FAILED', details: { journal_entry_id: journalEntryId } }
  }

  const result = (data ?? {}) as { invoice_status?: string }
  return {
    ok: true,
    writeOffId: id,
    journalEntryId,
    invoiceStatus: result.invoice_status ?? state.invoice.status,
    amount: params.amount,
  }
}
