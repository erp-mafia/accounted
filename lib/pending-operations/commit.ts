/**
 * Unified entry point for executing a pending_operation.
 *
 * Used by:
 *   - The web UI commit route (app/api/pending-operations/[id]/commit/route.ts)
 *     when a human clicks "Approve"
 *   - The MCP server (extensions/general/mcp-server/server.ts) when a trusted
 *     agent stages a low-risk op that the company has opted in to auto-commit
 *
 * Both paths converge here so the same audit trail, event emission, error
 * handling, and status transition logic apply.
 *
 * The executor functions previously lived in the commit route. They are kept
 * private to this module — call `commitPendingOperation()` to invoke them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { validateVatNumber } from '@/lib/vat/vies-client'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
  createInvoiceJournalEntry,
  createCreditNoteJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod, reverseEntry, validateBalance } from '@/lib/bookkeeping/engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { closePeriod, lockPeriod, unlockPeriod, resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import {
  executeYearEndClosing,
  generateOpeningBalances,
} from '@/lib/core/bookkeeping/year-end-service'
import { executeCurrencyRevaluation } from '@/lib/bookkeeping/currency-revaluation'
import {
  createSupplierCreditNoteEntry,
  createSupplierInvoiceRegistrationEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { linkInvoiceToVoucher } from '@/lib/invoices/voucher-matching'
import { linkSupplierInvoiceToVoucher } from '@/lib/invoices/supplier-voucher-matching'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { parseSIEFile } from '@/lib/import/sie-parser'
import { executeSIEImport, undoSIEImport } from '@/lib/import/sie-import'
import type { AccountMapping } from '@/lib/import/types'
import { AccountsNotInChartError, isBookkeepingError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { getEmailService } from '@/lib/email/service'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { uploadDocument, linkToJournalEntry } from '@/lib/core/documents/document-service'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { CreateSupplierParamsSchema } from '@/lib/pending-operations/schemas/create-supplier'
import { z } from 'zod'
import type {
  Transaction,
  TransactionCategory,
  EntityType,
  VatTreatment,
  Currency,
  Invoice,
  Customer,
  Supplier,
  SupplierInvoice,
  SupplierInvoiceItem,
  PendingOperation,
  CompanySettings,
  InvoiceItem,
  AccountingMethod,
  CreditNote,
  CreateJournalEntryLineInput,
  JournalEntrySourceType,
} from '@/types'

const log = createLogger('pending-operations/commit')

export interface CommitResult {
  status: 'committed' | 'rejected' | 'failed'
  data?: Record<string, unknown>
  error?: string
  http_status?: number
  auto_rejected?: boolean
  // Set when the commit failed because the booking posts to BAS accounts not
  // active in the company chart. Recoverable — the op is left 'pending' so the
  // caller can activate the accounts and retry. Lets the route rebuild the
  // structured ACCOUNTS_NOT_IN_CHART envelope (code + account_numbers).
  code?: string
  account_numbers?: string[]
}

export interface CommitOptions {
  /** Email address used as cc on send_invoice (typically the human user's email). */
  userEmail?: string
  /**
   * commit_method recorded on any journal_entries created by this operation.
   * Must match the CHECK constraint on journal_entries.commit_method:
   * 'user_accept' | 'bulk_accept' | 'timing_ceiling' | 'migration' | 'legacy'.
   * Single-approval route passes 'user_accept' (default); bulk-approval passes
   * 'bulk_accept'. Defaults to 'user_accept' since the dispatcher is only
   * invoked from human-approval paths after agent auto-commit was removed
   * (migration 20260505190027_drop_agent_auto_commit).
   */
  commitMethod?: 'user_accept' | 'bulk_accept'
}

// ── Helper: ensure fiscal period covers the date ──────────────────

async function ensureFiscalPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  date: string,
  fiscalYearStartMonth: number = 1
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
    }, { onConflict: 'user_id,period_start,period_end' })

  if (error) {
    log.error('Failed to create fiscal period:', error)
    return false
  }
  return true
}

async function recordSkippedInvoiceJournalEntry(
  invoiceId: string,
  companyId: string,
  userId: string,
  operation: 'send_invoice' | 'mark_invoice_sent',
  err: unknown
): Promise<void> {
  try {
    const reasonCode = err instanceof AccountsNotInChartError
      ? 'accounts_not_in_chart'
      : 'journal_entry_error'
    const accountNumbers = err instanceof AccountsNotInChartError ? err.accountNumbers : undefined
    await appendProcessingHistory({
      companyId,
      correlationId: invoiceId,
      aggregateType: 'System',
      aggregateId: invoiceId,
      eventType: 'InvoiceJournalEntrySkipped',
      payload: {
        invoice_id: invoiceId,
        operation,
        reason_code: reasonCode,
        ...(accountNumbers ? { account_numbers: accountNumbers } : {}),
      },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (historyErr) {
    log.warn('Failed to append InvoiceJournalEntrySkipped to processing_history', historyErr)
  }
}

// ── Executors ────────────────────────────────────────────────────

type ExecutorResult = { data?: Record<string, unknown>; error?: string; status?: number }

async function commitCategorizeTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const txId = params.transaction_id as string
  const category = params.category as TransactionCategory
  const vatTreatment = params.vat_treatment as VatTreatment | undefined
  // Optional audit-trail text the agent passed alongside the categorization.
  // For representation bookings the agent captures deltagare + syfte and
  // funnels them in here so the verifikation's description carries the
  // context an external auditor needs (SKV's representationsregler).
  const notes =
    typeof params.notes === 'string' && params.notes.trim().length > 0
      ? (params.notes as string)
      : undefined

  const { data: transaction, error: fetchError } = await supabase
    .from('transactions').select('*').eq('id', txId).eq('company_id', companyId).single()

  if (fetchError || !transaction) {
    return { error: 'Transaction not found — it may have been deleted.', status: 404 }
  }
  if (transaction.journal_entry_id) {
    return { error: 'Transaction already has a journal entry — it was categorized in the meantime.', status: 409 }
  }

  const isBusiness = category !== 'private'

  const { data: settings } = await supabase
    .from('company_settings').select('entity_type, fiscal_year_start_month').eq('company_id', companyId).single()

  const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'
  const fiscalYearStartMonth = settings?.fiscal_year_start_month ?? 1

  const mappingResult = buildMappingResultFromCategory(
    category, transaction as Transaction, isBusiness, entityType, vatTreatment
  )

  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return { error: `No account mapping for category "${category}" with entity type "${entityType}".`, status: 400 }
  }

  await ensureFiscalPeriod(supabase, userId, companyId, transaction.date, fiscalYearStartMonth)

  let journalEntryId: string | null = null
  try {
    const journalEntry = await createTransactionJournalEntry(
      supabase, companyId, userId, transaction as Transaction, mappingResult, notes,
    )
    if (journalEntry) journalEntryId = journalEntry.id
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    log.error('Failed to create journal entry:', err)
    return { error: err instanceof Error ? err.message : 'Failed to create journal entry', status: 500 }
  }

  const { error: updateError } = await supabase
    .from('transactions')
    .update({ is_business: isBusiness, category, journal_entry_id: journalEntryId })
    .eq('id', txId)

  if (updateError) {
    log.error('Failed to update transaction:', updateError)
    return { error: 'Failed to update transaction', status: 500 }
  }

  // Propagate the underlag from a matched invoice-inbox item onto the new
  // verifikation. Without this, BFL 7 kap is violated: a verifikation
  // exists with no underlag attached even though the user has explicitly
  // linked an inbox item (with a document) to this transaction in the
  // inbox workspace. We:
  //   1. find the inbox item(s) where matched_transaction_id = txId
  //   2. for each item with a document_id, set
  //        document_attachments.journal_entry_id = journalEntryId
  //      (idempotent — re-linking the same doc is a no-op write).
  //   3. stamp invoice_inbox_items.created_journal_entry_id so the inbox
  //      row visibly moves to "Bearbetade" and shows "Öppna verifikation".
  // Errors are logged but don't fail the commit — the verifikation itself
  // is already posted, and the link can be repaired by re-running this
  // step. A future PR can move this into a single transaction with the
  // journal entry creation.
  if (journalEntryId) {
    try {
      const { data: matchedInboxItems } = await supabase
        .from('invoice_inbox_items')
        .select('id, document_id')
        .eq('company_id', companyId)
        .eq('matched_transaction_id', txId)
        .is('created_journal_entry_id', null)
      for (const inbox of (matchedInboxItems ?? []) as Array<{
        id: string
        document_id: string | null
      }>) {
        if (inbox.document_id) {
          try {
            await linkToJournalEntry(supabase, companyId, inbox.document_id, journalEntryId)
          } catch (err) {
            log.error('Failed to link inbox document to journal entry', {
              inbox_item_id: inbox.id,
              document_id: inbox.document_id,
              journal_entry_id: journalEntryId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        const { error: stampError } = await supabase
          .from('invoice_inbox_items')
          .update({ created_journal_entry_id: journalEntryId })
          .eq('id', inbox.id)
          .eq('company_id', companyId)
        if (stampError) {
          log.error('Failed to stamp inbox item created_journal_entry_id', {
            inbox_item_id: inbox.id,
            journal_entry_id: journalEntryId,
            error: stampError.message,
          })
        }
      }
    } catch (err) {
      log.error('Failed to propagate underlag from matched inbox items', err)
    }
  }

  try {
    await upsertCounterpartyTemplate(
      supabase, userId, transaction as Transaction, mappingResult, 'user_approved'
    )
  } catch { /* non-critical */ }

  await eventBus.emit({
    type: 'transaction.categorized',
    payload: {
      transaction: transaction as Transaction,
      account: mappingResult.debit_account,
      taxCode: mappingResult.vat_lines[0]?.account_number || '',
      userId,
      companyId,
    },
  })

  return { data: { journal_entry_id: journalEntryId, category } }
}

async function commitCreateCustomer(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const { data, error } = await supabase
    .from('customers')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: params.name as string,
      customer_type: params.customer_type as string,
      email: (params.email as string) || null,
      org_number: (params.org_number as string) || null,
      vat_number: (params.vat_number as string) || null,
      default_payment_terms: (params.payment_terms as number) || 30,
      address_line1: (params.address as string) || null,
      postal_code: (params.postal_code as string) || null,
      city: (params.city as string) || null,
      country: (params.country as string) || 'Sweden',
    })
    .select()
    .single()

  if (error) return { error: error.message, status: 500 }

  if (params.customer_type === 'eu_business' && params.vat_number) {
    try {
      const vatResult = await validateVatNumber(params.vat_number as string)
      if (vatResult.valid) {
        await supabase
          .from('customers')
          .update({ vat_number_validated: true, vat_number_validated_at: new Date().toISOString() })
          .eq('id', data.id)
          .eq('company_id', companyId)
      }
    } catch (err) {
      log.warn('Auto-VIES validation failed:', err)
    }
  }

  await eventBus.emit({ type: 'customer.created', payload: { customer: data as Customer, userId, companyId } })

  return { data: { customer_id: data.id } }
}

async function commitCreateSupplier(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so a
  // tampered pending_operations row cannot inject unexpected fields or
  // malformed payment-routing data into the suppliers table (ASVS V4.5).
  let validated
  try {
    validated = CreateSupplierParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const path = issue?.path?.join('.') ?? 'params'
      return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  const { data, error } = await supabase
    .from('suppliers')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: validated.name,
      supplier_type: validated.supplier_type,
      email: validated.email ?? null,
      phone: validated.phone ?? null,
      org_number: validated.org_number ?? null,
      vat_number: validated.vat_number ?? null,
      address_line1: validated.address_line1 ?? null,
      address_line2: validated.address_line2 ?? null,
      postal_code: validated.postal_code ?? null,
      city: validated.city ?? null,
      country: validated.country ?? 'SE',
      bankgiro: validated.bankgiro ?? null,
      plusgiro: validated.plusgiro ?? null,
      bank_account: validated.bank_account ?? null,
      iban: validated.iban ?? null,
      bic: validated.bic ?? null,
      default_expense_account: validated.default_expense_account ?? null,
      default_payment_terms: validated.default_payment_terms,
      default_currency: validated.default_currency ?? 'SEK',
      notes: validated.notes ?? null,
    })
    .select()
    .single()

  if (error) return { error: error.message, status: 500 }

  await eventBus.emit({ type: 'supplier.created', payload: { supplier: data as Supplier, userId, companyId } })

  return { data: { supplier_id: data.id } }
}

async function commitCreateTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const date = params.date as string
  const amount = Number(params.amount)
  const description = (params.description as string) ?? ''
  const currency = ((params.currency as string) || 'SEK') as Currency
  const bankConnectionId = (params.bank_connection_id as string) || null
  const externalId = (params.external_id as string) || null

  if (!date || !description.trim() || !Number.isFinite(amount)) {
    return { error: 'date, description, and amount are required', status: 400 }
  }

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      company_id: companyId,
      bank_connection_id: bankConnectionId,
      external_id: externalId,
      date,
      description: description.trim(),
      amount,
      currency,
      import_source: 'mcp',
    })
    .select('id')
    .single()

  if (error) {
    const isDuplicate = error.code === '23505'
    return {
      error: isDuplicate
        ? `A transaction with external_id "${externalId}" already exists.`
        : error.message,
      status: isDuplicate ? 409 : 500,
    }
  }

  return { data: { transaction_id: data.id } }
}

