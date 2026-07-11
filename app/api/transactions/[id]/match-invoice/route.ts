import { NextResponse } from 'next/server'
import { createInvoiceCashEntry } from '@/lib/bookkeeping/invoice-entries'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { reverseEntry, createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { Currency, EntityType, Invoice, Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-invoice
 *
 * Confirms an invoice match for a transaction. Supports partial payments:
 * 1. If transaction has an auto-categorization journal entry, storno it first
 * 2. Links transaction to invoice (sets invoice_id)
 * 3. Updates invoice status to 'paid' or 'partially_paid'
 * 4. Records payment in invoice_payments table
 * 5. Creates journal entry for payment receipt
 *    - Debit <resolved bank account> Företagskonto (Bank)
 *    - Credit 1510 Kundfordringar (Accounts Receivable)
 *
 * The bank leg is resolved from THIS transaction's own cash_account_id via
 * resolveSettlementAccount (cash_account_id -> cash_accounts.ledger_account),
 * never hardcoded to 1930: a receipt landing in a secondary SEK account or a
 * foreign-currency account (e.g. 1940 for EUR) must book to that account, not
 * silently to the primary bank account. Mirrors the fix already applied on
 * the supplier-invoice side (match-supplier-invoice/route.ts), which resolves
 * the credited account the same way instead of falling back to a stale
 * company-wide setting.
 */
export const POST = withRouteContext(
  'transaction.match_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchInvoiceSchema, {
      log,
      operation: 'transaction.match_invoice',
    })
    if (!validation.success) return validation.response
    const { invoice_id, force, expected_journal_entry_id, lines: customLines } = validation.data

    const txLog = log.child({ transactionId, invoiceId: invoice_id })

    const { data: transaction, error: fetchTxError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (fetchTxError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }

    if (transaction.amount <= 0) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INCOME', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if (transaction.invoice_id) {
      return errorResponseFromCode('MATCH_INVOICE_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingInvoiceId: transaction.invoice_id },
      })
    }

    const { data: invoice, error: fetchInvError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice_id)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', txLog, { requestId })
    }

    // Defense-in-depth: the InvoicePicker UI filters proformas / delivery
    // notes out of the candidate list, but a direct API call could still
    // pass a proforma id. A proforma is not a faktura per ML 17 kap 24§:
    // no VAT obligation, no binding payment: so matching one against a
    // bank receipt would book income and VAT incorrectly.
    const docType = (invoice as { document_type?: string }).document_type ?? 'invoice'
    if (docType !== 'invoice') {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', txLog, {
        requestId,
        details: { documentType: docType },
      })
    }

    if (invoice.status !== 'sent' && invoice.status !== 'overdue' && invoice.status !== 'partially_paid') {
      return errorResponseFromCode('MATCH_INVOICE_NOT_OPEN', txLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Cross-currency settlement (replaces the PR #614 round-9 block).
    //
    // invoices.paid_amount / remaining_amount are denominated in
    // invoice.currency; invoice_payments rows carry currency =
    // invoice.currency with amount in that currency. When tx and invoice
    // currencies differ, we convert tx.amount (SEK) to invoice currency
    // using the Riksbanken spot rate on the payment date (ML 8 kap 21-23§)
    // and accumulate / record in invoice currency throughout. The JE-lines
    // helper gets the same converted amount so the verifikat balances
    // exactly (FX-diff posted to 3960/7960). A manual rate may be supplied
    // via the request body when the lookup fails (e.g. bank-statement rate
    // when Riksbanken hasn't published for the date yet).
    type FxConversion =
      | { required: false }
      | {
          required: true
          rate: number
          rate_date: string
          paidInInvoiceCurrency: number
          // Provenance of the rate actually used, recorded for the audit
          // trail: 'manual' = caller-supplied from a bank statement (Riksbanken
          // had no rate for the date), 'riksbanken' = spot rate fetched on the
          // payment date. A manual override on a money path must be traceable
          // (BFL 5 kap 6-7§; ML 8 kap 21-23§).
          source: 'manual' | 'riksbanken'
        }

    let fx: FxConversion = { required: false }
    if (transaction.currency !== invoice.currency) {
      const manualRate =
        typeof validation.data?.manual_exchange_rate === 'number' &&
        validation.data.manual_exchange_rate > 0
          ? validation.data.manual_exchange_rate
          : null
      let rate = manualRate
      let rateDate = transaction.date
      if (rate == null) {
        const rateInfo = await fetchExchangeRate(
          invoice.currency as Currency,
          new Date(transaction.date),
        )
        if (rateInfo && rateInfo.rate > 0) {
          rate = rateInfo.rate
          rateDate = rateInfo.date
        }
      }
      if (rate == null || rate <= 0) {
        return errorResponseFromCode('MATCH_INVOICE_FX_RATE_UNAVAILABLE', txLog, {
          requestId,
          details: {
            transactionCurrency: transaction.currency,
            invoiceCurrency: invoice.currency,
            paymentDate: transaction.date,
          },
        })
      }
      const txAbsSek =
        transaction.currency === 'SEK'
          ? Math.abs(transaction.amount)
          : Math.abs(transaction.amount) * (transaction.exchange_rate ?? 1)
      const paidInInvoiceCurrency = Math.round((txAbsSek / rate) * 10000) / 10000
      fx = {
        required: true,
        rate,
        rate_date: rateDate,
        paidInInvoiceCurrency,
        source: manualRate != null ? 'manual' : 'riksbanken',
      }
    }

    // Hard-duplicate guard: if the invoice is 'sent'/'overdue' but already
    // has a payment voucher attached (status leak), refuse: booking again
    // would double-credit 1510 / double-debit 1930. Partially-paid invoices
    // pass through; additional payments are legitimate.
    if (invoice.status === 'sent' || invoice.status === 'overdue') {
      const { data: existingPayments } = await supabase
        .from('invoice_payments')
        .select('journal_entry_id')
        .eq('company_id', companyId)
        .eq('invoice_id', invoice_id)
        .not('journal_entry_id', 'is', null)
        .limit(1)
      if (existingPayments && existingPayments.length > 0) {
        return errorResponseFromCode('MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER', txLog, {
          requestId,
          details: {
            existing_journal_entry_id: (existingPayments[0] as { journal_entry_id: string }).journal_entry_id,
          },
        })
      }
    }

    // Soft-duplicate guard: scan for a manual verifikation that already
    // books this bank receipt outside the invoice flow. The customer's
    // exact case: they posted Dr 1930 / Cr 3100 by hand; the matcher
    // would otherwise create a second voucher and double-book. Bypassed
    // with force=true after the user reviews the candidate in the UI.
    //
    // force=true is bound to a specific candidate via expected_journal_entry_id
    // (validated by the schema). We re-detect the candidate server-side and
    // refuse the bypass if it no longer matches: a stale or fabricated
    // expected id cannot wave the guard away. The pre-flight runs even when
    // a candidate is detected so the audit log records the verifikation the
    // user opted to dismiss.
    let dismissedCandidateId: string | null = null
    try {
      const candidate = await detectDuplicatePaymentVoucher(supabase, {
        companyId: companyId!,
        transactionId,
        transactionDate: transaction.date,
        transactionAmount: transaction.amount,
      })
      if (!force) {
        if (candidate) {
          return errorResponseFromCode('MATCH_INVOICE_POSSIBLE_DUPLICATE', txLog, {
            requestId,
            details: { candidate },
          })
        }
      } else {
        if (!candidate || candidate.journal_entry_id !== expected_journal_entry_id) {
          // Either no current duplicate (force is moot: caller should retry
          // without force) or the candidate the caller claims to have seen
          // doesn't match what we detect now. Reject so an automation can't
          // smuggle force=true past the guard with a guessed id.
          return errorResponseFromCode('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH', txLog, {
            requestId,
            details: {
              expected_journal_entry_id,
              detected_journal_entry_id: candidate?.journal_entry_id ?? null,
            },
          })
        }
        dismissedCandidateId = candidate.journal_entry_id
      }
    } catch (err) {
      // Detection failure must not block the non-force match: log and
      // continue. force=true requires a successful detection, so re-throw
      // its branch as a clean 500 via the wrapper.
      if (force) {
        txLog.error('duplicate-payment-voucher detection failed under force=true', err as Error)
        return errorResponse(err, txLog, { requestId })
      }
      txLog.warn('duplicate-payment-voucher detection failed (continuing)', err as Error)
    }

    if (force && dismissedCandidateId) {
      txLog.warn('soft-duplicate guard bypassed', {
        reason: 'force=true',
        requestId,
        transactionId,
        invoiceId: invoice_id,
        userId: user.id,
        // The verifikation the user reviewed and dismissed. Recorded so the
        // override can be traced back to the specific duplicate that was
        // surfaced in the pre-flight UI.
        dismissedJournalEntryId: dismissedCandidateId,
      })
    }

    // Storno conflicting auto-categorization JE before any other state change.
    // If storno fails, return immediately: nothing else has been modified.
    if (transaction.journal_entry_id) {
      try {
        await reverseEntry(supabase, companyId, user.id, transaction.journal_entry_id)

        const { error: clearJeError } = await supabase
          .from('transactions')
          .update({ journal_entry_id: null })
          .eq('id', transactionId)
        if (clearJeError) {
          txLog.warn('failed to clear journal_entry_id after storno', clearJeError)
        }

        logMatchEvent(supabase, user.id, transactionId, 'storno_conflict_resolved', {
          invoiceId: invoice_id,
          previousState: { journal_entry_id: transaction.journal_entry_id },
          newState: { journal_entry_id: null },
        })
      } catch (err) {
        txLog.error('failed to storno conflicting journal entry', err as Error)
        return errorResponse(err, txLog, { requestId })
      }
    }

    const now = new Date().toISOString()
    // paidAmountInInvoiceCurrency is what gets accumulated into
    // invoice.paid_amount / remaining_amount and stored on the
    // invoice_payments row. For same-currency it's just tx.amount; for
    // cross-currency it's the Riksbanken-rate conversion computed above.
    // Using SEK directly for a USD invoice would corrupt the column units
    // (the bug the PR #614 round-9 block was working around).
    const paidAmountInInvoiceCurrency = fx.required
      ? fx.paidInInvoiceCurrency
      : transaction.amount

    // Overshoot guard + paid/remaining math: shared with the v1 and agent
    // (commit) paths via planInvoicePayment so they cannot drift again. Runs
    // before any JE is created, so a doomed match never burns a voucher number.
    // Pure-SEK settlements absorb sub-krona öresavrundning (booked to 3740 by
    // buildInvoicePaymentClearingLines) so a whole-krona payment settles in full.
    const pureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'
    const payment = planInvoicePayment(invoice, paidAmountInInvoiceCurrency, {
      absorbOreRounding: pureSek,
    })
    if (!payment.ok) {
      return errorResponseFromCode('MATCH_AMOUNT_EXCEEDS_REMAINING', txLog, {
        requestId,
        details: payment.details,
      })
    }
    const { newPaidAmount, newRemaining, isFullyPaid, newStatus } = payment.plan

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    // Debit the cash account THIS transaction actually belongs to, never a
    // hardcoded 1930: cash_account_id -> cash_accounts.ledger_account is the
    // only source of truth for which bank/cash account a real, matched
    // transaction settled into. A receipt into a secondary SEK account or a
    // foreign-currency account (e.g. 1940 for EUR) must book there, not to
    // the primary account, or the GL silently diverges from the actual bank
    // statement it's meant to represent (BFL 5 kap 1-2§).
    const paymentAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // Drive the JE shape from the INVOICE'S booking state, not from the
    // company's current accounting_method setting. If the invoice was already
    // booked at send (Dr 1510 / Cr 30xx + VAT) we MUST clear 1510 here:
    // otherwise the receivable stays orphaned and 30xx + VAT get double-
    // counted. This happens when a company sent invoices under accrual,
    // then flipped to kontantmetoden before payment arrived.
    // Only when the invoice carries no prior JE (pure kontantmetoden, no
    // receivable on the books) do we recognise revenue + VAT here.
    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

    let journalEntryId: string | null = null
    let journalEntryError: string | null = null

    try {
      if (customLines) {
        // User-edited rows from the match dialog. Validate balance, then
        // post via createJournalEntry directly. source_type still derives
        // from the routing decision so downstream payment-sync (which keys
        // off invoice_paid / invoice_cash_payment) keeps working.
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return errorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', txLog, {
            requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, transaction.date)
        if (!fiscalPeriodId) {
          return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId,
            details: { paymentDate: transaction.date },
          })
        }
        const sourceType = useCashEntry ? 'invoice_cash_payment' : 'invoice_paid'
        const desc = invoice.customer?.name
          ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
          : `Inbetalning kundfaktura ${invoice.invoice_number}`
        const journalEntry = await createJournalEntry(supabase, companyId!, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
        })
        journalEntryId = journalEntry?.id ?? null
      } else if (useCashEntry) {
        const journalEntry = await createInvoiceCashEntry(
          supabase, companyId, user.id, invoice as Invoice, transaction.date,
          entityType, invoice.customer?.name, paymentAccount,
        )
        journalEntryId = journalEntry?.id ?? null
      } else {
        // Clearing entry against 1510. Covers accrual, cash-with-prior-JE
        // (mid-stream switch), and cash partial. The cash partial path is
        // intentional: under kontantmetoden 1510 has no prior balance, so
        // partials leave a credit on 1510 that gets resolved on final
        // payment when createInvoiceCashEntry would normally run.
        //
        // Builds lines via buildInvoicePaymentClearingLines so the verifikat
        // is byte-identical to what the preview route showed the user. For
        // same-currency invoices that's just 1930/1510. For cross-currency
        // it also posts a 3960/7960 FX-diff line so the verifikat balances
        // per BFL 5 kap 4-5§. Bypasses createInvoicePaymentJournalEntry on
        // this single path (mark-paid and other callers still use it):
        // see lib/bookkeeping/invoice-payment-lines.ts for the contract.
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, transaction.date)
        if (!fiscalPeriodId) {
          return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId,
            details: { paymentDate: transaction.date },
          })
        }
        const desc = invoice.customer?.name
          ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
          : `Inbetalning kundfaktura ${invoice.invoice_number}`
        const { lines: clearingLines } = buildInvoicePaymentClearingLines(
          {
            amount: transaction.amount,
            amount_sek: transaction.amount_sek ?? null,
            currency: transaction.currency,
            exchange_rate: transaction.exchange_rate ?? null,
          },
          {
            currency: invoice.currency,
            exchange_rate: invoice.exchange_rate ?? null,
            remaining_amount: invoice.remaining_amount ?? null,
            total: invoice.total,
            paid_amount: invoice.paid_amount ?? null,
          },
          desc,
          // Cross-currency: pass the spot-rate-converted invoice-currency
          // amount so the helper credits 1510 proportionally and posts the
          // FX-diff line. Same-currency: undefined, helper just uses bankSek.
          fx.required ? fx.paidInInvoiceCurrency : undefined,
          paymentAccount,
        )
        const journalEntry = await createJournalEntry(supabase, companyId!, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: 'invoice_paid',
          source_id: invoice.id,
          lines: clearingLines,
        })
        journalEntryId = journalEntry?.id ?? null
      }
    } catch (err) {
      // AccountsNotInChart is fatal so the UI can open the activation dialog.
      if (err instanceof AccountsNotInChartError) {
        return errorResponse(err, txLog, { requestId })
      }
      txLog.error('failed to create payment journal entry', err as Error)
      // Other errors are recorded but don't abort the match: the user can
      // re-book the verifikation manually.
      if (isBookkeepingError(err)) {
        journalEntryError = getErrorMessage(err, { context: 'invoice' })
      } else {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }
    }

    // Underlag for the payment verifikation: re-attach the invoice PDF that
    // was archived on send to the new payment journal entry. document_
    // attachments.journal_entry_id is one-to-one, so we insert a parallel
    // row pointing at the same storage_path. Same WORM file, second JE
    // pointer: no copy, no schema change. Non-blocking (BFL 7 kap audit
    // gap, but the bank line + invoice still exist as evidence).
    if (journalEntryId && invoice.journal_entry_id) {
      try {
        const { data: invoiceDoc } = await supabase
          .from('document_attachments')
          .select('storage_path, file_name, file_size_bytes, mime_type, sha256_hash')
          .eq('journal_entry_id', invoice.journal_entry_id)
          .eq('company_id', companyId)
          .eq('is_current_version', true)
          .limit(1)
          .maybeSingle()
        if (invoiceDoc) {
          // Destructure error: Supabase client returns { data, error } on
          // postgres-level failures (unique constraint, RLS reject) instead
          // of throwing, so the surrounding try/catch only covers thrown
          // JS exceptions. Log via warn so attachment failures are visible
          // in logs even though we don't abort the match.
          const { error: attachErr } = await supabase.from('document_attachments').insert({
            user_id: user.id,
            company_id: companyId,
            uploaded_by: user.id,
            upload_source: 'system',
            storage_path: invoiceDoc.storage_path,
            file_name: invoiceDoc.file_name,
            file_size_bytes: invoiceDoc.file_size_bytes,
            mime_type: invoiceDoc.mime_type,
            sha256_hash: invoiceDoc.sha256_hash,
            journal_entry_id: journalEntryId,
          })
          if (attachErr) {
            txLog.warn('failed to attach invoice PDF to payment journal entry', {
              attachError: attachErr.message,
              paymentJournalEntryId: journalEntryId,
              invoiceJournalEntryId: invoice.journal_entry_id,
            })
          }
        }
      } catch (err) {
        txLog.warn('failed to attach invoice PDF to payment journal entry', err as Error)
      }
    }

    // Optimistic lock: only update if invoice is still in a matchable state.
    const { data: updatedRows, error: updateInvError } = await supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: isFullyPaid ? now : null,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      })
      .eq('id', invoice_id)
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .select('id')

    if (updateInvError) {
      txLog.error('failed to update invoice status', updateInvError)
      return errorResponse(updateInvError, txLog, { requestId })
    }

    if (!updatedRows || updatedRows.length === 0) {
      return errorResponseFromCode('MATCH_INVOICE_ALREADY_PAID', txLog, { requestId })
    }

    // The "intäkt bokförs vid slutbetalning" note only applies to genuine
    // kontantmetoden partials: invoices that were never booked. When the
    // invoice was booked under accrual, the clearing entry already handles
    // the partial cleanly and the note would be misleading.
    const cashMethodNote = (!invoiceAlreadyBooked && accountingMethod === 'cash' && !isFullyPaid)
      ? 'Kontantmetoden: intäkt bokförs vid slutbetalning'
      : null

    // Provenance for a manually-supplied FX rate. The Riksbanken spot rate is
    // self-documenting (rate + rate_date are reproducible), but a rate the
    // user typed from their bank statement is an override of the ML 8 kap
    // 21-23§ obligation and must leave a trail on the verifikat's payment row
    // (BFL 5 kap 6-7§: the verifikation must reflect the actual affärshändelse).
    const manualRateNote =
      fx.required && fx.source === 'manual'
        ? `Manuell valutakurs ${fx.rate} ${invoice.currency}/SEK (betalningsdatum ${transaction.date})`
        : null

    const paymentNotes = [cashMethodNote, manualRateNote].filter(Boolean).join(' · ') || null

    // Payment row stores amount in INVOICE currency (the column unit). For
    // same-currency that's tx.amount; for cross-currency it's the spot-rate
    // conversion above. exchange_rate records the rate ACTUALLY USED for
    // this payment: Riksbanken (or manual override) on tx.date: per
    // ML 8 kap 21-23§. Falling back to invoice.exchange_rate would record
    // the invoice-date rate, which is what the round-7/8 bot reviews
    // explicitly flagged as wrong.
    const { error: paymentInsertError } = await supabase
      .from('invoice_payments')
      .insert({
        user_id: user.id,
        company_id: companyId,
        invoice_id,
        payment_date: transaction.date,
        amount: paidAmountInInvoiceCurrency,
        currency: invoice.currency,
        exchange_rate: fx.required ? fx.rate : invoice.exchange_rate,
        journal_entry_id: journalEntryId,
        transaction_id: transactionId,
        notes: paymentNotes,
      })

    if (paymentInsertError) {
      if (paymentInsertError.code === '23505') {
        return errorResponseFromCode('MATCH_INVOICE_DUPLICATE_PAYMENT', txLog, { requestId })
      }
      txLog.error('failed to record invoice payment', paymentInsertError)
      return errorResponseFromCode('MATCH_INVOICE_RECORD_PAYMENT_FAILED', txLog, { requestId })
    }

    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        invoice_id: invoice_id,
        potential_invoice_id: null,
        journal_entry_id: journalEntryId,
        is_business: true,
        category: 'income_services',
      })
      .eq('id', transactionId)

    if (updateTxError) {
      txLog.error('failed to link transaction to invoice', updateTxError)
      return errorResponseFromCode('MATCH_INVOICE_LINK_TX_FAILED', txLog, { requestId })
    }

    logMatchEvent(supabase, user.id, transactionId, 'matched', {
      invoiceId: invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      // rate_source / exchange_rate live inside new_state (the persisted JSON
      // column) so a manual override: a user-supplied money-path input: is
      // distinguishable from an automatic Riksbanken lookup in the audit trail
      // (swarm V16 / SOC 2 CC6.1 / GDPR Art.5(1)(f)). Same-currency matches
      // carry rate_source: null.
      newState: {
        status: newStatus,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        rate_source: fx.required ? fx.source : null,
        exchange_rate: fx.required ? fx.rate : null,
      },
    })

    try {
      eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: invoice as Invoice,
          transaction: transaction as Transaction,
          userId: user.id,
          companyId,
        },
      })
    } catch (err) {
      txLog.warn('invoice.match_confirmed event emission failed', err as Error)
    }

    if (journalEntryError) {
      txLog.warn('match recorded but payment journal entry failed', {
        errorCode: 'MATCH_INVOICE_PARTIAL',
        message: journalEntryError,
      })
    }

    return NextResponse.json({
      success: true,
      invoice_status: newStatus,
      paid_at: isFullyPaid ? now : null,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
      journal_entry_error: journalEntryError,
      category: 'income_services',
    })
  },
  { requireWrite: true },
)
