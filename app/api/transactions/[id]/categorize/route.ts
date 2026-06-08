import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { getTemplateById, buildMappingResultFromTemplate, validateTemplateForEntity } from '@/lib/bookkeeping/booking-templates'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { saveUserMappingRule, applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { upsertCounterpartyTemplate, buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
  normalizeOcrReference,
} from '@/lib/invoices/duplicate-payment-guard'
import { AccountsNotInChartError, accountsNotInChartResponse, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findMissingActiveAccounts } from '@/lib/bookkeeping/account-validation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { Logger } from '@/lib/logger'
import type { CategorizationTemplate } from '@/types'
import { validateBody } from '@/lib/api/validate'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import type { Transaction, TransactionCategory, EntityType } from '@/types'

ensureInitialized()

/**
 * Ensure a fiscal period exists for the given date, create one if needed.
 */
async function ensureFiscalPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  date: string,
  fiscalYearStartMonth: number,
  log: Logger,
): Promise<boolean> {
  const { data: existing } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .limit(1)

  if (existing && existing.length > 0) return true

  const txDate = new Date(date)
  const txMonth = txDate.getMonth() + 1
  const txYear = txDate.getFullYear()

  let periodStartYear: number
  if (fiscalYearStartMonth === 1) {
    periodStartYear = txYear
  } else if (txMonth >= fiscalYearStartMonth) {
    periodStartYear = txYear
  } else {
    periodStartYear = txYear - 1
  }

  const startMonth = String(fiscalYearStartMonth).padStart(2, '0')
  const periodStart = `${periodStartYear}-${startMonth}-01`

  const endYear = fiscalYearStartMonth === 1 ? periodStartYear : periodStartYear + 1
  const endMonth = fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1
  const lastDay = new Date(endYear, endMonth, 0).getDate()
  const periodEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const periodName = fiscalYearStartMonth === 1
    ? `Räkenskapsår ${periodStartYear}`
    : `Räkenskapsår ${periodStartYear}/${endYear}`

  const { error } = await supabase
    .from('fiscal_periods')
    .upsert({
      user_id: userId,
      company_id: companyId,
      name: periodName,
      period_start: periodStart,
      period_end: periodEnd,
    }, {
      onConflict: 'company_id,period_start,period_end',
    })

  if (error) {
    log.error('failed to create fiscal period', error)
    return false
  }

  return true
}