async function commitCreateInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const customerId = params.customer_id as string
  const items = params.items as Array<{
    description: string; quantity: number; unit: string; unit_price: number; vat_rate?: number
  }>

  const { data: customer, error: customerError } = await supabase
    .from('customers').select('*').eq('id', customerId).eq('company_id', companyId).single()

  if (customerError || !customer) {
    return { error: 'Customer not found — they may have been deleted.', status: 404 }
  }

  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
  const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(availableRates.map((r) => r.rate))

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)

  let vatAmount = 0
  for (const item of items) {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    if (!allowedRates.has(itemRate)) {
      return { error: `Momssats ${itemRate}% är inte tillåten för denna kundtyp`, status: 400 }
    }
    const lineTotal = item.quantity * item.unit_price
    vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
  }

  const total = subtotal + vatAmount
  const currency = ((params.currency as string) || 'SEK') as Currency

  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null

  if (currency !== 'SEK') {
    const rateData = await fetchExchangeRate(currency)
    if (rateData) {
      exchangeRate = rateData.rate
      exchangeRateDate = rateData.date
      subtotalSek = convertToSEK(subtotal, exchangeRate)
      vatAmountSek = convertToSEK(vatAmount, exchangeRate)
      totalSek = convertToSEK(total, exchangeRate)
    }
  }

  const uniqueRates = new Set(items.map((item) => item.vat_rate ?? vatRules.rate))
  const isMixedRate = uniqueRates.size > 1

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: customerId,
      invoice_number: null,
      invoice_date: (params.invoice_date as string) || new Date().toISOString().split('T')[0],
      due_date: (params.due_date as string) || null,
      currency,
      exchange_rate: exchangeRate,
      exchange_rate_date: exchangeRateDate,
      subtotal,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmount,
      vat_amount_sek: vatAmountSek,
      total,
      total_sek: totalSek,
      vat_treatment: vatRules.treatment,
      vat_rate: isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate),
      moms_ruta: vatRules.momsRuta,
      reverse_charge_text: vatRules.reverseChargeText || null,
      our_reference: (params.our_reference as string) || null,
      your_reference: (params.your_reference as string) || null,
      notes: (params.notes as string) || null,
    })
    .select()
    .single()

  if (invoiceError) return { error: invoiceError.message, status: 500 }

  const invoiceItems = items.map((item, index) => {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    const lineTotal = item.quantity * item.unit_price
    const itemVat = Math.round(lineTotal * itemRate / 100 * 100) / 100
    return {
      invoice_id: invoice.id,
      sort_order: index,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
    }
  })

  const { error: itemsError } = await supabase.from('invoice_items').insert(invoiceItems)

  if (itemsError) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { error: itemsError.message, status: 500 }
  }

  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  if (completeInvoice) {
    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: completeInvoice as Invoice, userId, companyId },
    })
  }

  return { data: { invoice_id: invoice.id, invoice_number: invoice.invoice_number } }
}

async function commitMarkInvoicePaid(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string
  const paymentDate = (params.payment_date as string) || new Date().toISOString().split('T')[0]

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    return { error: 'Invoice can only be marked as paid when status is "sent" or "overdue"', status: 409 }
  }

  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null

  // Route on invoice state, not the company's current accounting_method —
  // an invoice booked at send under accrual must clear 1510 here even if
  // the company has since switched to kontantmetoden.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

  if (isRealInvoice) {
    if (useCashEntry) {
      const je = await createInvoiceCashEntry(
        supabase, companyId, userId, invoice as Invoice, paymentDate, entityType, invoice.customer?.name
      )
      journalEntryId = je?.id ?? null
    } else {
      const je = await createInvoicePaymentJournalEntry(
        supabase, companyId, userId, invoice as Invoice, paymentDate, undefined, invoice.customer?.name
      )
      journalEntryId = je?.id ?? null
    }
  }

  const now = new Date().toISOString()
  const { error: updateError } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: now, paid_amount: invoice.total })
    .eq('id', invoiceId)
    .eq('company_id', companyId)

  if (updateError) return { error: 'Failed to update invoice status', status: 500 }

  return { data: { status: 'paid', journal_entry_id: journalEntryId } }
}

async function commitSendInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  userEmail?: string
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string

  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    return { error: 'Email service not configured', status: 500 }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.status === 'sent' || invoice.status === 'paid' || invoice.status === 'overdue') {
    return { error: 'Invoice has already been sent', status: 409 }
  }

  const customer = invoice.customer as Customer
  if (!customer.email) return { error: 'Customer has no email address', status: 400 }

  const { data: company, error: companyError } = await supabase
    .from('company_settings').select('*').eq('company_id', companyId).single()

  if (companyError || !company) return { error: 'Company settings missing', status: 500 }

  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    return { error: `Failed to assign invoice number: ${err instanceof Error ? err.message : 'unknown'}`, status: 500 }
  }

  const items = (invoice.items as InvoiceItem[]).sort(
    (a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order
  )

  let originalInvoiceNumber: string | undefined
  if (invoice.credited_invoice_id) {
    const { data: orig } = await supabase
      .from('invoices').select('invoice_number').eq('id', invoice.credited_invoice_id).single()
    if (orig) originalInvoiceNumber = orig.invoice_number
  }

  // Override `status` to 'sent' on the in-memory copy. The DB flip happens
  // after email delivery (line ~625); rendering with the stale 'draft' status
  // would stamp the customer's PDF with "UTKAST – inte en giltig faktura".
  const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
  const { branding } = prepareInvoicePdfRender(company as CompanySettings)
  const pdfBuffer = await renderToBuffer(
    InvoicePDF({
      invoice: renderableInvoice,
      customer,
      items,
      company: company as CompanySettings,
      originalInvoiceNumber,
      branding,
    })
  )

  const isCreditNote = !!invoice.credited_invoice_id
  const docType = invoice.document_type || 'invoice'
  let filename: string
  if (isCreditNote) filename = `kreditfaktura-${invoice.invoice_number}.pdf`
  else if (docType === 'proforma') filename = `proformafaktura-${invoice.invoice_number}.pdf`
  else if (docType === 'delivery_note') filename = `foljesedel-${invoice.invoice_number}.pdf`
  else filename = `faktura-${invoice.invoice_number}.pdf`

  const ccAddress = company.email || userEmail
  const emailData = { invoice: invoice as Invoice, customer, company: company as CompanySettings }
  const result = await emailService.sendEmail({
    to: customer.email,
    cc: ccAddress,
    subject: generateInvoiceEmailSubject(emailData),
    html: generateInvoiceEmailHtml(emailData),
    text: generateInvoiceEmailText(emailData),
    replyTo: company.email || undefined,
    fromName: company.company_name,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  })

  if (!result.success) return { error: `Failed to send email: ${result.error}`, status: 500 }

  await supabase.from('invoices').update({ status: 'sent' }).eq('id', invoiceId).eq('company_id', companyId)

  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let createdJournalEntryId: string | undefined
  if (isRealInvoice && (company.accounting_method === 'accrual' || !company.accounting_method)) {
    try {
      const je = await createInvoiceJournalEntry(
        supabase, companyId, userId, invoice as Invoice, (company as CompanySettings).entity_type
      )
      if (je) {
        createdJournalEntryId = je.id
        await supabase.from('invoices').update({ journal_entry_id: je.id }).eq('id', invoiceId)
      }
    } catch (err) {
      await recordSkippedInvoiceJournalEntry(invoiceId, companyId, userId, 'send_invoice', err)
    }
  }

  if (isRealInvoice) {
    try {
      const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
      await uploadDocument(supabase, userId, companyId, {
        name: filename, buffer: pdfArrayBuffer, type: 'application/pdf',
      }, { upload_source: 'system', journal_entry_id: createdJournalEntryId })
    } catch { /* non-blocking */ }
  }

  await eventBus.emit({ type: 'invoice.sent', payload: { invoice: invoice as Invoice, userId, companyId } })

  return { data: { message: `Invoice ${invoice.invoice_number} sent to ${customer.email}` } }
}

async function commitMarkInvoiceSent(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (invoice.status !== 'draft') return { error: 'Only draft invoices can be marked as sent', status: 409 }

  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    return { error: `Failed to assign invoice number: ${err instanceof Error ? err.message : 'unknown'}`, status: 500 }
  }

  const { error: updateError } = await supabase
    .from('invoices').update({ status: 'sent' }).eq('id', invoiceId).eq('company_id', companyId)

  if (updateError) return { error: 'Failed to update invoice status', status: 500 }

  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()

  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null

  if (isRealInvoice && (settings?.accounting_method === 'accrual' || !settings?.accounting_method)) {
    try {
      const je = await createInvoiceJournalEntry(
        supabase, companyId, userId, invoice as Invoice,
        (settings?.entity_type as EntityType) || 'enskild_firma',
        invoice.customer?.name
      )
      if (je) {
        journalEntryId = je.id
        await supabase.from('invoices').update({ journal_entry_id: je.id }).eq('id', invoiceId)
      }
    } catch (err) {
      await recordSkippedInvoiceJournalEntry(invoiceId, companyId, userId, 'mark_invoice_sent', err)
    }
  }

  return { data: { status: 'sent', journal_entry_id: journalEntryId } }
}

