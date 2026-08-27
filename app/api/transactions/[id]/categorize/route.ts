import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { getTemplateById, buildMappingResultFromTemplate, validateTemplateForEntity } from '@/lib/bookkeeping/booking-templates'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { getEarliestFiscalPeriodStart } from '@/lib/core/bookkeeping/period-service'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { saveUserMappingRule, applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { upsertCounterpartyTemplate, buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode, getStructuredError } from '@/lib/errors/get-structured-error'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
  normalizeOcrReference,
} from '@/lib/invoices/duplicate-payment-guard'
import {
  invoiceAmountSek,
  magnitudesWithinTolerance,
  normalizeCurrencyCode,
  planAmountSweeps,
  type ComparableAmount,
} from '@/lib/invoices/duplicate-guard-currency'
import { resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
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

  // Pre-FY guard (issue #1825): a date before the company's first fiscal
  // period must NEVER mint a calendar-year rakenskapsar. Depending on overlap
  // with the real first period, the upsert below would either bounce off the
  // no_overlapping_fiscal_periods exclusion constraint (log noise) or silently
  // create a pre-registration year (legally wrong). Return true and let the
  // pre-FY clamp in createTransactionJournalEntry book the event on the first
  // fiscal year's first day. Dates AFTER the latest period (next-year
  // auto-creation) pass through unchanged.
  const earliestStart = await getEarliestFiscalPeriodStart(supabase, companyId)
  if (earliestStart && date < earliestStart) return true

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
        .update({ is_business, category: finalCat, is_ignored: false })
        .eq('id', id)
        .eq('company_id', companyId)

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

    // Booking-time duplicate guard: this transaction is about to become a NEW
    // verifikat. If another transaction on the same date+amount+account is
    // already booked, booking this one double-counts one real affärshändelse
    // (felaktig bokföring per BFL). Warn; the user confirms with force=true
    // bound to the reviewed sibling. Mirrors the match-invoice soft-duplicate
    // guard. Runs before any categorization work so the user resolves it first.
    try {
      const candidate = await detectBookingDuplicate(supabase, companyId, {
        id,
        date: transaction.date,
        amount: transaction.amount,
        // `amount` is denominated in `currency`; the ledger legs the guard
        // compares it against are always SEK. Selected above via select('*').
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
      })
      if (!body.force) {
        if (candidate) {
          return errorResponseFromCode('TRANSACTION_BOOK_POSSIBLE_DUPLICATE', txLog, {
            requestId,
            details: { candidate },
          })
        }
      } else if (
        // force=true is bound to the reviewed candidate. A sibling-transaction
        // candidate carries a transaction_id; a ledger-only voucher candidate
        // does not, so both are bound by journal_entry_id. Re-detect and refuse
        // the bypass unless it still matches, so a guessed id can't wave it away.
        !candidate ||
        !(
          (candidate.journal_entry_id && candidate.journal_entry_id === body.expected_duplicate_journal_entry_id) ||
          (candidate.transaction_id && candidate.transaction_id === body.expected_duplicate_transaction_id)
        )
      ) {
        return errorResponseFromCode('TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH', txLog, {
          requestId,
          details: {
            expected_duplicate_transaction_id: body.expected_duplicate_transaction_id ?? null,
            expected_duplicate_journal_entry_id: body.expected_duplicate_journal_entry_id ?? null,
            detected_transaction_id: candidate?.transaction_id ?? null,
            detected_journal_entry_id: candidate?.journal_entry_id ?? null,
          },
        })
      } else {
        txLog.warn('booking-time duplicate guard bypassed', {
          reason: 'force=true',
          requestId,
          dismissedTransactionId: candidate.transaction_id,
        })
        // Persist the dismissal to behandlingshistorik (BFNAR 2013:2 kap 8):         // booking over a DETECTED possible double-booking is a bookkeeping
        // decision that needs a durable record. Best-effort; never blocks the
        // booking.
        try {
          await appendProcessingHistory({
            companyId,
            correlationId: id,
            aggregateType: 'BankTransaction',
            aggregateId: id,
            eventType: 'BankTransactionDuplicateDismissed',
            payload: {
              transaction_id: id,
              dismissed_transaction_id: candidate.transaction_id,
              dismissed_journal_entry_id: candidate.journal_entry_id,
              // Null when the candidate's SEK value could not be established
              // (a rateless foreign sibling); the foreign figures below then
              // carry the durable record instead of a fabricated kr amount.
              amount_ore: candidate.amount != null ? Math.round(candidate.amount * 100) : null,
              dismissed_currency: candidate.currency,
              dismissed_amount_in_currency: candidate.amount_in_currency,
              entry_date: candidate.entry_date,
              // Whether the user dismissed a confirmed same-amount twin or a
              // candidate whose kr figure was never established (BFNAR 2013:2
              // kap 8: the behandlingshistorik has to say which). Parity with
              // the /book route's dismissal record.
              amount_verified: candidate.amount_verified,
              unverified_reason: candidate.unverified_reason,
            },
            actor: { type: 'user', id: user.id },
            occurredAt: new Date(),
          })
        } catch (logErr) {
          txLog.error('failed to append duplicate-dismissal behandlingshistorik', logErr as Error)
        }
      }
    } catch (err) {
      if (body.force) {
        return errorResponseFromCode('TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH', txLog, {
          requestId,
          details: { detection_failed: true },
        })
      }
      txLog.warn('booking-time duplicate detection failed (continuing)', err as Error)
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
    // 1930 leg and is a no-op when the settlement account is 1930, so legacy
    // rows with no cash_account_id behave exactly as before.
    const settlementAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      txLog,
      transaction.currency,
    )
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

    // Dimensions: an explicitly picked bag tags the business lines of the
    // generated verifikat (bank/VAT legs stay untagged, see
    // buildTransactionEntryLines). It wins over a learned counterparty-
    // template bag; omitted = the learned bag (if any) applies unchanged.
    if (body.dimensions && Object.keys(body.dimensions).length > 0) {
      mappingResult.dimensions = body.dimensions
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
    //
    // Only truly unresolvable accounts block: a standard BAS account that is
    // merely absent from the chart is seeded on demand by the engine, so the
    // user can always book the row without registering accounts first.
    const missingAccounts = await findUnresolvableAccounts(
      supabase,
      companyId,
      collectMappingResultAccounts(mappingResult),
    )
    if (missingAccounts.length > 0) {
      txLog.warn('mapping references inactive/unknown accounts', { missingAccounts })
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

    // Units for both invoice-suggestion prongs below. `transactions.amount` is
    // denominated in `transactions.currency`, while `remaining_amount` on
    // `supplier_invoices` / `invoices` is denominated in the INVOICE's
    // currency. A plus-minus 2 % band built around a EUR bank row and applied
    // to a kronor `remaining_amount` column is off by the whole exchange rate:
    // it either matches nothing or points the user at an unrelated invoice.
    // `planAmountSweeps` therefore issues one SQL sweep per currency (band and
    // column in the same unit) and `magnitudesWithinTolerance` re-checks every
    // returned row. A SEK transaction yields exactly one sweep with the band it
    // had before, so a SEK-only company runs the identical single query.
    const txReferenceAmount: ComparableAmount = {
      amount: transaction.amount,
      currency: normalizeCurrencyCode(transaction.currency),
      sek: resolveTransactionAmountSek({
        amount: transaction.amount,
        currency: transaction.currency,
        amount_sek: transaction.amount_sek,
        exchange_rate: transaction.exchange_rate,
      }),
    }

    /** A candidate invoice row as a comparable amount (pro-rates `total_sek`). */
    const invoiceRowAmount = (row: {
      remaining_amount: number | null
      total?: number | null
      currency: string | null
      total_sek?: number | null
      exchange_rate?: number | null
    }): ComparableAmount => {
      const remaining = row.remaining_amount ?? row.total ?? 0
      const currency = normalizeCurrencyCode(row.currency)
      return {
        amount: Number(remaining),
        currency,
        sek: invoiceAmountSek({
          amount: Number(remaining),
          currency,
          total: row.total,
          totalSek: row.total_sek,
          exchangeRate: row.exchange_rate,
        }),
      }
    }

    // Prong B: intercept plain 244x categorization of supplier payments when
    // an open supplier invoice already covers this amount. Categorizing direct
    // to 244x leaves the invoice with status='approved' and lures the user
    // into a duplicate "Markera som betald" later. Credit must be a bank/cash
    // account (1xxx): 244x against a clearing account, equity, etc. isn't a
    // supplier payment and the suggestion would misdirect the user.
    if (
      !body.confirm_no_match &&
      is_business &&
      transaction.amount < 0 &&
      /^244\d$/.test(mappingResult.debit_account) &&
      /^1\d{3}$/.test(mappingResult.credit_account)
    ) {
      const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
        txReferenceAmount,
        DUPLICATE_AMOUNT_TOLERANCE_PCT,
      )
      if (crossCurrencyUnverifiable) {
        // A foreign bank row with neither amount_sek nor exchange_rate cannot
        // be stated in kronor, so kronor invoices are excluded rather than
        // compared raw. Logged: an unevaluated candidate set is not the same
        // thing as "no open invoice matches".
        txLog.warn('supplier-invoice suggestion: cross-currency candidates not evaluated', {
          reason: 'transaction_missing_sek_value',
          currency: txReferenceAmount.currency,
        })
      }

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

        type SupplierCandidateRow = {
          id: string
          supplier_invoice_number: string | null
          invoice_date: string
          remaining_amount: number | null
          total: number | null
          currency: string | null
          total_sek: number | null
          exchange_rate: number | null
          supplier: { name?: string } | null
        }

        const sweepResults = await Promise.all(
          sweeps.map((sweep) =>
            supabase
              .from('supplier_invoices')
              .select(
                'id, supplier_invoice_number, invoice_date, remaining_amount, total, currency, total_sek, exchange_rate, supplier:suppliers(name)',
              )
              .eq('company_id', companyId)
              .in('supplier_id', supplierIds)
              .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
              .or(sweep.currencyFilter)
              .gte('remaining_amount', sweep.low)
              .lte('remaining_amount', sweep.high)
              .gte('invoice_date', invoiceDateLow)
              .lte('invoice_date', invoiceDateHigh)
              .order('invoice_date', { ascending: false })
              .limit(5),
          ),
        )

        const byId = new Map<string, SupplierCandidateRow>()
        for (const res of sweepResults) {
          for (const row of (res.data ?? []) as unknown as SupplierCandidateRow[]) {
            if (!byId.has(row.id)) byId.set(row.id, row)
          }
        }
        const openInvoices = Array.from(byId.values())
          .filter((inv) =>
            magnitudesWithinTolerance(
              txReferenceAmount,
              invoiceRowAmount(inv),
              DUPLICATE_AMOUNT_TOLERANCE_PCT,
            ),
          )
          .sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : a.invoice_date > b.invoice_date ? -1 : 0))
          .slice(0, 5)

        if (openInvoices.length > 0) {
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
    // must be a bank/cash account (^19\d{2}$, BAS class 19): a 1xxx debit
    // outside class 19 isn't a payment receipt and the suggestion would
    // misdirect the user.
    if (
      !body.confirm_no_match &&
      is_business &&
      transaction.amount > 0 &&
      /^19\d{2}$/.test(mappingResult.debit_account) &&
      /^151\d$/.test(mappingResult.credit_account)
    ) {
      const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
        txReferenceAmount,
        DUPLICATE_AMOUNT_TOLERANCE_PCT,
      )
      if (crossCurrencyUnverifiable) {
        txLog.warn('customer-invoice suggestion: cross-currency candidates not evaluated', {
          reason: 'transaction_missing_sek_value',
          currency: txReferenceAmount.currency,
        })
      }

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
      // with 60-90 day terms, anchoring on invoice_date would push the
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
        currency: string | null
        total_sek: number | null
        exchange_rate: number | null
        customer: { name?: string } | null
      }
      const CANDIDATE_COLUMNS =
        'id, invoice_number, invoice_date, due_date, remaining_amount, total, currency, total_sek, exchange_rate, customer:customers(name)'
      const openInvoiceCandidates: CandidateRow[] = []
      /** Same-unit re-check: drops any row the SQL sweep let through. */
      const comparable = (row: CandidateRow) =>
        magnitudesWithinTolerance(
          txReferenceAmount,
          invoiceRowAmount(row),
          DUPLICATE_AMOUNT_TOLERANCE_PCT,
        )

      if (customerIds.length > 0) {
        const sweepResults = await Promise.all(
          sweeps.map((sweep) =>
            supabase
              .from('invoices')
              .select(CANDIDATE_COLUMNS)
              .eq('company_id', companyId)
              .in('customer_id', customerIds)
              .in('status', ['sent', 'overdue', 'partially_paid'])
              .or(sweep.currencyFilter)
              .gte('remaining_amount', sweep.low)
              .lte('remaining_amount', sweep.high)
              .gte('due_date', dueDateLow)
              .lte('due_date', dueDateHigh)
              .order('due_date', { ascending: false })
              .limit(5),
          ),
        )
        for (const res of sweepResults) {
          for (const row of (res.data ?? []) as unknown as CandidateRow[]) {
            if (!comparable(row)) continue
            if (!openInvoiceCandidates.some((existing) => existing.id === row.id)) {
              openInvoiceCandidates.push(row)
            }
          }
        }
      }

      // OCR pass: if the bank-tx reference matches an open invoice's
      // invoice_number, surface it regardless of customer-name match. This
      // catches the common case where the bank populated `reference` but
      // neither merchant_name nor description carried the customer name.
      const txReference = (transaction as Transaction & { reference?: string | null }).reference
      const normalizedTxRef = normalizeOcrReference(txReference ?? null)
      if (normalizedTxRef) {
        const refSweepResults = await Promise.all(
          sweeps.map((sweep) =>
            supabase
              .from('invoices')
              .select(CANDIDATE_COLUMNS)
              .eq('company_id', companyId)
              .in('status', ['sent', 'overdue', 'partially_paid'])
              .or(sweep.currencyFilter)
              .gte('remaining_amount', sweep.low)
              .lte('remaining_amount', sweep.high)
              .gte('due_date', dueDateLow)
              .lte('due_date', dueDateHigh)
              .order('due_date', { ascending: false })
              .limit(20),
          ),
        )
        for (const res of refSweepResults) {
          for (const row of (res.data ?? []) as unknown as CandidateRow[]) {
            if (normalizeOcrReference(row.invoice_number) !== normalizedTxRef) continue
            if (!comparable(row)) continue
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
      // the partial-success path: that would mark the transaction bokförd
      // with no verifikation and leave the user staring at an unclosable
      // dialog. Return a structured 400 so the row stays in "Att bokföra"
      // and the user can re-activate the account and retry.
      if (err instanceof AccountsNotInChartError) {
        return accountsNotInChartResponse(err)
      }
      // Fail closed (issue #1947): the verifikat IS the booking. Writing
      // is_business/category without one used to drop the row out of the
      // canonical worklist predicate in lib/worklist/types.ts (is_business IS
      // NULL) while it was still unbooked, so it vanished from "Att bokföra"
      // and the nav badge with no reminder to finish it. Nothing is persisted
      // when the entry fails: the row stays uncategorized and visible. The
      // Swedish reason comes from getErrorMessage; the raw message is already
      // logged above and must never reach the user verbatim (issue #337).
      return errorResponseFromCode('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED', txLog, {
        requestId,
        messageSv: getErrorMessage(err, { context: 'transaction' }),
        details: { cause: getStructuredError(err).code },
      })
    }

    // createTransactionJournalEntry returns null (no throw) when no fiscal
    // period covers the date and the pre-FY clamp does not apply. Same
    // fail-closed rule: refuse rather than mark the row categorized-but-unbooked.
    if (!journalEntryId) {
      return errorResponseFromCode('NO_OPEN_PERIOD_FOR_DATE', txLog, {
        requestId,
        details: { transaction_date: transaction.date },
      })
    }

    // Learning writes (mapping rule, counterparty template) run only after a
    // posted verifikat, so they never learn from a booking that did not happen.
    // direction_mismatch = a mirrored refund/repayment booking; learning it
    // as a rule would store backwards accounts for the merchant.
    if (is_business && transaction.merchant_name && !mappingResult.direction_mismatch) {
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
      // Templates are company-scoped since the multi-tenant refactor: passing
      // user.id here broke learning entirely (FK/RLS reject the write).
      await upsertCounterpartyTemplate(
        supabase, companyId, transaction as Transaction, mappingResult, 'user_approved',
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
      // the link. Supabase JS returns { error } rather than throwing: destructure
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
        // posted entry, while the transactions view (which reads the
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
        is_ignored: false,
        journal_entry_id: journalEntryId,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .select('*')

    if (updateError) {
      txLog.error('failed to update transaction', updateError)
      if (journalEntryId) {
        await reverseOrphanedJournalEntry(
          supabase,
          companyId,
          user.id,
          journalEntryId,
          'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
        )
      }
      return errorResponse(updateError, txLog, { requestId })
    }

    if (!updateResult || updateResult.length === 0) {
      // CAS guard: another request set journal_entry_id between our read and
      // write. If this request posted an orphan, compensate through the
      // bookkeeping engine with a storno entry.
      if (journalEntryId) {
        await reverseOrphanedJournalEntry(
          supabase,
          companyId,
          user.id,
          journalEntryId,
          'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
        )
      }

      return errorResponseFromCode('TX_CATEGORIZE_RACE', txLog, { requestId })
    }

    const updatedTransaction = updateResult[0] as Transaction

    // Flag any inbox underlag already matched to this transaction as booked.
    // The block above only fires when the caller passes an explicit
    // inbox_item_id (booking straight from the inbox flow). Booking the same
    // transaction from anywhere else (the /transactions list, quick review)
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
        transaction: updatedTransaction,
        account: mappingResult.debit_account,
        taxCode: mappingResult.vat_lines[0]?.account_number || '',
        userId: user.id,
        companyId,
      },
    })

    // journal_entry_error is always null here: a failed verifikat now returns
    // a typed 409 above (issue #1947). The field stays for client compatibility.
    return NextResponse.json({
      success: true,
      journal_entry_created: journalEntryCreated,
      journal_entry_id: journalEntryId,
      journal_entry_error: null,
      document_link_warning: documentLinkWarning,
      category: finalCategory,
    })
  },
  { requireWrite: true },
)
