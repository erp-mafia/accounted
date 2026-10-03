import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { reconcileRcBasisWithCostAccount } from '@/lib/bookkeeping/account-override'
import { getTemplateById, buildMappingResultFromTemplate, validateTemplateForEntity } from '@/lib/bookkeeping/booking-templates'
import { applyVatAmountOverride } from '@/lib/bookkeeping/vat-amount-override'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { getEarliestFiscalPeriodStart } from '@/lib/core/bookkeeping/period-service'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { runBookingDuplicateGuard } from '@/lib/transactions/booking-duplicate-guard'
import { assertTransactionBookable } from '@/lib/transactions/is-booked'
import { findInvoiceMatchSuggestion } from '@/lib/transactions/invoice-match-suggestion'
import { saveUserMappingRule, applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { guardCounterLegs } from '@/lib/cash-accounts/service'
import {
  upsertCounterpartyTemplate,
  buildMappingResultFromCounterpartyTemplate,
  loadCounterpartyTemplateMatch,
} from '@/lib/bookkeeping/counterparty-templates'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode, getStructuredError } from '@/lib/errors/get-structured-error'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { Logger } from '@/lib/logger'
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

    // A NULL pointer is not "unbooked": a row bulk-booked into a
    // samlingsverifikat, split 1:N, or re-pointed by a correction is anchored
    // only through a bank_line voucher link. Shared with every booking door.
    const bookable = await assertTransactionBookable(supabase, companyId, transaction)
    if (!bookable.ok) {
      return errorResponseFromCode(bookable.code, txLog, {
        requestId,
        details: { journal_entry_id: bookable.journalEntryId, via: bookable.via },
      })
    }

    // Booking-time duplicate guard: this transaction is about to become a NEW
    // verifikat. If the ledger already books this affärshändelse (a booked
    // sibling transaction, or a voucher booking the same amount on the bank
    // account), booking this one double-counts it (felaktig bokföring per
    // BFL). Warn; the user confirms with force=true bound to the reviewed
    // candidate, and the dismissal is recorded in behandlingshistorik. Shared
    // with the v1 :categorize and batch-categorize doors. Runs before any
    // categorization work so the user resolves it first.
    const duplicateVerdict = await runBookingDuplicateGuard(
      supabase,
      companyId,
      user.id,
      {
        id,
        date: transaction.date,
        amount: transaction.amount,
        // `amount` is denominated in `currency`; the ledger legs the guard
        // compares it against are always SEK. Selected above via select('*').
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
      },
      body,
      txLog,
    )
    if (!duplicateVerdict.ok) {
      return errorResponseFromCode(duplicateVerdict.code, txLog, {
        requestId,
        details: duplicateVerdict.details,
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('entity_type, fiscal_year_start_month, vat_registered')
      .eq('company_id', companyId)
      .single()

    const entityType: EntityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
    const fiscalYearStartMonth: number = settings?.fiscal_year_start_month ?? 1
    // Icke momsregistrerad verksamhet books no moms line on a bank
    // transaction (lib/bookkeeping/vat-registration.ts); passed as loaded.
    const vatRegistered: boolean | null = settings?.vat_registered ?? null

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
      // Learned codes the registry no longer accepts are dropped on load; an
      // explicit body.dimensions (applied below) is never filtered.
      const match = await loadCounterpartyTemplateMatch(supabase, companyId, body.counterparty_template_id)

      if (!match) {
        return errorResponseFromCode('NOT_FOUND', txLog, {
          requestId,
          details: { resource: 'counterparty_template', id: body.counterparty_template_id },
        })
      }

      mappingResult = buildMappingResultFromCounterpartyTemplate(
        match, transaction as Transaction, entityType, vatRegistered,
      )
      txLog.info('using counterparty template', {
        counterparty: match.template.counterparty_name,
        lines: match.template.line_pattern ? 'multi' : 'simple',
      })
    } else if (body.template_id) {
      const template = getTemplateById(body.template_id)!
      mappingResult = buildMappingResultFromTemplate(template, transaction as Transaction, entityType, vatRegistered)
      if (body.vat_amount != null) {
        // The underlag's moms replaces the template's rate-based line; the
        // helper refuses treatments it cannot apply to, which is a 400.
        try {
          mappingResult = applyVatAmountOverride(mappingResult, transaction as Transaction, template.vat_treatment, body.vat_amount)
        } catch (err) {
          txLog.warn('vat_amount rejected for template booking', err as Error)
          return errorResponseFromCode('TX_CATEGORIZE_INVALID_VAT_AMOUNT', txLog, {
            requestId,
            details: { vat_amount: body.vat_amount, vat_treatment: template.vat_treatment ?? null },
          })
        }
      }
    } else {
      try {
        mappingResult = buildMappingResultFromCategory(
          finalCategory,
          transaction as Transaction,
          is_business,
          entityType,
          body.vat_treatment,
          body.vat_amount ?? null,
          vatRegistered,
        )
      } catch (err) {
        if (body.vat_amount == null) throw err
        txLog.warn('vat_amount rejected for category booking', err as Error)
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_VAT_AMOUNT', txLog, {
          requestId,
          details: { vat_amount: body.vat_amount, vat_treatment: body.vat_treatment ?? null },
        })
      }
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
        .select('account_number, account_class, default_vat_treatment')
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
      // A reverse-charge cost line moved onto an account that reports ruta
      // 20-24 itself must not keep the category's basis pair (#2919).
      mappingResult = reconcileRcBasisWithCostAccount(
        mappingResult,
        transaction.amount,
        body.account_override,
        accountExists.default_vat_treatment ?? null,
      )
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

    // Issue #1643 problem 4: a learned template or transfer proposal must never
    // book the COUNTER leg onto an orphaned cash-account ledger, or onto a twin
    // ledger of the transaction's own bank account. Confirming such a proposal
    // silently drops revenue/expense from the P&L onto a junk balance-sheet
    // account. A twin that is merely the stale BANK leg of a learned template
    // is rewritten to the settlement account instead (see guardCounterLegs).
    {
      const guarded = await guardCounterLegs(
        supabase,
        companyId!,
        mappingResult,
        settlementAccount,
        transaction.cash_account_id,
      )
      if (guarded.refusedLedger) {
        return errorResponseFromCode('TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT', txLog, {
          requestId,
          details: { accountNumber: guarded.refusedLedger },
        })
      }
      mappingResult = guarded.mappingResult
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

    // Invoice-match intercept (Prong B): a plain 244x categorization of a
    // supplier payment, or 151x of an inbound payment, while an open invoice
    // covers the amount is refused with the candidates so the user matches the
    // invoice instead; confirm_no_match keeps the plain categorization. Shared
    // with the v1 :categorize and batch-categorize doors.
    const invoiceSuggestion = await findInvoiceMatchSuggestion(
      supabase,
      companyId,
      {
        transaction: transaction as Transaction & { reference?: string | null },
        debitAccount: mappingResult.debit_account,
        creditAccount: mappingResult.credit_account,
        isBusiness: is_business,
        confirmNoMatch: body.confirm_no_match,
      },
      txLog,
    )
    if (invoiceSuggestion) {
      return errorResponseFromCode(invoiceSuggestion.code, txLog, {
        requestId,
        details: invoiceSuggestion.details,
      })
    }

    await ensureFiscalPeriod(supabase, user.id, companyId, transaction.date, fiscalYearStartMonth, txLog)

    // Issue #1661: a private marking books eget uttag/insättning, so a locked
    // period refuses it like any verifikat. Pre-check only for private rows:
    // the trigger path below would answer with a bare locked-period cause,
    // while the row the user wants to clear (a duplicate, a PSD2 ghost) is
    // usually no affärshändelse at all and should be ignored instead. The
    // response carries suggested_action: 'ignore' for the one-click toast.
    if (!is_business) {
      const privateLock = await checkPeriodLock(supabase, companyId, transaction.date)
      if (privateLock.locked) {
        return errorResponseFromCode('TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED', txLog, {
          requestId,
          details: {
            transaction_date: transaction.date,
            reason: privateLock.reason,
            fiscal_period_id: privateLock.fiscal_period_id,
            suggested_action: 'ignore',
          },
        })
      }
    }

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
      // when the entry fails: the row stays uncategorized and visible. Both
      // message locales come from getErrorMessage (sv/en from the same error,
      // per the errorResponseFromCode contract: provide both or neither); the
      // raw message is already logged above and must never reach the user
      // verbatim (issue #337).
      const structured = getStructuredError(err)
      return errorResponseFromCode('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED', txLog, {
        requestId,
        messageSv: getErrorMessage(err, { context: 'transaction' }),
        messageEn: getErrorMessage(err, { context: 'transaction', locale: 'en' }),
        details: { cause: structured.code },
      })
    }

    // createTransactionJournalEntry returns null (no throw) when
    // findFiscalPeriod sees no OPEN period covering the date and the pre-FY
    // clamp does not apply: either no fiscal period exists there at all, or
    // the covering period exists but is closed (is_closed = true; findFiscalPeriod
    // filters is_closed = false). Same fail-closed rule either way: refuse
    // rather than mark the row categorized-but-unbooked. checkPeriodLock tells
    // the two apart so a closed year answers PERIOD_LOCKED (reason
    // period_is_closed) instead of claiming the räkenskapsår does not exist.
    if (!journalEntryId) {
      const periodLock = await checkPeriodLock(supabase, companyId, transaction.date)
      if (periodLock.locked) {
        return errorResponseFromCode(
          is_business ? 'PERIOD_LOCKED' : 'TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED',
          txLog,
          {
            requestId,
            details: {
              transaction_date: transaction.date,
              reason: periodLock.reason,
              fiscal_period_id: periodLock.fiscal_period_id,
              ...(is_business ? {} : { suggested_action: 'ignore' }),
            },
          },
        )
      }
      return errorResponseFromCode('NO_OPEN_PERIOD_FOR_DATE', txLog, {
        requestId,
        details: { transaction_date: transaction.date, reason: 'no_fiscal_period' },
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