async function commitMatchTransactionInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const transactionId = params.transaction_id as string
  const invoiceId = params.invoice_id as string

  const { data: transaction, error: txError } = await supabase
    .from('transactions').select('*').eq('id', transactionId).eq('company_id', companyId).single()

  if (txError || !transaction) return { error: 'Transaction not found', status: 404 }
  if (transaction.amount <= 0) return { error: 'Only income transactions can be matched', status: 400 }
  if (transaction.invoice_id) return { error: 'Transaction already linked to an invoice', status: 409 }

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (invError || !invoice) return { error: 'Invoice not found', status: 404 }
  if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
    return { error: 'Invoice is not in a matchable state', status: 409 }
  }

  if (transaction.journal_entry_id) {
    await reverseEntry(supabase, companyId, userId, transaction.journal_entry_id)
    await supabase.from('transactions').update({ journal_entry_id: null }).eq('id', transactionId)
  }

  const now = new Date().toISOString()
  const paidAmount = transaction.amount
  const newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
  const currentRemaining = invoice.remaining_amount ?? (invoice.total - (invoice.paid_amount || 0))
  const newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
  const isFullyPaid = newRemaining <= 0
  const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  // Route on invoice state, not the company's current setting. Mirror of
  // the match-invoice route fix — see that handler for the full rationale.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

  let journalEntryId: string | null = null
  try {
    if (useCashEntry) {
      const je = await createInvoiceCashEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, entityType, invoice.customer?.name
      )
      journalEntryId = je?.id ?? null
    } else {
      const je = await createInvoicePaymentJournalEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, undefined, invoice.customer?.name, paidAmount
      )
      journalEntryId = je?.id ?? null
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    log.error('Failed to create match journal entry:', err)
  }

  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_at: isFullyPaid ? now : null,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    })
    .eq('id', invoiceId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateInvError) return { error: 'Failed to update invoice status', status: 500 }
  if (!updatedRows || updatedRows.length === 0) {
    return { error: 'Invoice has already been fully paid or is no longer matchable', status: 409 }
  }

  const paymentNotes = (accountingMethod === 'cash' && !isFullyPaid)
    ? 'Kontantmetoden: intäkt bokförs vid slutbetalning' : null

  await supabase.from('invoice_payments').insert({
    user_id: userId,
    company_id: companyId,
    invoice_id: invoiceId,
    payment_date: transaction.date,
    amount: paidAmount,
    currency: invoice.currency,
    exchange_rate: invoice.exchange_rate,
    journal_entry_id: journalEntryId,
    transaction_id: transactionId,
    notes: paymentNotes,
  })

  await supabase
    .from('transactions')
    .update({
      invoice_id: invoiceId,
      potential_invoice_id: null,
      journal_entry_id: journalEntryId,
      is_business: true,
      category: 'income_services',
    })
    .eq('id', transactionId)

  try {
    await eventBus.emit({
      type: 'invoice.match_confirmed',
      payload: { invoice: invoice as Invoice, transaction: transaction as Transaction, userId, companyId },
    })
  } catch { /* non-critical */ }

  return { data: { invoice_status: newStatus, paid_amount: newPaidAmount, journal_entry_id: journalEntryId } }
}

async function commitLinkInvoiceVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const invoiceId = params.invoice_id as string | undefined
  const journalEntryId = params.journal_entry_id as string | undefined
  const notes = (params.notes as string | undefined) ?? undefined

  if (!invoiceId || !journalEntryId) {
    return { error: 'invoice_id and journal_entry_id are required', status: 400 }
  }

  const outcome = await linkInvoiceToVoucher(supabase, userId, companyId, {
    invoiceId,
    journalEntryId,
    notes,
  })

  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    const httpStatus = entry?.httpStatus ?? 500
    // 404/409 are auto-rejected by the dispatcher (the user can re-stage with
    // adjusted inputs); 400 surfaces as a normal failure so the UI can
    // explain what went wrong.
    return {
      error: entry?.message_en ?? outcome.code,
      status: httpStatus,
    }
  }

  return {
    data: {
      invoice_status: outcome.result.invoiceStatus,
      paid_amount: outcome.result.paidAmount,
      remaining_amount: outcome.result.remainingAmount,
      payment_amount: outcome.result.paymentAmount,
      payment_id: outcome.result.paymentId,
      journal_entry_id: outcome.result.journalEntryId,
    },
  }
}

async function commitLinkSupplierInvoiceVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const supplierInvoiceId = params.supplier_invoice_id as string | undefined
  const journalEntryId = params.journal_entry_id as string | undefined
  const notes = (params.notes as string | undefined) ?? undefined

  if (!supplierInvoiceId || !journalEntryId) {
    return { error: 'supplier_invoice_id and journal_entry_id are required', status: 400 }
  }

  const outcome = await linkSupplierInvoiceToVoucher(supabase, userId, companyId, {
    supplierInvoiceId,
    journalEntryId,
    notes,
  })

  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    // 404/409 are auto-rejected by the dispatcher (the user can re-stage with
    // adjusted inputs); 400 surfaces as a normal failure so the UI can explain.
    return {
      error: entry?.message_en ?? outcome.code,
      status: entry?.httpStatus ?? 500,
    }
  }

  return {
    data: {
      invoice_status: outcome.result.invoiceStatus,
      paid_amount: outcome.result.paidAmount,
      remaining_amount: outcome.result.remainingAmount,
      payment_amount: outcome.result.paymentAmount,
      payment_id: outcome.result.paymentId,
      journal_entry_id: outcome.result.journalEntryId,
    },
  }
}

// ── Stream 1 Phase 1 + follow-up executors ───────────────────────

async function commitClosePeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  if (!id) return { error: 'fiscal_period_id is required', status: 400 }
  try {
    const period = await closePeriod(supabase, companyId, userId, id)
    return { data: { period_id: period.id, closed_at: period.closed_at } }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Close failed', status: 400 }
  }
}

async function commitLockPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  if (!id) return { error: 'fiscal_period_id is required', status: 400 }
  try {
    const period = await lockPeriod(supabase, companyId, userId, id)
    return { data: { period_id: period.id, locked_at: period.locked_at } }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Lock failed', status: 400 }
  }
}

async function commitUnlockPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  if (!id) return { error: 'fiscal_period_id is required', status: 400 }
  try {
    const period = await unlockPeriod(supabase, companyId, userId, id)
    return { data: { period_id: period.id, locked_at: period.locked_at } }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unlock failed', status: 400 }
  }
}

async function commitUncategorizeTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const txId = params.transaction_id as string
  const journalEntryId = params.journal_entry_id as string
  if (!txId || !journalEntryId) return { error: 'transaction_id and journal_entry_id are required', status: 400 }

  try {
    await reverseEntry(supabase, companyId, userId, journalEntryId)
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Reversal failed', status: 500 }
  }

  const { error: updateError } = await supabase
    .from('transactions')
    .update({ is_business: null, category: null, journal_entry_id: null })
    .eq('id', txId)
    .eq('company_id', companyId)

  if (updateError) return { error: 'Failed to reset transaction', status: 500 }

  return { data: { transaction_id: txId, reversed_journal_entry_id: journalEntryId } }
}

async function commitAttachDocumentToTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const txId = params.transaction_id as string
  const documentId = params.document_id as string
  if (!txId || !documentId) {
    return { error: 'transaction_id and document_id are required', status: 400 }
  }

  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, document_id, journal_entry_id')
    .eq('id', txId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError || !tx) return { error: 'Transaction not found', status: 404 }

  const previousDocumentId = (tx.document_id as string | null) ?? null

  // Pre-check: if the tx already has a doc and that doc is räkenskapsinformation,
  // mirror the DELETE-route 409 instead of letting the DB trigger raise a
  // raw check_violation. Same compliance message in both places.
  if (tx.document_id && tx.document_id !== documentId) {
    const { data: existing } = await supabase
      .from('document_attachments')
      .select('journal_entry_id')
      .eq('id', tx.document_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (existing?.journal_entry_id) {
      return {
        error:
          'Bilagan är kopplad till en bokförd verifikation och kan inte ersättas. Storno verifikationen först.',
        status: 409,
      }
    }
  }

  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (docError || !doc) return { error: 'Document not found', status: 404 }

  // Race-free read of journal_entry_id: use UPDATE ... RETURNING so the value
  // we propagate against reflects any concurrent categorize that committed
  // before our UPDATE acquired the row lock. Reading the post-update state
  // (rather than the pre-staging state) is what makes the
  // attach-then-categorize and categorize-then-attach orderings produce the
  // same final state — both end with document_attachments.journal_entry_id
  // set to the tx's journal_entry_id. (BFL 5 kap 6 § verifikation underlag.)
  const { data: postUpdate, error: updateError } = await supabase
    .from('transactions')
    .update({ document_id: documentId })
    .eq('id', txId)
    .eq('company_id', companyId)
    .select('journal_entry_id')
    .maybeSingle()

  if (updateError) {
    // The DB-level immutability trigger raises P0001 with a stable
    // BFL_DOCUMENT_IMMUTABILITY: prefix when the previous doc is already
    // räkenskapsinformation. Match on the prefix (not the generic SQLSTATE)
    // so unrelated future exceptions don't get translated.
    const errMsg = (updateError as { message?: string }).message ?? ''
    if (errMsg.includes('BFL_DOCUMENT_IMMUTABILITY')) {
      return {
        error:
          'Bilagan är kopplad till en bokförd verifikation och kan inte ersättas. Storno verifikationen först.',
        status: 409,
      }
    }
    return { error: 'Failed to attach document', status: 500 }
  }
  if (!postUpdate) return { error: 'Transaction not found', status: 404 }

  // If the attached doc came from an invoice_inbox_items row, mark that row
  // as matched so the inbox UI shows "Kopplad till transaktion". Best-effort:
  // a failure must not roll back the (compliant) attach. Mirrors the REST
  // route in app/api/transactions/[id]/attach-document/route.ts so MCP-staged
  // and REST attaches converge on the same inbox state.
  //
  // The Supabase client resolves with { error } rather than rejecting on
  // RLS/DB errors, so we destructure rather than try/catch.
  const { error: inboxLinkErr } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: txId })
    .eq('document_id', documentId)
    .eq('company_id', companyId)
    .is('matched_transaction_id', null)
    .is('created_supplier_invoice_id', null)
  if (inboxLinkErr) {
    console.error('[commitAttach] Failed to link inbox item:', inboxLinkErr)
  }

  const journalEntryId = postUpdate.journal_entry_id as string | null
  if (journalEntryId) {
    const { error: linkErr } = await supabase
      .from('document_attachments')
      .update({ journal_entry_id: journalEntryId })
      .eq('id', documentId)
      .eq('company_id', companyId)
    if (linkErr) {
      // Surface the propagation failure rather than logging-and-continuing.
      // BFL 5 kap 6 § requires the verifikation to reference its underlag, so
      // a "succeeded" attach that left document_attachments.journal_entry_id
      // null would be a silent compliance gap. Failing here marks the op
      // failed; a retry is idempotent (same documentId on tx, same propagate
      // target) and will replay the document_attachments UPDATE.
      console.error('[commitAttach] Failed to propagate to journal entry:', linkErr)
      return {
        error:
          'Bilagan kopplades till transaktionen men kunde inte länkas till verifikationen. Försök igen — operationen är idempotent.',
        status: 500,
      }
    }
  }

  // Rättelse audit trail (BFL 5 kap 5 §): if we replaced a non-null doc, log
  // the swap to processing_history so the original is traceable. Best-effort —
  // a logging failure must not roll back the (compliant) attach.
  if (previousDocumentId && previousDocumentId !== documentId) {
    try {
      await appendProcessingHistory({
        companyId,
        correlationId: txId,
        aggregateType: 'BankTransaction',
        aggregateId: txId,
        eventType: 'TransactionDocumentReplaced',
        payload: {
          transaction_id: txId,
          previous_document_id: previousDocumentId,
          new_document_id: documentId,
          journal_entry_id: journalEntryId,
        },
        actor: { type: 'user', id: userId },
        occurredAt: new Date(),
      })
    } catch (logErr) {
      console.error('[commitAttach] Failed to append rättelse event:', logErr)
    }
  }

  return {
    data: {
      transaction_id: txId,
      document_id: documentId,
      previous_document_id: previousDocumentId,
      journal_entry_id: journalEntryId,
    },
  }
}

