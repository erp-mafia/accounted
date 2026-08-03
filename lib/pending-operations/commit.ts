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
 * private to this module: call `commitPendingOperation()` to invoke them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { bulkBookMatchedInboxItems, categorizeMatchedTransaction } from '@/lib/transactions/categorize-core'
import { getVatRules, getPermittedVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { roundOre } from '@/lib/money'
import { validateVatNumber } from '@/lib/vat/vies-client'
import {
  normalizeVatRateToDecimal,
  normalizeVatRateToFraction,
} from '@/lib/vat/supplier-invoice-line-checks'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
  createInvoiceJournalEntry,
  createCreditNoteJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { createJournalEntry, findFiscalPeriod, getSwedishLocalDate, reverseEntry, validateBalance } from '@/lib/bookkeeping/engine'
import {
  canApproveSupplierInvoice,
  resolveUnsettledStatus,
} from '@/lib/supplier-invoices/lifecycle'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
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
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { linkSupplierInvoiceToVoucher } from '@/lib/invoices/supplier-voucher-matching'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import {
  clearSettledBatchAllocationSuggestions,
  type BatchAllocationResult,
} from '@/lib/invoices/clear-settled-batch-allocations'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { parseSIEFile } from '@/lib/import/sie-parser'
import { executeSIEImport, undoSIEImport } from '@/lib/import/sie-import'
import type { AccountMapping } from '@/lib/import/types'
import { AccountsNotInChartError, isBookkeepingError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { extensionRegistry } from '@/lib/extensions/registry'
import {
  SkatteverketRecoverableError,
  type SkatteverketCommitServices,
  type SkvSubmitResult,
} from '@/lib/pending-operations/skatteverket-commit'
import { PartialCommitError } from '@/lib/pending-operations/errors'
import { getEmailService } from '@/lib/email/service'
import { hasCapability, CAPABILITY_BLOCKED_MESSAGE_SV } from '@/lib/entitlements/has-capability'
import { PAID_OPERATION_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import {
  exceedsInvoiceEmailRecipientLimit,
  invoiceEmailRecipientCount,
  resolveInvoiceEmailRecipients,
} from '@/lib/invoices/email-recipients'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  recordManualInvoiceDelivery,
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
} from '@/lib/invoices/invoice-deliveries'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { CreateSupplierParamsSchema } from '@/lib/pending-operations/schemas/create-supplier'
import { CreateArticleParamsSchema, UpdateArticleParamsSchema } from '@/lib/pending-operations/schemas/article'
import { CreateDimensionValueParamsSchema } from '@/lib/pending-operations/schemas/dimension-value'
import { RetagLineDimensionsParamsSchema } from '@/lib/pending-operations/schemas/retag-line-dimensions'
import { CreateAccountParamsSchema, UpdateAccountParamsSchema } from '@/lib/pending-operations/schemas/account'
import { SetVoucherNoteParamsSchema } from '@/lib/pending-operations/schemas/voucher-note'
import { UpdateCompanySettingsParamsSchema } from '@/lib/pending-operations/schemas/company-settings'
import { UpdateCustomerParamsSchema } from '@/lib/pending-operations/schemas/customer'
import {
  CreateRecurringScheduleParamsSchema,
  UpdateRecurringScheduleParamsSchema,
} from '@/lib/pending-operations/schemas/recurring-schedule'
import {
  computeInitialRunDate,
  computeNextRunDate,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'
import { UpdateInvoiceParamsSchema } from '@/lib/pending-operations/schemas/update-invoice'
import {
  buildInvoiceWriteData,
  type InvoiceWriteInput,
  type InvoiceWriteItemInput,
} from '@/lib/invoices/build-invoice-write'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import { replaceInvoiceItems } from '@/lib/invoices/replace-invoice-items'
import { applyRecurringScheduleUpdate } from '@/lib/invoices/apply-recurring-schedule-update'
import { BulkBookInboxSchema } from '@/lib/api/schemas'
import { ensureArticleNumber } from '@/lib/articles/ensure-article-number'
import { isValidRevenueAccount } from '@/lib/articles/validate-revenue-account'
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
  Article,
  SupplierInvoice,
  SupplierInvoiceItem,
  PendingOperation,
  CompanySettings,
  InvoiceItem,
  InvoiceDocumentType,
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
  // Structured-error registry code for the failure, when one is known, so a
  // caller can branch on the failure mode instead of parsing `error` text.
  // ACCOUNTS_NOT_IN_CHART is the recoverable case: the booking posts to BAS
  // accounts not active in the company chart, the op is left 'pending', and
  // the route rebuilds the structured envelope (code + account_numbers).
  // Other codes (e.g. INVOICE_RECURRING_UPDATE_PARTIAL) are informational:
  // callers that do not recognize the code fall back to `error`.
  code?: string
  account_numbers?: string[]
}

export interface CommitOptions {
  /** Email address used as cc on send_invoice (typically the human user's email). */
  userEmail?: string
  /**
   * commit_method recorded on any journal_entries created by this operation.
   * Must match the CHECK constraint on journal_entries.commit_method
   * (migration 20260618120001): 'user_accept' | 'bulk_accept' |
   * 'timing_ceiling' | 'migration' | 'legacy' | 'agent' | 'api_key'.
   *
   * Web-UI single-approval passes 'user_accept'; bulk-approval passes
   * 'bulk_accept'. MCP approvals pass the relaying credential: 'api_key'
   * (gnubok-mcp bridge) or 'agent' (OAuth connector), so the immutable layer
   * records that the acknowledgment was agent-relayed rather than a
   * first-party human session (agent_first_vision.md §8 P0-1). Every path is
   * still human-approval-gated; agent auto-commit was removed in
   * 20260505190027_drop_agent_auto_commit.
   */
  commitMethod?: 'user_accept' | 'bulk_accept' | 'agent' | 'api_key'
  /**
   * WHO is relaying this approval (api_key with the key's display name, plain
   * user, agent_chat, …). Propagated to every journal-entry commit made by the
   * operation via the runWithActor() AsyncLocalStorage scope (unlike
   * commitMethod, which only the create_voucher executor threads explicitly)
   * and stamped onto journal_entries.committed_actor_* plus the audit_log
   * COMMIT row by the commit_journal_entry RPC (migration 20260619120000).
   * Omitted → NULL attribution, identical to pre-attribution behaviour.
   */
  actor?: CommitActor
}

// ensureFiscalPeriod moved to lib/transactions/categorize-core.ts (imported
// above) so the bulk-book-inbox path and the single-categorize path share one
// implementation.

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

type ExecutorResult = {
  data?: Record<string, unknown>
  error?: string
  // Structured-error registry code for `error`, when the executor has one.
  // Surfaced as CommitResult.code and persisted in result_data.error_code so a
  // caller can branch on the failure mode instead of parsing the message text.
  errorCode?: string
  status?: number
  // Set when the executor already performed an irreversible side-effect
  // (posted voucher, persisted credit note) before the failure in `error`:
  // the dispatcher then lands the op in 'failed_partial' instead of
  // 'rejected' and persists these ids in result_data.posted_ids (issue #842).
  partialPostedIds?: Record<string, string>
}

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
  // The underlag's actual VAT, staged when the document's moms differs from
  // rate × belopp (e.g. dricks). Threaded into the mapping builder so the
  // approved posting matches the staged preview exactly.
  const vatAmount =
    typeof params.vat_amount === 'number' && Number.isFinite(params.vat_amount)
      ? params.vat_amount
      : undefined

  // Booking, the duplicate guard, VAT mapping, and matched-inbox underlag
  // propagation all live in the shared core (lib/transactions/categorize-core.ts)
  // so the bulk-book-inbox executor and the Underlag "Bokför valda" route reuse
  // exactly this logic.
  return categorizeMatchedTransaction(supabase, userId, companyId, txId, {
    category,
    vatTreatment,
    vatAmount,
    notes,
    allowDuplicate: params.allow_duplicate === true,
    // Dimensions PR7: resolved at staging; coerce is the drift/tamper gate.
    dimensions: coerceDimensionsBag(params.dimensions),
  })
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

async function commitUpdateCustomer(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  let validated
  try {
    validated = UpdateCustomerParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { customer_id: customerId, changes } = validated
  const { data: current, error: currentError } = await supabase
    .from('customers')
    .select('customer_type')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (currentError) return { error: currentError.message, status: 500 }
  if (!current) return { error: 'Customer not found', status: 404 }

  const updateData: Record<string, unknown> = { ...changes }
  if (changes.customer_number !== undefined) {
    updateData.customer_number = changes.customer_number || null
  }
  const effectiveType = changes.customer_type ?? current.customer_type
  if (changes.customer_type !== undefined && effectiveType !== 'individual') {
    updateData.personal_number = null
  }

  if (changes.vat_number !== undefined) {
    if (effectiveType === 'eu_business') {
      if (changes.vat_number) {
        try {
          const vatResult = await validateVatNumber(changes.vat_number)
          updateData.vat_number_validated = vatResult.valid
          updateData.vat_number_validated_at = vatResult.valid
            ? new Date().toISOString()
            : null
        } catch (err) {
          log.warn('Auto-VIES validation failed on staged customer update:', err)
          updateData.vat_number_validated = false
          updateData.vat_number_validated_at = null
        }
      } else {
        updateData.vat_number_validated = false
        updateData.vat_number_validated_at = null
      }
    }
  }

  const { data, error } = await supabase
    .from('customers')
    .update(updateData)
    .eq('id', customerId)
    .eq('company_id', companyId)
    .select('id, name, customer_type, customer_number, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, language, default_payment_terms, notes')
    .maybeSingle()

  if (error) {
    if (error.code === '23505') {
      return { error: 'A customer with this organization number already exists', status: 409 }
    }
    return { error: error.message, status: 500 }
  }
  if (!data) return { error: 'Customer not found', status: 404 }

  return {
    data: {
      customer_id: data.id,
      name: data.name,
      customer_type: data.customer_type,
      customer_number: data.customer_number ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      address_line1: data.address_line1 ?? null,
      address_line2: data.address_line2 ?? null,
      postal_code: data.postal_code ?? null,
      city: data.city ?? null,
      country: data.country,
      org_number: data.org_number ?? null,
      vat_number: data.vat_number ?? null,
      vat_number_validated: data.vat_number_validated ?? false,
      language: data.language ?? 'sv',
      default_payment_terms: data.default_payment_terms,
      notes: data.notes ?? null,
    },
  }
}

async function commitUpdateCompanySettings(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  let validated
  try {
    validated = UpdateCompanySettingsParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { data, error } = await supabase
    .from('company_settings')
    .update(validated.changes)
    .eq('company_id', companyId)
    .select('bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, default_our_reference, email, phone, website, invoice_email_texts')
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return { error: 'Company settings not found', status: 404 }
    }
    return { error: error.message, status: 500 }
  }

  return {
    data: {
      company_id: companyId,
      bank_name: data.bank_name ?? null,
      clearing_number: data.clearing_number ?? null,
      account_number: data.account_number ?? null,
      bankgiro: data.bankgiro ?? null,
      plusgiro: data.plusgiro ?? null,
      swish: data.swish ?? null,
      iban: data.iban ?? null,
      bic: data.bic ?? null,
      contact_person: data.default_our_reference ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      website: data.website ?? null,
      invoice_email_texts: data.invoice_email_texts ?? null,
    },
  }
}

async function commitCreateRecurringSchedule(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  // Re-validate at the commit boundary with the shared schema so a tampered
  // pending_operations row is rejected with the same rules the staging tool
  // and the cookie-session POST route enforce.
  let validated
  try {
    validated = CreateRecurringScheduleParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, email')
    .eq('id', validated.customer_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (customerError) return { error: customerError.message, status: 500 }
  if (!customer) return { error: 'Customer not found', status: 404 }

  // auto_send without a customer email would silently degrade to a monthly
  // draft + warning at cron time. Reject at commit exactly like the route.
  if (validated.auto_send && !customer.email) {
    return {
      error: 'Customer has no email address: automatic sending requires one',
      status: 400,
    }
  }

  const nextRunDate = computeInitialRunDate(
    new Date(),
    validated.day_of_month,
    validated.start_date,
  )

  const { data: schedule, error: insertError } = await supabase
    .from('recurring_invoice_schedules')
    .insert({
      company_id: companyId,
      user_id: userId,
      customer_id: validated.customer_id,
      name: validated.name,
      day_of_month: validated.day_of_month,
      send_hour: validated.send_hour,
      payment_terms_days: validated.payment_terms_days,
      currency: validated.currency,
      your_reference: validated.your_reference ?? null,
      our_reference: validated.our_reference ?? null,
      notes: validated.notes ?? null,
      auto_send: validated.auto_send,
      default_dimensions: validated.default_dimensions ?? {},
      next_run_date: nextRunDate,
      status: 'active',
    })
    .select()
    .single()

  if (insertError || !schedule) {
    return { error: insertError?.message ?? 'Failed to insert recurring schedule', status: 500 }
  }

  const itemRows = validated.items.map((item, idx) => ({
    schedule_id: schedule.id,
    sort_order: idx,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate ?? null,
    dimensions: item.dimensions ?? {},
  }))

  const { error: itemsError } = await supabase
    .from('recurring_invoice_schedule_items')
    .insert(itemRows)

  if (itemsError) {
    // Roll back the parent so a half-created schedule doesn't ship: an
    // item-less schedule makes every cron run throw "schedule has no items"
    // and silently skip billing dates.
    await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', schedule.id)
      .eq('company_id', companyId)
    return { error: itemsError.message, status: 500 }
  }

  return {
    data: {
      recurring_schedule_id: schedule.id,
      name: validated.name,
      customer_id: validated.customer_id,
      day_of_month: validated.day_of_month,
      send_hour: validated.send_hour,
      currency: validated.currency,
      auto_send: validated.auto_send,
      status: 'active',
      next_run_date: nextRunDate,
      item_count: itemRows.length,
    },
  }
}

async function commitUpdateRecurringSchedule(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  let validated
  try {
    validated = UpdateRecurringScheduleParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { schedule_id: scheduleId, changes } = validated
  const { items, ...fieldChanges } = changes

  const { data: existing, error: existingError } = await supabase
    .from('recurring_invoice_schedules')
    .select('id, status, auto_send, customer_id, day_of_month, next_run_date')
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (existingError) return { error: existingError.message, status: 500 }
  if (!existing) return { error: 'Recurring schedule not found', status: 404 }

  // Turning auto_send on (or moving the schedule to another customer) needs
  // the target customer checked: email when auto_send is effectively on
  // (mirrors the PATCH route), and company membership always (this executor
  // runs on a service-role client with no RLS, so a cross-tenant customer_id
  // would otherwise pass the FK).
  if (changes.customer_id !== undefined || changes.auto_send === true) {
    const effectiveAutoSend = changes.auto_send ?? existing.auto_send
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id, email')
      .eq('id', changes.customer_id ?? existing.customer_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (customerError) return { error: customerError.message, status: 500 }
    if (!customer) return { error: 'Customer not found', status: 404 }
    if (effectiveAutoSend && !customer.email) {
      return {
        error: 'Customer has no email address: automatic sending requires one',
        status: 400,
      }
    }
  }

  const updateRow: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fieldChanges)) {
    if (v !== undefined) updateRow[k] = v
  }

  // Recompute next_run_date when the schedule is reactivated from a stale
  // date or its day-of-month changed: mirror of the PATCH route. Always the
  // next STRICTLY-future occurrence, never today, so an approval cannot
  // trigger a same-hour surprise send. Editing other fields leaves
  // next_run_date alone so an unrelated edit never skips an imminent send.
  if (changes.status === 'active' || changes.day_of_month !== undefined) {
    const reactivating = changes.status === 'active'
    const dayChanged =
      changes.day_of_month !== undefined && changes.day_of_month !== existing.day_of_month
    const effectiveDay = changes.day_of_month ?? existing.day_of_month
    const { date: todayStockholm } = getStockholmDateHour(new Date())
    const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)

    const staleOnReactivate = reactivating && existing.next_run_date <= todayStockholm
    if (staleOnReactivate || dayChanged) {
      const rolled = computeInitialRunDate(stockholmToday, effectiveDay)
      updateRow.next_run_date =
        rolled === todayStockholm
          ? computeNextRunDate(stockholmToday, effectiveDay)
          : rolled
    }

    // A conscious reactivation invalidates any lingering warning.
    if (reactivating) {
      updateRow.last_run_warning = null
    }
  }

  // Items provided = replace all; omitted = keep existing (the schema
  // contract). The shared helper compensates BOTH writes on failure, so an
  // item failure cannot leave the header fields half-saved.
  const result = await applyRecurringScheduleUpdate(supabase, {
    scheduleId,
    companyId,
    fields: updateRow,
    items,
    log,
  })
  if (!result.ok) {
    if (result.stage !== 'header' && (!result.itemsRestored || !result.headerRestored)) {
      // Same registry sentence the PATCH route returns, so the two surfaces
      // cannot drift on what the user is told.
      const partial = getErrorEntry('INVOICE_RECURRING_UPDATE_PARTIAL')
      log.error('recurring schedule update left a partial state', result.error, {
        scheduleId,
        companyId,
        stage: result.stage,
        itemsRestored: result.itemsRestored,
        headerRestored: result.headerRestored,
      })
      return {
        error: `${partial?.message_sv ?? 'Ändringen kunde inte slutföras.'} (${result.error.message})`,
        // Machine-readable twin of the PATCH route's envelope code, so an
        // MCP/staged-op caller can detect the partial state without
        // substring-matching the Swedish sentence.
        errorCode: 'INVOICE_RECURRING_UPDATE_PARTIAL',
        status: 500,
      }
    }
    return { error: result.error.message, status: 500 }
  }
  const itemsReplaced = Boolean(items)

  return {
    data: {
      recurring_schedule_id: scheduleId,
      status: changes.status ?? existing.status,
      updated_fields: Object.keys(updateRow),
      items_replaced: itemsReplaced,
      ...(itemsReplaced && items ? { item_count: items.length } : {}),
      ...(updateRow.next_run_date !== undefined
        ? { next_run_date: updateRow.next_run_date }
        : {}),
    },
  }
}

async function commitCreateArticle(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so a
  // tampered pending_operations row cannot inject unexpected fields (ASVS V4.5).
  let validated
  try {
    validated = CreateArticleParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  if (validated.revenue_account) {
    const ok = await isValidRevenueAccount(supabase, companyId, validated.revenue_account)
    if (!ok) return { error: 'Posting account is not an active class 1-3 account', status: 400 }
  }

  const { data, error } = await supabase
    .from('articles')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: validated.name,
      name_en: validated.name_en ?? null,
      type: validated.type,
      unit: validated.unit ?? 'st',
      price_excl_vat: validated.price_excl_vat,
      currency: validated.currency ?? 'SEK',
      vat_rate: validated.vat_rate,
      revenue_account: validated.revenue_account ?? null,
      cost_price: validated.cost_price ?? null,
      ean: validated.ean ?? null,
      housework_type: validated.housework_type ?? null,
      notes: validated.notes ?? null,
      article_number: validated.article_number ?? null,
    })
    .select()
    .single()

  if (error) {
    // FK to public.currencies: the reference table is the allow-list.
    if (error.code === '23503' && error.message.includes('currency')) {
      return { error: `Currency ${validated.currency} is not supported`, status: 400 }
    }
    return { error: error.message, status: 500 }
  }

  if (!data.article_number) {
    try {
      data.article_number = await ensureArticleNumber(supabase, companyId, data.id)
    } catch (err) {
      log.warn('article number assignment failed (staged create):', err)
    }
  }

  await eventBus.emit({ type: 'article.created', payload: { article: data as Article, userId, companyId } })

  return { data: { article_id: data.id, article_number: data.article_number } }
}

async function commitUpdateArticle(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = UpdateArticleParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  if (validated.revenue_account) {
    const ok = await isValidRevenueAccount(supabase, companyId, validated.revenue_account)
    if (!ok) return { error: 'Posting account is not an active class 1-3 account', status: 400 }
  }

  const { article_id, ...rest } = validated
  const updateData: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) updateData[key] = value
  }

  const { data, error } = await supabase
    .from('articles')
    .update(updateData)
    .eq('id', article_id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    if (error.code === 'PGRST116') return { error: 'Article not found', status: 404 }
    // FK to public.currencies: the reference table is the allow-list.
    if (error.code === '23503' && error.message.includes('currency')) {
      return { error: `Currency ${validated.currency} is not supported`, status: 400 }
    }
    return { error: error.message, status: 500 }
  }

  await eventBus.emit({ type: 'article.updated', payload: { article: data as Article, userId, companyId } })

  return { data: { article_id: data.id } }
}

