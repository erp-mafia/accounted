/**
 * The Inkorg's "Registrera och koppla till betalningen": a supplier invoice
 * that looks already paid by the bank row match on arrival proposed is
 * registered and settled against that row in one request, through the two
 * services the separate doors use:
 *
 *   1. convertInboxItemToSupplierInvoice (POST /items/:id/convert): the
 *      supplier invoice, and its registration verifikat when the company
 *      books on issue (faktureringsmetoden);
 *   2. bookSupplierBankMatch (POST /transactions/:id/match-supplier-invoice):
 *      the payment verifikat through the engine, the ledger update, the
 *      payment row and the bank row's link. Under faktureringsmetoden that
 *      clears 2440 against the bank account; under kontantmetoden the invoice
 *      has no registration verifikat and this one verifikat books cost and
 *      moms against the bank account, with no 2440 leg. A company that books
 *      supplier invoices in a separate Bokför step (defer_invoice_booking)
 *      gets the registration verifikat booked first by the same call
 *      (lib/supplier-invoices/registration-first.ts), then the payment
 *      clears the 2440 it credits: the cost is booked once, on the
 *      registration.
 *
 * One implementation behind POST /api/inkorg/items/:id/register-and-settle
 * (the body the person confirmed in the form) and the Inkorg's one click,
 * POST /api/inkorg/items/:id/book (a body built on the server,
 * lib/inkorg/one-click.ts).
 *
 * Refused before anything is written: an item already converted, a proposal
 * that no longer stands (the row booked or claimed since) or names another
 * row, and a row that is not money out.
 *
 * Partial failure: when the registration went through and the settlement
 * did not (a locked payment month, an amount the plan refuses, a
 * registration the Bokför step refuses), the invoice stays registered and
 * unpaid, and the answer says so: settled false and the settlement's error
 * envelope, so the person can link the payment from the invoice later. A
 * registered invoice is never removed again to undo it.
 *
 * Link basis: the payment row and the bank row are stamped user_confirmed (a
 * person confirmed the pair), with the rule that proposed it as evidence.
 */