async function commitRunYearEnd(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  if (!id) return { error: 'fiscal_period_id is required', status: 400 }

  try {
    const result = await executeYearEndClosing(supabase, companyId, userId, id)
    return {
      data: {
        closing_entry_id: result.closingEntry?.id ?? null,
        next_period_id: result.nextPeriod?.id ?? null,
        opening_balance_entry_id: result.openingBalanceEntry?.id ?? null,
      },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Year-end failed', status: 400 }
  }
}

async function commitSetOpeningBalances(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const closedId = params.closed_period_id as string
  const nextId = params.next_period_id as string
  if (!closedId || !nextId) return { error: 'closed_period_id and next_period_id are required', status: 400 }

  try {
    const entry = await generateOpeningBalances(supabase, companyId, userId, closedId, nextId)
    return { data: { opening_balance_entry_id: entry.id } }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Opening balances failed', status: 400 }
  }
}

async function commitRunCurrencyRevaluation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.fiscal_period_id as string
  const closingDate = params.closing_date as string
  if (!id || !closingDate) return { error: 'fiscal_period_id and closing_date are required', status: 400 }

  try {
    const result = await executeCurrencyRevaluation(supabase, companyId, closingDate, id, userId)
    return {
      data: result
        ? { entry_id: result.entry.id, items_revalued: result.preview.items.length }
        : { entry_id: null, items_revalued: 0, message: 'No foreign-currency items to revalue' },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Revaluation failed', status: 400 }
  }
}

async function commitPostAnnualDepreciation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const fiscalPeriodId = params.fiscal_period_id as string
  if (!fiscalPeriodId) return { error: 'fiscal_period_id is required', status: 400 }
  const assetIds = Array.isArray(params.asset_ids) ? (params.asset_ids as string[]) : undefined

  try {
    const { commitAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
    const { posted, skipped } = await commitAnnualPostings(supabase, companyId, userId, fiscalPeriodId, {
      assetIds,
    })
    return {
      data: {
        posted_count: posted.length,
        skipped_count: skipped.length,
        posted: posted.map((p) => ({
          asset_id: p.assetId,
          journal_entry_id: p.entry.id,
          voucher_number: p.entry.voucher_number,
          schedule_id: p.scheduleId,
        })),
        skipped,
      },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Depreciation posting failed', status: 400 }
  }
}

async function commitExplainVoucherGap(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const fiscalPeriodId = params.fiscal_period_id as string
  const voucherSeries = params.voucher_series as string
  const gapStart = Number(params.gap_start)
  const gapEnd = Number(params.gap_end)
  const explanation = params.explanation as string
  if (!fiscalPeriodId || !voucherSeries || !gapStart || !gapEnd || !explanation?.trim()) {
    return { error: 'fiscal_period_id, voucher_series, gap_start, gap_end, and explanation are required', status: 400 }
  }

  const { data, error } = await supabase
    .from('voucher_gap_explanations')
    .insert({
      user_id: userId,
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      voucher_series: voucherSeries,
      gap_start: gapStart,
      gap_end: gapEnd,
      explanation: explanation.trim(),
    })
    .select('id')
    .single()

  if (error) return { error: error.message, status: 500 }
  return { data: { explanation_id: data.id } }
}

async function commitApproveSupplierInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.supplier_invoice_id as string
  if (!id) return { error: 'supplier_invoice_id is required', status: 400 }

  const { data: invoice } = await supabase
    .from('supplier_invoices').select('*').eq('id', id).eq('company_id', companyId).single()

  if (!invoice) return { error: 'Supplier invoice not found', status: 404 }
  if (invoice.status !== 'registered') {
    return { error: 'Kan bara godkänna registrerade fakturor', status: 400 }
  }

  const { data, error } = await supabase
    .from('supplier_invoices')
    .update({ status: 'approved' })
    .eq('id', id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) return { error: error.message, status: 500 }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.approved',
      payload: { supplierInvoice: data, companyId, userId },
    })
  } catch { /* non-blocking */ }

  return { data: { supplier_invoice_id: id, status: 'approved' } }
}

async function commitCreateSupplierInvoiceFromInbox(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const inboxItemId = params.inbox_item_id as string
  const supplierId = params.supplier_id as string
  const documentId = (params.document_id as string | null) ?? null
  const supplierInvoiceNumber = params.supplier_invoice_number as string
  const invoiceDate = params.invoice_date as string
  const dueDate = (params.due_date as string | null) ?? null
  const currency = (params.currency as string) || 'SEK'
  const vatTreatment = (params.vat_treatment as string) || 'standard_25'
  const notes = (params.notes as string | null) ?? null
  const rawItems = (params.items as Array<Record<string, unknown>> | undefined) ?? []

  if (!inboxItemId || !supplierId || !supplierInvoiceNumber || !invoiceDate || rawItems.length === 0) {
    return {
      error: 'inbox_item_id, supplier_id, supplier_invoice_number, invoice_date, and items are required',
      status: 400,
    }
  }

  // Reject tampered financial fields: Number(x) || 0 silently turns string
  // junk and undefined into a zero-value invoice. Require a finite number on
  // every monetary field, including the optional exchange_rate when present.
  const finite = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const subtotal = finite(params.subtotal)
  const vatAmount = finite(params.vat_amount)
  const total = finite(params.total)
  if (subtotal === null || vatAmount === null || total === null) {
    return {
      error: 'subtotal, vat_amount, and total must be finite numbers',
      status: 400,
    }
  }
  const exchangeRate = params.exchange_rate === null || params.exchange_rate === undefined
    ? null
    : finite(params.exchange_rate)
  if (params.exchange_rate !== null && params.exchange_rate !== undefined && exchangeRate === null) {
    return { error: 'exchange_rate must be a finite number when provided', status: 400 }
  }

  // Idempotency: a re-fired commit (e.g. retry, double-click on the approval
  // UI, racy MCP call) must not create a second leverantörsfaktura for the
  // same inbox row. The DB FK on invoice_inbox_items.created_supplier_invoice_id
  // is the source of truth.
  const { data: inbox, error: inboxErr } = await supabase
    .from('invoice_inbox_items')
    .select('id, created_supplier_invoice_id, status')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .single()

  if (inboxErr || !inbox) return { error: 'Inbox item not found', status: 404 }
  if (inbox.created_supplier_invoice_id) {
    return {
      data: {
        supplier_invoice_id: inbox.created_supplier_invoice_id,
        inbox_item_id: inboxItemId,
        idempotent: true,
      },
    }
  }

  // Defense in depth: the staging-time supplier lookup may be stale by the
  // time the human approves. RLS would block a cross-company supplier too,
  // but a 404 here is a cleaner error than an RLS denial later.
  const { data: supplier, error: supplierErr } = await supabase
    .from('suppliers')
    .select('id, name, supplier_type')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .single()

  if (supplierErr || !supplier) return { error: 'Supplier not found', status: 404 }

  const { data: arrivalNum, error: arrivalErr } = await supabase
    .rpc('get_next_arrival_number', { p_company_id: companyId })

  if (arrivalErr) {
    return { error: `Failed to generate arrival number: ${arrivalErr.message}`, status: 500 }
  }

  const reverseCharge = vatTreatment === 'reverse_charge'
  const subtotalRounded = Math.round(subtotal * 100) / 100
  const vatAmountRounded = Math.round(vatAmount * 100) / 100
  const totalRounded = Math.round(total * 100) / 100
  const subtotalSek = exchangeRate ? Math.round(subtotal * exchangeRate * 100) / 100 : null
  const vatAmountSek = exchangeRate ? Math.round(vatAmount * exchangeRate * 100) / 100 : null
  const totalSek = exchangeRate ? Math.round(total * exchangeRate * 100) / 100 : null

  const { data: invoice, error: invoiceErr } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_id: supplierId,
      arrival_number: arrivalNum,
      supplier_invoice_number: supplierInvoiceNumber,
      invoice_date: invoiceDate,
      due_date: dueDate,
      status: 'registered',
      currency,
      exchange_rate: exchangeRate,
      vat_treatment: vatTreatment,
      reverse_charge: reverseCharge,
      paid_with_private_funds: false,
      subtotal: subtotalRounded,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmountRounded,
      vat_amount_sek: vatAmountSek,
      total: totalRounded,
      total_sek: totalSek,
      paid_amount: 0,
      remaining_amount: totalRounded,
      notes,
    })
    .select()
    .single()

  if (invoiceErr || !invoice) {
    const pgErr = invoiceErr as { code?: string; message?: string } | null
    const isDuplicate = pgErr?.code === '23505'
    if (isDuplicate) {
      // Generic 409 — supplier_invoice_number alone is already in the staged
      // params the caller submitted; we just don't echo back the supplier's
      // name or row id. The UI surface uses the supplier-side ledger, not
      // this error.
      log.warn('Duplicate supplier invoice number on inbox conversion', {
        companyId,
        supplierId,
        supplierInvoiceNumber,
      })
      return {
        error: `Leverantörsfaktura ${supplierInvoiceNumber} finns redan registrerad.`,
        status: 409,
      }
    }
    log.error('Failed to insert supplier invoice from inbox', {
      companyId,
      inboxItemId,
      supplierId,
      error: pgErr?.message ?? 'unknown',
    })
    return { error: 'Failed to create supplier invoice', status: 500 }
  }

  // RC invariant: a reverse-charge supplier invoice never shows output VAT
  // from the supplier. Zero any per-line VAT that slipped through staging so
  // the registration JE's 2614/2645 self-assessed leg lines up with rutor
  // 20–24 / 48 instead of double-counting input VAT into 2641. Tampered
  // params can't smuggle non-zero VAT into the items table.
  const itemInserts = rawItems.map((item, idx) => {
    const vatRate = reverseCharge ? 0 : (typeof item.vat_rate === 'number' && Number.isFinite(item.vat_rate) ? item.vat_rate : 0)
    const vatAmt = reverseCharge ? 0 : (typeof item.vat_amount === 'number' && Number.isFinite(item.vat_amount) ? item.vat_amount : 0)
    return {
      supplier_invoice_id: invoice.id,
      sort_order: idx,
      description: String(item.description ?? `Position ${idx + 1}`),
      quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? item.quantity : 1,
      unit: (item.unit as string | undefined) ?? 'st',
      unit_price: typeof item.unit_price === 'number' && Number.isFinite(item.unit_price) ? item.unit_price : 0,
      line_total: typeof item.line_total === 'number' && Number.isFinite(item.line_total) ? item.line_total : 0,
      account_number: String(item.account_number ?? '4000'),
      vat_code: null,
      vat_rate: vatRate,
      vat_amount: vatAmt,
      // For reverse charge the buyer self-assesses VAT; carry an explicit
      // statutory rate when staged, else null (engine defaults to 25%).
      reverse_charge_rate: reverseCharge
        ? ([0.06, 0.12, 0.25].includes(Number(item.reverse_charge_rate)) ? Number(item.reverse_charge_rate) : null)
        : null,
    }
  })

  const { error: itemsErr } = await supabase
    .from('supplier_invoice_items')
    .insert(itemInserts)

  if (itemsErr) {
    // Roll back the parent to avoid orphan supplier_invoices rows. Without
    // line items the registration JE can't be built and the invoice would
    // be invisible in the supplier ledger anyway.
    await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
    log.error('Failed to insert supplier invoice items, rolled back parent', {
      companyId,
      invoiceId: invoice.id,
      error: itemsErr.message,
    })
    return { error: 'Failed to insert supplier invoice items', status: 500 }
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'
  let registrationJournalEntryId: string | null = null

  if (accountingMethod === 'accrual') {
    try {
      const journalEntry = await createSupplierInvoiceRegistrationEntry(
        supabase,
        companyId,
        userId,
        invoice as SupplierInvoice,
        itemInserts as unknown as SupplierInvoiceItem[],
        supplier.supplier_type,
        supplier.name,
      )

      if (journalEntry) {
        registrationJournalEntryId = journalEntry.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)

        // Attach the OCR'd source document to the verifikat so the
        // registration JE has its underlag per BFL 5 kap 6 §. Linking failure
        // is non-fatal — the JE is already posted and immutable; we log and
        // continue so the supplier invoice stays usable.
        if (documentId) {
          try {
            await linkToJournalEntry(supabase, companyId, documentId, journalEntry.id)
          } catch (linkErr) {
            log.warn('Failed to link inbox document to registration JE', {
              documentId,
              journalEntryId: journalEntry.id,
              error: linkErr instanceof Error ? linkErr.message : String(linkErr),
            })
          }
        }
      } else {
        // createSupplierInvoiceRegistrationEntry returns null ONLY when no
        // fiscal period covers invoice_date (every other failure throws into
        // the catch below). Without this branch the inbox item gets linked to
        // an unbooked supplier invoice — the same 2440/2641 orphan the catch
        // guards against. Roll back (items first, see FK note below) and return
        // an actionable error instead of silently "succeeding".
        await supabase
          .from('supplier_invoice_items')
          .delete()
          .eq('supplier_invoice_id', invoice.id)
        await supabase
          .from('supplier_invoices')
          .delete()
          .eq('id', invoice.id)
          .eq('company_id', companyId)
        return {
          error:
            'Det finns inget räkenskapsår som täcker fakturadatumet. Lägg upp räkenskapsåret först, eller ändra fakturadatumet.',
          status: 400,
        }
      }
    } catch (err) {
      // Roll back: orphan supplier_invoices row without its registration JE
      // understates leverantörsskuld (2440) + ingående moms (2641) on the
      // momsdeklaration. Items must be deleted BEFORE the parent — the FK
      // on supplier_invoice_items.supplier_invoice_id is ON DELETE NO ACTION
      // (default), so a parent-first delete would be silently blocked and
      // leave the doomed invoice in the supplier ledger.
      await supabase
        .from('supplier_invoice_items')
        .delete()
        .eq('supplier_invoice_id', invoice.id)
      const { error: parentDeleteErr } = await supabase
        .from('supplier_invoices')
        .delete()
        .eq('id', invoice.id)
        .eq('company_id', companyId)
      if (parentDeleteErr) {
        // Hard inconsistency: items gone but parent stuck. Log loudly so an
        // operator can clean up — this should not happen in practice.
        log.error('Rollback partial: parent supplier_invoices delete failed after JE failure', {
          companyId,
          invoiceId: invoice.id,
          parentDeleteError: parentDeleteErr.message,
          originalError: err instanceof Error ? err.message : String(err),
        })
      }
      if (isBookkeepingError(err)) throw err
      log.error('Failed to create registration journal entry; supplier invoice rolled back', {
        companyId,
        inboxItemId,
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : 'unknown',
      })
      return {
        error: 'Failed to create registration journal entry',
        status: 500,
      }
    }
  }

  // Terminal state for the inbox row: created_supplier_invoice_id is the
  // dedup key for next time this inbox item is touched, and it's what the UI
  // and list_unmatched_documents use to drop the row out of "needs action".
  // Do NOT write status here — the status CHECK only allows received|error
  // (migration 20260504180000); writing 'confirmed' makes Postgres reject the
  // whole UPDATE, so the link column never lands and the item stays unresolved.
  const { error: linkInboxErr } = await supabase
    .from('invoice_inbox_items')
    .update({ created_supplier_invoice_id: invoice.id })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)

  if (linkInboxErr) {
    log.warn('Failed to link inbox item to new supplier invoice (invoice still created)', {
      inboxItemId,
      supplierInvoiceId: invoice.id,
      error: linkInboxErr.message,
    })
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: invoice as SupplierInvoice, companyId, userId },
    })
  } catch { /* non-blocking */ }

  return {
    data: {
      supplier_invoice_id: invoice.id,
      inbox_item_id: inboxItemId,
      registration_journal_entry_id: registrationJournalEntryId,
      arrival_number: arrivalNum,
    },
  }
}