async function commitCreateAccount(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so
  // a tampered pending_operations row cannot inject unexpected fields into
  // chart_of_accounts (ASVS V4.5): mirrors commitCreateArticle.
  let validated
  try {
    validated = CreateAccountParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  // Same row shape as the dashboard create route
  // (app/api/bookkeeping/accounts/route.ts): class/group/sort_order derive
  // from the number so the two write paths cannot drift.
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .insert({
      user_id: userId,
      company_id: companyId,
      account_number: validated.account_number,
      account_name: validated.account_name,
      account_class: parseInt(validated.account_number[0]),
      account_group: validated.account_number.substring(0, 2),
      account_type: validated.account_type,
      normal_balance: validated.normal_balance,
      plan_type: validated.plan_type,
      is_active: true,
      is_system_account: false,
      description: validated.description ?? null,
      default_vat_code: validated.default_vat_code ?? null,
      default_vat_rate: validated.default_vat_rate ?? null,
      sru_code: validated.sru_code ?? null,
      sort_order: parseInt(validated.account_number),
    })
    .select('account_number, account_name')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { error: `Kontonummer ${validated.account_number} finns redan i kontoplanen.`, status: 409 }
    }
    return { error: error.message, status: 500 }
  }

  return { data: { account_number: data.account_number, account_name: data.account_name } }
}

async function commitUpdateAccount(
  supabase: SupabaseClient,
  _userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = UpdateAccountParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  const { account_number, ...rest } = validated
  const updateData: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) updateData[key] = value
  }
  if (Object.keys(updateData).length === 0) {
    return { error: 'Inget att uppdatera', status: 400 }
  }

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .update(updateData)
    .eq('company_id', companyId)
    .eq('account_number', account_number)
    .select('account_number, account_name, is_active')
    .single()

  if (error) {
    if (error.code === 'PGRST116') return { error: 'Kontot hittades inte', status: 404 }
    return { error: error.message, status: 500 }
  }

  return { data: { account_number: data.account_number, account_name: data.account_name, is_active: data.is_active } }
}

