/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-invoice
 *
 * Match a positive (income) transaction to an open customer invoice. The
 * full flow:
 *   1. Storno any conflicting auto-categorization JE.
 *   2. Create the payment journal entry (resolved bank account debit / 1510
 *      credit under accrual; cash-method path delegates to
 *      createInvoiceCashEntry). The debited account is resolved from this
 *      transaction's own cash_account_id via resolveSettlementAccount, never
 *      hardcoded to 1930 (mirrors the fix on the supplier-invoice side).
 *   3. Re-attach the invoice PDF to the new payment JE (BFL 7 kap underlag).
 *   4. Update invoice status (paid / partially_paid) with optimistic lock.
 *   5. Insert invoice_payments row; link transaction to invoice.
 *
 * Mirrors the internal route's failure ordering exactly. Idempotent on
 * (transaction, key). NOT dry-runnable: the multi-row interlock makes a
 * meaningful preview infeasible without staging the JE for real, and dry-
 * run is reserved for endpoints where the caller benefits from a fully
 * resolved preview before commit. Skip the flag here; document it.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { reverseEntry, createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { eventBus } from '@/lib/events/bus'
import type { EntityType, Invoice, Transaction } from '@/types'

const MatchInvoiceResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_at: z.string().nullable(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  // Preserved from the prior :categorize call (or whatever the existing
  // value was). Returns null when the transaction had never been
  // categorized: the v1 surface no longer guesses 'income_services'
  // for unmatched-revenue rows because the wrong default flows into
  // BAS 3001/3041/3530 selection and INK2R/SRU reporting.
  category: z.string().nullable(),
})