async function commitCreditSupplierInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.supplier_invoice_id as string
  if (!id) return { error: 'supplier_invoice_id is required', status: 400 }

  const { data: original, error: fetchError } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) return { error: 'Supplier invoice not found', status: 404 }
  if (original.status === 'credited') return { error: 'Fakturan har redan krediterats', status: 409 }

  const { data: arrivalNum } = await supabase.rpc('get_next_arrival_number', { p_company_id: companyId })

  const { data: creditNote, error: creditError } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_id: original.supplier_id,
      arrival_number: arrivalNum,
      supplier_invoice_number: `KREDIT-${original.supplier_invoice_number}`,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: new Date().toISOString().split('T')[0],
      status: 'registered',
      currency: original.currency,
      exchange_rate: original.exchange_rate,
      vat_treatment: original.vat_treatment,
      reverse_charge: original.reverse_charge,
      subtotal: original.subtotal,
      subtotal_sek: original.subtotal_sek,
      vat_amount: original.vat_amount,
      vat_amount_sek: original.vat_amount_sek,
      total: original.total,
      total_sek: original.total_sek,
      remaining_amount: 0,
      is_credit_note: true,
      credited_invoice_id: id,
    })
    .select()
    .single()

  if (creditError || !creditNote) return { error: creditError?.message ?? 'Failed to create credit note', status: 500 }

  const creditItems = (original.items ?? []).map((item: Record<string, unknown>) => ({
    supplier_invoice_id: creditNote.id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
    account_number: item.account_number,
    vat_code: item.vat_code,
    vat_rate: item.vat_rate,
    vat_amount: item.vat_amount,
  }))
  await supabase.from('supplier_invoice_items').insert(creditItems)

  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method').eq('company_id', companyId).single()
  const accountingMethod = settings?.accounting_method || 'accrual'

  let journalEntryId: string | null = null
  if (accountingMethod === 'accrual') {
    try {
      const je = await createSupplierCreditNoteEntry(
        supabase,
        companyId,
        userId,
        creditNote,
        creditItems as never,
        original.supplier?.supplier_type || 'swedish_business',
        original.supplier?.name
      )
      if (je) {
        journalEntryId = je.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: je.id })
          .eq('id', creditNote.id)
      }
    } catch (err) {
      await supabase.from('supplier_invoices').delete().eq('id', creditNote.id).eq('company_id', companyId)
      if (isBookkeepingError(err)) throw err
      return { error: err instanceof Error ? err.message : 'Failed to book credit note', status: 500 }
    }
  }

  const newRemaining = Math.max(0, original.remaining_amount - original.total)
  const newStatus = newRemaining <= 0 ? 'credited' : original.status

  await supabase
    .from('supplier_invoices')
    .update({ status: newStatus, remaining_amount: newRemaining })
    .eq('id', id)

  try {
    await eventBus.emit({
      type: 'supplier_invoice.credited',
      payload: { supplierInvoice: original, creditNote, companyId, userId },
    })
  } catch { /* non-blocking */ }

  return { data: { credit_note_id: creditNote.id, journal_entry_id: journalEntryId } }
}

async function commitCreditInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.invoice_id as string
  const reason = params.reason as string | undefined
  if (!id) return { error: 'invoice_id is required', status: 400 }

  const { data: original, error: fetchError } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) return { error: 'Original invoice not found', status: 404 }
  if (original.document_type && original.document_type !== 'invoice') {
    return { error: 'Credit notes can only be created from standard invoices', status: 400 }
  }
  if (original.status === 'credited') return { error: 'Invoice has already been credited', status: 409 }
  if (!['sent', 'paid', 'overdue'].includes(original.status)) {
    return { error: 'Only sent, paid, or overdue invoices can be credited', status: 400 }
  }

  const today = new Date().toISOString().split('T')[0]
  const creditNoteNumber = `KR-${original.invoice_number}`

  const { data: creditNote, error: creditNoteError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: original.customer_id,
      invoice_number: creditNoteNumber,
      invoice_date: today,
      due_date: today,
      delivery_date: original.delivery_date ?? null,
      currency: original.currency,
      exchange_rate: original.exchange_rate,
      exchange_rate_date: original.exchange_rate_date,
      subtotal: -Math.abs(original.subtotal),
      subtotal_sek: original.subtotal_sek != null ? -Math.abs(original.subtotal_sek) : null,
      vat_amount: -Math.abs(original.vat_amount),
      vat_amount_sek: original.vat_amount_sek != null ? -Math.abs(original.vat_amount_sek) : null,
      total: -Math.abs(original.total),
      total_sek: original.total_sek != null ? -Math.abs(original.total_sek) : null,
      vat_treatment: original.vat_treatment,
      vat_rate: original.vat_rate,
      moms_ruta: original.moms_ruta,
      reverse_charge_text: original.reverse_charge_text,
      your_reference: original.your_reference,
      our_reference: original.our_reference,
      notes: reason || `Krediterar faktura ${original.invoice_number}`,
      credited_invoice_id: id,
      status: 'sent',
    })
    .select()
    .single()

  if (creditNoteError || !creditNote) {
    return { error: creditNoteError?.message ?? 'Failed to create credit note', status: 500 }
  }

  const creditItems = (original.items || []).map((item: {
    sort_order: number
    description: string
    quantity: number
    unit: string
    unit_price: number
    line_total: number
    vat_rate?: number
    vat_amount?: number
  }) => ({
    invoice_id: creditNote.id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: -Math.abs(item.quantity),
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: -Math.abs(item.line_total),
    vat_rate: item.vat_rate ?? 0,
    vat_amount: -(item.vat_amount ? Math.abs(item.vat_amount) : 0),
  }))

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(creditItems)

  if (itemsError) {
    await supabase.from('invoices').delete().eq('id', creditNote.id)
    return { error: itemsError.message, status: 500 }
  }

  await supabase.from('invoices').update({ status: 'credited' }).eq('id', id)

  const { data: completeCreditNote } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', creditNote.id)
    .single()

  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type, accounting_method')
    .eq('company_id', companyId)
    .single()

  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'
  const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'

  // Resolve the original verifikation reference so the credit-note JE can
  // point back to the corrected entry per BFL 5 kap. 5 §. We tolerate
  // missing-JE on the original (legacy data) — the description simply omits
  // the voucher reference and keeps the invoice-number reference.
  let originalVoucherRef: string | undefined
  if (original.journal_entry_id) {
    const { data: origJe } = await supabase
      .from('journal_entries')
      .select('voucher_series, voucher_number')
      .eq('id', original.journal_entry_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (origJe?.voucher_series && origJe?.voucher_number != null) {
      originalVoucherRef = `${origJe.voucher_series}-${origJe.voucher_number}`
    }
  }

  let journalEntryId: string | null = null
  if (completeCreditNote && accountingMethod === 'accrual') {
    try {
      const journalEntry = await createCreditNoteJournalEntry(
        supabase,
        companyId,
        userId,
        completeCreditNote as Invoice,
        entityType,
        completeCreditNote.customer?.name,
        originalVoucherRef
      )
      if (journalEntry) {
        journalEntryId = journalEntry.id
        await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', creditNote.id)
      }
    } catch (err) {
      if (isBookkeepingError(err)) throw err
      log.error('Failed to create credit note journal entry:', err)
    }

    try {
      await eventBus.emit({
        type: 'credit_note.created',
        payload: { creditNote: completeCreditNote as CreditNote, companyId, userId },
      })
    } catch { /* non-blocking */ }
  }

  return { data: { credit_note_id: creditNote.id, journal_entry_id: journalEntryId } }
}