async function commitSetVoucherNote(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  let validated
  try {
    validated = SetVoucherNoteParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  // Notes-only UPDATE: the journal_entries immutability trigger (migration
  // 20260608120000) allows exactly this on committed entries and raises on
  // anything else, so no status pre-check is needed here. Period-lock and
  // company-lock-date triggers still apply and surface as errors.
  const { data, error } = await supabase
    .from('journal_entries')
    .update({ notes: validated.notes })
    .eq('id', validated.journal_entry_id)
    .eq('company_id', companyId)
    .select('id, voucher_series, voucher_number')
    .maybeSingle()

  if (error) return { error: error.message, status: 400 }
  // Zero rows = the entry doesn't exist in this company: report it instead
  // of a phantom success (same contract as the dashboard notes route).
  if (!data) return { error: 'Verifikationen hittades inte.', status: 404 }

  return {
    data: {
      journal_entry_id: data.id,
      voucher_series: data.voucher_series,
      voucher_number: data.voucher_number,
      notes: validated.notes,
    },
  }
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

/**
 * Executor for the staged create_dimension_value operation
 * (gnubok_create_dimension_value, dimensions PR3). Inserts a dimension value
 * (SIE #OBJEKT) into the registry. Agents never silently mint reporting
 * values: this always arrives via a human-approved pending_operation.
 *
 * Idempotent on duplicate code: a 23505 on (company_id, dimension_id, code)
 * re-reads the existing row and reports success with already_existed=true, so
 * a raced or re-committed approval never fails on "already there".
 */
async function commitCreateDimensionValue(
  supabase: SupabaseClient,
  _userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so
  // a tampered pending_operations row cannot inject a non-portable code or
  // malformed dates into the registry (ASVS V4.5): mirrors commitCreateSupplier.
  let validated
  try {
    validated = CreateDimensionValueParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const path = issue?.path?.join('.') ?? 'params'
      return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  // Get-or-create the system dims (1 = kostnadsställe, 6 = projekt):
  // idempotent lazy seeding. Custom dims must already exist in the registry:
  // agents may stage new VALUES, never new dimensions.
  if (validated.sie_dim_no === 1 || validated.sie_dim_no === 6) {
    const { error: ensureError } = await supabase.rpc('ensure_company_dimensions', {
      p_company_id: companyId,
    })
    if (ensureError) {
      return { error: `Kunde inte skapa systemdimensionerna: ${ensureError.message}`, status: 500 }
    }
  }

  const { data: dimension, error: dimError } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, name, resets_annually')
    .eq('company_id', companyId)
    .eq('sie_dim_no', validated.sie_dim_no)
    .maybeSingle()

  if (dimError) return { error: dimError.message, status: 500 }
  if (!dimension) {
    return {
      error:
        `Okänd dimension ${validated.sie_dim_no}. Endast registrerade dimensioner kan få nya värden ` +
        '(1 = kostnadsställe och 6 = projekt skapas automatiskt; övriga skapas i registret).',
      status: 400,
    }
  }

  // Value dates only make sense on accumulating dimensions (projekt-style
  // ranges): mirrors POST /api/dimensions/[id]/values.
  if (dimension.resets_annually && (validated.start_date || validated.end_date)) {
    return {
      error: `Start-/slutdatum är inte tillåtna på dimensionen "${dimension.name}" (nollställs årligen).`,
      status: 400,
    }
  }

  const { data: created, error: insertError } = await supabase
    .from('dimension_values')
    .insert({
      company_id: companyId,
      dimension_id: dimension.id,
      code: validated.code,
      name: validated.name,
      start_date: validated.start_date ?? null,
      end_date: validated.end_date ?? null,
    })
    .select('id, code, name, is_active')
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      // Duplicate code: treat the existing value as success (idempotency).
      const { data: existing, error: existingError } = await supabase
        .from('dimension_values')
        .select('id, code, name, is_active')
        .eq('company_id', companyId)
        .eq('dimension_id', dimension.id)
        .eq('code', validated.code)
        .maybeSingle()
      if (existingError || !existing) {
        return { error: insertError.message, status: 500 }
      }
      return {
        data: {
          dimension_value_id: existing.id,
          sie_dim_no: dimension.sie_dim_no,
          dimension_name: dimension.name,
          code: existing.code,
          name: existing.name,
          is_active: existing.is_active,
          already_existed: true,
        },
      }
    }
    return { error: insertError.message, status: 500 }
  }

  return {
    data: {
      dimension_value_id: created.id,
      sie_dim_no: dimension.sie_dim_no,
      dimension_name: dimension.name,
      code: created.code,
      name: created.name,
      is_active: created.is_active,
      already_existed: false,
    },
  }
}

/**
 * Executor for the staged retag_line_dimensions operation
 * (gnubok_tag_journal_lines, dimensions PR6). Loops the staged line_ids
 * through the retag_line_dimensions RPC: the ONE audited write path for
 * changing dimension tags on posted lines. The RPC enforces everything per
 * line at commit time (open period, company lock date, active registry
 * values, writer role, posted status) and writes an immutable
 * dimension_retag_log row before touching the line.
 *
 * Partial-success semantics: one line failing (e.g. its period was locked
 * between staging and approval) must not roll back the lines already
 * retagged: each RPC call is its own transaction. Failures are collected
 * and echoed (capped at 20) so the caller can re-stage just the failed set.
 * Only when EVERY line fails does the operation as a whole fail.
 */
async function commitRetagLineDimensions(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  // Defense in depth: re-validate the staged params at the commit boundary so
  // a tampered pending_operations row cannot inject arbitrary ids or a
  // malformed bag (ASVS V4.5): mirrors commitCreateDimensionValue.
  let validated
  try {
    validated = RetagLineDimensionsParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const path = issue?.path?.join('.') ?? 'params'
      return { error: `Invalid ${path}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }

  let retagged = 0
  let unchanged = 0
  const failed: Array<{ line_id: string; error: string }> = []

  for (const lineId of validated.line_ids) {
    const { data, error } = await supabase.rpc('retag_line_dimensions', {
      p_company_id: companyId,
      p_line_id: lineId,
      p_dimensions: validated.dimensions,
      p_reason: validated.reason,
      p_user_id: userId,
    })
    if (error) {
      failed.push({ line_id: lineId, error: error.message })
      continue
    }
    if ((data as { changed?: boolean } | null)?.changed) retagged++
    else unchanged++
  }

  if (failed.length > 0 && retagged === 0 && unchanged === 0) {
    return {
      error: `Ingen rad kunde taggas om (${failed.length} rader misslyckades). Första felet: ${failed[0].error}`,
      status: 400,
    }
  }

  return {
    data: {
      retagged,
      unchanged,
      failed_count: failed.length,
      // Echo at most 20 failures: enough to act on without bloating
      // result_data on a pathological 500-line all-but-one failure.
      failed: failed.slice(0, 20),
      dimensions: validated.dimensions,
      ...(validated.filter_summary ? { filter_summary: validated.filter_summary } : {}),
    },
  }
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
  const ledgerAccount = (params.ledger_account as string) || null
  const bankConnectionId = (params.bank_connection_id as string) || null
  const externalId = (params.external_id as string) || null

  if (!date || !description.trim() || !Number.isFinite(amount)) {
    return { error: 'date, description, and amount are required', status: 400 }
  }
  if (ledgerAccount && !/^19\d{2}$/.test(ledgerAccount)) {
    return { error: 'ledger_account must be a BAS 19xx cash account', status: 400 }
  }

  // A foreign-currency row must carry its SEK translation from the moment it
  // lands. The categorization path resolves a line amount through the LENIENT
  // resolveSekAmount() (lib/bookkeeping/currency-utils.ts), which falls back to
  // the RAW foreign number when amount_sek and exchange_rate are both empty. A
  // staged 1500 USD row therefore debited 1500 kr while buildCurrencyMetadata()
  // stamped the same line `currency: USD, amount_in_currency: 1500`: one line
  // asserting two different amounts. Nothing catches it, because every leg is
  // scaled by the same wrong factor so the verifikation still balances and no
  // trigger fires. Under ML 8 kap 21-23 § the beskattningsunderlag must be
  // translated at a published kurs, so the understatement lands straight in
  // rutorna 05/10 or 48 of the momsdeklaration.
  //
  // Rate is fetched for the row's OWN date (not "today"), with the supabase
  // client passed so `exchange_rates` acts as the read-through cache and as the
  // last-cached-observation fallback when Riksbanken 429s. Identical call shape
  // to lib/transactions/ingest.ts, which is the reference for this path.
  //
  // Resolved BEFORE ensureManualCashAccount below so a refusal leaves no
  // half-created kassakonto behind (same ordering rationale as the arrival
  // number in app/api/supplier-invoices/route.ts).
  let amountSek: number | null = null
  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null

  if (currency !== 'SEK') {
    const rateDate = new Date(date)
    let rateInfo: Awaited<ReturnType<typeof fetchExchangeRate>> = null
    if (!Number.isNaN(rateDate.getTime())) {
      try {
        rateInfo = await fetchExchangeRate(currency, rateDate, supabase)
      } catch {
        // fetchExchangeRate swallows its own network errors and reports null; a
        // throw can only come from a mock or a future refactor. Treat it as
        // "no rate", never as a reason to invent one.
        rateInfo = null
      }
    }
    if (!rateInfo || !Number.isFinite(rateInfo.rate) || rateInfo.rate <= 0) {
      // Refuse rather than insert with NULL. ingest.ts may store NULL because
      // it is a bulk bank feed where one unreachable rate must not abort the
      // batch, and its rows stay repairable via
      // /api/transactions/[id]/refresh-exchange-rate. Here there is exactly one
      // row, the approver is present, and storing NULL only relocates the
      // failure to the categorization step, which does NOT refuse: it silently
      // books 1:1. So the commit boundary is the last place the contradiction
      // can still be surfaced to a human.
      return {
        error:
          `Transaktionen är i ${currency} men ingen växelkurs kunde hämtas för ${date}. ` +
          `Utan kurs skulle raden bokföras som om 1 ${currency} = 1 SEK. ` +
          'Försök igen när kursen finns publicerad, eller registrera beloppet i kronor.',
        status: 400,
      }
    }
    exchangeRate = rateInfo.rate
    exchangeRateDate = rateInfo.date ?? null
    amountSek = roundOre(amount * exchangeRate)
  }

  // Bind the row to a manual kassakonto when a ledger account is given, so
  // reconciliation and voucher matching resolve the real account instead of
  // falling back to 1930 (issue #1016). Find-or-create; the row's currency
  // follows this transaction.
  let cashAccountId: string | null = null
  if (ledgerAccount) {
    cashAccountId = await ensureManualCashAccount(supabase, companyId, ledgerAccount, currency)
  }

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      company_id: companyId,
      bank_connection_id: bankConnectionId,
      cash_account_id: cashAccountId,
      external_id: externalId,
      date,
      description: description.trim(),
      amount,
      currency,
      // NULL for a SEK row: the column means "SEK translation of a foreign
      // amount", and amount already IS kronor. Mirrors ingest.ts.
      amount_sek: amountSek,
      exchange_rate: exchangeRate,
      exchange_rate_date: exchangeRateDate,
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
    article_id?: string | null; revenue_account?: string | null
    line_type?: 'product' | 'text'
    dimensions?: Record<string, string>
  }>
  // Dimensions PR7: bags were resolved against the registry at staging time
  // (resolveDimensionBags in the MCP tool); coerce is the drift/tamper gate.
  const defaultDimensions = coerceDimensionsBag(params.default_dimensions)

  // Free-text rows carry no amounts and never book. The MCP staging tool does
  // not accept line_type today, but the totals math must stay identical to
  // app/api/invoices/route.ts, which excludes text rows from subtotal, VAT,
  // and the mixed-rate detection.
  const billableItems = items.filter((item) => item.line_type !== 'text')

  const { data: customer, error: customerError } = await supabase
    .from('customers').select('*').eq('id', customerId).eq('company_id', companyId).single()

  if (customerError || !customer) {
    return { error: 'Customer not found: they may have been deleted.', status: 404 }
  }

  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
  // Gate on the PERMITTED set, not the picker default, exactly like
  // buildInvoiceWriteData: the ML 6 kap. supplies taxed where they are performed
  // (hotel/restaurang 12%, persontransport and event admission 6%,
  // fastighetstjänst and korttidsuthyrning 25%) carry Swedish VAT even to a
  // foreign business customer. The default is still 0% (vatRules.rate is the
  // fallback below), so a Swedish rate only lands here when staged explicitly.
  const permittedRates = getPermittedVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(permittedRates.map((r) => r.rate))

  // VAT registration gate (mirrors app/api/invoices/route.ts). A
  // non-momsregistrerad company books no output VAT: force every line to 0%
  // (momsfri → treatment 'exempt'). 0% is allowed for every customer type, so
  // the allowedRates guard below still passes.
  const { data: vatSettings } = await supabase
    .from('company_settings')
    .select('vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  const notVatRegistered = vatSettings?.vat_registered === false
  if (notVatRegistered) for (const item of items) item.vat_rate = 0

  const subtotal = billableItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)

  let vatAmount = 0
  for (const item of billableItems) {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    if (!allowedRates.has(itemRate)) {
      return { error: `Momssats ${itemRate}% är inte tillåten för denna kundtyp`, status: 400 }
    }
    const lineTotal = item.quantity * item.unit_price
    vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
  }

  // Validate any per-line posting-account override (defense in depth: the legacy field
  // is frozen onto invoice_items and flows to generatePerRateLines()).
  const overrideAccounts = Array.from(
    new Set(billableItems.map((i) => i.revenue_account).filter((a): a is string => !!a)),
  )
  for (const acct of overrideAccounts) {
    if (!(await isValidRevenueAccount(supabase, companyId, acct))) {
      return { error: `Bokföringskonto ${acct} är inte ett aktivt balans- eller intäktskonto (klass 1-3)`, status: 400 }
    }
  }

  const total = subtotal + vatAmount
  const currency = ((params.currency as string) || 'SEK') as Currency
  const invoiceDate = (params.invoice_date as string) || new Date().toISOString().split('T')[0]

  // Sales-side twin of the supplier-invoice currency policy
  // (lib/currency/supplier-invoice-rate.ts). Three defects lived here:
  //
  //  1. `fetchExchangeRate(currency)` passed NO date, so a back-dated invoice
  //     was translated at TODAY'S kurs. ML 8 kap 21-23 § anchors the
  //     beskattningsunderlag on the taxable event, and the registration
  //     verifikat is posted on invoice_date, so the money and the verifikat
  //     must be anchored on the same day. The staged params carry no
  //     delivery_date, so invoice_date IS that event here (the web path,
  //     lib/invoices/build-invoice-write.ts, prefers delivery_date when the
  //     form supplied one).
  //  2. No supabase client, so the shared `exchange_rates` cache was neither
  //     read nor used as the last-cached-observation fallback when Riksbanken
  //     rate-limits. One transient 429 left the invoice permanently unconverted.
  //  3. A null result fell through in silence and stored exchange_rate = NULL,
  //     which resolveSekAmount() then books 1:1: 1000 EUR posts 1000 kr to 3001
  //     and 250 kr to 2611 instead of 11 500 and 2 875, understating ruta 05
  //     and ruta 10 by the whole FX difference.
  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  // Multiplier to SEK. 1 for a SEK invoice, so the *_sek columns equal their
  // invoice-currency counterparts instead of staying NULL: an ordinary Swedish
  // invoice legitimately has no exchange_rate, and the old
  // `if (currency !== 'SEK')` guard therefore left total_sek NULL on every one
  // of them. Same fix, same reason, as supplierInvoiceSekAmounts().
  let sekRate = 1

  if (currency !== 'SEK') {
    const rateDate = new Date(invoiceDate)
    let rateData: Awaited<ReturnType<typeof fetchExchangeRate>> = null
    if (!Number.isNaN(rateDate.getTime())) {
      try {
        rateData = await fetchExchangeRate(currency, rateDate, supabase)
      } catch {
        rateData = null
      }
    }
    if (!rateData || !Number.isFinite(rateData.rate) || rateData.rate <= 0) {
      // Refuse at the approval boundary. Storing NULL only relocates the
      // failure: createInvoiceJournalEntry() already refuses such an invoice
      // with INVOICE_FX_RATE_MISSING, by which point the invoice row (and its
      // F-series number, once sent) exists and the approver has moved on.
      return {
        error:
          getErrorEntry('INVOICE_FX_RATE_MISSING')?.message_sv ??
          'Fakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs.',
        status: 400,
      }
    }
    exchangeRate = rateData.rate
    exchangeRateDate = rateData.date ?? null
    sekRate = rateData.rate
  }

  const subtotalSek = roundOre(subtotal * sekRate)
  const vatAmountSek = roundOre(vatAmount * sekRate)
  const totalSek = roundOre(total * sekRate)

  const uniqueRates = new Set(billableItems.map((item) => item.vat_rate ?? vatRules.rate))
  const isMixedRate = uniqueRates.size > 1

  // Validated https-only at staging time (gnubok_create_invoice); re-checked
  // here so a hand-crafted pending-operation row can't smuggle a non-https
  // link into customer-facing emails/PDFs. Invalid → dropped, never blocks.
  const paymentLinkUrl = (() => {
    const raw = typeof params.payment_link_url === 'string' ? params.payment_link_url.trim() : ''
    if (!raw || raw.length > 2048) return null
    try {
      return new URL(raw).protocol === 'https:' ? raw : null
    } catch {
      return null
    }
  })()

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: customerId,
      invoice_number: null,
      invoice_date: invoiceDate,
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
      vat_treatment: notVatRegistered ? 'exempt' : vatRules.treatment,
      vat_rate: isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate),
      moms_ruta: notVatRegistered ? null : vatRules.momsRuta,
      reverse_charge_text: notVatRegistered ? null : (vatRules.reverseChargeText || null),
      our_reference: (params.our_reference as string) || null,
      your_reference: (params.your_reference as string) || null,
      notes: (params.notes as string) || null,
      payment_link_url: paymentLinkUrl,
      default_dimensions: defaultDimensions ?? {},
    })
    .select()
    .single()

  if (invoiceError) return { error: invoiceError.message, status: 500 }

  const invoiceItems = items.map((item, index) => {
    // Text rows store the description only and zero everything else. Keys must
    // match the product branch exactly: PostgREST rejects a bulk insert whose
    // objects have differing key sets.
    if (item.line_type === 'text') {
      return {
        invoice_id: invoice.id,
        sort_order: index,
        line_type: 'text',
        description: item.description ?? '',
        quantity: 0,
        unit: '',
        unit_price: 0,
        line_total: 0,
        vat_rate: 0,
        vat_amount: 0,
        article_id: null,
        revenue_account: null,
        dimensions: {},
      }
    }
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    const lineTotal = item.quantity * item.unit_price
    const itemVat = Math.round(lineTotal * itemRate / 100 * 100) / 100
    return {
      invoice_id: invoice.id,
      sort_order: index,
      line_type: 'product',
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
      // Frozen per-line override so generatePerRateLines() books to the article's
      // account; null falls back to the VAT-treatment-derived account.
      article_id: item.article_id ?? null,
      revenue_account: item.revenue_account ?? null,
      dimensions: coerceDimensionsBag(item.dimensions) ?? {},
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

/**
 * Commit a staged update_invoice: rewrite a DRAFT invoice in place (header
 * fields and/or a FULL REPLACE of its line items).
 *
 * Staging is not a lock: the invoice can be sent, paid, or credited between
 * staging and approval, so the shared editable-draft predicate
 * (isEditableInvoiceDraft) is re-checked HERE, and the row update carries a
 * .eq('status','draft') guard so a concurrent send turns into a 0-row update
 * instead of rewriting a now-issued invoice.
 *
 * Totals and VAT are recomputed by buildInvoiceWriteData: the exact builder
 * the cookie PATCH route (app/api/invoices/[id]) and the v1 REST routes use,
 * so VAT gating, accrual guards, ROT/RUT compute, and currency conversion
 * cannot drift. When the staged changes carry no items, the existing rows are
 * fed back through the builder so a header-only edit (e.g. a new invoice_date
 * on a foreign-currency draft) still recomputes the SEK legs consistently.
 */
async function commitUpdateInvoice(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  // Re-validate staged params at the commit boundary (defense in depth: a
  // hand-crafted pending_operations row must not reach the write below).
  let validated
  try {
    validated = UpdateInvoiceParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    throw err
  }

  const { invoice_id: invoiceId, changes } = validated

  const { data: existing, error: fetchError } = await supabase
    .from('invoices')
    .select(
      'id, status, invoice_number, journal_entry_id, is_self_billed, credited_invoice_id, customer_id, document_type, invoice_date, due_date, delivery_date, currency, your_reference, our_reference, notes, payment_link_url, payment_link_auto, ore_rounding, default_dimensions, deduction_personnummer_encrypted, deduction_personnummer_last4',
    )
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchError) return { error: fetchError.message, status: 500 }
  if (!existing) return { error: 'Invoice not found: it may have been deleted.', status: 404 }

  if (!isEditableInvoiceDraft(existing)) {
    return {
      error: `Fakturan är inte längre ett redigerbart utkast (status: ${existing.status}). Skickade eller bokförda fakturor rättas med kreditfaktura.`,
      status: 409,
    }
  }

  // The customer is structural on a draft edit (never changed here): resolve
  // the EXISTING customer for VAT rules.
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', existing.customer_id)
    .eq('company_id', companyId)
    .single()

  if (customerError || !customer) {
    return { error: 'Customer not found: they may have been deleted.', status: 404 }
  }

  // Effective line set: FULL REPLACE when staged, otherwise the current rows
  // fed back through the builder unchanged.
  let itemsInput: InvoiceWriteItemInput[]
  if (changes.items) {
    itemsInput = changes.items as InvoiceWriteItemInput[]
  } else {
    const { data: itemRows, error: itemsFetchError } = await supabase
      .from('invoice_items')
      .select(
        'line_type, description, quantity, unit, unit_price, vat_rate, article_id, revenue_account, deduction_type, labor_hours, work_type, housing_designation, apartment_number, brf_org_number, accrual_period_start, accrual_period_end, accrual_balance_account, dimensions',
      )
      .eq('invoice_id', invoiceId)
      .order('sort_order', { ascending: true })
    if (itemsFetchError) return { error: itemsFetchError.message, status: 500 }
    itemsInput = (itemRows ?? []) as InvoiceWriteItemInput[]
  }
  if (itemsInput.length === 0) {
    return { error: 'Fakturan saknar rader: minst en rad krävs.', status: 400 }
  }

  // ROT/RUT claim info lives per line, not on the header: derive the
  // invoice-level inputs the builder's presence checks expect from the first
  // deduction line (per-line values win in the item mapping regardless).
  const firstDeduction = itemsInput.find((item) => item.deduction_type)

  const input: InvoiceWriteInput = {
    customer_id: existing.customer_id,
    invoice_date: changes.invoice_date ?? existing.invoice_date,
    due_date: changes.due_date ?? existing.due_date,
    delivery_date:
      changes.delivery_date !== undefined ? changes.delivery_date : existing.delivery_date,
    currency: existing.currency as Currency,
    your_reference: changes.your_reference ?? existing.your_reference ?? undefined,
    our_reference: changes.our_reference ?? existing.our_reference ?? undefined,
    notes: changes.notes ?? existing.notes ?? undefined,
    // Not editable through this operation: fed back so the builder echoes the
    // stored values instead of clearing them.
    payment_link_url: existing.payment_link_url ?? undefined,
    payment_link_auto: existing.payment_link_auto ?? undefined,
    ore_rounding: existing.ore_rounding ?? undefined,
    deduction_housing_designation: firstDeduction?.housing_designation ?? undefined,
    deduction_apartment_number: firstDeduction?.apartment_number ?? undefined,
    deduction_brf_org_number: firstDeduction?.brf_org_number ?? undefined,
    default_dimensions:
      changes.default_dimensions ??
      ((existing.default_dimensions as Record<string, string> | null) ?? {}),
    items: itemsInput,
  }

  const build = await buildInvoiceWriteData({
    supabase,
    companyId,
    customer: customer as Customer,
    documentType: (existing.document_type || 'invoice') as InvoiceDocumentType,
    input,
    // The stored personnummer exists only as ciphertext: an edit that carries
    // deduction lines but no plaintext keeps the stored value.
    existingPersonnummer: existing.deduction_personnummer_encrypted
      ? {
          encrypted: existing.deduction_personnummer_encrypted,
          last4: existing.deduction_personnummer_last4 ?? null,
        }
      : null,
  })
  if (!build.ok) {
    if ('dbError' in build) {
      const message = (build.dbError as { message?: string } | null)?.message
      return { error: message ?? 'Database error', status: 500 }
    }
    const entry = getErrorEntry(build.code)
    return {
      error: entry?.message_sv ?? build.code,
      status: entry?.httpStatus ?? 400,
      data: build.details as Record<string, unknown> | undefined,
    }
  }

  // invoice_number and status are intentionally NOT in build.invoiceFields:
  // editing never (re)allocates a number nor changes lifecycle state.
  const { data: updated, error: updateError } = await supabase
    .from('invoices')
    .update({ ...build.invoiceFields, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select('id')

  if (updateError) return { error: updateError.message, status: 500 }
  if (!updated || updated.length === 0) {
    return {
      error: 'Fakturan är inte längre ett utkast: den har skickats eller bokförts efter att ändringen förbereddes.',
      status: 409,
    }
  }

  const replaced = await replaceInvoiceItems(supabase, invoiceId, build.items)
  if (!replaced.ok) {
    return {
      error: `Fakturaraderna kunde inte skrivas om (${replaced.stage}): ${replaced.error.message}`,
      status: 500,
    }
  }

  return {
    data: {
      invoice_id: invoiceId,
      invoice_number: existing.invoice_number ?? null,
      subtotal: build.invoiceFields.subtotal,
      vat_amount: build.invoiceFields.vat_amount,
      total: build.invoiceFields.total,
      item_count: build.items.length,
      items_replaced: Boolean(changes.items),
    },
  }
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
  if (invoice.credited_invoice_id) {
    return { error: 'Kreditfakturor kan inte markeras som betalda.', status: 409 }
  }
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    return { error: 'Invoice can only be marked as paid when status is "sent" or "overdue"', status: 409 }
  }

  // Duplicate-payment guard: parity with the web mark-paid route, which the
  // agent path otherwise bypassed. If an unlinked inbound bank transaction
  // already looks like this invoice's payment, booking a parallel payment
  // voucher here creates exactly the orphan that later double-counts the
  // receipt. Fail closed; the agent re-stages with allow_duplicate=true (after
  // the user confirms) or, better, matches the transaction to the invoice
  // instead. Fail-open on a detection error so it never blocks a real payment.
  if (params.allow_duplicate !== true) {
    const customerName = (invoice as { customer?: { name?: string } }).customer?.name
    if (customerName) {
      const remainingAmount =
        (invoice as { remaining_amount?: number }).remaining_amount ?? invoice.total
      let candidates: Awaited<ReturnType<typeof findDuplicatePaymentCandidatesForInvoice>> = []
      try {
        candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId,
          invoice: {
            invoice_number: invoice.invoice_number,
            customer_name: customerName,
            currency: invoice.currency ?? null,
            total: invoice.total ?? null,
            total_sek: invoice.total_sek ?? null,
            exchange_rate: invoice.exchange_rate ?? null,
          },
          // remaining_amount is stored in the invoice currency; the lookup
          // converts it before banding kronor bank rows.
          paymentAmount: remainingAmount,
          paymentDate,
        })
      } catch (err) {
        log.warn('duplicate-payment detection failed (continuing)', err)
      }
      if (candidates.length > 0) {
        return {
          error:
            `Möjlig dubbelbetalning: en obokförd banktransaktion ser ut att vara betalningen för faktura ` +
            `${invoice.invoice_number}. Matcha banktransaktionen mot fakturan (gnubok_match_transaction_to_invoice) ` +
            `i stället för att bokföra en separat betalning. Om det verkligen rör sig om en annan betalning, ` +
            `kör om med allow_duplicate=true.`,
          status: 409,
        }
      }
    }
  } else {
    // allow_duplicate=true bypassed the duplicate-payment guard. The decision
    // to book a payment over a possible existing one must leave a durable
    // behandlingshistorik record (BFNAR 2013:2 kap 8) so an auditor can see why
    // the duplicate was allowed. Re-detect to capture the dismissed candidate;
    // best-effort, never blocks the payment. Payload stays PII-safe
    // (ids/amounts/dates only: no customer or merchant name).
    const customerName = (invoice as { customer?: { name?: string } }).customer?.name
    if (customerName) {
      try {
        const remainingAmount =
          (invoice as { remaining_amount?: number }).remaining_amount ?? invoice.total
        const dismissed = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId,
          invoice: {
            invoice_number: invoice.invoice_number,
            customer_name: customerName,
            currency: invoice.currency ?? null,
            total: invoice.total ?? null,
            total_sek: invoice.total_sek ?? null,
            exchange_rate: invoice.exchange_rate ?? null,
          },
          paymentAmount: remainingAmount,
          paymentDate,
        })
        if (dismissed.length > 0) {
          await appendProcessingHistory({
            companyId,
            correlationId: invoiceId,
            aggregateType: 'System',
            aggregateId: invoiceId,
            eventType: 'InvoiceDuplicatePaymentDismissed',
            payload: {
              invoice_id: invoiceId,
              payment_date: paymentDate,
              dismissed_transaction_ids: dismissed.map((c) => c.id),
              candidate_count: dismissed.length,
              via: 'allow_duplicate',
            },
            actor: { type: 'user', id: userId },
            occurredAt: new Date(),
          })
        }
      } catch (logErr) {
        log.warn('failed to record duplicate-payment-dismissal behandlingshistorik', logErr)
      }
    }
  }

  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null

  // Route on invoice state, not the company's current accounting_method:
  // an invoice booked at send under accrual must clear 1510 here even if
  // the company has since switched to kontantmetoden.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

  // Paid/remaining/status math + overpayment guard via the shared
  // planInvoicePayment helper: the single source of truth across the three
  // mark-paid surfaces (this agent path, the dashboard route, and the v1 API).
  // This path settles the full remaining (no custom lines), so it can never
  // overpay, but routing through the helper keeps the state identical. Runs
  // BEFORE the JE below so a rejected payment never burns a voucher number.
  // Settle the full outstanding balance. Prefer remaining_amount; for legacy rows
  // where it was never written, derive it from total − paid_amount rather than
  // falling back to the full total (which would double-count a prior partial
  // payment and trip the overpayment guard).
  const inv = invoice as { remaining_amount?: number | null; paid_amount?: number | null }
  const paymentAmount = inv.remaining_amount ?? (invoice.total - (inv.paid_amount ?? 0))
  const payment = planInvoicePayment(invoice, paymentAmount)
  if (!payment.ok) {
    return {
      error:
        getErrorEntry('MATCH_AMOUNT_EXCEEDS_REMAINING')?.message_sv ??
        'Betalningsbeloppet är större än fakturans återstående belopp.',
      status: 400,
    }
  }
  const { newPaidAmount, newRemaining, newStatus } = payment.plan

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

    // Fail closed: a real invoice must produce a posted payment voucher.
    // Marking it paid with no journal entry orphans the receivable and
    // diverges the GL from the AR sub-ledger. Nothing was posted (the helper
    // returned null), so there is no voucher to cancel.
    if (!journalEntryId) {
      return {
        error:
          'Betalningen kunde inte bokföras (ingen verifikation skapades: t.ex. stängd räkenskapsperiod). ' +
          'Fakturan har inte markerats som betald.',
        status: 422,
      }
    }
  }

  const paidAt = newStatus === 'paid' ? paidAtFromDate(paymentDate) : null
  // CAS guard: only flip from a payable status so a concurrently-settled
  // invoice no-ops here instead of double-booking the payment.
  const { data: updateResult, error: updateError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateError) {
    // The payment voucher already posted but the invoice row did not flip;
    // cancel the orphan so the GL doesn't diverge from the sub-ledger.
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase, companyId, userId, journalEntryId,
        'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning',
      )
    }
    return { error: 'Failed to update invoice status', status: 500 }
  }

  if (!updateResult || updateResult.length === 0) {
    // Race lost: the invoice was settled concurrently between our read and
    // write. Cancel the orphaned payment voucher and document the gap rather
    // than leaving a double booking.
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase, companyId, userId, journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
    }
    return {
      error: 'Invoice can only be marked as paid from a payable status (sent, overdue or partially paid)',
      status: 409,
    }
  }

  // Fully settled: retire every transaction's suggestion pointer at this
  // invoice (issue #1259). No exceptTransactionId: this flow is not driven by
  // a bank transaction, so any pointer at it is now dead.
  if (newStatus === 'paid') {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoiceId)
  }

  // Notify subscribers: invoice.paid fans out to registered webhooks
  // (lib/webhooks/handler.ts). Best-effort: the payment is already committed,
  // so an emit failure must not fail the operation. Parity with the v1 and
  // dashboard mark-paid routes, which previously emitted while this path did not.
  try {
    await eventBus.emit({
      type: 'invoice.paid',
      payload: {
        invoice: {
          ...(invoice as Invoice),
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: paidAt ?? (invoice as Invoice).paid_at,
        } as Invoice,
        companyId,
        userId,
        paymentAmount,
        paymentDate,
      },
    })
  } catch (err) {
    log.warn('invoice.paid emit failed', err)
  }

  return { data: { status: newStatus, remaining_amount: newRemaining, journal_entry_id: journalEntryId } }
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
  if (invoice.credited_invoice_id) {
    return {
      error: 'Credit notes must be issued through the invoice send flow',
      status: 409,
    }
  }
  // partially_paid/credited imply the invoice was already issued too: the
  // status flip below would regress them to 'sent' (PR #666 review, ASVS V2.3).
  if (['sent', 'paid', 'overdue', 'partially_paid', 'credited'].includes(invoice.status)) {
    return { error: 'Invoice has already been sent', status: 409 }
  }
  // A cancelled invoice keeps its F-series number for ML 17 kap 24§ compliance
  // but is not a valid faktura: sending it would silently re-activate it (the
  // status flip below has no guard) and deliver a "MAKULERAD" PDF as if live.
  // Mirrors the send route's guard (audit C17, this agent path lacked it).
  if (invoice.status === 'cancelled') {
    return {
      error:
        getErrorEntry('INVOICE_SEND_CANCELLED')?.message_sv ??
        'Makulerade fakturor kan inte skickas. Skapa en ny faktura istället.',
      status: 400,
    }
  }

  const customer = invoice.customer as Customer
  if (!customer.email?.trim()) return { error: 'Customer has no email address', status: 400 }

  const { data: company, error: companyError } = await supabase
    .from('company_settings').select('*').eq('company_id', companyId).single()

  if (companyError || !company) return { error: 'Company settings missing', status: 500 }

  const paymentAccountRequired = invoiceRequiresPaymentAccount(invoice as Invoice)
  if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, invoice as Invoice)) {
    return {
      error:
        getErrorEntry('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')?.message_sv
        ?? 'Betalningskonto saknas för fakturans valuta.',
      status: 400,
    }
  }

  const recipients = resolveInvoiceEmailRecipients({
    to: customer.email,
    configuredCc: company.invoice_email_cc_addresses,
    configuredBcc: company.invoice_email_bcc_addresses,
    legacyCc: company.email || userEmail,
  })
  if (exceedsInvoiceEmailRecipientLimit(recipients)) {
    return {
      error:
        getErrorEntry('INVOICE_SEND_TOO_MANY_RECIPIENTS')?.message_sv
        ?? `Ett fakturautskick får inte ha ${invoiceEmailRecipientCount(recipients)} mottagare.`,
      status: 400,
    }
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

  // Preflight render: validate the PDF pipeline BEFORE consuming an F-series
  // number, so a render failure can't leave a numbered-but-never-issued
  // invoice (an F-series gap if the draft is later abandoned). Skipped when
  // the row is already numbered (retry path): we'd render twice for no gain.
  // Mirrors the send route (audit C17, this agent path assigned the number
  // first and rendered unguarded).
  const isFreshAllocation = !invoice.invoice_number
  if (isFreshAllocation) {
    try {
      const preflight = await prepareInvoicePdfRender(
        company as CompanySettings,
        (invoice as Invoice).currency,
        { paymentAccountRequired },
      )
      await renderToBuffer(
        InvoicePDF({
          invoice: { ...(invoice as Invoice), invoice_number: 'F-PREVIEW' },
          customer,
          items,
          company: preflight.company,
          originalInvoiceNumber,
          branding: preflight.branding,
        })
      )
    } catch (err) {
      log.error('preflight PDF render failed before invoice number assignment (agent send)', err as Error, {
        companyId,
        userId,
        invoiceId,
      })
      return {
        error:
          getErrorEntry('INVOICE_SEND_PDF_RENDER_FAILED')?.message_sv ??
          'Fakturans PDF kunde inte skapas. Kontrollera fakturarader och kunduppgifter och försök igen.',
        status: 500,
      }
    }
  }

  let deliveryId: string
  try {
    deliveryId = await reserveInvoiceDelivery({
      supabase,
      companyId,
      userId,
      invoiceId,
    })
  } catch (err) {
    log.error('failed to reserve invoice delivery before agent number assignment', err as Error, {
      companyId,
      userId,
      invoiceId,
    })
    return { error: 'Utskicksinformationen kunde inte sparas. Ingen e-post skickades.', status: 500 }
  }

  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    return { error: `Failed to assign invoice number: ${err instanceof Error ? err.message : 'unknown'}`, status: 500 }
  }

  // Override `status` to 'sent' on the in-memory copy. The DB flip happens
  // after email delivery (line ~625); rendering with the stale 'draft' status
  // would stamp the customer's PDF with "UTKAST: inte en giltig faktura".
  const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
  const { branding, company: renderCompany } = await prepareInvoicePdfRender(
    company as CompanySettings,
    renderableInvoice.currency,
    { paymentAccountRequired },
  )
  const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, renderableInvoice)
  const pdfBuffer = await renderToBuffer(
    InvoicePDF({
      invoice: renderableInvoice,
      customer,
      items,
      company: renderCompany,
      originalInvoiceNumber,
      branding,
      swishQrDataUrl,
    })
  )

  const isCreditNote = !!invoice.credited_invoice_id
  const filename = invoicePdfFilename({
    companyName: company.company_name,
    customerName: customer.name,
    invoiceNumber: invoice.invoice_number,
    invoiceId: invoice.id,
    invoiceDate: invoice.invoice_date,
    documentType: invoice.document_type,
    isCreditNote,
  })

  const emailData = { invoice: renderableInvoice, customer, company: company as CompanySettings }
  const subject = generateInvoiceEmailSubject(emailData)
  const html = generateInvoiceEmailHtml(emailData)
  const text = generateInvoiceEmailText(emailData)
  let result
  try {
    result = await sendTrackedInvoiceEmail({
      supabase,
      emailService,
      companyId,
      userId,
      invoiceId,
      deliveryId,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      html,
      text,
      replyTo: company.email || undefined,
      fromName: company.company_name,
      filename,
      pdfBuffer,
    })
  } catch (err) {
    log.error('failed to persist invoice delivery snapshot before agent send', err as Error, {
      companyId,
      userId,
      invoiceId,
    })
    return { error: 'Utskicksinformationen kunde inte sparas. Ingen e-post skickades.', status: 500 }
  }

  if (result.trackingWarning) {
    log.warn('agent invoice delivery snapshot requires reconciliation', {
      companyId,
      userId,
      invoiceId,
      deliveryId: result.deliveryId,
      warning: result.trackingWarning,
    })
  }

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

  if (isRealInvoice && createdJournalEntryId) {
    try {
      await linkToJournalEntry(supabase, companyId, result.documentId, createdJournalEntryId)
    } catch { /* non-blocking */ }
  }

  await eventBus.emit({ type: 'invoice.sent', payload: { invoice: invoice as Invoice, userId, companyId } })

  return {
    data: {
      message: `Invoice ${invoice.invoice_number} sent to ${customer.email}`,
      ...(result.trackingWarning
        ? { warning: 'Delivery history requires reconciliation.' }
        : {}),
    },
  }
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
  if (invoice.credited_invoice_id) {
    return {
      error: 'Credit notes must be issued through the invoice send flow',
      status: 409,
    }
  }
  if (invoice.status !== 'draft') return { error: 'Only draft invoices can be marked as sent', status: 409 }

  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type, invoice_payment_accounts, bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic')
    .eq('company_id', companyId)
    .single()

  if (settingsError || !settings) return { error: 'Company settings missing', status: 500 }

  if (!hasRequiredInvoicePaymentAccount(settings as CompanySettings, invoice as Invoice)) {
    return {
      error:
        getErrorEntry('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')?.message_sv
        ?? 'Betalningskonto saknas för fakturans valuta.',
      status: 400,
    }
  }

  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    return { error: `Failed to assign invoice number: ${err instanceof Error ? err.message : 'unknown'}`, status: 500 }
  }

  const { error: updateError } = await supabase
    .from('invoices').update({ status: 'sent' }).eq('id', invoiceId).eq('company_id', companyId)

  if (updateError) return { error: 'Failed to update invoice status', status: 500 }

  let deliveryHistoryWarning: string | undefined
  try {
    await recordManualInvoiceDelivery({ supabase, companyId, userId, invoiceId })
  } catch (err) {
    log.error('failed to persist manual invoice delivery from pending operation', err as Error, {
      companyId,
      userId,
      invoiceId,
    })
    deliveryHistoryWarning = 'Fakturan markerades som skickad men utskickshistoriken kunde inte sparas.'
  }

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

  return {
    data: {
      status: 'sent',
      journal_entry_id: journalEntryId,
      ...(deliveryHistoryWarning ? { warning: deliveryHistoryWarning } : {}),
    },
  }
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
  if (invoice.credited_invoice_id) {
    return { error: 'Kreditfakturor kan inte registreras som betalda.', status: 409 }
  }
  if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
    return { error: 'Invoice is not in a matchable state', status: 409 }
  }

  // Overshoot guard + paid/remaining math: shared with the dashboard and v1
  // routes via planInvoicePayment. This agent/MCP path previously had NO guard,
  // so a 1500 payment on a 1000 invoice was silently accepted (paid_amount >
  // total, AR over-credited). Runs BEFORE the storno + JE below, so a rejected
  // match leaves the transaction untouched and never burns a voucher number.
  const paidAmount = transaction.amount
  const payment = planInvoicePayment(invoice, paidAmount)
  if (!payment.ok) {
    return {
      error:
        getErrorEntry('MATCH_AMOUNT_EXCEEDS_REMAINING')?.message_sv ??
        'Transaktionsbeloppet är större än fakturans återstående belopp.',
      status: 400,
    }
  }
  const { newPaidAmount, newRemaining, isFullyPaid, newStatus } = payment.plan
  const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

  // Read-only prevalidation, deliberately hoisted ABOVE the irreversible
  // storno below (issue #842): resolveSettlementAccount can throw
  // (BookkeepingDatabaseError on a failed cash_accounts lookup), and a throw
  // here must reject the op with NOTHING posted. Behavior-preserving on the
  // happy path: these are pure reads.
  const { data: settings } = await supabase
    .from('company_settings').select('accounting_method, entity_type').eq('company_id', companyId).single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  // Route on invoice state, not the company's current setting. Mirror of
  // the match-invoice route fix: see that handler for the full rationale.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

  // Debit the cash account THIS transaction actually belongs to, never a
  // hardcoded 1930: cash_account_id -> cash_accounts.ledger_account is the
  // only source of truth for which bank/cash account a real, matched
  // transaction settled into. Mirrors the match-invoice route fix.
  const paymentAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, log)

  // From here on the executor posts irreversible vouchers. Track their ids so
  // a later failure can land the op in 'failed_partial' carrying them
  // (issue #842) instead of a clean-looking 'rejected'.
  const postedIds: Record<string, string> = {}

  if (transaction.journal_entry_id) {
    const reversal = await reverseEntry(supabase, companyId, userId, transaction.journal_entry_id)
    postedIds.reversal_journal_entry_id = reversal.id
    await supabase.from('transactions').update({ journal_entry_id: null }).eq('id', transactionId)
  }

  let journalEntryId: string | null = null
  try {
    if (useCashEntry) {
      const je = await createInvoiceCashEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, entityType, invoice.customer?.name,
        paymentAccount,
      )
      journalEntryId = je?.id ?? null
    } else {
      const je = await createInvoicePaymentJournalEntry(
        supabase, companyId, userId, invoice as Invoice, transaction.date, undefined, invoice.customer?.name, paidAmount,
        paymentAccount,
      )
      journalEntryId = je?.id ?? null
    }
  } catch (err) {
    // Recoverable: the dispatcher releases the op back to 'pending' and this
    // executor is re-entrant past the storno (the transaction was unlinked
    // above, so a retry does not post a second storno). Keep that path even
    // when a reversal voucher was already posted.
    if (err instanceof AccountsNotInChartError) throw err
    if (isBookkeepingError(err)) {
      // A reversal voucher already posted makes this a partial commit, not a
      // clean failure: surface the storno id (issue #842).
      if (Object.keys(postedIds).length > 0) {
        throw new PartialCommitError(
          `match_transaction_invoice failed after posting a reversal voucher: ${err instanceof Error ? err.message : 'journal entry creation failed'}`,
          postedIds,
          err,
        )
      }
      throw err
    }
    log.error('Failed to create match journal entry:', err)
  }
  if (journalEntryId) postedIds.payment_journal_entry_id = journalEntryId

  const { data: updatedRows, error: updateInvError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_at: paidAt,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    })
    .eq('id', invoiceId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateInvError) {
    return {
      error: 'Failed to update invoice status',
      status: 500,
      ...(Object.keys(postedIds).length > 0 ? { partialPostedIds: postedIds } : {}),
    }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return {
      error: 'Invoice has already been fully paid or is no longer matchable',
      status: 409,
      ...(Object.keys(postedIds).length > 0 ? { partialPostedIds: postedIds } : {}),
    }
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

  // The invoice is now settled, so every OTHER transaction still carrying a
  // suggestion pointer at it is dead: retire them (issue #1259). This
  // operation's own row is cleared by the update just below.
  if (isFullyPaid) {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', invoiceId, {
      exceptTransactionId: transactionId,
    })
  }

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
      payload: {
        invoice: {
          ...(invoice as Invoice),
          status: newStatus,
          paid_at: paidAt,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
        } as Invoice,
        transaction: {
          ...(transaction as Transaction),
          invoice_id: invoiceId,
          potential_invoice_id: null,
          journal_entry_id: journalEntryId,
          is_business: true,
          category: 'income_services',
        } as Transaction,
        userId,
        companyId,
      },
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
      reconciled_transaction_id: outcome.result.reconciledTransactionId,
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
      reconciled_transaction_id: outcome.result.reconciledTransactionId,
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
    .select('id, journal_entry_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (docError || !doc) return { error: 'Document not found', status: 404 }

  // A document that already serves as underlag for a DIFFERENT verifikation
  // cannot be pinned here: propagating would either corrupt that link or be
  // blocked by the document-metadata immutability trigger. Same verifikation
  // is fine (idempotent re-attach; propagation below becomes a no-op).
  // Mirrors the REST route in app/api/transactions/[id]/attach-document.
  const docJournalEntryId = (doc.journal_entry_id as string | null) ?? null
  if (docJournalEntryId && docJournalEntryId !== tx.journal_entry_id) {
    return {
      error: 'Underlaget är redan kopplat till en annan verifikation.',
      status: 409,
    }
  }

  // Race-free read of journal_entry_id: use UPDATE ... RETURNING so the value
  // we propagate against reflects any concurrent categorize that committed
  // before our UPDATE acquired the row lock. Reading the post-update state
  // (rather than the pre-staging state) is what makes the
  // attach-then-categorize and categorize-then-attach orderings produce the
  // same final state: both end with document_attachments.journal_entry_id
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
  // Skip when the doc already points at this verifikation: the period-lock
  // trigger raises on ANY journal_entry_id write (even a same-value rewrite),
  // so an unconditional re-run would 500 an otherwise idempotent re-attach
  // once the period locks.
  if (journalEntryId && docJournalEntryId !== journalEntryId) {
    const { error: linkErr } = await supabase
      .from('document_attachments')
      .update({ journal_entry_id: journalEntryId })
      .eq('id', documentId)
      .eq('company_id', companyId)
    if (linkErr) {
      // The enforce_period_lock trigger blocks journal_entry_id writes when
      // the target entry sits in a closed/locked period. Map to 409: the
      // dispatcher auto-rejects it, and a retry could never succeed until the
      // period is unlocked, so "försök igen" would be a false promise.
      const linkMsg = (linkErr as { message?: string }).message ?? ''
      if (/locked\/closed fiscal period|Bokföringen är låst/i.test(linkMsg)) {
        return {
          error:
            'Bilagan kopplades till transaktionen men verifikationens period är låst: den kunde inte länkas till verifikationen.',
          status: 409,
        }
      }
      // Surface the propagation failure rather than logging-and-continuing.
      // BFL 5 kap 6 § requires the verifikation to reference its underlag, so
      // a "succeeded" attach that left document_attachments.journal_entry_id
      // null would be a silent compliance gap. Failing here marks the op
      // failed; a retry is idempotent (same documentId on tx, same propagate
      // target) and will replay the document_attachments UPDATE.
      console.error('[commitAttach] Failed to propagate to journal entry:', linkErr)
      return {
        error:
          'Bilagan kopplades till transaktionen men kunde inte länkas till verifikationen. Försök igen: operationen är idempotent.',
        status: 500,
      }
    }
  }

  // Rättelse audit trail (BFL 5 kap 5 §): if we replaced a non-null doc, log
  // the swap to processing_history so the original is traceable. Best-effort:
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

async function commitLinkDocumentToVoucher(
  supabase: SupabaseClient,
  _userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const documentId = params.document_id as string
  const journalEntryId = params.journal_entry_id as string
  const journalEntryLineId = params.journal_entry_line_id as string | undefined
  if (!documentId || !journalEntryId) {
    return { error: 'document_id and journal_entry_id are required', status: 400 }
  }

  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, file_name, journal_entry_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (docError || !doc) return { error: 'Document not found', status: 404 }

  // WORM guard: refuse to re-link a doc already linked to a DIFFERENT posted JE.
  const existingJeId = (doc.journal_entry_id as string | null) ?? null
  if (existingJeId && existingJeId !== journalEntryId) {
    const { data: existingJe } = await supabase
      .from('journal_entries')
      .select('status')
      .eq('id', existingJeId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (existingJe && (existingJe as { status: string }).status === 'posted') {
      return {
        error:
          'Bilagan är kopplad till en bokförd verifikation och kan inte länkas om. Ladda upp ett nytt dokument.',
        status: 409,
      }
    }
  }

  try {
    const updated = await linkToJournalEntry(
      supabase,
      companyId,
      documentId,
      journalEntryId,
      journalEntryLineId,
    )
    return {
      data: {
        document_id: updated.id,
        file_name: updated.file_name,
        journal_entry_id: updated.journal_entry_id,
        journal_entry_line_id: updated.journal_entry_line_id ?? null,
      },
    }
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (/locked\/closed fiscal period|Bokföringen är låst/i.test(msg)) {
      return {
        error: 'Verifikationens period är låst: bilagan kan inte länkas.',
        status: 409,
      }
    }
    return { error: `Failed to link document: ${msg}`, status: 500 }
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
  // 'overdue' is approvable: the daily cron flips unbooked invoices there just
  // by aging, and a registered-only gate left an aged invoice with no way
  // through attest (#1206). approved_at makes the approval idempotent.
  if (!canApproveSupplierInvoice(invoice)) {
    return {
      error: 'Fakturan är redan godkänd eller kan inte godkännas i nuvarande status',
      status: 400,
    }
  }

  // A still-past-due invoice keeps the 'overdue' label after attest: that is
  // what the cron would do on its next run.
  const approvedAt = new Date().toISOString()
  const nextStatus = resolveUnsettledStatus(
    { ...invoice, approved_at: approvedAt },
    getSwedishLocalDate(),
  )

  const { data, error } = await supabase
    .from('supplier_invoices')
    .update({ status: nextStatus, approved_at: approvedAt })
    .eq('id', id)
    .eq('company_id', companyId)
    // Optimistic concurrency on the pre-approval state, same guard as the web
    // and v1 approve routes. Staged operations can be committed twice (retry,
    // two approvers): without this both writes would land and both would emit
    // supplier_invoice.approved.
    .in('status', ['registered', 'overdue'])
    .is('approved_at', null)
    .select()
    .maybeSingle()

  if (error) return { error: error.message, status: 500 }
  if (!data) {
    return { error: 'Fakturan godkändes av någon annan medan operationen väntade', status: 409 }
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.approved',
      payload: { supplierInvoice: data, companyId, userId },
    })
  } catch { /* non-blocking */ }

  return { data: { supplier_invoice_id: id, status: nextStatus, approved_at: approvedAt } }
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
  // Dimensions PR7: resolved at staging time; coerce is the drift/tamper gate.
  const defaultDimensions = coerceDimensionsBag(params.default_dimensions)

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

  // Fourth and last supplier-invoice write path to adopt the shared resolver
  // (POST /api/supplier-invoices, POST /api/v1/.../supplier-invoices and the
  // inbox convert route went first). It took `params.exchange_rate` verbatim
  // with no fetch, so an inbox conversion whose staging-time lookup failed
  // (the MCP tool stages `exchange_rate: null` + `exchange_rate_source:
  // 'lookup_failed'` in that case) persisted a foreign invoice with
  // exchange_rate = NULL. createSupplierInvoiceRegistrationEntry then refuses
  // it with SI_FX_RATE_MISSING further down, after the ankomstnummer has
  // already been burnt, and a NULL rate that does reach a lenient reader
  // understates the fiktiv moms on 2614/2645, i.e. rutorna 20-24 + 30-32.
  //
  // Sharing the resolver is what keeps the four paths in agreement: the
  // currency policy, the SEK arithmetic and the refusal are defined once. A
  // caller-supplied positive rate is still trusted verbatim, which is what
  // makes the approved preview number the number written; only a missing rate
  // triggers the Riksbanken fetch, anchored on invoice_date with the supabase
  // client passed so `exchange_rates` serves as the read-through cache.
  //
  // Resolved BEFORE get_next_arrival_number so a refusal never burns an
  // ankomstnummer: same ordering as app/api/supplier-invoices/route.ts.
  const fx = await resolveSupplierInvoiceExchangeRate(supabase, {
    currency,
    invoiceDate,
    suppliedRate: exchangeRate,
  })
  if (!fx.ok) {
    return {
      error:
        getErrorEntry('SI_FX_RATE_MISSING')?.message_sv ??
        'Leverantörsfakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs.',
      status: 400,
    }
  }

  const { data: arrivalNum, error: arrivalErr } = await supabase
    .rpc('get_next_arrival_number', { p_company_id: companyId })

  if (arrivalErr) {
    return { error: `Failed to generate arrival number: ${arrivalErr.message}`, status: 500 }
  }

  const reverseCharge = vatTreatment === 'reverse_charge'
  const subtotalRounded = Math.round(subtotal * 100) / 100
  const vatAmountRounded = Math.round(vatAmount * 100) / 100
  const totalRounded = Math.round(total * 100) / 100
  // Fed the already-rounded figures so a SEK invoice (rate 1) gets
  // total_sek === total to the öre instead of the two roundings disagreeing on
  // an exact-half value. The old `exchangeRate ? … : null` guard left all three
  // SEK columns NULL on every ordinary Swedish invoice, which is what blanked
  // the SEK-reporting readers (the KPI "Största leverantörer" panel among them).
  const {
    subtotal_sek: subtotalSek,
    vat_amount_sek: vatAmountSek,
    total_sek: totalSek,
  } = supplierInvoiceSekAmounts(fx.rate, {
    subtotal: subtotalRounded,
    vatAmount: vatAmountRounded,
    total: totalRounded,
  })

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
      currency: fx.rate.currency,
      exchange_rate: fx.rate.exchangeRate,
      // Which day's kurs the SEK amounts were translated at: the audit trail
      // that makes them verifiable under BFL 5 kap.
      exchange_rate_date: fx.rate.exchangeRateDate,
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
      document_id: documentId,
      notes,
      default_dimensions: defaultDimensions ?? {},
    })
    .select()
    .single()

  if (invoiceErr || !invoice) {
    const pgErr = invoiceErr as { code?: string; message?: string } | null
    const isDuplicate = pgErr?.code === '23505'
    if (isDuplicate) {
      // Generic 409: supplier_invoice_number alone is already in the staged
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
  // 20-24 / 48 instead of double-counting input VAT into 2641. Tampered
  // params can't smuggle non-zero VAT into the items table.
  const itemInserts = rawItems.map((item, idx) => {
    // Normalize percent-shaped rates (25 -> 0.25) and snap to the statutory
    // set: rows staged before the issue #310 fix (or tampered params) carry
    // percent integers, and inserting one books 2500 % VAT downstream.
    const vatRate = reverseCharge ? 0 : (typeof item.vat_rate === 'number' ? normalizeVatRateToDecimal(item.vat_rate) : 0)
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
      dimensions: coerceDimensionsBag(item.dimensions) ?? {},
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
        // is non-fatal: the JE is already posted and immutable; we log and
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
        // an unbooked supplier invoice: the same 2440/2641 orphan the catch
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
      // momsdeklaration. Items must be deleted BEFORE the parent: the FK
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
        // operator can clean up; this should not happen in practice.
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
  // Do NOT write status here: the status CHECK only allows received|error
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
      // Dimensions PR7: copy so the reversal nets against the same cells.
      default_dimensions: original.default_dimensions ?? {},
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
    vat_rate: normalizeVatRateToFraction(item.vat_rate),
    vat_amount: item.vat_amount,
    dimensions: item.dimensions ?? {},
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
        original.items as never,
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
      // Dimensions PR7: copy so the reversal nets against the same cells.
      default_dimensions: original.default_dimensions ?? {},
      status: 'sent',
    })
    .select()
    .single()

  if (creditNoteError || !creditNote) {
    return { error: creditNoteError?.message ?? 'Failed to create credit note', status: 500 }
  }

  const creditItems = (original.items || []).map((item: {
    sort_order: number
    line_type?: 'product' | 'text'
    description: string
    quantity: number
    unit: string
    unit_price: number
    line_total: number
    vat_rate?: number
    vat_amount?: number
    revenue_account?: string | null
    article_id?: string | null
    dimensions?: Record<string, string>
  }) => ({
    invoice_id: creditNote.id,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: -Math.abs(item.quantity),
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: -Math.abs(item.line_total),
    vat_rate: item.vat_rate ?? 0,
    vat_amount: -(item.vat_amount ? Math.abs(item.vat_amount) : 0),
    // Reverse to the SAME account the original credited (e.g. 3041, not the
    // VAT-derived 3001) so the override account doesn't keep a dangling balance.
    revenue_account: item.revenue_account ?? null,
    article_id: item.article_id ?? null,
    // Same reasoning for the per-item bag (dimensions PR7).
    dimensions: item.dimensions ?? {},
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
  // missing-JE on the original (legacy data): the description simply omits
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
      if (isBookkeepingError(err)) {
        // The credit note row and the original's 'credited' flip are already
        // persisted: a clean 'rejected' would hide them. Land the op in
        // 'failed_partial' carrying the ids (issue #842). This intentionally
        // covers AccountsNotInChartError too: the release-to-pending retry
        // path cannot recover a credit_invoice op (re-running the executor
        // auto-rejects with 409 because the original is already 'credited').
        throw new PartialCommitError(
          `credit_invoice failed after persisting the credit note: ${err instanceof Error ? err.message : 'journal entry creation failed'}`,
          { credit_note_id: creditNote.id, original_invoice_id: id },
          err,
        )
      }
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
      // Dimensions PR7: the converted invoice books with the proforma's bag.
      default_dimensions: proforma.default_dimensions ?? {},
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
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
    // Preserve per-line VAT and any article/revenue-account override from the
    // proforma so the converted invoice books exactly as the proforma showed
    // (mixed rates + per-article accounts both rely on these per-line fields).
    vat_rate: item.vat_rate ?? 0,
    vat_amount: item.vat_amount ?? 0,
    revenue_account: item.revenue_account ?? null,
    article_id: item.article_id ?? null,
    dimensions: item.dimensions ?? {},
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
  // Default true (not Boolean(...): operations staged before this param
  // existed must keep the file's account names, matching the UI default).
  const updateAccountNames =
    params.update_account_names === undefined ? true : Boolean(params.update_account_names)

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
      updateAccountNames,
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
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  const importId = params.import_id as string

  if (!importId) {
    return { error: 'import_id is required', status: 400 }
  }

  const result = await undoSIEImport(supabase, companyId, importId, userId)
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
 * validates via Zod before staging: defensive coercion only.
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
      // Boundary-validated with the same constraints as the Zod line schema:
      // staged payloads must not bypass API-layer validation (SOC 2 PI1.1).
      dimensions: coerceDimensionsBag(line.dimensions),
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
  // bypass that gate. createDraftEntry runs the same check internally: this
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

  // source_type is derived here: never trust params.source_type. The MCP tool
  // stages a typed boolean (is_opening_balance), not a raw source_type string,
  // so a tampered or future direct-staging path can't inject
  // 'bank'/'invoice'/etc. and corrupt audit attribution. The default is
  // 'manual'. We only upgrade to 'opening_balance' after independently
  // re-validating the entry genuinely looks like an ingående balans: this
  // matters because bank reconciliation excludes an IB from the period movement
  // ONLY when source_type='opening_balance' (lib/reconciliation/bank-reconciliation.ts);
  // a mislabelled 'manual' IB shows up as a phantom reconciliation difference.
  let sourceType: JournalEntrySourceType = 'manual'
  if (params.is_opening_balance === true) {
    // Constraint 1: every line must be a balance-sheet account (BAS class 1 or
    // 2). Mirrors the canonical opening-balance flow which rejects P&L accounts
    // (app/api/import/opening-balance/execute/route.ts). Inlined to avoid
    // coupling this executor to the SIE-import module.
    const nonBalanceSheet = lines
      .map((l) => l.account_number)
      .filter((num) => {
        const cls = parseInt(num.charAt(0), 10)
        return !(cls === 1 || cls === 2)
      })
    if (nonBalanceSheet.length > 0) {
      return {
        error:
          `Ingående balans får bara innehålla balanskonton (klass 1-2). ` +
          `Dessa konton hör inte hemma i en IB: ${[...new Set(nonBalanceSheet)].join(', ')}. ` +
          `Bokför resultatkonton som en vanlig verifikation utan is_opening_balance.`,
        status: 400,
      }
    }

    // Constraint 2: the entry must be dated on the fiscal period's first day:
    // an IB opens the period (same as the canonical flow, which dates the entry
    // on period.period_start). We fetch period_start here because the resolved
    // fiscalPeriodId may have come from either the explicit param or a date
    // lookup; either way the date must line up exactly.
    const { data: period, error: periodErr } = await supabase
      .from('fiscal_periods')
      .select('period_start, name')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (periodErr || !period) {
      return { error: 'Räkenskapsperioden hittades inte.', status: 404 }
    }
    if (entryDate !== period.period_start) {
      return {
        error:
          `En ingående balans måste dateras på räkenskapsårets första dag ` +
          `(${period.period_start}). Angivet datum: ${entryDate}. ` +
          `Ändra datumet eller bokför som en vanlig verifikation utan is_opening_balance.`,
        status: 400,
      }
    }

    sourceType = 'opening_balance'
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
        source_type: sourceType,
        voucher_series: (params.voucher_series as string) || undefined,
        notes: (params.notes as string) || undefined,
        lines,
      },
      // commit_method records HOW it was committed, not who staged it.
      // Web routes pass 'user_accept'/'bulk_accept'; the MCP approve path
      // passes 'api_key'/'agent' so agent-relayed acknowledgments are
      // distinguishable in the immutable layer. The DB CHECK constraint
      // rejects anything else (migrations 20260420120001, 20260618120001).
      opts.commitMethod ?? 'user_accept'
    )

    // Optional inbox linking: set when gnubok_create_voucher is called with
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
      // Only the link column is written: the status CHECK allows received|error
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
        // and immutable: we leave it; an operator can rättelse via storno
        // if it's a true duplicate.
        log.warn('Voucher posted but inbox item was already claimed by a concurrent commit', {
          inboxItemId,
          journalEntryId: entry.id,
        })
      } else {
        inboxLinked = true
      }

      // Only attach the OCR document when the inbox link succeeded: if a
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

async function commitUpdatePayslipLine(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  const lineId = params.salary_line_item_id as string
  const patch = params.patch as Record<string, unknown> | undefined
  if (!salaryRunId || !lineId || !patch || Object.keys(patch).length === 0) {
    return { error: 'salary_run_id, salary_line_item_id and patch are required', status: 400 }
  }

  try {
    const { updatePayslipLine } = await import('@/lib/salary/payslip-lines')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await updatePayslipLine(supabase, {
      companyId,
      salaryRunId,
      lineId,
      patch: patch as never,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Kunde inte uppdatera lönebeskedsraden: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        salary_line_item_id: lineId,
        salary_run_id: salaryRunId,
        item_type: result.data.item_type,
        description: result.data.description,
        amount: result.data.amount,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update payslip line',
      status: 500,
    }
  }
}

async function commitCreateEmployee(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  try {
    const { createEmployee } = await import('@/lib/salary/employee-commands')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await createEmployee(supabase, {
      companyId,
      userId,
      input: params as never,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      const detailMessage =
        (result.details?.message as string | undefined) ?? entry?.message_sv
      return {
        error: detailMessage ?? `Kunde inte skapa anställd: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return { data: { ...result.data } }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to create employee',
      status: 500,
    }
  }
}

async function commitUpdateEmployee(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const employeeId = params.employee_id as string
  const patch = params.patch as Record<string, unknown> | undefined
  if (!employeeId || !patch) {
    return { error: 'employee_id and patch are required', status: 400 }
  }

  try {
    const { updateEmployee } = await import('@/lib/salary/employee-commands')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await updateEmployee(supabase, { companyId, employeeId, patch })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      const detailMessage =
        (result.details?.message as string | undefined) ?? entry?.message_sv
      return {
        error: detailMessage ?? `Kunde inte uppdatera anställd: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return { data: { ...result.data } }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update employee',
      status: 500,
    }
  }
}

async function commitRegisterAbsence(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const employeeId = params.employee_id as string
  const from = params.from as string
  const to = params.to as string
  const absenceType = params.absence_type as string
  if (!employeeId || !from || !to || !absenceType) {
    return { error: 'employee_id, from, to and absence_type are required', status: 400 }
  }

  try {
    const { upsertAbsenceRange } = await import('@/lib/salary/absence')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await upsertAbsenceRange(supabase, {
      companyId,
      employeeId,
      from,
      to,
      absenceType,
      hoursPerDay: (params.hours_per_day as number | undefined) ?? 8,
      notes: (params.notes as string | null | undefined) ?? null,
      includeWeekends: (params.include_weekends as boolean | undefined) ?? false,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Kunde inte registrera frånvaron: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        employee_id: employeeId,
        absence_type: absenceType,
        from,
        to,
        day_count: result.data.count,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to register absence',
      status: 500,
    }
  }
}

async function commitBookSalaryRun(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const salaryRunId = params.salary_run_id as string
  if (!salaryRunId) return { error: 'salary_run_id is required', status: 400 }

  try {
    const { advanceAndBookSalaryRun } = await import('@/lib/salary/book-run')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await advanceAndBookSalaryRun(supabase, {
      companyId,
      userId,
      salaryRunId,
      log: createLogger('commit/book_salary_run'),
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      const detail =
        (result.details?.reason as string | undefined) ??
        (Array.isArray(result.details?.employees)
          ? `Saknar beräkning: ${(result.details.employees as string[]).join(', ')}`
          : undefined)
      return {
        error: [entry?.message_sv ?? `Kunde inte bokföra lönekörningen: ${result.code}`, detail]
          .filter(Boolean)
          .join(' '),
        status: entry?.httpStatus ?? 500,
      }
    }
    const run = result.data.run as { period_year?: number; period_month?: number; status?: string }
    return {
      data: {
        salary_run_id: salaryRunId,
        status: run.status ?? 'booked',
        period: run.period_year
          ? `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
          : undefined,
        journal_entry_ids: result.data.entryIds,
        nollkorning: result.data.nollkorning,
        warnings: result.data.warnings,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to book salary run',
      status: 500,
    }
  }
}

async function commitDeleteAbsence(
  supabase: SupabaseClient,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const employeeId = params.employee_id as string
  const from = params.from as string
  const to = params.to as string
  if (!employeeId || !from || !to) {
    return { error: 'employee_id, from and to are required', status: 400 }
  }

  try {
    const { deleteAbsenceRange } = await import('@/lib/salary/absence')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await deleteAbsenceRange(supabase, {
      companyId,
      employeeId,
      from,
      to,
      absenceType: (params.absence_type as string | undefined) || undefined,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Kunde inte ta bort frånvaron: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        employee_id: employeeId,
        from,
        to,
        absence_type: (params.absence_type as string | undefined) ?? null,
        deleted_count: result.data.deleted_count,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to delete absence',
      status: 500,
    }
  }
}

async function commitSetEmployeeOpeningBalances(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const items = params.items as Array<Record<string, unknown>> | undefined
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { error: 'items are required', status: 400 }
  }

  try {
    const { OpeningBalancesBulkSchema } = await import('@/lib/api/schemas')
    const parsed = OpeningBalancesBulkSchema.safeParse({ items })
    if (!parsed.success) {
      return { error: 'Ogiltiga ingående saldon i den godkända operationen', status: 400 }
    }
    const { setOpeningBalancesBulk } = await import('@/lib/salary/opening-balances')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await setOpeningBalancesBulk(supabase, {
      companyId,
      userId,
      items: parsed.data.items,
    })
    if (!result.ok) {
      const itemSummary = result.itemErrors
        ?.map((e) => `${e.employee_id}: ${e.message}`)
        .join('; ')
      const entry = getErrorEntry(result.code)
      return {
        error: itemSummary ?? entry?.message_sv ?? `Kunde inte spara ingående saldon: ${result.code}`,
        status: entry?.httpStatus ?? 400,
      }
    }
    return {
      data: {
        employee_count: result.data.count,
        employee_opening_balances_ids: result.data.rows.map((r) => r.employee_opening_balances_id),
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to set opening balances',
      status: 500,
    }
  }
}

async function commitVacationYearClose(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const yearStart = params.vacation_year_start as string
  if (!yearStart) return { error: 'vacation_year_start is required', status: 400 }
  const bookAdjustment = params.book_adjustment !== false

  try {
    const { commitVacationYearClose: runClose } = await import('@/lib/salary/semesterberedning')
    const { getErrorEntry } = await import('@/lib/errors/structured-errors')
    const result = await runClose(supabase, companyId, userId, yearStart, { bookAdjustment })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return {
        error: entry?.message_sv ?? `Semesterårsavslutet misslyckades: ${result.code}`,
        status: entry?.httpStatus ?? 500,
      }
    }
    return {
      data: {
        vacation_year_closure_id: result.data.closure_id,
        adjustment_entry_id: result.data.adjustment_entry_id,
        vacation_year_start: yearStart,
        employee_count: result.data.report.rows.length,
        drift_2920: result.data.report.sek.drift_2920,
      },
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to close vacation year',
      status: 500,
    }
  }
}

// ── Skatteverket filing commit handlers (PR5) ─────────────────────
//
// Core cannot import @/extensions (CI guard), so these reach the Skatteverket
// extension only through the registry-resolved `services` channel. The service
// runs the SKV chain and returns a SkvSubmitResult (shared shape in
// ./skatteverket-commit). A recoverable failure throws SkatteverketRecoverable-
// Error, which the dispatcher catch releases back to 'pending'; a non-recoverable
// failure becomes a plain { error, status } that rejects the op.

function getSkatteverketServices(): SkatteverketCommitServices {
  const services = extensionRegistry.get('skatteverket')?.services as
    | Partial<SkatteverketCommitServices>
    | undefined
  if (!services?.commitSubmitVatDeclaration || !services?.commitSubmitAgi) {
    // Extension absent or not wired. Recoverable: leave the op pending so a
    // re-enable + re-approve works without re-staging.
    throw new SkatteverketRecoverableError(
      'Skatteverket-integrationen är inte tillgänglig.',
      'EXTENSION_DISABLED',
      503,
    )
  }
  return services as SkatteverketCommitServices
}

function handleSkvSubmitResult(result: SkvSubmitResult): ExecutorResult {
  if (!result.ok) {
    if (result.recoverable) {
      throw new SkatteverketRecoverableError(result.error, result.code, result.http_status)
    }
    return { error: result.error, status: result.http_status }
  }
  const data: Record<string, unknown> = { ...result, status: 'awaiting_signature' }
  delete data.ok
  return { data }
}

async function commitSubmitVatDeclaration(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  if (!params.period_type || !params.year || !params.period) {
    return { error: 'period_type, year och period krävs', status: 400 }
  }
  const services = getSkatteverketServices()
  const result = await services.commitSubmitVatDeclaration(supabase, userId, companyId, params)
  return handleSkvSubmitResult(result)
}

async function commitSubmitAgi(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<ExecutorResult> {
  if (!params.salary_run_id) {
    return { error: 'salary_run_id krävs', status: 400 }
  }
  const services = getSkatteverketServices()
  const result = await services.commitSubmitAgi(supabase, userId, companyId, params)
  return handleSkvSubmitResult(result)
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
  // pass-through by design: re-querying here would triple the same
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
    // payload: error.details can echo invoice IDs, amounts, etc.
    log.error('match_batch_allocate RPC error', {
      code: (error as { code?: string }).code,
      message: error.message,
    })
    return { error: error.message || 'Database error', status: 500 }
  }
  const result = data as {
    ok: boolean
    code?: string
    details?: unknown
    journal_entry_id?: string
    allocations?: BatchAllocationResult[]
  }
  if (!result || !result.ok) {
    return {
      error: result?.code || 'match_batch_allocate failed',
      status: 400,
      data: result?.details as Record<string, unknown> | undefined,
    }
  }
  // Every allocation the RPC settled in full retires its suggestion pointer
  // from the company's OTHER transactions (issue #1259): the RPC only nulls
  // them on the source tx. Same helper as the HTTP twin
  // (app/api/transactions/[id]/match-batch/route.ts) so the two cannot drift.
  await clearSettledBatchAllocationSuggestions(supabase, companyId, result.allocations ?? [], txId)

  // Structured audit-trail entry on success (compliance-swarm V16). Tx
  // count + JE id + the source tx id only: no amounts, no
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

/**
 * Bulk-book selected Underlag (Dokumentinkorgen): Lena-driven flow. Each
 * selected inbox item is booked against its matched bank transaction using one
 * shared category + VAT treatment. The booking, VAT (incl. reverse charge), and
 * underlag→verifikat propagation are the SAME shared core the single-item
 * categorize path uses (categorizeMatchedTransaction). Items that can't be
 * booked are skipped with a reason rather than failing the whole batch: the
 * "Bokför valda hoppar över" contract. A per-item throw (e.g. period locked,
 * accounts not in chart) is caught and recorded as a skip so one bad underlag
 * never blocks the rest.
 */
async function commitBulkBookInboxItems(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<ExecutorResult> {
  const parsed = BulkBookInboxSchema.safeParse(params)
  if (!parsed.success) {
    return { error: `Invalid bulk_book_inbox_items params: ${parsed.error.message}`, status: 400 }
  }

  const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, userId, companyId, parsed.data)

  log.info('bulk_book_inbox_items committed', {
    companyId,
    operationType: 'bulk_book_inbox_items',
    requested: parsed.data.item_ids.length,
    bookedCount: booked.length,
    skippedCount: skipped.length,
  })

  return {
    data: {
      booked_count: booked.length,
      skipped_count: skipped.length,
      booked,
      skipped,
    },
  }
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
  // Mirrors commitMatchBatchAllocate / commitBulkBookTransactions: IDs only,
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
 *
 * When opts.actor is set, the entire executor runs inside a runWithActor()
 * scope so EVERY journal-entry commit the operation makes (regardless of
 * which entry generator produced it) carries actor attribution into
 * journal_entries.committed_actor_* and the audit_log COMMIT row via
 * commitEntry() → commit_journal_entry RPC (migration 20260619120000).
 */
export async function commitPendingOperation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  const run = () => commitPendingOperationInner(supabase, userId, companyId, pendingOp, opts)
  return opts.actor ? runWithActor(opts.actor, run) : run()
}

async function commitPendingOperationInner(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  pendingOp: PendingOperation,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  // ── Capability gate (commit-time twin of the MCP dispatch gate). The actual
  //    external-service call (email / Skatteverket submit) happens below, so
  //    this is the true paid chokepoint: it also catches an op STAGED during
  //    the trial then approved AFTER the grant expired, regardless of caller
  //    (MCP approve tool or the UI approval path). Checked BEFORE the atomic
  //    claim so a blocked op stays 'pending' and is re-approvable once the
  //    company subscribes. Self-hosted short-circuits to all-on in hasCapability.
  const requiredCapability = PAID_OPERATION_CAPABILITY_MAP[pendingOp.operation_type]
  if (requiredCapability && !(await hasCapability(supabase, companyId, requiredCapability))) {
    return {
      status: 'failed',
      error: CAPABILITY_BLOCKED_MESSAGE_SV,
      http_status: 403,
      code: 'capability_blocked',
    }
  }

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
      case 'update_customer':
        result = await commitUpdateCustomer(supabase, companyId, pendingOp.params)
        break
      case 'update_invoice':
        result = await commitUpdateInvoice(supabase, companyId, pendingOp.params)
        break
      case 'create_recurring_schedule':
        result = await commitCreateRecurringSchedule(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_recurring_schedule':
        result = await commitUpdateRecurringSchedule(supabase, companyId, pendingOp.params)
        break
      case 'update_company_settings':
        result = await commitUpdateCompanySettings(supabase, companyId, pendingOp.params)
        break
      case 'create_article':
        result = await commitCreateArticle(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_article':
        result = await commitUpdateArticle(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_supplier':
        result = await commitCreateSupplier(supabase, userId, companyId, pendingOp.params)
        break
      case 'create_account':
        result = await commitCreateAccount(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_account':
        result = await commitUpdateAccount(supabase, userId, companyId, pendingOp.params)
        break
      case 'set_voucher_note':
        result = await commitSetVoucherNote(supabase, companyId, pendingOp.params)
        break
      case 'create_dimension_value':
        result = await commitCreateDimensionValue(supabase, userId, companyId, pendingOp.params)
        break
      case 'retag_line_dimensions':
        result = await commitRetagLineDimensions(supabase, userId, companyId, pendingOp.params)
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
      case 'link_document_to_voucher':
        result = await commitLinkDocumentToVoucher(supabase, userId, companyId, pendingOp.params)
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
        result = await commitUndoSieImport(supabase, userId, companyId, pendingOp.params)
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
      case 'update_payslip_line':
        result = await commitUpdatePayslipLine(supabase, companyId, pendingOp.params)
        break
      case 'register_absence':
        result = await commitRegisterAbsence(supabase, companyId, pendingOp.params)
        break
      case 'book_salary_run':
        result = await commitBookSalaryRun(supabase, userId, companyId, pendingOp.params)
        break
      case 'delete_absence':
        result = await commitDeleteAbsence(supabase, companyId, pendingOp.params)
        break
      case 'create_employee':
        result = await commitCreateEmployee(supabase, userId, companyId, pendingOp.params)
        break
      case 'update_employee':
        result = await commitUpdateEmployee(supabase, companyId, pendingOp.params)
        break
      case 'set_employee_opening_balances':
        result = await commitSetEmployeeOpeningBalances(supabase, userId, companyId, pendingOp.params)
        break
      case 'vacation_year_close':
        result = await commitVacationYearClose(supabase, userId, companyId, pendingOp.params)
        break
      case 'match_batch_allocate':
        result = await commitMatchBatchAllocate(supabase, companyId, pendingOp.params)
        break
      case 'bulk_book_transactions':
        result = await commitBulkBookTransactions(supabase, companyId, pendingOp.params)
        break
      case 'bulk_book_inbox_items':
        result = await commitBulkBookInboxItems(supabase, userId, companyId, pendingOp.params)
        break
      case 'link_transaction_journal_entry':
        result = await commitLinkTransactionJournalEntry(supabase, userId, companyId, pendingOp.params)
        break
      case 'submit_vat_declaration':
        result = await commitSubmitVatDeclaration(supabase, userId, companyId, pendingOp.params)
        break
      case 'submit_agi':
        result = await commitSubmitAgi(supabase, userId, companyId, pendingOp.params)
        break
      default:
        return {
          status: 'failed',
          error: `Unknown operation type: ${pendingOp.operation_type}`,
          http_status: 400,
        }
    }
  } catch (err) {
    // Partial commit (issue #842): the executor already posted an
    // irreversible side-effect (storno voucher, credit note) before a later
    // step failed. 'rejected' would misrepresent reality and hide the posted
    // entity, so land the op in the terminal 'failed_partial' status with the
    // posted ids in result_data so an operator can locate the orphan. Checked
    // FIRST: a wrapped recoverable cause must NOT release the claim back to
    // 'pending' (the side-effect already exists).
    if (err instanceof PartialCommitError) {
      await supabase
        .from('pending_operations')
        .update({
          status: 'failed_partial',
          resolved_at: new Date().toISOString(),
          result_data: { error: err.message, threw: true, posted_ids: err.postedIds },
        })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: err.message,
        http_status: 500,
        code: 'partial_commit',
        data: { posted_ids: err.postedIds },
      }
    }
    // Accounts-not-in-chart is RECOVERABLE: the booking itself is valid; the
    // company's chart just lacks the (standard BAS) accounts it posts to. Do
    // NOT consume the op: release the atomic claim back to 'pending' so the
    // user can activate the accounts and retry the SAME op, and surface the
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
    // Recoverable Skatteverket failure (extension disabled, no connection,
    // rate-limited, still processing). Same contract as accounts-not-in-chart:
    // release the claim back to 'pending' so the user can fix the connection/
    // flag and re-approve the SAME op, and surface the structured code.
    if (err instanceof SkatteverketRecoverableError) {
      await supabase
        .from('pending_operations')
        .update({ status: 'pending' })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: err.message,
        http_status: err.httpStatus,
        code: err.code,
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
    // Structured partial marker (issue #842): same semantics as the
    // PartialCommitError branch above, for executors that report the failure
    // via the ExecutorResult contract instead of throwing. Must run before
    // the auto-reject branch: a 409 AFTER a voucher was posted is a partial
    // commit, not a re-stageable rejection.
    const partialPostedIds =
      result.partialPostedIds && Object.keys(result.partialPostedIds).length > 0
        ? result.partialPostedIds
        : null
    if (partialPostedIds) {
      await supabase
        .from('pending_operations')
        .update({
          status: 'failed_partial',
          resolved_at: new Date().toISOString(),
          result_data: {
            error: result.error,
            http_status: result.status,
            posted_ids: partialPostedIds,
          },
        })
        .eq('id', pendingOp.id)
      return {
        status: 'failed',
        error: result.error,
        http_status: result.status ?? 500,
        code: 'partial_commit',
        data: { posted_ids: partialPostedIds },
      }
    }
    const isAutoReject = result.status === 404 || result.status === 409
    await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        result_data: isAutoReject
          ? { auto_rejected: true, reason: result.error }
          : {
              error: result.error,
              http_status: result.status,
              ...(result.errorCode ? { error_code: result.errorCode } : {}),
            },
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
      ...(result.errorCode ? { code: result.errorCode } : {}),
    }
  }

  const now = new Date().toISOString()
  const { error: finalizeError } = await supabase
    .from('pending_operations')
    .update({
      status: 'committed',
      resolved_at: now,
      result_data: result.data || {},
    })
    .eq('id', pendingOp.id)

  if (finalizeError) {
    // The executor's side-effects already committed (and are immutable); only
    // the terminal status write failed. Log loudly with the ids needed to
    // finalize manually; the response still reports success because the
    // actual work is done.
    //
    // Runbook (#843): rows left in 'committing' by this failure are picked up
    // by the daily recovery sweep in
    // lib/pending-operations/recover-stuck-committing.ts (runs from the
    // expire cron, threshold 15 min). Grep logs for 'pending_op_recovery' to
    // see per-row outcomes: 'committed' when posted side-effects were
    // verified, 'rejected' when no trace was detectable (nothing re-executes
    // either way).
    log.error('failed to finalize pending_operation to committed (left in committing)', finalizeError, {
      pendingOperationId: pendingOp.id,
      operationType: pendingOp.operation_type,
      companyId,
    })
  }

  return {
    status: 'committed',
    data: result.data,
  }
}