import { NextResponse } from 'next/server'
import { errorResponse, errorResponseFromCode, type ErrorEnvelope } from '@/lib/errors/get-structured-error'
import { bankMatchLinkEvidence, readInboxBankMatch, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'
import { bookSupplierBankMatch, type SupplierBankMatchTransactionRow } from '@/lib/invoices/book-supplier-bank-match'
import type { SupplierInvoice } from '@/types'
import { convertInboxItemToSupplierInvoice, type ConvertInboxItemInput } from './inbox-convert'
import { sessionFailureResponse } from './session'
import type { OperationContext } from './types'

export interface RegisterAndSettleContext extends OperationContext {
  requestId: string
}

export interface RegisterAndSettleResult {
  supplier_invoice_id: string
  arrival_number: number | null
  registration_journal_entry_id: string | null
  settled: boolean
  invoice_status: string
  payment_journal_entry_id?: string | null
  /** The envelope the match door would have answered (code, message, message_en), when the settlement failed. */
  settlement_error: ErrorEnvelope['error'] | null
}

export type RegisterAndSettleOutcome =
  | { ok: true; data: RegisterAndSettleResult; warnings: Array<{ code: string; message: string }> }
  | { ok: false; response: NextResponse }

export async function registerAndSettleInboxItem(
  ctx: RegisterAndSettleContext,
  id: string,
  input: { transaction_id: string; invoice: ConvertInboxItemInput },
): Promise<RegisterAndSettleOutcome> {
  const { supabase, companyId, userId, log, requestId } = ctx
  const { transaction_id: transactionId, invoice: invoiceBody } = input
  const refused = (response: NextResponse): RegisterAndSettleOutcome => ({ ok: false, response })

  const { data: itemRow, error: itemError } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, extracted_data, kind_hint, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, routed_to_arkiv_at, bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_source_key')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (itemError) return refused(errorResponse(itemError, log, { requestId }))
  if (!itemRow) return refused(errorResponseFromCode('INBOX_ITEM_NOT_FOUND', log, { requestId }))
  const item = itemRow as BankMatchItemRow
  if (item.created_supplier_invoice_id) {
    return refused(errorResponseFromCode('INBOX_ITEM_ALREADY_CONVERTED', log, {
      requestId,
      details: { supplier_invoice_id: item.created_supplier_invoice_id },
    }))
  }

  // The proposal as every read shows it, checked again now: only the row it
  // names, and only while nothing else claims that row.
  const proposal = await readInboxBankMatch(supabase, companyId, item)
  if (!proposal || proposal.transaction_id !== transactionId) {
    return refused(errorResponseFromCode('INBOX_BANK_MATCH_STALE', log, {
      requestId,
      details: { proposed_transaction_id: proposal?.transaction_id ?? null },
    }))
  }

  const { data: transactionRow, error: transactionError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (transactionError) return refused(errorResponse(transactionError, log, { requestId }))
  if (!transactionRow) return refused(errorResponseFromCode('INBOX_BANK_MATCH_STALE', log, { requestId }))
  const transaction = transactionRow as SupplierBankMatchTransactionRow
  if (Number(transaction.amount) >= 0) {
    return refused(errorResponseFromCode('MATCH_SI_NOT_EXPENSE', log, { requestId, details: { amount: transaction.amount } }))
  }

  // 1. Register: the same rules as the convert door.
  const registered = await convertInboxItemToSupplierInvoice({ supabase, companyId, userId, log }, id, invoiceBody)
  if (!registered.ok) return refused(sessionFailureResponse(registered, log, requestId))
  if (registered.dryRun) return refused(NextResponse.json({ data: registered.preview }))
  const supplierInvoiceId = registered.data.invoice.id
  const warnings = (registered.warnings ?? []).map((w) => ({ code: w.code, message: w.message_sv }))
  const registration = {
    supplier_invoice_id: supplierInvoiceId,
    arrival_number: registered.data.invoice.arrival_number,
    registration_journal_entry_id: registered.data.registration_journal_entry_id,
  }

  // 2. Settle against the bank row. From here on the invoice stays registered whatever happens.
  const settleLog = log.child({ transactionId, supplierInvoiceId })
  const unsettled = async (failure: NextResponse): Promise<RegisterAndSettleOutcome> => {
    const envelope = (await failure.json()) as ErrorEnvelope
    settleLog.warn('inkorg register-and-settle: registered, not settled', { code: envelope.error.code })
    return {
      ok: true,
      data: {
        ...registration,
        settled: false,
        invoice_status: 'registered',
        settlement_error: envelope.error,
      },
      warnings,
    }
  }

  const { data: invoiceRow, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (invoiceError || !invoiceRow) {
    return unsettled(
      invoiceError
        ? errorResponse(invoiceError, settleLog, { requestId })
        : errorResponseFromCode('MATCH_SI_NOT_FOUND', settleLog, { requestId }),
    )
  }
  const invoice = invoiceRow as SupplierInvoice

  // A deferring company's unbooked invoice is booked by the settlement
  // itself, registration first (bookSupplierBankMatch): no refusal here.
  const settled = await bookSupplierBankMatch(supabase, {
    transaction,
    invoice,
    userId,
    companyId,
    log: settleLog,
    match: {
      action: 'matched',
      method: 'inbox_bank_match',
      confidence: 1.0,
      newState: { inbox_item_id: id, evidence_level: proposal.evidence_level },
    },
    linkBasis: { basis: 'user_confirmed', evidence: bankMatchLinkEvidence(item, transactionId) },
  })
  if (!settled.ok) {
    return unsettled(
      settled.error !== undefined
        ? errorResponse(settled.error, settleLog, { requestId })
        : errorResponseFromCode(settled.code, settleLog, settled.details ? { requestId, details: settled.details } : { requestId }),
    )
  }

  return {
    ok: true,
    data: {
      ...registration,
      // The registration verifikat the settlement booked first, in a deferring company.
      registration_journal_entry_id: registration.registration_journal_entry_id ?? settled.registrationJournalEntryId ?? null,
      settled: true,
      invoice_status: settled.plan.newStatus,
      payment_journal_entry_id: settled.journalEntryId,
      settlement_error: null,
    },
    warnings,
  }
}