async function commitConvertInvoice(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const id = params.invoice_id as string
  if (!id) return { error: 'invoice_id is required', status: 400 }

  const { data: proforma, error: proformaError } = await supabase
    .from('invoices').select('*, items:invoice_items(*)').eq('id', id).eq('company_id', companyId).single()

  if (proformaError || !proforma) return { error: 'Proformafakturan hittades inte', status: 404 }
  if (proforma.document_type !== 'proforma') {
    return { error: 'Endast proformafakturor kan konverteras', status: 400 }
  }
  if (proforma.status === 'cancelled') {
    return { error: 'Denna proformafaktura har redan makuleras', status: 409 }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: proforma.customer_id,
      invoice_number: null,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: proforma.due_date,
      currency: proforma.currency,
      exchange_rate: proforma.exchange_rate,
      exchange_rate_date: proforma.exchange_rate_date,
      subtotal: proforma.subtotal,
      subtotal_sek: proforma.subtotal_sek,
      vat_amount: proforma.vat_amount,
      vat_amount_sek: proforma.vat_amount_sek,
      total: proforma.total,
      total_sek: proforma.total_sek,
      vat_treatment: proforma.vat_treatment,
      vat_rate: proforma.vat_rate,
      moms_ruta: proforma.moms_ruta,
      reverse_charge_text: proforma.reverse_charge_text,
      your_reference: proforma.your_reference,
      our_reference: proforma.our_reference,
      notes: proforma.notes,
      document_type: 'invoice',
      converted_from_id: id,
    })
    .select()
    .single()

  if (invoiceError) return { error: invoiceError.message, status: 500 }

  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { error: err instanceof Error ? err.message : 'Failed to assign invoice number', status: 500 }
  }

  const items = (proforma.items ?? []).map((item: Record<string, unknown>) => ({
    invoice_id: invoice.id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
  }))

  if (items.length > 0) {
    const { error: itemsError } = await supabase.from('invoice_items').insert(items)
    if (itemsError) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      return { error: itemsError.message, status: 500 }
    }
  }

  await supabase.from('invoices').update({ status: 'cancelled' }).eq('id', id)

  return { data: { invoice_id: invoice.id, invoice_number: invoice.invoice_number } }
}

async function commitImportSie(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const fileContent = params.file_content as string
  const filename = params.filename as string
  const mappings = params.mappings as AccountMapping[] | undefined
  const createFiscalPeriod = Boolean(params.create_fiscal_period)
  const importOpeningBalances = Boolean(params.import_opening_balances)
  const importTransactions = Boolean(params.import_transactions)
  const voucherSeries = params.voucher_series as string | undefined

  if (!fileContent || !filename || !Array.isArray(mappings)) {
    return { error: 'file_content, filename, and mappings are required', status: 400 }
  }

  let parsed
  try {
    parsed = parseSIEFile(fileContent)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to parse SIE file', status: 400 }
  }

  try {
    const result = await executeSIEImport(supabase, companyId, userId, parsed, mappings, {
      filename,
      fileContent,
      createFiscalPeriod,
      importOpeningBalances,
      importTransactions,
      voucherSeries,
    })

    if (!result.success) {
      return { error: result.errors.join('; ') || 'SIE import failed', status: 400 }
    }

    return {
      data: {
        import_id: result.importId,
        fiscal_period_id: result.fiscalPeriodId,
        opening_balance_entry_id: result.openingBalanceEntryId,
        journal_entries_created: result.journalEntriesCreated,
        warnings: result.warnings,
      },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'SIE import failed', status: 500 }
  }
}

async function commitUndoSieImport(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const importId = params.import_id as string

  if (!importId) {
    return { error: 'import_id is required', status: 400 }
  }

  const result = await undoSIEImport(supabase, companyId, importId)
  if (!result.success) {
    return { error: result.error ?? 'SIE undo failed', status: 400 }
  }

  return {
    data: {
      import_id: importId,
      deleted_entries: result.deletedEntries,
    },
  }
}

// ── Phase 4: arbitrary-line bookkeeping primitives ───────────────

/**
 * Normalize raw JSON line input from pending_operations.params into the
 * engine's typed line shape. Trusts shape because the MCP tool already
 * validates via Zod before staging — defensive coercion only.
 */
function normalizeVoucherLines(raw: unknown): CreateJournalEntryLineInput[] {
  if (!Array.isArray(raw)) return []
  return raw.map((l) => {
    const line = l as Record<string, unknown>
    return {
      account_number: String(line.account_number),
      debit_amount: Number(line.debit_amount) || 0,
      credit_amount: Number(line.credit_amount) || 0,
      line_description: line.line_description ? String(line.line_description) : undefined,
      currency: line.currency ? String(line.currency) : undefined,
      amount_in_currency: line.amount_in_currency !== undefined ? Number(line.amount_in_currency) : undefined,
      exchange_rate: line.exchange_rate !== undefined ? Number(line.exchange_rate) : undefined,
      tax_code: line.tax_code ? String(line.tax_code) : undefined,
      cost_center: line.cost_center ? String(line.cost_center) : undefined,
      project: line.project ? String(line.project) : undefined,
    }
  })
}