export const POST = withRouteContext(
  'transaction.categorize',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CategorizeTransactionSchema, {
      log,
      operation: 'transaction.categorize',
    })
    if (!validation.success) return validation.response
    const body = validation.data
    const { is_business, category } = body

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    const txLog = log.child({ transactionId: id })

    // Already-categorized fast path: just update flags, leave the JE alone.
    if (transaction.journal_entry_id) {
      const finalCat: TransactionCategory = is_business ? (category || 'uncategorized') : 'private'

      const { error: updateErr } = await supabase
        .from('transactions')
        .update({ is_business, category: finalCat })
        .eq('id', id)

      if (updateErr) {
        txLog.error('failed to update already-categorized transaction', updateErr)
        return errorResponse(updateErr, txLog, { requestId })
      }

      return NextResponse.json({
        success: true,
        journal_entry_created: false,
        journal_entry_id: transaction.journal_entry_id,
        journal_entry_error: null,
        category: finalCat,
        already_had_journal_entry: true,
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('entity_type, fiscal_year_start_month')
      .eq('company_id', companyId)
      .single()

    const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'
    const fiscalYearStartMonth: number = settings?.fiscal_year_start_month ?? 1

    let finalCategory: TransactionCategory
    if (body.template_id) {
      const template = getTemplateById(body.template_id)
      if (!template) {
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_TEMPLATE', txLog, {
          requestId,
          details: { templateId: body.template_id, reason: 'unknown_template' },
        })
      }
      const entityValidation = validateTemplateForEntity(template, entityType)
      if (!entityValidation.valid) {
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_TEMPLATE', txLog, {
          requestId,
          details: { templateId: body.template_id, reason: entityValidation.error },
        })
      }
      finalCategory = is_business ? template.fallback_category : 'private'
      txLog.info('using template', {
        template: body.template_id,
        templateName: template.name_sv,
        category: finalCategory,
        debit: template.debit_account,
        credit: template.credit_account,
      })
    } else {
      finalCategory = is_business ? (category || 'uncategorized') : 'private'
      txLog.info('using category', {
        category: finalCategory,
        vatTreatment: body.vat_treatment ?? null,
        accountOverride: body.account_override ?? null,
      })
    }

    let mappingResult
    if (body.counterparty_template_id && is_business) {
      const { data: cpTemplate } = await supabase
        .from('categorization_templates')
        .select('*')
        .eq('id', body.counterparty_template_id)
        .eq('company_id', companyId)
        .eq('is_active', true)
        .maybeSingle()

      if (!cpTemplate) {
        return errorResponseFromCode('NOT_FOUND', txLog, {
          requestId,
          details: { resource: 'counterparty_template', id: body.counterparty_template_id },
        })
      }

      const match = {
        template: cpTemplate as CategorizationTemplate,
        matchMethod: 'exact_alias' as const,
        confidence: Number(cpTemplate.confidence),
      }
      mappingResult = buildMappingResultFromCounterpartyTemplate(match, transaction as Transaction, entityType)
      txLog.info('using counterparty template', {
        counterparty: cpTemplate.counterparty_name,
        lines: cpTemplate.line_pattern ? 'multi' : 'simple',
      })
    } else if (body.template_id) {
      const template = getTemplateById(body.template_id)!
      mappingResult = buildMappingResultFromTemplate(template, transaction as Transaction, entityType)
    } else {
      mappingResult = buildMappingResultFromCategory(
        finalCategory,
        transaction as Transaction,
        is_business,
        entityType,
        body.vat_treatment,
      )
    }

    // Book the bank leg against the transaction's ACTUAL settlement account
    // rather than the hardcoded 1930 in the templates. Without this, interest
    // or fees that landed on a savings/EUR account mis-book to 1930 and the
    // real bank line never reconciles. applySettlementAccount only rewrites a
    // 1930 leg and is a no-op when the settlement account is 1930 — so legacy
    // rows with no cash_account_id behave exactly as before.
    let settlementAccount = '1930'
    if (transaction.cash_account_id) {
      const { data: txCashAccount, error: cashAccountError } = await supabase
        .from('cash_accounts')
        .select('ledger_account')
        .eq('id', transaction.cash_account_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (cashAccountError) {
        // Don't fail the booking — fall back to 1930 — but surface the lookup
        // failure so a silent mis-booking to the wrong bank leg stays auditable.
        txLog.warn('settlement-account lookup failed; defaulting to 1930', {
          cashAccountId: transaction.cash_account_id,
          error: cashAccountError.message,
        })
      }
      if (txCashAccount?.ledger_account) {
        settlementAccount = txCashAccount.ledger_account as string
      }
    }
    mappingResult = applySettlementAccount(mappingResult, settlementAccount)

    txLog.info('mapping resolved', {
      debit: mappingResult.debit_account,
      credit: mappingResult.credit_account,
      allLinesComplete: mappingResult.all_lines_complete || false,
      vatLineCount: mappingResult.vat_lines.length,
    })

    if (is_business && body.account_override && !body.template_id && !body.counterparty_template_id) {
      const { data: accountExists } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_class')
        .eq('company_id', companyId)
        .eq('account_number', body.account_override)
        .eq('is_active', true)
        .single()

      if (!accountExists) {
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_ACCOUNT', txLog, {
          requestId,
          details: { accountNumber: body.account_override },
        })
      }

      if (transaction.amount < 0) {
        mappingResult.debit_account = body.account_override
      } else {
        mappingResult.credit_account = body.account_override
      }

      if (accountExists.account_class === 2) {
        mappingResult.vat_lines = []
      }
    }

    if (!mappingResult.debit_account || !mappingResult.credit_account) {
      return errorResponseFromCode('TX_CATEGORIZE_INVALID_MAPPING', txLog, {
        requestId,
        details: {
          debitAccount: mappingResult.debit_account,
          creditAccount: mappingResult.credit_account,
        },
      })
    }

    // Pre-validate every account the engine will resolve. Templates,
    // counterparty templates, and category defaults can all reference accounts
    // that aren't activated in this company's kontoplan. Without this check,
    // the engine throws AccountsNotInChartError mid-flight and the legacy
    // catch below silently marks the transaction as bokförd with no
    // verifikation. Catching it here means the row stays in "Att bokföra"
    // and the user gets a clear actionable message.
    const missingAccounts = await findMissingActiveAccounts(
      supabase,
      companyId,
      collectMappingResultAccounts(mappingResult),
    )
    if (missingAccounts.length > 0) {
      txLog.warn('mapping references inactive/missing accounts', { missingAccounts })
      return accountsNotInChartResponse(new AccountsNotInChartError(missingAccounts))
    }

    if (body.confirm_no_match && /^244\d$/.test(mappingResult.debit_account)) {
      txLog.warn('supplier-invoice match suggestion bypassed', {
        reason: 'confirm_no_match=true',
        debitAccount: mappingResult.debit_account,
        creditAccount: mappingResult.credit_account,
      })
    }
    if (body.confirm_no_match && /^151\d$/.test(mappingResult.credit_account)) {
      txLog.warn('customer-invoice match suggestion bypassed', {
        reason: 'confirm_no_match=true',
        debitAccount: mappingResult.debit_account,
        creditAccount: mappingResult.credit_account,
      })
    }

    // Prong B: intercept plain 244x categorization of supplier payments when
    // an open supplier invoice already covers this amount. Categorizing direct
    // to 244x leaves the invoice with status='approved' and lures the user
    // into a duplicate "Markera som betald" later. Credit must be a bank/cash
    // account (1xxx) — 244x against a clearing account, equity, etc. isn't a
    // supplier payment and the suggestion would misdirect the user.
    if (
      !body.confirm_no_match &&
      is_business &&
      transaction.amount < 0 &&
      /^244\d$/.test(mappingResult.debit_account) &&
      /^1\d{3}$/.test(mappingResult.credit_account)
    ) {
      const txAmountAbs = Math.abs(transaction.amount)
      const windowLow = Math.round(txAmountAbs * (1 - DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
      const windowHigh = Math.round(txAmountAbs * (1 + DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100

      let supplierIds: string[] = []
      if (transaction.merchant_name) {
        const escapedMerchant = escapeLikePattern(transaction.merchant_name)
        const { data: matchedSuppliers } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .ilike('name', `%${escapedMerchant}%`)
          .limit(10)
        supplierIds = (matchedSuppliers || []).map((s) => s.id)
      }

      if (supplierIds.length > 0) {
        // Restrict candidates to invoices within the date window relative to
        // the bank tx date. Without this, an open invoice from years back can
        // surface as a match and misdirect the user (swedish-compliance bot).
        const txDateMs = new Date(transaction.date).getTime()
        const invoiceDateLow = new Date(txDateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
          .toISOString()
          .split('T')[0]
        const invoiceDateHigh = new Date(txDateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
          .toISOString()
          .split('T')[0]

        const { data: openInvoices } = await supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, invoice_date, remaining_amount, currency, supplier:suppliers(name)')
          .eq('company_id', companyId)
          .in('supplier_id', supplierIds)
          .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
          .gte('remaining_amount', windowLow)
          .lte('remaining_amount', windowHigh)
          .gte('invoice_date', invoiceDateLow)
          .lte('invoice_date', invoiceDateHigh)
          .order('invoice_date', { ascending: false })
          .limit(5)

        if (openInvoices && openInvoices.length > 0) {
          return errorResponseFromCode('TX_CATEGORIZE_SUGGEST_SI_MATCH', txLog, {
            requestId,
            details: {
              candidates: openInvoices.map((inv) => ({
                supplier_invoice_id: inv.id,
                invoice_number: inv.supplier_invoice_number,
                invoice_date: inv.invoice_date,
                remaining_amount: inv.remaining_amount,
                currency: inv.currency,
                supplier_name: (inv.supplier as { name?: string } | null)?.name ?? null,
              })),
            },
          })
        }
      }
    }

    // Prong B (customer side): intercept plain 151x categorization of an
    // inbound payment when an unpaid customer invoice already covers this
    // amount. Symmetric with the supplier-side intercept above. The debit
    // must be a bank/cash account (^19\d{2}$, BAS class 19) — a 1xxx debit
    // outside class 19 isn't a payment receipt and the suggestion would
    // misdirect the user.
    if (
      !body.confirm_no_match &&
      is_business &&
      transaction.amount > 0 &&
      /^19\d{2}$/.test(mappingResult.debit_account) &&
      /^151\d$/.test(mappingResult.credit_account)
    ) {
      const txAmount = transaction.amount
      const windowLow = Math.round(txAmount * (1 - DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
      const windowHigh = Math.round(txAmount * (1 + DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100

      // Resolve candidate customer(s) by name. Inbound bank txs are typically
      // described by payer name in EITHER merchant_name OR description, so
      // search both. OCR-direct lookup is below.
      let customerIds: string[] = []
      const searchTerms: string[] = []
      if (transaction.merchant_name) searchTerms.push(transaction.merchant_name)
      if (transaction.description) searchTerms.push(transaction.description)
      const collected = new Set<string>()
      for (const term of searchTerms) {
        const escaped = escapeLikePattern(term)
        const { data: matched } = await supabase
          .from('customers')
          .select('id')
          .eq('company_id', companyId)
          .ilike('name', `%${escaped}%`)
          .limit(10)
        for (const c of matched ?? []) collected.add(c.id)
      }
      customerIds = Array.from(collected)

      // Date window anchored on `due_date`, NOT `invoice_date`. Customer
      // payments arrive close to (or after) the due date; for an invoice
      // with 60–90 day terms, anchoring on invoice_date would push the
      // expected payment outside a ±60-day window and the guard would miss
      // genuine matches. due_date is the better proxy for "around when the
      // payment is expected."
      const txDateMs = new Date(transaction.date).getTime()
      const dueDateLow = new Date(txDateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
        .toISOString()
        .split('T')[0]
      const dueDateHigh = new Date(txDateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
        .toISOString()
        .split('T')[0]

      type CandidateRow = {
        id: string
        invoice_number: string | null
        invoice_date: string
        due_date: string | null
        remaining_amount: number | null
        total: number
        currency: string
        customer: { name?: string } | null
      }
      const openInvoiceCandidates: CandidateRow[] = []

      if (customerIds.length > 0) {
        const { data: byCustomer } = await supabase
          .from('invoices')
          .select(
            'id, invoice_number, invoice_date, due_date, remaining_amount, total, currency, customer:customers(name)',
          )
          .eq('company_id', companyId)
          .in('customer_id', customerIds)
          .in('status', ['sent', 'overdue', 'partially_paid'])
          .gte('remaining_amount', windowLow)
          .lte('remaining_amount', windowHigh)
          .gte('due_date', dueDateLow)
          .lte('due_date', dueDateHigh)
          .order('due_date', { ascending: false })
          .limit(5)
        for (const row of (byCustomer ?? []) as unknown as CandidateRow[]) {
          openInvoiceCandidates.push(row)
        }
      }

      // OCR pass: if the bank-tx reference matches an open invoice's
      // invoice_number, surface it regardless of customer-name match. This
      // catches the common case where the bank populated `reference` but
      // neither merchant_name nor description carried the customer name.
      const txReference = (transaction as Transaction & { reference?: string | null }).reference
      const normalizedTxRef = normalizeOcrReference(txReference ?? null)
      if (normalizedTxRef) {
        const { data: byRef } = await supabase
          .from('invoices')
          .select(
            'id, invoice_number, invoice_date, due_date, remaining_amount, total, currency, customer:customers(name)',
          )
          .eq('company_id', companyId)
          .in('status', ['sent', 'overdue', 'partially_paid'])
          .gte('remaining_amount', windowLow)
          .lte('remaining_amount', windowHigh)
          .gte('due_date', dueDateLow)
          .lte('due_date', dueDateHigh)
          .order('due_date', { ascending: false })
          .limit(20)
        for (const row of (byRef ?? []) as unknown as CandidateRow[]) {
          if (normalizeOcrReference(row.invoice_number) === normalizedTxRef) {
            if (!openInvoiceCandidates.some((existing) => existing.id === row.id)) {
              openInvoiceCandidates.unshift(row)
            }
          }
        }
      }

      if (openInvoiceCandidates.length > 0) {
        return errorResponseFromCode('TX_CATEGORIZE_SUGGEST_CI_MATCH', txLog, {
          requestId,
          details: {
            candidates: openInvoiceCandidates.slice(0, 5).map((inv) => {
              const reasonOcr =
                normalizedTxRef && normalizeOcrReference(inv.invoice_number) === normalizedTxRef
              return {
                invoice_id: inv.id,
                invoice_number: inv.invoice_number,
                invoice_date: inv.invoice_date,
                remaining_amount: inv.remaining_amount ?? inv.total,
                currency: inv.currency,
                customer_name: inv.customer?.name ?? null,
                match_reason: reasonOcr ? ('ocr_exact' as const) : ('name_amount_fuzzy' as const),
              }
            }),
          },
        })
      }
    }

    await ensureFiscalPeriod(supabase, user.id, companyId, transaction.date, fiscalYearStartMonth, txLog)

    let journalEntryCreated = false
    let journalEntryId: string | null = null
    let journalEntryError: string | null = null
    let documentLinkWarning: string | null = null

    try {
      const journalEntry = await createTransactionJournalEntry(
        supabase,
        companyId,
        user.id,
        transaction as Transaction,
        mappingResult,
      )

      if (journalEntry) {
        journalEntryCreated = true
        journalEntryId = journalEntry.id
      }
    } catch (err) {
      txLog.error('failed to create transaction journal entry', err as Error)
      // AccountsNotInChartError means an account was deactivated between our
      // pre-validation and the engine call (rare race). Don't fall through to
      // the partial-success path — that would mark the transaction bokförd
      // with no verifikation and leave the user staring at an unclosable
      // dialog. Return a structured 400 so the row stays in "Att bokföra"
      // and the user can re-activate the account and retry.
      if (err instanceof AccountsNotInChartError) {
        return accountsNotInChartResponse(err)
      }
      // Bookkeeping errors map to Swedish via the registry. Other errors get
      // their raw message — the categorization is preserved either way so the
      // user can still re-book the verifikation manually.
      if (isBookkeepingError(err)) {
        journalEntryError = getErrorMessage(err, { context: 'transaction' })
      } else {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }
    }

    if (is_business && transaction.merchant_name) {
      try {
        await saveUserMappingRule(
          supabase,
          companyId,
          transaction.merchant_name,
          mappingResult.debit_account,
          mappingResult.credit_account,
          !is_business,
          body.user_description,
          body.template_id,
        )
      } catch (err) {
        txLog.warn('failed to save mapping rule (non-critical)', err as Error)
      }
    }

    try {
      await upsertCounterpartyTemplate(
        supabase, user.id, transaction as Transaction, mappingResult, 'user_approved',
      )
    } catch (err) {
      txLog.warn('failed to upsert counterparty template (non-critical)', err as Error)
    }

    if (journalEntryId && transaction.receipt_id) {
      try {
        const { data: receipt } = await supabase
          .from('receipts')
          .select('document_id')
          .eq('id', transaction.receipt_id)
          .single()

        if (receipt?.document_id) {
          await supabase
            .from('document_attachments')
            .update({ journal_entry_id: journalEntryId })
            .eq('id', receipt.document_id)
            .eq('company_id', companyId)
        }
      } catch (linkErr) {
        txLog.warn('failed to link receipt document (non-critical)', linkErr as Error)
      }
    } else if (journalEntryId && transaction.document_id) {
      // Document was pinned to the transaction (via /attach-document or MCP) before
      // categorization. Propagate the link to the journal entry so
      // receipt-on-verifikation (BFL 5 kap 6 §) is satisfied. The journal entry has
      // already been committed at this point, so we can't roll it back; instead
      // surface a warning in the response so the UI can prompt the user to retry
      // the link. Supabase JS returns { error } rather than throwing — destructure
      // and surface it, never swallow silently.
      try {
        const { error: linkErr } = await supabase
          .from('document_attachments')
          .update({ journal_entry_id: journalEntryId })
          .eq('id', transaction.document_id)
          .eq('company_id', companyId)
        if (linkErr) {
          txLog.error('failed to link transaction document', linkErr, {
            documentId: transaction.document_id,
          })
          documentLinkWarning =
            'Verifikationen skapades men bilagan kunde inte länkas till den. Försök länka om bilagan manuellt.'
        }
      } catch (docErr) {
        txLog.error('failed to link transaction document', docErr as Error, {
          documentId: transaction.document_id,
        })
        documentLinkWarning =
          'Verifikationen skapades men bilagan kunde inte länkas till den. Försök länka om bilagan manuellt.'
      }
    }

    if (body.inbox_item_id && journalEntryId) {
      try {
        const { data: inboxItem } = await supabase
          .from('invoice_inbox_items')
          .select('document_id')
          .eq('id', body.inbox_item_id)
          .eq('company_id', companyId)
          .single()

        if (inboxItem?.document_id) {
          await supabase
            .from('document_attachments')
            .update({ journal_entry_id: journalEntryId })
            .eq('id', inboxItem.document_id)
            .eq('company_id', companyId)
        }

        // Reflect the booking back onto the inbox row so it stops appearing as
        // unmatched. Categorizing here puts the underlag on a verifikation,
        // which is the inbox's "booked" state. Without this the inbox keeps
        // offering "Matcha mot transaktion" for an underlag that's already on a
        // posted entry — while the transactions view (which reads the
        // doc↔verifikat link) already shows it as attached. Mirrors the
        // backfill that /attach-document does for the manual paperclip path.
        await supabase
          .from('invoice_inbox_items')
          .update({
            matched_transaction_id: id,
            created_journal_entry_id: journalEntryId,
          })
          .eq('id', body.inbox_item_id)
          .eq('company_id', companyId)
      } catch (inboxErr) {
        txLog.warn('failed to sync inbox item after booking (non-critical)', inboxErr as Error)
      }
    }

    const { data: updateResult, error: updateError } = await supabase
      .from('transactions')
      .update({
        is_business,
        category: finalCategory,
        journal_entry_id: journalEntryId,
      })
      .eq('id', id)
      .is('journal_entry_id', null)
      .select('id')

    if (updateError) {
      txLog.error('failed to update transaction', updateError)
      return errorResponse(updateError, txLog, { requestId })
    }

    if ((!updateResult || updateResult.length === 0) && journalEntryId) {
      // CAS guard: another request set journal_entry_id between our read and
      // write. Cancel the orphaned entry and document the voucher gap.
      const { data: orphan } = await supabase
        .from('journal_entries')
        .select('fiscal_period_id, voucher_series, voucher_number')
        .eq('id', journalEntryId)
        .single()

      await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', journalEntryId)

      if (orphan) {
        await supabase.from('voucher_gap_explanations').insert({
          company_id: companyId,
          fiscal_period_id: orphan.fiscal_period_id,
          voucher_series: orphan.voucher_series || 'A',
          gap_number: orphan.voucher_number,
          explanation: 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
          created_by: user.id,
        })
      }

      return errorResponseFromCode('TX_CATEGORIZE_RACE', txLog, { requestId })
    }

    // Flag any inbox underlag already matched to this transaction as booked.
    // The block above only fires when the caller passes an explicit
    // inbox_item_id (booking straight from the inbox flow). Booking the same
    // transaction from anywhere else — the /transactions list, quick review —
    // would otherwise leave an attached underlag stuck as "Kopplad" in the
    // inbox forever. Here we resolve it by the link itself (matched_transaction
    // _id) so the inbox reflects the booking regardless of entry point. Mirrors
    // the propagation in lib/pending-operations/commit.ts. Runs post-CAS so we
    // never stamp the inbox with a journal entry that lost the race.
    if (journalEntryId) {
      try {
        const { data: matchedInboxItems } = await supabase
          .from('invoice_inbox_items')
          .select('id, document_id')
          .eq('company_id', companyId)
          .eq('matched_transaction_id', id)
          .is('created_journal_entry_id', null)

        for (const inbox of (matchedInboxItems ?? []) as Array<{
          id: string
          document_id: string | null
        }>) {
          if (inbox.document_id) {
            await supabase
              .from('document_attachments')
              .update({ journal_entry_id: journalEntryId })
              .eq('id', inbox.document_id)
              .eq('company_id', companyId)
          }
          await supabase
            .from('invoice_inbox_items')
            .update({ created_journal_entry_id: journalEntryId })
            .eq('id', inbox.id)
            .eq('company_id', companyId)
        }
      } catch (inboxErr) {
        txLog.warn('failed to flag matched inbox items after booking (non-critical)', inboxErr as Error)
      }
    }

    await eventBus.emit({
      type: 'transaction.categorized',
      payload: {
        transaction: transaction as Transaction,
        account: mappingResult.debit_account,
        taxCode: mappingResult.vat_lines[0]?.account_number || '',
        userId: user.id,
        companyId,
      },
    })

    if (journalEntryError) {
      // Categorization stuck but the verifikation didn't make it through.
      // Surface as a structured warning — the response below carries the
      // user-facing message in `journal_entry_error`.
      txLog.warn('partial outcome: journal entry creation failed', {
        reason: 'journal_entry_creation_failed',
        message: journalEntryError,
      })
    }

    return NextResponse.json({
      success: true,
      journal_entry_created: journalEntryCreated,
      journal_entry_id: journalEntryId,
      journal_entry_error: journalEntryError,
      document_link_warning: documentLinkWarning,
      category: finalCategory,
    })
  },
  { requireWrite: true },
)