registerEndpoint({
  operation: 'transactions.match-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-invoice',
  summary: 'Match a positive bank transaction to a customer invoice.',
  description:
    'Confirms an invoice match for a transaction. Storno any conflicting auto-categorization JE, create the payment journal entry, update the invoice status (paid / partially_paid), insert into invoice_payments, and link the transaction. Idempotent.',
  useWhen:
    'You have a bank receipt and a known open invoice it pays. The transaction must be positive (income) and unlinked.',
  doNotUseFor:
    'Categorizing a transaction without an invoice: use `:categorize`. Matching to a supplier invoice: use `:match-supplier-invoice`. Bulk auto-match: use `POST /reconciliation/bank/run`.',
  pitfalls: [
    'Proforma + delivery notes are rejected (MATCH_INVOICE_NOT_INVOICE_TYPE): only document_type=\'invoice\' can be matched.',
    'Transaction must be positive (amount > 0): negative transactions return MATCH_INVOICE_NOT_INCOME.',
    'Invoice must be in sent / overdue / partially_paid status: paid or draft invoices return MATCH_INVOICE_NOT_OPEN.',
    'Idempotency-Key is mandatory.',
  ],
  example: {
    request: { invoice_id: 'inv_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 12500,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
        category: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchInvoiceSchema },
  response: { success: dataEnvelope(MatchInvoiceResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-invoice',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }
    const txId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = MatchInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const { invoice_id, force, expected_journal_entry_id, lines: customLines } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, invoiceId: invoice_id })

    const { data: transaction, error: fetchTxErr } = await ctx.supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchTxErr || !transaction) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    // Preserve any prior category (e.g. income_products for goods sales).
    // Only fall back to the generic 'income_services' default if the
    // transaction has never been categorized: Greptile + Swedish-compliance
    // flagged the dashboard's hardcode-on-write as a wrong BAS classification
    // for goods/rental income flows.
    const existingTxCategory = (transaction as { category?: string | null }).category ?? null
    if (transaction.amount <= 0) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_INCOME', txLog, {
        requestId: ctx.requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.invoice_id) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_TX_ALREADY_LINKED', txLog, {
        requestId: ctx.requestId,
        details: { existingInvoiceId: transaction.invoice_id },
      })
    }

    const { data: invoice, error: fetchInvErr } = await ctx.supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchInvErr || !invoice) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    const docType = (invoice as { document_type?: string }).document_type ?? 'invoice'
    if (docType !== 'invoice') {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', txLog, {
        requestId: ctx.requestId,
        details: { documentType: docType },
      })
    }
    if (
      invoice.status !== 'sent' &&
      invoice.status !== 'overdue' &&
      invoice.status !== 'partially_paid'
    ) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_OPEN', txLog, {
        requestId: ctx.requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Hard-duplicate guard: status leak: the invoice still says
    // 'sent'/'overdue' but already has a payment voucher attached. Mirror
    // of the internal route's defensive check.
    if (invoice.status === 'sent' || invoice.status === 'overdue') {
      const { data: existingPayments } = await ctx.supabase
        .from('invoice_payments')
        .select('journal_entry_id')
        .eq('company_id', ctx.companyId!)
        .eq('invoice_id', invoice_id)
        .not('journal_entry_id', 'is', null)
        .limit(1)
      if (existingPayments && existingPayments.length > 0) {
        return v1ErrorResponseFromCode('MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER', txLog, {
          requestId: ctx.requestId,
          details: {
            existing_journal_entry_id:
              (existingPayments[0] as { journal_entry_id: string }).journal_entry_id,
          },
        })
      }
    }

    // Soft-duplicate guard: a manual verifikation already books this
    // bank receipt. Bypassed only when the caller echoes the candidate's
    // journal_entry_id back in expected_journal_entry_id (validated by
    // the schema). The Idempotency-Key body hash already prevents replay
    // with a different body, and re-detecting the candidate here means an
    // automation can't fabricate or stale-roll an id past the guard.
    let dismissedCandidateId: string | null = null
    try {
      const candidate = await detectDuplicatePaymentVoucher(ctx.supabase, {
        companyId: ctx.companyId!,
        transactionId: txId,
        transactionDate: transaction.date,
        transactionAmount: transaction.amount,
      })
      if (!force) {
        if (candidate) {
          return v1ErrorResponseFromCode('MATCH_INVOICE_POSSIBLE_DUPLICATE', txLog, {
            requestId: ctx.requestId,
            details: { candidate },
          })
        }
      } else {
        if (!candidate || candidate.journal_entry_id !== expected_journal_entry_id) {
          return v1ErrorResponseFromCode('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH', txLog, {
            requestId: ctx.requestId,
            details: {
              expected_journal_entry_id,
              detected_journal_entry_id: candidate?.journal_entry_id ?? null,
            },
          })
        }
        dismissedCandidateId = candidate.journal_entry_id
      }
    } catch (err) {
      if (force) {
        txLog.error('duplicate-payment-voucher detection failed under force=true', err as Error)
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      txLog.warn('duplicate-payment-voucher detection failed (continuing)', err as Error)
    }

    if (force && dismissedCandidateId) {
      txLog.warn('soft-duplicate guard bypassed', {
        reason: 'force=true',
        requestId: ctx.requestId,
        transactionId: txId,
        invoiceId: invoice_id,
        // Attribute the override to the calling user AND the API key. The
        // user identifier alone is not enough for v1: a single user can
        // hold multiple keys (CI bot, integration, personal), and revocation
        // / abuse triage needs to know which key was used.
        userId: ctx.userId,
        apiKeyId: ctx.apiKeyId,
        // The verifikation the caller acknowledged and dismissed.
        dismissedJournalEntryId: dismissedCandidateId,
      })
    }

    const paidAmount = transaction.amount

    // Overshoot guard + paid/remaining math: shared with the dashboard and
    // agent (commit) paths via planInvoicePayment. Without this, the public API
    // silently overpaid an invoice (recording paid_amount > total, over-crediting
    // AR). Runs BEFORE the storno + strict-mode JE creation, so a rejected match
    // touches no state.
    const payment = planInvoicePayment(invoice, paidAmount)
    if (!payment.ok) {
      return v1ErrorResponseFromCode('MATCH_AMOUNT_EXCEEDS_REMAINING', txLog, {
        requestId: ctx.requestId,
        details: payment.details,
      })
    }
    const { newPaidAmount, newRemaining, isFullyPaid, newStatus } = payment.plan

    if (transaction.journal_entry_id) {
      try {
        await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, transaction.journal_entry_id)
        const { error: clearErr } = await ctx.supabase
          .from('transactions')
          .update({ journal_entry_id: null })
          .eq('id', txId)
          .eq('company_id', ctx.companyId!)
        if (clearErr) {
          txLog.warn('failed to clear journal_entry_id after storno', clearErr)
        }
        logMatchEvent(ctx.supabase, ctx.userId, txId, 'storno_conflict_resolved', {
          invoiceId: invoice_id,
          previousState: { journal_entry_id: transaction.journal_entry_id },
          newState: { journal_entry_id: null },
        })
      } catch (err) {
        txLog.error('storno failed', err as Error)
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
    }

    const now = new Date().toISOString()

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .single()
    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType: EntityType =
      (settings?.entity_type as EntityType) || 'enskild_firma'

    // Debit the cash account THIS transaction actually belongs to, never a
    // hardcoded 1930: cash_account_id -> cash_accounts.ledger_account is the
    // only source of truth for which bank/cash account a real, matched
    // transaction settled into.
    const paymentAccount = await resolveSettlementAccount(
      ctx.supabase,
      ctx.companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // The JE shape is driven by the INVOICE'S booking state, not the
    // company's current setting. If the invoice already has a JE (Dr 1510
    // posted at send), the match must clear 1510: otherwise the receivable
    // stays orphaned and 30xx + 26xx get double-counted. The current
    // accounting_method only governs the cash-method fast path for
    // invoices that were never booked.
    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

    // Reject cash-method partial payments ONLY for pure kontantmetoden
    // invoices (no prior JE). Under kontantmetoden utgående moms must be
    // reported in the period of actual receipt (ML 13 kap 8 §); the
    // partial-payment branch uses the accrual-style clearing entry which
    // doesn't model the per-installment moms event. When the invoice was
    // already booked under accrual, the clearing entry IS the correct
    // partial path regardless of the company's current setting.
    if (!invoiceAlreadyBooked && accountingMethod === 'cash' && !isFullyPaid) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId: ctx.requestId,
        details: {
          field: 'accounting_method',
          message:
            'Kontantmetoden does not support partial-payment matching via this endpoint. ' +
            'Match the full payment when received, or switch to accrual (faktureringsmetoden).',
          accounting_method: 'cash',
          payment_amount: paidAmount,
          invoice_total: invoice.total,
        },
      })
    }

    // Guard the resolved account against the chart (mirrors the categorize
    // routes and the same fix on match-supplier-invoice): an inactive
    // cash_accounts.ledger_account would otherwise reach the engine as a
    // generic INVOICE_PAID_BOOK_FAILED instead of ACCOUNTS_NOT_IN_CHART.
    // Only reachable where the account is actually used: customLines specify
    // their own accounts directly and never consume paymentAccount.
    if (!customLines) {
      const missingAccounts = await findUnresolvableAccounts(ctx.supabase, ctx.companyId!, [
        paymentAccount,
      ])
      if (missingAccounts.length > 0) {
        txLog.warn('resolved settlement account is inactive/unknown', { missingAccounts })
        return v1ErrorResponse(new AccountsNotInChartError(missingAccounts), txLog, {
          requestId: ctx.requestId,
        })
      }
    }

    // Strict-mode for the public API: if the payment JE can't be created we
    // ABORT before touching invoice / payment / transaction state. The
    // dashboard's internal route soft-fails here and surfaces a banner so
    // the user can re-book manually; the v1 caller is an automation with
    // no UI, so a partial state (invoice marked paid, GL has no entry) is
    // strictly worse than a clean failure to retry.
    let journalEntryId: string | null = null
    try {
      if (customLines) {
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return v1ErrorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', txLog, {
            requestId: ctx.requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId!, transaction.date)
        if (!fiscalPeriodId) {
          return v1ErrorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId: ctx.requestId,
            details: { payment_date: transaction.date },
          })
        }
        const sourceType = useCashEntry ? 'invoice_cash_payment' : 'invoice_paid'
        const desc = invoice.customer?.name
          ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
          : `Inbetalning kundfaktura ${invoice.invoice_number}`
        const je = await createJournalEntry(ctx.supabase, ctx.companyId!, ctx.userId, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
        })
        journalEntryId = je?.id ?? null
      } else if (useCashEntry) {
        const je = await createInvoiceCashEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          invoice as Invoice,
          transaction.date,
          entityType,
          invoice.customer?.name,
          paymentAccount,
        )
        journalEntryId = je?.id ?? null
      } else {
        const je = await createInvoicePaymentJournalEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          invoice as Invoice,
          transaction.date,
          undefined,
          invoice.customer?.name,
          paidAmount,
          paymentAccount,
        )
        journalEntryId = je?.id ?? null
      }
    } catch (err) {
      if (err instanceof AccountsNotInChartError) {
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      txLog.error('match-invoice: payment JE creation failed: aborting before state mutation', err as Error)
      const message = isBookkeepingError(err)
        ? getErrorMessage(err, { context: 'invoice' })
        : err instanceof Error
          ? err.message
          : 'Unknown error'
      return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', txLog, {
        requestId: ctx.requestId,
        details: { reason: message },
      })
    }

    // Re-attach invoice PDF to the payment JE (BFL 7 kap underlag).
    if (journalEntryId && invoice.journal_entry_id) {
      try {
        const { data: invoiceDoc } = await ctx.supabase
          .from('document_attachments')
          .select('storage_path, file_name, file_size_bytes, mime_type, sha256_hash')
          .eq('journal_entry_id', invoice.journal_entry_id)
          .eq('company_id', ctx.companyId!)
          .eq('is_current_version', true)
          .limit(1)
          .maybeSingle()
        if (invoiceDoc) {
          const { error: attachErr } = await ctx.supabase
            .from('document_attachments')
            .insert({
              user_id: ctx.userId,
              company_id: ctx.companyId!,
              uploaded_by: ctx.userId,
              upload_source: 'system',
              storage_path: invoiceDoc.storage_path,
              file_name: invoiceDoc.file_name,
              file_size_bytes: invoiceDoc.file_size_bytes,
              mime_type: invoiceDoc.mime_type,
              sha256_hash: invoiceDoc.sha256_hash,
              journal_entry_id: journalEntryId,
            })
          if (attachErr) {
            txLog.warn('failed to attach invoice PDF to payment JE', {
              attachError: attachErr.message,
            })
          }
        }
      } catch (err) {
        txLog.warn('attach invoice PDF threw', err as Error)
      }
    }

    const { data: updatedRows, error: updateInvErr } = await ctx.supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: isFullyPaid ? now : null,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      })
      .eq('id', invoice_id)
      .eq('company_id', ctx.companyId!)
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .select('id')
    if (updateInvErr) return v1ErrorResponse(updateInvErr, txLog, { requestId: ctx.requestId })
    if (!updatedRows || updatedRows.length === 0) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_ALREADY_PAID', txLog, {
        requestId: ctx.requestId,
      })
    }

    // The "intäkt bokförs vid slutbetalning" note only applies to genuine
    // kontantmetoden partials: never-booked invoices. When the invoice was
    // booked under accrual, the clearing entry handles the partial cleanly
    // and the note would be misleading.
    const paymentNotes =
      !invoiceAlreadyBooked && accountingMethod === 'cash' && !isFullyPaid
        ? 'Kontantmetoden: intäkt bokförs vid slutbetalning'
        : null

    const { error: paymentInsertErr } = await ctx.supabase
      .from('invoice_payments')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        invoice_id,
        payment_date: transaction.date,
        amount: paidAmount,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate,
        journal_entry_id: journalEntryId,
        transaction_id: txId,
        notes: paymentNotes,
      })
    if (paymentInsertErr) {
      if (paymentInsertErr.code === '23505') {
        return v1ErrorResponseFromCode('MATCH_INVOICE_DUPLICATE_PAYMENT', txLog, {
          requestId: ctx.requestId,
        })
      }
      txLog.error('failed to record payment', paymentInsertErr)
      return v1ErrorResponseFromCode('MATCH_INVOICE_RECORD_PAYMENT_FAILED', txLog, {
        requestId: ctx.requestId,
      })
    }

    // When the tx already has a category (set by a prior :categorize call,
    // could be income_products / rental / etc.), preserve it. When there is
    // none, leave the column UNTOUCHED: the existing default ('uncategorized')
    // persists. Writing a hardcoded 'income_services' here was the source of
    // a known mis-classification for goods/rental flows (BAS 3001/3041/3530
    // distinct accounts → wrong INK2R field → wrong SRU).
    const txUpdate: Record<string, unknown> = {
      invoice_id,
      potential_invoice_id: null,
      journal_entry_id: journalEntryId,
      is_business: true,
    }
    if (existingTxCategory) txUpdate.category = existingTxCategory

    const { error: updateTxErr } = await ctx.supabase
      .from('transactions')
      .update(txUpdate)
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
    if (updateTxErr) {
      txLog.error('failed to link transaction to invoice', updateTxErr)
      return v1ErrorResponseFromCode('MATCH_INVOICE_LINK_TX_FAILED', txLog, {
        requestId: ctx.requestId,
      })
    }

    logMatchEvent(ctx.supabase, ctx.userId, txId, 'matched', {
      invoiceId: invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      newState: {
        status: newStatus,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      },
    })

    try {
      eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: invoice as Invoice,
          transaction: transaction as Transaction,
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (err) {
      txLog.warn('event emit failed (non-critical)', err as Error)
    }

    return ok(
      {
        success: true,
        invoice_status: newStatus,
        paid_at: isFullyPaid ? now : null,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        journal_entry_id: journalEntryId,
        category: existingTxCategory,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