async function commitCreateVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
  opts: CommitOptions = {}
): Promise<ExecutorResult> {
  const entryDate = params.entry_date as string
  const description = params.description as string
  const lines = normalizeVoucherLines(params.lines)

  if (!entryDate || !description || lines.length < 2) {
    return { error: 'entry_date, description, and at least two lines are required', status: 400 }
  }

  // Re-validate balance defensively. The MCP tool already checks before
  // staging, but a tampered or hand-inserted pending_operations row would
  // bypass that gate. createDraftEntry runs the same check internally — this
  // is for a cleaner 400 + Swedish error before reaching the engine.
  const balance = validateBalance(lines)
  if (!balance.valid) {
    return {
      error: `Verifikationen balanserar inte: debet ${balance.totalDebit} SEK, kredit ${balance.totalCredit} SEK.`,
      status: 400,
    }
  }

  // Resolve fiscal period: prefer explicit, fall back to date lookup so the
  // caller can post a voucher without first calling list_fiscal_periods.
  let fiscalPeriodId = params.fiscal_period_id as string | undefined
  if (!fiscalPeriodId) {
    const resolved = await findFiscalPeriod(supabase, companyId, entryDate)
    if (!resolved) {
      return {
        error: `Ingen öppen räkenskapsperiod täcker datumet ${entryDate}. Öppna en period eller välj ett annat datum.`,
        status: 400,
      }
    }
    fiscalPeriodId = resolved
  }

  try {
    const entry = await createJournalEntry(
      supabase,
      companyId,
      userId,
      {
        fiscal_period_id: fiscalPeriodId,
        entry_date: entryDate,
        description,
        // source_type is hardcoded — never trust params.source_type. The MCP
        // tool stages 'manual', but a future direct-staging path could
        // otherwise inject 'bank'/'invoice'/etc. and corrupt audit attribution.
        source_type: 'manual' as JournalEntrySourceType,
        voucher_series: (params.voucher_series as string) || undefined,
        notes: (params.notes as string) || undefined,
        lines,
      },
      // commit_method records HOW it was committed, not who staged it. MCP-
      // staged ops still go through human approval, so 'user_accept' (or
      // 'bulk_accept' from the bulk route) is the correct value. The DB CHECK
      // constraint rejects anything else (migration 20260420120001).
      opts.commitMethod ?? 'user_accept'
    )

    // Optional inbox linking — set when gnubok_create_voucher is called with
    // inbox_item_id (book-direct flow for kvitton). The verifikat is already
    // posted and immutable; failures here are non-fatal and only affect
    // discoverability (inbox row stays in "needs action" with the document
    // unlinked). Logged so the user can repair via the UI if needed.
    const inboxItemId = params.inbox_item_id as string | undefined
    const documentId = params.document_id as string | undefined
    let inboxLinked = false
    if (inboxItemId) {
      // Race guard: the UNIQUE constraint on
      // invoice_inbox_items.created_journal_entry_id (migration 20260515090000)
      // stops two inbox items from being linked to the same JE, but it does
      // NOT stop two concurrent commits of different staged ops on the same
      // inbox item from overwriting each other (the second UPDATE on the same
      // row trivially satisfies UNIQUE). We add a `.is('created_journal_entry_id', null)`
      // predicate so only the first commit succeeds; the loser sees a
      // zero-rows-updated result and surfaces a structured warning. We also
      // require .eq('created_supplier_invoice_id', null) so a concurrent
      // create_supplier_invoice_from_inbox doesn't get clobbered either.
      // Only the link column is written — the status CHECK allows received|error
      // (migration 20260504180000), so writing 'confirmed' here would fail the
      // whole UPDATE and silently leave the inbox item in "needs action".
      const { data: updatedRows, error: linkInboxErr } = await supabase
        .from('invoice_inbox_items')
        .update({ created_journal_entry_id: entry.id })
        .eq('id', inboxItemId)
        .eq('company_id', companyId)
        .is('created_journal_entry_id', null)
        .is('created_supplier_invoice_id', null)
        .select('id')

      if (linkInboxErr) {
        log.warn('Failed to link inbox item to new voucher (voucher still posted)', {
          inboxItemId,
          journalEntryId: entry.id,
          error: linkInboxErr.message,
        })
      } else if (!updatedRows || updatedRows.length === 0) {
        // Race: another commit already claimed this inbox item (either as a
        // journal entry or supplier invoice). The verifikat is already posted
        // and immutable — we leave it; an operator can rättelse via storno
        // if it's a true duplicate.
        log.warn('Voucher posted but inbox item was already claimed by a concurrent commit', {
          inboxItemId,
          journalEntryId: entry.id,
        })
      } else {
        inboxLinked = true
      }

      // Only attach the OCR document when the inbox link succeeded — if a
      // racing commit already owns the inbox row, the document already lives
      // on its JE and re-attaching here would either fail noisily (UNIQUE on
      // document_attachments.journal_entry_id, if any) or silently shift it.
      if (documentId && inboxLinked) {
        try {
          await linkToJournalEntry(supabase, companyId, documentId, entry.id)
        } catch (linkDocErr) {
          log.warn('Failed to attach inbox document to new voucher', {
            documentId,
            journalEntryId: entry.id,
            error: linkDocErr instanceof Error ? linkDocErr.message : String(linkDocErr),
          })
        }
      }
    }

    return {
      data: {
        journal_entry_id: entry.id,
        voucher_number: entry.voucher_number,
        voucher_series: entry.voucher_series,
        fiscal_period_id: fiscalPeriodId,
        ...(inboxItemId ? { inbox_item_id: inboxItemId, inbox_linked: inboxLinked } : {}),
      },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Failed to create voucher', status: 500 }
  }
}

async function commitCorrectEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const entryId = params.entry_id as string
  const lines = normalizeVoucherLines(params.lines)

  if (!entryId || lines.length < 2) {
    return { error: 'entry_id and at least two lines are required', status: 400 }
  }

  // Pre-flight: verify the original is posted and its period is not locked.
  // Falling into correctEntry without this returns a less helpful DB error and
  // half-creates the storno before rolling back; surfacing the Swedish message
  // here matches the period_locked UX everywhere else in the app.
  //
  // Period lock check is two-layer (matches the DB triggers): per-period
  // (is_closed / locked_at) AND company-wide (bookkeeping_locked_through).
  // The staging tool uses resolvePeriodStatusForDate; we reuse it here so the
  // commit-time gate matches the staging-time signal.
  const { data: original, error: origErr } = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, fiscal_period_id, fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(is_closed, locked_at)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (origErr || !original) {
    return { error: 'Verifikationen hittades inte.', status: 404 }
  }
  if (original.status !== 'posted') {
    return {
      error: `Endast bokförda verifikationer kan rättas. Aktuell status: ${original.status}. Drafts redigeras direkt.`,
      status: 409,
    }
  }
  const period = original.fiscal_periods as { is_closed?: boolean; locked_at?: string | null } | { is_closed?: boolean; locked_at?: string | null }[] | null
  const periodRow = Array.isArray(period) ? period[0] : period
  if (periodRow?.is_closed || periodRow?.locked_at) {
    return {
      error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
      status: 409,
    }
  }
  // resolvePeriodStatusForDate also covers the company-wide bookkeeping_locked_through
  // gate. A DB blip here would otherwise propagate as a 500 with a raw Postgres
  // message; wrap so the caller sees a clean Swedish 500 instead, consistent with
  // the staging-side log-and-degrade behaviour in stagePendingOperation.
  try {
    const periodStatus = await resolvePeriodStatusForDate(supabase, companyId, original.entry_date)
    if (periodStatus.status === 'locked' || periodStatus.status === 'closed') {
      return {
        error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
        status: 409,
      }
    }
  } catch (err) {
    return {
      error: `Kunde inte verifiera periodstatus: ${err instanceof Error ? err.message : 'okänt fel'}`,
      status: 500,
    }
  }

  try {
    // correctEntry() posts both the storno and the corrected entry into the
    // SAME fiscal_period_id and entry_date as the original (see
    // lib/core/bookkeeping/storno-service.ts:99,102,195,198). So a rättelse
    // made in May 2026 for a December 2025 voucher correctly lands in 2025,
    // keeping that period's balances consistent. The is_closed pre-flight
    // above is what blocks corrections to already-locked periods.
    const result = await correctEntry(supabase, companyId, userId, entryId, lines)
    return {
      data: {
        original_entry_id: entryId,
        storno_entry_id: result.reversal.id,
        corrected_entry_id: result.corrected.id,
        storno_voucher_number: result.reversal.voucher_number,
        corrected_voucher_number: result.corrected.voucher_number,
      },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Failed to correct entry', status: 500 }
  }
}

async function commitReverseEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const entryId = params.entry_id as string
  const reversalDate = typeof params.reversal_date === 'string' ? params.reversal_date : undefined

  if (!entryId) {
    return { error: 'entry_id is required', status: 400 }
  }

  // Pre-flight matches commitCorrectEntry: posted + period not closed. Surfaces
  // Swedish messages before reverseEntry() throws less helpful errors. Period
  // lock check is two-layer (per-period + company-wide bookkeeping_locked_through)
  // via resolvePeriodStatusForDate, matching the staging-time signal.
  const { data: original, error: origErr } = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, fiscal_period_id, fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(is_closed, locked_at)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (origErr || !original) {
    return { error: 'Verifikationen hittades inte.', status: 404 }
  }
  if (original.status !== 'posted') {
    return {
      error: `Endast bokförda verifikationer kan makuleras. Aktuell status: ${original.status}.`,
      status: 409,
    }
  }
  const period = original.fiscal_periods as { is_closed?: boolean; locked_at?: string | null } | { is_closed?: boolean; locked_at?: string | null }[] | null
  const periodRow = Array.isArray(period) ? period[0] : period
  if (periodRow?.is_closed || periodRow?.locked_at) {
    return {
      error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
      status: 409,
    }
  }
  try {
    const periodStatus = await resolvePeriodStatusForDate(supabase, companyId, original.entry_date)
    if (periodStatus.status === 'locked' || periodStatus.status === 'closed') {
      return {
        error: 'Räkenskapsperioden är låst. Öppna perioden eller använd omprövning för redan inlämnade momsdeklarationer.',
        status: 409,
      }
    }
  } catch (err) {
    return {
      error: `Kunde inte verifiera periodstatus: ${err instanceof Error ? err.message : 'okänt fel'}`,
      status: 500,
    }
  }

  try {
    const reversal = await reverseEntry(supabase, companyId, userId, entryId, reversalDate)
    // Invariant per BFL 5 kap 5§: the storno must land in the same fiscal period
    // as the original entry. reverseEntry() at lib/bookkeeping/engine.ts:492 uses
    // original.fiscal_period_id, but assert it here so a future engine change that
    // breaks this invariant fails fast instead of silently shifting period attribution.
    if (reversal.fiscal_period_id !== original.fiscal_period_id) {
      return {
        error: `BFL invariant broken: storno period ${reversal.fiscal_period_id} differs from original ${original.fiscal_period_id}.`,
        status: 500,
      }
    }
    return {
      data: {
        original_entry_id: entryId,
        reversal_entry_id: reversal.id,
        reversal_voucher_number: reversal.voucher_number,
        reversal_voucher_series: reversal.voucher_series,
        fiscal_period_id: reversal.fiscal_period_id,
      },
    }
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    return { error: err instanceof Error ? err.message : 'Failed to reverse entry', status: 500 }
  }
}

// ── Payroll executors ────────────────────────────────────────────

async function commitCreateSalaryRun(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const periodYear = params.period_year as number
  const periodMonth = params.period_month as number
  const paymentDate = params.payment_date as string
  if (
    !Number.isInteger(periodYear) ||
    !Number.isInteger(periodMonth) ||
    typeof paymentDate !== 'string'
  ) {
    return { error: 'period_year, period_month, payment_date are required', status: 400 }
  }

  try {
    const { createSalaryRunWithEmployees } = await import('@/lib/salary/create-run')
    const { run, employeeCount } = await createSalaryRunWithEmployees(
      supabase,
      companyId,
      userId,
      { periodYear, periodMonth, paymentDate },
    )
    return {
      data: {
        salary_run_id: (run as { id?: string }).id,
        employee_count: employeeCount,
        period: `${periodYear}-${String(periodMonth).padStart(2, '0')}`,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to create salary run',
      status: 500,
    }
  }
}

async function commitGenerateAgi(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  if (!salaryRunId) return { error: 'salary_run_id is required', status: 400 }

  try {
    const { generateAgiDeclaration } = await import('@/lib/salary/agi/generate-declaration')
    const { randomUUID } = await import('node:crypto')
    const result = await generateAgiDeclaration({
      supabase,
      companyId,
      userId,
      userEmail: null,
      salaryRunId,
      log: createLogger('commit/generate_agi'),
      requestId: randomUUID(),
    })
    if (!result.ok) {
      return { error: `AGI-generering misslyckades: ${result.code}`, status: 500 }
    }
    const period = `${result.periodYear}-${String(result.periodMonth).padStart(2, '0')}`
    return {
      data: {
        agi_declaration_id: result.agiDeclarationId,
        period,
        employee_count: result.employeeCount,
        is_correction: result.isCorrection,
        download_url: `/api/salary/runs/${salaryRunId}/agi/xml`,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to generate AGI',
      status: 500,
    }
  }
}

// ── Multi-tx commit handlers (PRs #603/#606/#608/#610) ────────────
//
// Both wrap their SQL RPC. The RPCs do all the heavy lifting (locking,
// balance/period checks, journal entry creation, voucher number,
// payment/junction rows, doc inheritance). The commit handlers just
// shape params, call the RPC, and translate the structured error code
// or success payload into an ExecutorResult.

async function commitMatchBatchAllocate(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Trust boundary (compliance-swarm V8.2.1, A.8.2):
  // Tenant isolation is enforced authoritatively inside the SQL RPC
  // `match_batch_allocate` (supabase/migrations/20260601122000_*.sql):
  //   - `transactions` row fetched WHERE id = p_tx_id AND company_id = p_company_id
  //   - `invoices` and `supplier_invoices` rows fetched WHERE id = ? AND company_id = p_company_id
  //   - `auth.uid()` resolves the caller; membership checked against
  //     `company_members.company_id = p_company_id`
  // The MCP execute() handler additionally pre-checks the same IDs to
  // surface clean errors before staging. This commit handler is a thin
  // pass-through by design — re-querying here would triple the same
  // check without adding security.
  const txId = params.transaction_id as string
  const allocations = params.allocations
  if (!txId) return { error: 'transaction_id is required', status: 400 }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return { error: 'allocations is required (non-empty array)', status: 400 }
  }
  const { data, error } = await supabase.rpc('match_batch_allocate', {
    p_tx_id: txId,
    p_allocations: allocations,
    p_company_id: companyId,
  })
  if (error) {
    // Sanitised log (A.8.11, CC7.2): only error code + message, no
    // payload — error.details can echo invoice IDs, amounts, etc.
    log.error('match_batch_allocate RPC error', {
      code: (error as { code?: string }).code,
      message: error.message,
    })
    return { error: error.message || 'Database error', status: 500 }
  }
  const result = data as { ok: boolean; code?: string; details?: unknown; journal_entry_id?: string }
  if (!result || !result.ok) {
    return {
      error: result?.code || 'match_batch_allocate failed',
      status: 400,
      data: result?.details as Record<string, unknown> | undefined,
    }
  }
  // Structured audit-trail entry on success (compliance-swarm V16). Tx
  // count + JE id + the source tx id only — no amounts, no
  // counterparty identifiers, no descriptions. txId is included
  // intentionally so the audit trail can join successful commits back
  // to the source bank tx without a separate query; it's not PII on
  // its own (just an internal UUID, scoped to companyId already logged).
  log.info('match_batch_allocate committed', {
    companyId,
    operationType: 'match_batch_allocate',
    journalEntryId: result.journal_entry_id,
    txId,
    allocationCount: allocations.length,
  })
  return { data: result as unknown as Record<string, unknown>, status: 200 }
}

async function commitBulkBookTransactions(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Trust boundary (compliance-swarm V8.2.1, A.8.2):
  // Tenant isolation + chart-of-accounts validation are enforced
  // authoritatively inside the SQL RPC `bulk_book_transactions`
  // (supabase/migrations/20260602121000_*.sql):
  //   - All `transactions` rows fetched WHERE id = ANY(p_tx_ids) AND
  //     company_id = p_company_id (line ~115).
  //   - `journal_entries` row (link-existing branch) fetched WHERE id =
  //     p_existing_journal_entry_id AND company_id = p_company_id.
  //   - Every account_number in p_new_entry.lines validated against
  //     `chart_of_accounts` filtered by company_id + is_active (PR #610
  //     round 2 added this allowlist).
  //   - `auth.uid()` resolves the caller; membership checked against
  //     `company_members.company_id = p_company_id`.
  // The MCP execute() handler additionally pre-checks tx ownership +
  // JE ownership at stage time to surface clean errors. This commit
  // handler is a thin pass-through by design.
  const txIds = params.tx_ids
  const existingJeId = (params.existing_journal_entry_id as string | null | undefined) ?? null
  const newEntry = (params.new_entry as Record<string, unknown> | null | undefined) ?? null
  if (!Array.isArray(txIds) || txIds.length === 0) {
    return { error: 'tx_ids is required (non-empty array)', status: 400 }
  }
  if ((existingJeId == null) === (newEntry == null)) {
    return {
      error: 'Provide exactly one of existing_journal_entry_id or new_entry',
      status: 400,
    }
  }
  const { data, error } = await supabase.rpc('bulk_book_transactions', {
    p_tx_ids: txIds,
    p_existing_journal_entry_id: existingJeId,
    p_new_entry: newEntry,
    p_company_id: companyId,
  })
  if (error) {
    // Sanitised log (A.8.11, CC7.2): only error code + message.
    log.error('bulk_book_transactions RPC error', {
      code: (error as { code?: string }).code,
      message: error.message,
    })
    return { error: error.message || 'Database error', status: 500 }
  }
  const result = data as { ok: boolean; code?: string; details?: unknown; journal_entry_id?: string; mode?: string; linked_tx_count?: number; docs_linked?: number }
  if (!result || !result.ok) {
    return {
      error: result?.code || 'bulk_book_transactions failed',
      status: 400,
      data: result?.details as Record<string, unknown> | undefined,
    }
  }
  // Structured audit-trail entry on success (compliance-swarm V16).
  log.info('bulk_book_transactions committed', {
    companyId,
    operationType: 'bulk_book_transactions',
    journalEntryId: result.journal_entry_id,
    mode: result.mode,
    txCount: result.linked_tx_count,
    docsLinked: result.docs_linked,
  })
  return { data: result as unknown as Record<string, unknown>, status: 200 }
}

async function commitLinkTransactionJournalEntry(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const transactionId = params.transaction_id as string | undefined
  const journalEntryId = params.journal_entry_id as string | undefined
  const invoiceId = (params.invoice_id as string | undefined) ?? undefined

  if (!transactionId || !journalEntryId) {
    return { error: 'transaction_id and journal_entry_id are required', status: 400 }
  }

  const outcome = await linkTransactionToJournalEntry(supabase, userId, companyId, {
    transactionId,
    journalEntryId,
    invoiceId,
  })

  if (!outcome.ok) {
    const entry = getErrorEntry(outcome.code)
    const httpStatus = entry?.httpStatus ?? 500
    return {
      error: entry?.message_en ?? outcome.code,
      status: httpStatus,
      data: outcome.details as Record<string, unknown> | undefined,
    }
  }

  // Structured audit-trail entry on success (compliance-swarm V16, SOC 2 CC4.1).
  // Mirrors commitMatchBatchAllocate / commitBulkBookTransactions — IDs only,
  // no amounts or counterparty PII. invoiceId is logged as boolean to avoid
  // leaking which invoices are touched while still distinguishing the two
  // code paths (link-only vs link+settle).
  log.info('link_transaction_journal_entry committed', {
    companyId,
    operationType: 'link_transaction_journal_entry',
    transactionId: outcome.result.transactionId,
    journalEntryId: outcome.result.journalEntryId,
    settledInvoice: outcome.result.invoiceId != null,
  })

  return {
    data: {
      transaction_id: outcome.result.transactionId,
      journal_entry_id: outcome.result.journalEntryId,
      voucher_label: outcome.result.voucherLabel,
      invoice_id: outcome.result.invoiceId,
      invoice_status: outcome.result.invoiceStatus,
      paid_amount: outcome.result.paidAmount,
      remaining_amount: outcome.result.remainingAmount,
    },
  }
}

// ── Public dispatcher ────────────────────────────────────────────

/**
 * Execute a pending_operation by type, update its status row, and return a
 * normalized CommitResult.
 *
 * Used by both the human-approval route and the auto-commit path. Status row
 * transitions are applied here so the two callers stay consistent.
 */
export async function commitPendingOperation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  // ── Atomic claim: flip status pending → committing in a single conditional
  //    update. If 0 rows are affected, another caller (auto-commit ↔ human
  //    approval, or two parallel approvals) already claimed this op and we
  //    must not run side-effects. Without this, both callers can pass the
  //    in-memory status check and double-book journal entries, send duplicate
  //    emails, etc.
  const { data: claimed, error: claimError } = await supabase
    .from('pending_operations')
    .update({ status: 'committing' })
    .eq('id', pendingOp.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (claimError) {
    log.error('Failed to claim pending_operation:', claimError)
    return { status: 'failed', error: 'Failed to claim operation', http_status: 500 }
  }
  if (!claimed) {
    return {
      status: 'failed',
      error: 'Operation already claimed or resolved by another caller',
      http_status: 409,
    }
  }

  let result: ExecutorResult
  try {
    switch (pendingOp.operation_type) {
      case 'categorize_transaction':
        result = await commitCategorizeTransaction(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_customer':
        result = await commitCreateCustomer(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_supplier':
        result = await commitCreateSupplier(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_invoice':
        result = await commitCreateInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_transaction':
        result = await commitCreateTransaction(supabase, userId, companyId, pendingOp.params)
        break
      case 'mark_invoice_paid':
        result = await commitMarkInvoicePaid(supabase, userId, companyId, pendingOp.params)
        break
      case 'send_invoice':
        result = await commitSendInvoice(supabase, userId, companyId, pendingOp.params, opts.userEmail)
        break
      case 'mark_invoice_sent':
        result = await commitMarkInvoiceSent(supabase, userId, companyId, pendingOp.params)
        break
      case 'match_transaction_invoice':
        result = await commitMatchTransactionInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_invoice_voucher':
        result = await commitLinkInvoiceVoucher(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_supplier_invoice_voucher':
        result = await commitLinkSupplierInvoiceVoucher(supabase, userId, companyId, pendingOp.params)
        break
      case 'close_period':
        result = await commitClosePeriod(supabase, userId, companyId, pendingOp.params)
        break
      case 'lock_period':
        result = await commitLockPeriod(supabase, userId, companyId, pendingOp.params)
        break
      case 'unlock_period':
        result = await commitUnlockPeriod(supabase, userId, companyId, pendingOp.params)
        break
      case 'uncategorize_transaction':
        result = await commitUncategorizeTransaction(supabase, userId, companyId, pendingOp.params)
        break
      case 'attach_document_to_transaction':
        result = await commitAttachDocumentToTransaction(supabase, userId, companyId, pendingOp.params)
        break
      case 'run_year_end':
        result = await commitRunYearEnd(supabase, userId, companyId, pendingOp.params)
        break
      case 'set_opening_balances':
        result = await commitSetOpeningBalances(supabase, userId, companyId, pendingOp.params)
        break
      case 'run_currency_revaluation':
        result = await commitRunCurrencyRevaluation(supabase, userId, companyId, pendingOp.params)
        break
      case 'explain_voucher_gap':
        result = await commitExplainVoucherGap(supabase, userId, companyId, pendingOp.params)
        break
      case 'approve_supplier_invoice':
        result = await commitApproveSupplierInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_supplier_invoice_from_inbox':
        result = await commitCreateSupplierInvoiceFromInbox(supabase, userId, companyId, pendingOp.params)
        break
      case 'credit_supplier_invoice':
        result = await commitCreditSupplierInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'convert_invoice':
        result = await commitConvertInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'credit_invoice':
        result = await commitCreditInvoice(supabase, userId, companyId, pendingOp.params)
        break
      case 'import_sie':
        result = await commitImportSie(supabase, userId, companyId, pendingOp.params)
        break
      case 'undo_sie_import':
        result = await commitUndoSieImport(supabase, companyId, pendingOp.params)
        break
      case 'create_voucher':
        result = await commitCreateVoucher(supabase, userId, companyId, pendingOp.params, opts)
        break
      case 'correct_entry':
        result = await commitCorrectEntry(supabase, userId, companyId, pendingOp.params)
        break
      case 'reverse_entry':
        result = await commitReverseEntry(supabase, userId, companyId, pendingOp.params)
        break
      case 'post_annual_depreciation':
        result = await commitPostAnnualDepreciation(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_salary_run':
        result = await commitCreateSalaryRun(supabase, userId, companyId, pendingOp.params)
        break
      case 'generate_agi':
        result = await commitGenerateAgi(supabase, userId, companyId, pendingOp.params)
        break
      case 'match_batch_allocate':
        result = await commitMatchBatchAllocate(supabase, companyId, pendingOp.params)
        break
      case 'bulk_book_transactions':
        result = await commitBulkBookTransactions(supabase, companyId, pendingOp.params)
        break
      case 'link_transaction_journal_entry':
        result = await commitLinkTransactionJournalEntry(supabase, userId, companyId, pendingOp.params)
        break
      default:
        return {
          status: 'failed',
          error: `Unknown operation type: ${pendingOp.operation_type}`,
          http_status: 400,
        }
    }
  } catch (err) {
    // Accounts-not-in-chart is RECOVERABLE: the booking itself is valid; the
    // company's chart just lacks the (standard BAS) accounts it posts to. Do
    // NOT consume the op — release the atomic claim back to 'pending' so the
    // user can activate the accounts and retry the SAME op — and surface the
    // structured code + numbers so the client can offer one-click activation.
    if (err instanceof AccountsNotInChartError) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: err.message,
        http_status: 400,
        code: ACCOUNTS_NOT_IN_CHART,
        account_numbers: err.accountNumbers,
      }
    }
    const isBkErr = isBookkeepingError(err)
    const message = err instanceof Error ? err.message : (isBkErr ? 'Bookkeeping error' : 'Executor failed')
    // Release the claim by transitioning to 'rejected' so the row never gets
    // stuck in 'committing'. The error text is persisted in result_data for
    // audit/debug.
    await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        result_data: { error: message, threw: true },
      })
      .eq('id', pendingOp.id)
    return {
      status: 'failed',
      error: message,
      http_status: isBkErr ? 400 : 500,
    }
  }

  if (result.error) {
    const isAutoReject = result.status === 404 || result.status === 409
    await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        result_data: isAutoReject
          ? { auto_rejected: true, reason: result.error }
          : { error: result.error, http_status: result.status },
      })
      .eq('id', pendingOp.id)
    if (isAutoReject) {
      return {
        status: 'rejected',
        auto_rejected: true,
        error: result.error,
        http_status: result.status,
      }
    }
    return {
      status: 'failed',
      error: result.error,
      http_status: result.status ?? 500,
    }
  }

  const now = new Date().toISOString()
  await supabase
    .from('pending_operations')
    .update({
      status: 'committed',
      resolved_at: now,
      result_data: result.data || {},
    })
    .eq('id', pendingOp.id)

  return {
    status: 'committed',
    data: result.data,
  }
}

