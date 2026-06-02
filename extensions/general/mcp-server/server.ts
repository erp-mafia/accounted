import { NextResponse } from 'next/server'
import {
  extractBearerToken,
  validateApiKey,
  createServiceClientNoCookies,
  hasScope,
  TOOL_SCOPE_MAP,
} from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate, findCounterpartyTemplatesBatch, formatCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { formatVoucherLabel } from '@/lib/transactions/link-journal-entry'
import { eventBus } from '@/lib/events/bus'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { getBranding } from '@/lib/branding/service'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import {
  calculateGrossMargin,
  calculateCashPosition,
  calculateExpenseRatio,
  calculateAvgPaymentDays,
} from '@/lib/reports/kpi'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { uiWidgets, findUiWidget, WIDGET_MIME_TYPE } from './widgets'
import { dataResources, findResource, parseResourceQuery } from './resources'
import { prompts, findPrompt } from './prompts'
import { findSkill, loadAllSkills, SKILL_MIME_TYPE, SKILL_URI_PREFIX, skillUri, skillSlugFromUri } from './skills'
import type { SkillTier } from './skills'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { CreateSupplierParamsSchema } from '@/lib/pending-operations/schemas/create-supplier'
import { z } from 'zod'
import {
  checkIdempotencyKey,
  storeIdempotencyResponse,
  hashRequest,
  IdempotencyKeyReuseError,
} from '@/lib/api/idempotency'
import { toToolError, type NextActionHint } from './tool-result'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { createInvoicePaymentJournalEntry, createInvoiceCashEntry, createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { findMatchingInvoices } from '@/lib/invoices/invoice-matching'
import {
  findMatchingVouchersForInvoice,
  validateVoucherForInvoiceLink,
} from '@/lib/invoices/voucher-matching'
import {
  findMatchingVouchersForSupplierInvoice,
  validateVoucherForSupplierInvoiceLink,
} from '@/lib/invoices/supplier-voucher-matching'
import { findFiscalPeriod, reverseEntry, validateBalance } from '@/lib/bookkeeping/engine'
import { closePeriod, lockPeriod, resolvePeriodStatusForDate, type PeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { validateYearEndReadiness, previewYearEndClosing } from '@/lib/core/bookkeeping/year-end-service'
import { generateSIEExport } from '@/lib/reports/sie-export'
import { generateFullArchive, estimateArchiveSize } from '@/lib/reports/full-archive-export'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { getSuggestedCategories } from '@/lib/transactions/category-suggestions'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { getEmailService } from '@/lib/email/service'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { uploadDocument, MAX_DOCUMENT_SIZE } from '@/lib/core/documents/document-service'
import { extractInvoiceFields, ExtractionSchema as InvoiceExtractionSchema } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { appendProcessingHistory } from '@/lib/processing-history/append'
// ensureInitialized() is called by the extension router (ext/[...path]/route.ts)
// which dispatches to this handler — no duplicate call needed here.
import type { Transaction, TransactionCategory, EntityType, VatTreatment, Invoice, Currency, CompanySettings, Customer, InvoiceItem, PendingOperation } from '@/types'

// ── Actor context ────────────────────────────────────────────

interface ActorContext {
  type: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
  id?: string
  label?: string
  /**
   * Stable agent-session identifier from the `Mcp-Session-Id` JSON-RPC header
   * when present, otherwise null. Used to correlate `mcp.tool_called`,
   * `mcp.workflow_started`, `mcp.next_hint_followed`, etc. events across a
   * single agent conversation. Not used for auth.
   */
  sessionId?: string | null
}

// ── JSON-RPC types ───────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── MCP Tool definition ──────────────────────────────────────

interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: McpToolAnnotations
  _meta?: { ui: { resourceUri: string } }
  // Result-level UI hint: when set, a call passing render_ui=true gets a
  // _meta.ui.resourceUri on the RESULT, so the host renders the widget only when
  // asked. (Contrast _meta above, on the definition, which renders on every call.)
  uiResourceUri?: string
  execute: (
    args: Record<string, unknown>,
    companyId: string,
    userId: string,
    supabase: SupabaseClient,
    actor?: ActorContext
  ) => Promise<unknown>
}

// ── Shared constants ─────────────────────────────────────────

const log = createLogger('mcp-server')

// gnubok_feedback rate limit: 1 per 60s per actor. In-memory single-process;
// no Redis dependency. See the gnubok_feedback tool definition below.
const FEEDBACK_RATE_LIMIT_MS = 60_000
const feedbackRateLimit = new Map<string, number>()

const VALID_CATEGORIES = [
  'income_services', 'income_products', 'income_other',
  'expense_equipment', 'expense_software', 'expense_travel', 'expense_office',
  'expense_marketing', 'expense_professional_services', 'expense_education',
  'expense_representation', 'expense_consumables', 'expense_vehicle',
  'expense_telecom', 'expense_bank_fees', 'expense_card_fees',
  'expense_currency_exchange', 'expense_other', 'private',
] as const

const VALID_VAT_TREATMENTS = [
  'standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt',
] as const

// ── Pending operations staging ───────────────────────────────

/**
 * Param-keys we'll scan for an affärshändelse date when the caller doesn't
 * pass `dateForPeriodCheck` explicitly. Ordered: most-specific first. The
 * first ISO yyyy-MM-dd hit wins. Adding a new field is safe — unknown values
 * just fall through to undefined.
 */
const AUTO_PERIOD_DATE_KEYS = [
  'entry_date',
  'payment_date',
  'invoice_date',
  'date',
  'period_end',
  'period_start',
  'voucher_date',
  'paid_date',
  'transfer_date',
] as const

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function autoExtractDateForPeriodCheck(params: Record<string, unknown>): string | undefined {
  for (const key of AUTO_PERIOD_DATE_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && ISO_DATE_RE.test(value)) return value
  }
  return undefined
}

interface StageOptions {
  /**
   * When true, validate inputs and return the would-be preview without
   * inserting into pending_operations or executing any side-effects. Used
   * by agents to preflight an operation before committing to it.
   */
  dryRun?: boolean
  /**
   * Per-operation idempotency key. When supplied, repeat calls with the same
   * key + same payload return the original response and never re-execute.
   * Different payload + same key returns IDEMPOTENCY_KEY_REUSE.
   */
  idempotencyKey?: string
  /**
   * ISO yyyy-MM-dd date used to look up period_status before staging. When
   * provided, the response includes a `period_status` envelope so agents and
   * widgets can detect locked/closed periods without a round-trip. Failure to
   * resolve (DB blip, missing settings row) leaves the response unchanged —
   * the DB triggers remain the authoritative gate.
   */
  dateForPeriodCheck?: string
}

function buildApprovalGuidance(operationId: string, riskLevel: 'low' | 'medium' | 'high'): string {
  if (riskLevel === 'high') {
    return `This is an irreversible posting under BFL 5 kap 5§ — surface the irreversibility implications to the user and obtain an explicit acknowledgment before committing. Once the user has acknowledged, call gnubok_approve_pending_operation with operation_id="${operationId}" and confirmed=true.`
  }
  return `When the user authorises, call gnubok_approve_pending_operation with operation_id="${operationId}".`
}

async function stagePendingOperation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  operationType: string,
  title: string,
  params: Record<string, unknown>,
  previewData: Record<string, unknown>,
  actor: ActorContext = { type: 'user' },
  next?: NextActionHint,
  options: StageOptions = {}
): Promise<{
  staged: boolean
  dry_run?: boolean
  idempotency_replay?: boolean
  operation_id?: string
  risk_level: 'low' | 'medium' | 'high'
  actor: ActorContext
  message: string
  approve?: { tool: string; args: Record<string, unknown> }
  preview: Record<string, unknown>
  period_status?: PeriodStatusForDate
  next?: NextActionHint
}> {
  const riskLevel = getRiskLevel(operationType)
  const branding = getBranding().appName.toLowerCase()

  // Resolve period_status once. The caller can pass `dateForPeriodCheck`
  // explicitly; otherwise we scan params for a known affärshändelse-date
  // field so every date-bearing operation surfaces a period_status envelope
  // without each tool having to opt in. Failure is non-fatal — DB triggers
  // are the authoritative gate; a missing envelope just degrades preview UX.
  const dateForPeriodCheck = options.dateForPeriodCheck ?? autoExtractDateForPeriodCheck(params)
  let periodStatus: PeriodStatusForDate | undefined
  if (dateForPeriodCheck) {
    try {
      periodStatus = await resolvePeriodStatusForDate(supabase, companyId, dateForPeriodCheck)
    } catch (err) {
      log.warn('resolvePeriodStatusForDate failed', {
        operationType,
        companyId,
        dateForPeriodCheck,
        error: err instanceof Error ? err.message : String(err),
      })
      periodStatus = undefined
    }
  }

  // ── Dry-run path: skip both the cache and the insert. Return the preview
  //    so the agent sees exactly what would happen without committing.
  if (options.dryRun) {
    return {
      staged: false,
      dry_run: true,
      risk_level: riskLevel,
      actor,
      message: `Dry run: would stage "${operationType}" (risk: ${riskLevel}). No changes made.`,
      preview: previewData,
      ...(periodStatus ? { period_status: periodStatus } : {}),
      ...(next ? { next } : {}),
    }
  }

  // ── Idempotency check: same key + same payload + same company → return
  //    cached response. companyId is folded into the canonical hash so the
  //    same key UUID submitted under a different company is treated as a
  //    fresh request, not a replay.
  const requestHash = options.idempotencyKey
    ? hashRequest({ operationType, params, companyId })
    : null
  if (options.idempotencyKey && requestHash) {
    const cached = await checkIdempotencyKey(supabase, userId, companyId, options.idempotencyKey, requestHash)
    if (cached) {
      const cachedBody = cached.body as Record<string, unknown>
      const cachedOpId = typeof cachedBody.operation_id === 'string' ? cachedBody.operation_id : undefined
      return {
        ...cachedBody,
        idempotency_replay: true,
        risk_level: riskLevel,
        actor,
        message: cachedOpId
          ? `Replayed cached response for idempotency_key "${options.idempotencyKey}" — already staged as pending_operation ${cachedOpId}. No new side-effects. ${buildApprovalGuidance(cachedOpId, riskLevel)}`
          : `Replayed cached response for idempotency_key "${options.idempotencyKey}". No new side-effects.`,
        ...(cachedOpId
          ? { approve: { tool: 'gnubok_approve_pending_operation', args: { operation_id: cachedOpId } } }
          : {}),
        preview: periodStatus ? { ...previewData, period_status: periodStatus } : previewData,
        ...(periodStatus ? { period_status: periodStatus } : {}),
      } as Awaited<ReturnType<typeof stagePendingOperation>>
    }
  }

  const { data, error } = await supabase
    .from('pending_operations')
    .insert({
      company_id: companyId,
      user_id: userId,
      operation_type: operationType,
      title,
      params,
      preview_data: previewData,
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      actor_label: actor.label ?? null,
      risk_level: riskLevel,
    })
    .select('*')
    .single()

  if (error) throw new Error(`Failed to stage operation: ${error.message}`)

  // approve.args carries only the operation_id. For high-risk operations the
  // LLM must supply confirmed=true itself after surfacing the BFL 5 kap 5§
  // irreversibility implications to the user — pre-filling it server-side
  // would collapse the explicit-acknowledgment gate (mirrors the web UI's
  // warning dialog). The server-side check in gnubok_approve_pending_operation
  // remains authoritative.
  const response = {
    staged: true,
    operation_id: data.id,
    risk_level: riskLevel,
    actor,
    message: `Staged as pending_operation ${data.id} (risk: ${riskLevel}). ${buildApprovalGuidance(data.id, riskLevel)} The user can also approve at /pending in the ${branding} web app.`,
    approve: {
      tool: 'gnubok_approve_pending_operation',
      args: { operation_id: data.id } as Record<string, unknown>,
    },
    preview: periodStatus ? { ...previewData, period_status: periodStatus } : previewData,
    ...(periodStatus ? { period_status: periodStatus } : {}),
    ...(next ? { next } : {}),
  } as const

  if (options.idempotencyKey && requestHash) {
    await storeIdempotencyResponse(
      supabase, userId, companyId, options.idempotencyKey, requestHash,
      'success', { staged: true, operation_id: data.id, preview: previewData }
    )
  }
  return response
}

// ── Journal entry reference resolution ────────────────────────

/**
 * Resolve a journal entry reference to a journal_entries.id UUID.
 *
 * Accepts either a raw UUID (returned as-is) or a voucher reference like
 * "A-113" / "A113" / "A/113" (resolved by voucher_series + voucher_number
 * scoped to the company).
 *
 * Voucher refs are the preferred input shape for LLM-driven callers: short,
 * semantically meaningful, and resistant to UUID hallucination — a failure
 * mode where the agent reproduces the first 8 hex chars correctly but
 * fabricates the remaining 24, so a downstream lookup rejects the ID even
 * though the entry exists.
 */
async function resolveJournalEntryRef(
  supabase: SupabaseClient,
  companyId: string,
  ref: string
): Promise<string> {
  const trimmed = ref.trim()

  // UUIDs pass through. If the UUID was hallucinated, the caller's own
  // lookup surfaces the "not found" diagnostic with the supplied value.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed
  }

  // Voucher ref: letters (series) + optional separator + digits (number).
  const match = trimmed.match(/^([A-Za-z]+)\s*[-:/ ]?\s*(\d+)$/)
  if (!match) {
    throw new Error(
      `Could not parse entry reference "${ref}". Expected a UUID or a voucher ref like "A-113".`
    )
  }
  const series = match[1].toUpperCase()
  const number = parseInt(match[2], 10)

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, entry_date, description')
    .eq('company_id', companyId)
    .eq('voucher_series', series)
    .eq('voucher_number', number)
    .order('entry_date', { ascending: false })

  if (error) {
    throw new Error(`Database error resolving voucher "${series}-${number}": ${error.message}`)
  }

  const matches = (data ?? []) as Array<{ id: string; entry_date: string; description: string }>

  if (matches.length === 0) {
    throw new Error(
      `No journal entry found for voucher "${series}-${number}" in this company. ` +
      `Verify the series and number, or supply the full UUID.`
    )
  }

  // Voucher numbers reset per fiscal period. The same (series, number) pair
  // can therefore appear in multiple years — refuse to guess.
  if (matches.length > 1) {
    const summary = matches
      .map((m) => `${m.entry_date} "${m.description}" (id=${m.id})`)
      .join('; ')
    throw new Error(
      `Voucher "${series}-${number}" matches multiple entries across fiscal periods: ${summary}. ` +
      `Supply the specific UUID instead.`
    )
  }

  return matches[0].id
}

// ── Shared categorization logic ──────────────────────────────

async function categorizeTransactionCore(
  txId: string,
  category: TransactionCategory,
  vatTreatment: VatTreatment | undefined,
  userId: string,
  companyId: string,
  supabase: SupabaseClient,
  confirm: boolean = false
): Promise<{
  preview?: boolean
  success?: boolean
  journal_entry_created?: boolean
  journal_entry_id?: string | null
  journal_entry_error?: string | null
  category: string
  debit_account: string
  credit_account: string
  amount: number
  currency: string
  vat_lines?: Array<{ account_number: string; debit_amount: number; credit_amount: number; description: string }>
  message?: string
  transaction?: Transaction
  underlag?: {
    document_id: string
    total: number | null
    vat_amount: number | null
    currency: string | null
  } | null
}> {
  // Validate category
  if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
    throw new Error(
      `Invalid category "${category}". Valid categories: ${VALID_CATEGORIES.join(', ')}`
    )
  }

  if (vatTreatment && !VALID_VAT_TREATMENTS.includes(vatTreatment as typeof VALID_VAT_TREATMENTS[number])) {
    throw new Error(
      `Invalid vat_treatment "${vatTreatment}". Valid: ${VALID_VAT_TREATMENTS.join(', ')}`
    )
  }

  const isBusiness = category !== 'private'

  // Fetch the transaction
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', txId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !transaction) {
    throw new Error('Transaction not found. Check the transaction_id is correct.')
  }

  // Underlag guard: if the transaction has an attached document with
  // AI-extracted invoice data, use it to validate the proposed VAT treatment
  // BEFORE we build the booking. The historical failure mode here was the
  // agent stamping reverse_charge on any foreign-vendor charge and producing
  // fictive 2645/2614 VAT lines (25% of the SEK amount) on an invoice where
  // the seller had already debited real VAT. Block that explicitly.
  let underlagSummary: {
    document_id: string
    total: number | null
    vat_amount: number | null
    currency: string | null
  } | null = null
  if (transaction.document_id) {
    const { data: doc } = await supabase
      .from('document_attachments')
      .select('id, extracted_data')
      .eq('id', transaction.document_id)
      .eq('company_id', companyId)
      .maybeSingle()
    const ex = (doc?.extracted_data ?? null) as
      | { totals?: { total?: number; vatAmount?: number }; invoice?: { currency?: string } }
      | null
    if (doc) {
      underlagSummary = {
        document_id: doc.id as string,
        total: ex?.totals?.total ?? null,
        vat_amount: ex?.totals?.vatAmount ?? null,
        currency: ex?.invoice?.currency ?? null,
      }
      const sellerChargedVat = (ex?.totals?.vatAmount ?? 0) > 0
      if (vatTreatment === 'reverse_charge' && sellerChargedVat) {
        throw new Error(
          `Reverse charge avvisas: underlaget (document_id=${doc.id}) visar att säljaren redan har debiterat moms ` +
          `(${ex?.totals?.vatAmount} ${ex?.invoice?.currency ?? ''}). Omvänd skattskyldighet gäller bara fakturor utan säljarens moms. ` +
          `Bokför som vanlig kostnad (utan vat_treatment, eller standard_25 om svensk faktura) — den utländska momsen ingår i kostnaden.`,
        )
      }
    }
  }

  if (transaction.journal_entry_id) {
    return {
      success: true,
      journal_entry_created: false,
      journal_entry_id: transaction.journal_entry_id,
      journal_entry_error: 'Transaction already has a journal entry — use gnubok_list_uncategorized_transactions to find unbooked ones.',
      category,
      debit_account: '',
      credit_account: '',
      amount: Math.abs(transaction.amount),
      currency: transaction.currency,
      transaction: transaction as Transaction,
    }
  }

  // Get entity type
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type, fiscal_year_start_month')
    .eq('company_id', companyId)
    .single()

  const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  // Build mapping
  const mappingResult = buildMappingResultFromCategory(
    category,
    transaction as Transaction,
    isBusiness,
    entityType,
    vatTreatment
  )

  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    throw new Error(
      `No account mapping for category "${category}" with entity type "${entityType}". ` +
      'Try a different category or check your chart of accounts.'
    )
  }

  // Preview mode: return what would happen without executing
  if (!confirm) {
    return {
      preview: true,
      category,
      debit_account: mappingResult.debit_account,
      credit_account: mappingResult.credit_account,
      amount: Math.abs(transaction.amount),
      currency: transaction.currency,
      vat_lines: mappingResult.vat_lines.map(v => ({
        account_number: v.account_number,
        debit_amount: v.debit_amount,
        credit_amount: v.credit_amount,
        description: v.description,
      })),
      message: 'Preview only — no changes made. Call again with confirm: true to create the journal entry.',
      underlag: underlagSummary,
    }
  }

  // Ensure fiscal period exists
  const fiscalYearStartMonth = settings?.fiscal_year_start_month ?? 1
  const txDate = new Date(transaction.date)
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

  await supabase
    .from('fiscal_periods')
    .upsert(
      { user_id: userId, name: periodName, period_start: periodStart, period_end: periodEnd },
      { onConflict: 'user_id,period_start,period_end' }
    )

  // Create journal entry
  let journalEntryId: string | null = null
  let journalEntryError: string | null = null

  try {
    const journalEntry = await createTransactionJournalEntry(
      supabase,
      companyId,
      userId,
      transaction as Transaction,
      mappingResult
    )
    if (journalEntry) {
      journalEntryId = journalEntry.id
    }
  } catch (err) {
    journalEntryError = err instanceof Error ? err.message : 'Unknown error'
  }

  // Update transaction
  await supabase
    .from('transactions')
    .update({
      is_business: isBusiness,
      category,
      journal_entry_id: journalEntryId,
    })
    .eq('id', txId)

  // Emit event so extensions (mapping rules, etc.) can react
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

  // Upsert counterparty template for future auto-matching
  try {
    await upsertCounterpartyTemplate(
      supabase, userId, transaction as Transaction, mappingResult, 'user_approved'
    )
  } catch {
    // Non-critical
  }

  return {
    success: true,
    journal_entry_created: !!journalEntryId,
    journal_entry_id: journalEntryId,
    journal_entry_error: journalEntryError,
    category,
    debit_account: mappingResult.debit_account,
    credit_account: mappingResult.credit_account,
    amount: Math.abs(transaction.amount),
    currency: transaction.currency,
    transaction: transaction as Transaction,
  }
}

// ── Output schema helpers ────────────────────────────────────

const PAGINATION_PROPS = {
  count: { type: 'number', description: 'Number of items in this page' },
  total_count: { type: 'number', description: 'Total matching across all pages' },
  has_more: { type: 'boolean' },
  next_offset: { type: 'number', description: 'Offset for the next page (omitted on last page)' },
} as const

const NEXT_ACTION_HINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object', additionalProperties: true },
    resource: { type: 'string' },
  },
  required: ['description'],
} as const

const STAGED_OPERATION_SCHEMA = {
  type: 'object',
  properties: {
    staged: { type: 'boolean' },
    operation_id: { type: 'string', description: 'UUID of the staged operation, present once persisted' },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
    actor: { type: 'object' },
    dry_run: { type: 'boolean' },
    idempotency_replay: { type: 'boolean' },
    message: { type: 'string' },
    approve: { type: 'object' },
    preview: { type: 'object' },
    period_status: {
      type: 'object',
      description: 'Fiscal period covering the affärshändelse date. Use to detect locked/closed periods without a round-trip.',
      properties: {
        period_id: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['open', 'locked', 'closed'] },
        lock_date: { type: ['string', 'null'] },
      },
    },
    next: NEXT_ACTION_HINT_SCHEMA,
  },
  required: ['staged', 'risk_level', 'actor', 'message', 'preview'],
} as const

function paginatedSchema(itemsKey: string, itemSchema: Record<string, unknown> = { type: 'object' }) {
  return {
    type: 'object',
    properties: {
      [itemsKey]: { type: 'array', items: itemSchema },
      ...PAGINATION_PROPS,
    },
    required: [itemsKey, 'count', 'total_count', 'has_more'],
  } as const
}

const VAT_REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    period: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'] },
        year: { type: 'number' },
        period: { type: 'number' },
        start: { type: 'string', description: 'Period start date (YYYY-MM-DD)' },
        end: { type: 'string', description: 'Period end date (YYYY-MM-DD)' },
      },
      required: ['type', 'year', 'period', 'start', 'end'],
    },
    period_label: { type: 'string', description: 'Human-readable period label (e.g. "Q1 2026")' },
    rutor: {
      type: 'object',
      description: 'SKV 4700 momsdeklaration boxes — absolute values, signs implied by box semantics',
      properties: {
        ruta05: { type: 'number', description: 'Total domestic taxable sales (all rates)' },
        ruta10: { type: 'number', description: 'Output VAT 25 % (account 2611)' },
        ruta11: { type: 'number', description: 'Output VAT 12 % (account 2621)' },
        ruta12: { type: 'number', description: 'Output VAT 6 % (account 2631)' },
        ruta30: { type: 'number', description: 'Reverse-charge output VAT 25 % (account 2614)' },
        ruta31: { type: 'number', description: 'Reverse-charge output VAT 12 % (account 2624)' },
        ruta32: { type: 'number', description: 'Reverse-charge output VAT 6 % (account 2634)' },
        ruta35: { type: 'number', description: 'EU intra-community goods supplies, momsfri (account 3108)' },
        ruta39: { type: 'number', description: 'EU services sold (account 3308)' },
        ruta40: { type: 'number', description: 'Export outside EU (account 3305)' },
        ruta48: { type: 'number', description: 'Total input VAT (2641 + 2645 + 2647)' },
        ruta49: {
          type: 'number',
          description: 'VAT to pay (positive) or refund (negative) = (10+11+12+30+31+32+60+61+62) − 48',
        },
        ruta60: { type: 'number', description: 'Import VAT 25 % (account 2615) — non-EU import declared via momsdeklaration' },
        ruta61: { type: 'number', description: 'Import VAT 12 % (account 2625)' },
        ruta62: { type: 'number', description: 'Import VAT 6 % (account 2635)' },
      },
      required: ['ruta05', 'ruta10', 'ruta11', 'ruta12', 'ruta30', 'ruta31', 'ruta32', 'ruta35', 'ruta39', 'ruta40', 'ruta48', 'ruta49', 'ruta60', 'ruta61', 'ruta62'],
    },
    summary: { type: 'string', description: 'One-line Swedish summary string (att betala / att få tillbaka / noll)' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Pre-filing warnings (e.g. one-sided reverse charge). Empty when none.',
    },
  },
  required: ['period', 'period_label', 'rutor', 'summary', 'warnings'],
} as const

// ── VAT report computation (shared by gnubok_get_vat_report + gnubok_vat_review_widget) ──
//
// Maps posted journal entry lines to SKV 4700 rutor. ruta49 covers domestic
// output VAT (10/11/12) AND reverse-charge output VAT (30/31/32) per
// ML 2023:200 — both must be displayed and netted against ruta48 (input VAT).
//
// Account → ruta map:
//   3001-3008, 3041-3048, 3051-3058, 3071-3078 → ruta05  (all domestic taxable sales — common BAS revenue accounts)
//   2611           → ruta10  (output VAT 25%)
//   2621           → ruta11  (output VAT 12%)
//   2631           → ruta12  (output VAT 6%)
//   2614           → ruta30  (reverse-charge output VAT 25%)
//   2624           → ruta31  (reverse-charge output VAT 12%)
//   2634           → ruta32  (reverse-charge output VAT 6%)
//   3308           → ruta39  (EU services sold)
//   3305           → ruta40  (export outside EU)
//   2641/2645/2647 → ruta48  (all input VAT)
//
// Posted+reversed status filter: a "reversed" original entry is still part of
// its period's books — Skatteverket files VAT period-by-period under
// faktureringsmetoden (sale's VAT in invoice-date period; kreditfaktura's
// reduction in storno-date period). The original entry stays in its period;
// the storno (status 'posted', dated when the credit was issued) lands in
// its own period. The two periods file independently; across a year they
// arithmetically cancel. *Excluding* 'reversed' would under-report Period N
// (the original sale's VAT silently disappears) and over-credit Period N+M
// (a reversal with no original) — incorrect per ML 2023:200.

/** Common BAS taxable-revenue accounts that contribute to ruta 05.
 *
 *  Conservative expansion beyond 3001/3002/3003. Excludes 3004 (momsfri,
 *  exempt) and 3108/3305/3308 (handled by ruta35/40/39). 3106 covers the
 *  rare case of taxable EU goods (momspliktig EU-leverans, e.g. when the
 *  buyer's VAT number is invalid).
 *
 *  Companies using non-standard charts must either book to one of these
 *  or extend the list — gnubok's BAS chart only ships 3001/3002/3003/3004
 *  by default, but 30xx alternates are common in custom charts. */
const RUTA_05_ACCOUNTS = [
  // Domestic sales by VAT rate (canonical BAS)
  '3001', '3002', '3003', '3005', '3006', '3007', '3008',
  // Taxable EU goods (momspliktig — buyer's VAT number invalid or buyer is private)
  '3106',
  // Domestic services (alternative numbering some companies use)
  '3041', '3042', '3043', '3044', '3045', '3046', '3047', '3048',
  // Domestic goods (alternative numbering)
  '3051', '3052', '3053', '3054', '3055', '3056', '3057', '3058',
  // Other domestic taxable
  '3071', '3072', '3073', '3074', '3075', '3076', '3077', '3078',
] as const

export interface VatReportResult {
  period: { type: string; year: number; period: number; start: string; end: string }
  period_label: string
  rutor: {
    ruta05: number; ruta10: number; ruta11: number; ruta12: number
    ruta30: number; ruta31: number; ruta32: number
    ruta35: number; ruta39: number; ruta40: number
    ruta48: number; ruta49: number
    // Import VAT (post-2015 momsdeklaration path, accounts 2615/2625/2635).
    // Buyer/importer self-assesses output VAT here and deducts the matching
    // input via ruta 48 — same mechanic as ruta 30/31/32.
    ruta60: number; ruta61: number; ruta62: number
  }
  summary: string
  warnings: string[]
}

export async function computeVatReport(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatReportResult> {
  const periodType = args.period_type as string
  const year = Number(args.year)
  const period = Number(args.period)

  if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
    throw new Error('period_type must be: monthly, quarterly, yearly')
  }
  if (!year || year < 2000 || year > 2100) throw new Error('year must be between 2000 and 2100')
  if (periodType === 'monthly' && (period < 1 || period > 12)) throw new Error('period must be 1–12 for monthly')
  if (periodType === 'quarterly' && (period < 1 || period > 4)) throw new Error('period must be 1–4 for quarterly')

  let startDate: string
  let endDate: string

  if (periodType === 'monthly') {
    startDate = `${year}-${String(period).padStart(2, '0')}-01`
    const lastDay = new Date(year, period, 0).getDate()
    endDate = `${year}-${String(period).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } else if (periodType === 'quarterly') {
    const startMonth = (period - 1) * 3 + 1
    const endMonth = period * 3
    startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`
    const lastDay = new Date(year, endMonth, 0).getDate()
    endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } else {
    startDate = `${year}-01-01`
    endDate = `${year}-12-31`
  }

  const { data: lines, error } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, journal_entries!inner(entry_date, status, user_id)')
    .eq('journal_entries.company_id', companyId)
    .in('journal_entries.status', ['posted', 'reversed'])
    .gte('journal_entries.entry_date', startDate)
    .lte('journal_entries.entry_date', endDate)

  if (error) throw new Error(`Database error: ${error.message}`)

  const accountTotals = new Map<string, { debit: number; credit: number }>()
  for (const line of lines ?? []) {
    const acc = line.account_number
    const existing = accountTotals.get(acc) ?? { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    accountTotals.set(acc, existing)
  }

  function creditBalance(acc: string): number {
    const t = accountTotals.get(acc)
    return t ? Math.round((t.credit - t.debit) * 100) / 100 : 0
  }

  function debitBalance(acc: string): number {
    const t = accountTotals.get(acc)
    return t ? Math.round((t.debit - t.credit) * 100) / 100 : 0
  }

  const ruta05 = RUTA_05_ACCOUNTS.reduce((sum, acc) => sum + creditBalance(acc), 0)
  const ruta10 = creditBalance('2611')
  const ruta11 = creditBalance('2621')
  const ruta12 = creditBalance('2631')
  const ruta30 = creditBalance('2614')
  const ruta31 = creditBalance('2624')
  const ruta32 = creditBalance('2634')
  const ruta35 = creditBalance('3108')   // EU intra-community goods supplies (momsfri leverans till EU)
  const ruta39 = creditBalance('3308')
  const ruta40 = creditBalance('3305')
  // Import VAT (since 2015 declared via momsdeklaration, not Tullverket): the
  // importer books output VAT to 2615/2625/2635 (ruta 60/61/62) and the
  // matching deductible input to 2645 (rolls into ruta 48 below).
  const ruta60 = creditBalance('2615')
  const ruta61 = creditBalance('2625')
  const ruta62 = creditBalance('2635')
  const calculatedInput2645 = debitBalance('2645')
  const calculatedInput2647 = debitBalance('2647')
  const ruta48 = debitBalance('2641') + calculatedInput2645 + calculatedInput2647
  const ruta49 = Math.round(
    (ruta10 + ruta11 + ruta12 + ruta30 + ruta31 + ruta32 + ruta60 + ruta61 + ruta62 - ruta48) * 100
  ) / 100

  const monthNames = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
    'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December']

  let periodLabel: string
  if (periodType === 'monthly') periodLabel = `${monthNames[period - 1]} ${year}`
  else if (periodType === 'quarterly') periodLabel = `Q${period} ${year}`
  else periodLabel = `${year}`

  // Pre-filing warnings — surface common compliance footguns.
  //
  // The matching input for reverse-charge output (2614/2624/2634) lands on
  // 2645 (EU acquisitions) or 2647 (domestic reverse charge per ML 16:13 —
  // byggtjänster, electronics > 100k SEK, etc.). Either is a valid mirror;
  // the warning must fire only when *both* are zero.
  const warnings: string[] = []
  const totalReverseChargeOutput = ruta30 + ruta31 + ruta32
  const totalReverseChargeInput = calculatedInput2645 + calculatedInput2647
  if (totalReverseChargeOutput > 0 && totalReverseChargeInput === 0) {
    warnings.push(
      'Omvänd betalningsskyldighet: utgående moms har bokförts (rutor 30/31/32) men ingen ' +
      'beräknad ingående moms (varken 2645 EU eller 2647 inhemsk). Kontrollera att den ' +
      'motsvarande ingående bokningen finns — båda sidor krävs enligt ML 2023:200.'
    )
  }

  return {
    period: { type: periodType, year, period, start: startDate, end: endDate },
    period_label: periodLabel,
    rutor: {
      ruta05: Math.abs(ruta05),
      ruta10: Math.abs(ruta10),
      ruta11: Math.abs(ruta11),
      ruta12: Math.abs(ruta12),
      ruta30: Math.abs(ruta30),
      ruta31: Math.abs(ruta31),
      ruta32: Math.abs(ruta32),
      ruta35: Math.abs(ruta35),
      ruta39: Math.abs(ruta39),
      ruta40: Math.abs(ruta40),
      ruta48: Math.abs(ruta48),
      ruta49,
      ruta60: Math.abs(ruta60),
      ruta61: Math.abs(ruta61),
      ruta62: Math.abs(ruta62),
    },
    summary: ruta49 > 0
      ? `Moms att betala: ${Math.abs(ruta49).toFixed(2)} kr`
      : ruta49 < 0
        ? `Moms att få tillbaka: ${Math.abs(ruta49).toFixed(2)} kr`
        : 'Noll i moms',
    warnings,
  }
}

// ── VAT close check (composes VAT report + blocker scans + sanity ratios) ──
//
// Intent-shaped tool: answers "can I close VAT for this period?" in one call.
// Replaces the 5–7 chained tool calls (vat_report + uncategorized + supplier
// invoices + reconciliation + voucher gaps + prior-period compare) the agent
// would otherwise need to assemble the same answer.

interface VatCloseBlocker {
  kind:
    | 'uncategorized_transactions'
    | 'unapproved_supplier_invoices'
    | 'bank_unreconciled'
    | 'missing_high_value_receipts'
    | 'reverse_charge_input_missing'
  severity: 'high' | 'medium' | 'low'
  count: number
  message: string
  hint: string
}

interface VatCloseSanityAnomaly {
  kind: 'output_vat_ratio_drift' | 'input_vat_ratio_drift' | 'revenue_drop' | 'revenue_spike'
  rate?: '25' | '12' | '6'
  current: number
  previous: number
  delta_pct: number
  message: string
}

interface VatCloseCheckResult {
  period: VatReportResult['period']
  period_label: string
  rutor: VatReportResult['rutor']
  payment: {
    net_due: number
    direction: 'pay' | 'refund' | 'zero'
    deadline: string | null
    deadline_label: string | null
    moms_period: 'monthly' | 'quarterly' | 'yearly' | null
  }
  blockers: VatCloseBlocker[]
  sanity: {
    anomalies: VatCloseSanityAnomaly[]
    ratios: {
      output_vat_ratio_25: number  // ruta10 / domestic 25% revenue
      output_vat_ratio_12: number
      output_vat_ratio_6: number
      previous_period_compared: boolean
    }
  }
  ready_to_close: boolean
  summary: string
}

/** Compute the Skatteverket momsdeklaration deadline for a period.
 *  - monthly: due on the 12th of (period-end-month + 1)
 *  - quarterly: 26th of the month after quarter-end (Q4 → 26 Jan next year)
 *  - yearly: 26 Feb of next year
 */
export function computeMomsDeadline(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number
): { date: string; label: string } | null {
  if (periodType === 'monthly') {
    // period 1-12; deadline = 12th of next month
    const deadlineMonth = period === 12 ? 1 : period + 1
    const deadlineYear = period === 12 ? year + 1 : year
    return {
      date: `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-12`,
      label: `12 ${monthName(deadlineMonth)} ${deadlineYear}`,
    }
  }
  if (periodType === 'quarterly') {
    // Q1→26 apr, Q2→26 jul, Q3→26 okt, Q4→26 jan next year
    const monthByQuarter: Record<number, { m: number; yOffset: number }> = {
      1: { m: 4, yOffset: 0 },
      2: { m: 7, yOffset: 0 },
      3: { m: 10, yOffset: 0 },
      4: { m: 1, yOffset: 1 },
    }
    const cfg = monthByQuarter[period]
    if (!cfg) return null
    return {
      date: `${year + cfg.yOffset}-${String(cfg.m).padStart(2, '0')}-26`,
      label: `26 ${monthName(cfg.m)} ${year + cfg.yOffset}`,
    }
  }
  if (periodType === 'yearly') {
    return {
      date: `${year + 1}-02-26`,
      label: `26 februari ${year + 1}`,
    }
  }
  return null
}

function monthName(m: number): string {
  return ['januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december'][m - 1] ?? ''
}

// ── agent_memory dedup helpers ───────────────────────────────
// Cheap, embedding-free near-duplicate detection for gnubok_remember_fact.
// Lowercase, strip punctuation, drop very short / stop-ish words, and
// compare two memories by Jaccard similarity over their word sets. Good
// enough to catch the agent re-remembering the same fact in slightly
// different words; not a substitute for semantic embeddings, but zero-cost.
const MEMORY_DEDUP_STOPWORDS = new Set([
  'och', 'att', 'det', 'som', 'en', 'ett', 'är', 'för', 'med', 'på', 'av',
  'till', 'den', 'de', 'i', 'om', 'har', 'var', 'kan', 'ska', 'samt',
  'the', 'a', 'an', 'is', 'are', 'for', 'with', 'of', 'to', 'and', 'in',
])

function tokenizeForDedup(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !MEMORY_DEDUP_STOPWORDS.has(t))
  return new Set(tokens)
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

export async function computeVatCloseCheck(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatCloseCheckResult> {
  // 1) VAT report (validates inputs + gives us figures + period dates)
  const vatReport = await computeVatReport(args, companyId, supabase)
  const { start, end, type: periodType, year, period } = vatReport.period

  // 2) Company settings — moms_period drives deadline labelling
  const { data: settings } = await supabase
    .from('company_settings')
    .select('moms_period')
    .eq('company_id', companyId)
    .single()
  const momsPeriod = (settings?.moms_period as 'monthly' | 'quarterly' | 'yearly' | null) ?? null

  // 3) Deadline — based on the *requested* period type, not company setting,
  //    so the model gets the right deadline even when querying ad-hoc periods.
  const deadline = computeMomsDeadline(
    periodType as 'monthly' | 'quarterly' | 'yearly',
    Number(year),
    Number(period)
  )

  // 4) Blocker scans — run in parallel
  const [uncategorizedRes, unapprovedRes, reconRes, missingReceiptsRes] = await Promise.all([
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('date', start).lte('date', end)
      .is('journal_entry_id', null),
    supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'registered')
      .gte('invoice_date', start).lte('invoice_date', end),
    getReconciliationStatus(supabase, companyId, start, end),
    // Missing receipts: posted journal entries in period whose gross amount
    // (sum of debits, equal to sum of credits in a balanced entry) is ≥
    // 4 000 SEK and that have no document_attachments. Scoped to entries
    // originating from bank transactions / supplier invoices / receipts
    // (where a receipt is legally expected) — skips invoice-payment
    // entries, year-end entries, etc.
    //
    // The 4 000 SEK threshold from ML 17 kap 26–28 § (förenklad faktura) is
    // expressed inclusive of moms, so we deliberately compare against the
    // gross. Sum-of-debits equals the gross for ordinary purchase entries
    // (expense + ingående moms + AP/bank). For EU acquisitions and domestic
    // reverse-charge buyer entries the calculated VAT lines inflate the
    // sum, which can pull a sub-threshold purchase above 4 000 — that's a
    // false positive in favour of asking the user for the receipt, which
    // is the safe direction.
    (async () => {
      const { data: candidates } = await supabase
        .from('journal_entries')
        .select(
          'id, source_type, document_attachments(id), journal_entry_lines(debit_amount)'
        )
        .eq('company_id', companyId)
        .in('source_type', ['bank_transaction', 'supplier_invoice', 'receipt'])
        .in('status', ['posted'])
        .gte('entry_date', start).lte('entry_date', end)
      const missing = (candidates ?? []).filter((e) => {
        const lines = (e.journal_entry_lines ?? []) as { debit_amount: number | string }[]
        const gross = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
        const docs = e.document_attachments as unknown[] | null
        return gross >= 4000 && (!docs || docs.length === 0)
      })
      return missing.length
    })(),
  ])

  const blockers: VatCloseBlocker[] = []
  const uncategorizedCount = uncategorizedRes.count ?? 0
  if (uncategorizedCount > 0) {
    blockers.push({
      kind: 'uncategorized_transactions',
      severity: 'high',
      count: uncategorizedCount,
      message: `${uncategorizedCount} okategoriserade banktransaktioner i perioden`,
      hint: 'Kategorisera via gnubok_categorize_transaction eller kör gnubok_auto_match_period.',
    })
  }
  const unapprovedCount = unapprovedRes.count ?? 0
  if (unapprovedCount > 0) {
    blockers.push({
      kind: 'unapproved_supplier_invoices',
      severity: 'high',
      count: unapprovedCount,
      message: `${unapprovedCount} oattesterade leverantörsfakturor i perioden`,
      hint: 'Attestera via gnubok_approve_supplier_invoice — ingående moms (ruta 48) påverkas.',
    })
  }
  if (!reconRes.is_reconciled) {
    blockers.push({
      kind: 'bank_unreconciled',
      severity: Math.abs(reconRes.difference) > 100 ? 'high' : 'medium',
      count: reconRes.unmatched_transaction_count + reconRes.unmatched_gl_line_count,
      message: `Bankavstämning visar differens ${reconRes.difference.toFixed(2)} kr (${reconRes.unmatched_transaction_count} omatchade banktransaktioner, ${reconRes.unmatched_gl_line_count} omatchade huvudbokslinjer på 1930)`,
      hint: 'Granska via gnubok_get_reconciliation_status och matcha — moms beräknas från huvudboken så differenser döljer fel.',
    })
  }
  const missingReceipts = missingReceiptsRes
  if (missingReceipts > 0) {
    blockers.push({
      kind: 'missing_high_value_receipts',
      severity: 'medium',
      count: missingReceipts,
      message: `${missingReceipts} bokföringsposter över 4 000 kr saknar bifogat verifikat`,
      hint: 'BFL 5 kap 6§: varje affärshändelse måste ha verifikat. Använd gnubok_list_unmatched_documents för att para ihop.',
    })
  }
  // Reverse-charge / import sanity: rutor 30/31/32 are the buyer's calculated
  // utgående moms on reverse-charge purchases (domestic byggtjänster &
  // electronics → 2614 → ruta 30; EU acquisitions of goods → 2624 → ruta 31;
  // EU services → 2634 → ruta 32). Rutor 60/61/62 are the importer's
  // calculated utgående moms on non-EU imports declared via momsdeklaration
  // (since 2015 — 2615/2625/2635). All five carry a corresponding ingående
  // moms entry that lands in ruta 48 (2645 utlandet RC, 2647 domestic RC).
  // If any of these output rutor are > 0 but ruta 48 is 0, the buyer/importer
  // booked the output side but forgot the deductible input — ML 2023:200.
  const acquisitionAndImportBase =
    vatReport.rutor.ruta30 +
    vatReport.rutor.ruta31 +
    vatReport.rutor.ruta32 +
    vatReport.rutor.ruta60 +
    vatReport.rutor.ruta61 +
    vatReport.rutor.ruta62
  if (acquisitionAndImportBase > 0 && vatReport.rutor.ruta48 === 0) {
    blockers.push({
      kind: 'reverse_charge_input_missing',
      severity: 'high',
      count: 1,
      message:
        'Omvänd skattskyldighet eller import: utgående moms bokförd (ruta 30/31/32 eller 60/61/62) men ingen ingående moms (ruta 48)',
      hint: 'ML 2023:200: både beräknad utgående moms och avdragsgill ingående moms ska bokföras (2645 utlandet, 2647 inhemskt).',
    })
  }

  // 5) Sanity ratios — current period output VAT to revenue per rate, vs prior period
  const ratios = {
    output_vat_ratio_25: vatReport.rutor.ruta05 > 0
      ? Math.round((vatReport.rutor.ruta10 / vatReport.rutor.ruta05) * 10000) / 100
      : 0,
    output_vat_ratio_12: 0,  // no per-rate revenue split available from VAT report
    output_vat_ratio_6: 0,
    previous_period_compared: false,
  }
  const anomalies: VatCloseSanityAnomaly[] = []

  // Compare to previous same-length period
  const prevArgs = previousPeriodArgs(periodType as 'monthly' | 'quarterly' | 'yearly', Number(year), Number(period))
  if (prevArgs) {
    try {
      const prev = await computeVatReport(prevArgs, companyId, supabase)
      ratios.previous_period_compared = true
      // Output VAT ratio 25% drift
      if (vatReport.rutor.ruta05 > 0 && prev.rutor.ruta05 > 0) {
        const cur = vatReport.rutor.ruta10 / vatReport.rutor.ruta05
        const prv = prev.rutor.ruta10 / prev.rutor.ruta05
        if (prv > 0) {
          const deltaPct = Math.round(((cur - prv) / prv) * 10000) / 100
          if (Math.abs(deltaPct) > 20) {
            anomalies.push({
              kind: 'output_vat_ratio_drift',
              rate: '25',
              current: Math.round(cur * 10000) / 100,
              previous: Math.round(prv * 10000) / 100,
              delta_pct: deltaPct,
              message: `Utgående moms 25% / försäljning ändrades ${deltaPct > 0 ? '+' : ''}${deltaPct}% jämfört med föregående period — kontrollera momssatser`,
            })
          }
        }
      }
      // Revenue spike/drop
      if (prev.rutor.ruta05 > 0) {
        const revDelta = Math.round(((vatReport.rutor.ruta05 - prev.rutor.ruta05) / prev.rutor.ruta05) * 10000) / 100
        if (revDelta < -50) {
          anomalies.push({
            kind: 'revenue_drop',
            current: vatReport.rutor.ruta05,
            previous: prev.rutor.ruta05,
            delta_pct: revDelta,
            message: `Försäljning föll ${revDelta}% — bekräfta att alla fakturor är bokförda`,
          })
        } else if (revDelta > 200) {
          anomalies.push({
            kind: 'revenue_spike',
            current: vatReport.rutor.ruta05,
            previous: prev.rutor.ruta05,
            delta_pct: revDelta,
            message: `Försäljning steg ${revDelta}% — kontrollera att inget bokats två gånger`,
          })
        }
      }
    } catch {
      // Previous period unavailable — skip comparison silently
    }
  }

  const highBlockers = blockers.filter((b) => b.severity === 'high').length
  const readyToClose = highBlockers === 0
  const netDue = vatReport.rutor.ruta49
  const direction: 'pay' | 'refund' | 'zero' = netDue > 0 ? 'pay' : netDue < 0 ? 'refund' : 'zero'

  let summary: string
  if (readyToClose && anomalies.length === 0) {
    summary = `Klart för stängning. ${direction === 'pay' ? `Moms att betala: ${netDue.toFixed(2)} kr` : direction === 'refund' ? `Moms att få tillbaka: ${Math.abs(netDue).toFixed(2)} kr` : 'Noll i moms'}.${deadline ? ` Inlämning senast ${deadline.label}.` : ''}`
  } else if (readyToClose) {
    summary = `Klart för stängning men ${anomalies.length} avvikelse(r) att granska.`
  } else {
    summary = `Inte klart: ${highBlockers} kritiska blockerare.`
  }

  return {
    period: vatReport.period,
    period_label: vatReport.period_label,
    rutor: vatReport.rutor,
    payment: {
      net_due: netDue,
      direction,
      deadline: deadline?.date ?? null,
      deadline_label: deadline?.label ?? null,
      moms_period: momsPeriod,
    },
    blockers,
    sanity: { anomalies, ratios },
    ready_to_close: readyToClose,
    summary,
  }
}

function previousPeriodArgs(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number
): { period_type: string; year: number; period: number } | null {
  if (periodType === 'monthly') {
    if (period === 1) return { period_type: 'monthly', year: year - 1, period: 12 }
    return { period_type: 'monthly', year, period: period - 1 }
  }
  if (periodType === 'quarterly') {
    if (period === 1) return { period_type: 'quarterly', year: year - 1, period: 4 }
    return { period_type: 'quarterly', year, period: period - 1 }
  }
  if (periodType === 'yearly') {
    return { period_type: 'yearly', year: year - 1, period: 1 }
  }
  return null
}

// ── Tools ────────────────────────────────────────────────────

export const tools: McpTool[] = [
  {
    name: 'gnubok_search_tools',
    description: 'Search gnubok MCP tools by keyword and return their schemas at a chosen detail level. Call this first when looking for a capability — avoids loading every tool schema upfront.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords matched against tool name + description (e.g. "vat", "invoice", "categorize"). Empty string returns all tools.' },
        detail: { type: 'string', enum: ['name', 'summary', 'full'], description: 'Detail level. name: just names. summary: name + description + scope (default). full: complete schema including inputSchema and outputSchema.' },
        scope: { type: 'string', description: 'Optional filter: only tools requiring this API key scope (e.g. "invoices:write").' },
        limit: { type: 'number', description: 'Max results, 1–50 (default 20).' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
        total_matched: { type: 'number' },
        detail: { type: 'string' },
      },
      required: ['tools', 'count', 'total_matched', 'detail'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, _companyId, _userId, _supabase, _actor) {
      const query = ((args.query as string) || '').toLowerCase().trim()
      const detail = ((args.detail as string) || 'summary') as 'name' | 'summary' | 'full'
      const scopeFilter = args.scope as string | undefined
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)

      // Filter results to tools the caller is actually authorized to invoke.
      //
      // The dispatcher injects __keyScopes when it routes to gnubok_search_tools.
      // If the marker is missing (refactor regression, direct execute() invocation
      // outside the dispatcher, etc.), FAIL CLOSED — return only unscoped tools
      // rather than leaking the full inventory. The marker presence is also part
      // of the contract: an explicitly-empty array means "no scopes granted",
      // which still hides scoped tools.
      const rawKeyScopes = (args as Record<string, unknown>).__keyScopes
      const callerScopes: string[] = Array.isArray(rawKeyScopes)
        ? (rawKeyScopes as string[])
        : []
      const scopesInjected = Array.isArray(rawKeyScopes)

      let candidates = tools.filter((t) => {
        const required = TOOL_SCOPE_MAP[t.name]
        if (required) {
          // Scoped tool: visible only if scopes were injected AND the caller has it.
          if (!scopesInjected) return false
          if (!callerScopes.includes(required)) return false
        }
        if (scopeFilter && required !== scopeFilter) return false
        return true
      })

      if (query) {
        // Match: every whitespace-separated term must appear in name or description
        // (for a single-word query this is identical to a literal substring match).
        // Rank by relevance so the most on-point tool comes first instead of
        // whichever happens to be defined earliest: exact-ish name match > full
        // query as a name substring > per-term name hits > description hits. Ties
        // fall back to definition order (stable).
        const terms = query.split(/\s+/).filter(Boolean)
        const ranked = candidates
          .map((t, idx) => {
            const name = t.name.toLowerCase()
            const desc = t.description.toLowerCase()
            const hay = `${name} ${desc}`
            if (!terms.every((term) => hay.includes(term))) return null
            let score = 0
            if (name === query || name === `gnubok_${query}` || name.endsWith(`_${query}`)) score += 100
            if (name.includes(query)) score += 40
            for (const term of terms) {
              if (name.includes(term)) score += 10
              if (desc.includes(term)) score += 1
            }
            return { t, score, idx }
          })
          .filter((x): x is { t: McpTool; score: number; idx: number } => x !== null)
          .sort((a, b) => b.score - a.score || a.idx - b.idx)
        candidates = ranked.map((x) => x.t)
      }

      const totalMatched = candidates.length
      const sliced = candidates.slice(0, limit)

      const projected = sliced.map((t) => {
        const requiredScope = TOOL_SCOPE_MAP[t.name] ?? null
        if (detail === 'name') return { name: t.name, scope: requiredScope }
        if (detail === 'full') {
          return {
            name: t.name,
            description: t.description,
            scope: requiredScope,
            inputSchema: t.inputSchema,
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
            annotations: t.annotations,
          }
        }
        // summary (default)
        return { name: t.name, description: t.description, scope: requiredScope }
      })

      return {
        tools: projected,
        count: projected.length,
        total_matched: totalMatched,
        detail,
      }
    },
  },

  {
    name: 'gnubok_list_skills',
    description: 'List available domain-knowledge skills filtered to this company (entity type, VAT, payroll). Workflow guides + loaded specialty atoms. Pass include_all=true to see hidden skills. Call gnubok_load_skill(slug) for any body.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string', description: 'Optional filter by tag (e.g. "vat", "monthly", "yearly", "payroll", or the tier name "workflow"/"horizontal"/"vertical"/"modifier").' },
        tier: {
          type: 'string',
          enum: ['workflow', 'horizontal', 'vertical', 'modifier'],
          description: 'Optional filter by tier. workflow = static guides, horizontal = regulatory atoms (Swedish VAT/payroll/…), vertical = industry atoms (konsult-IT, e-handel…), modifier = cross-cutting atoms (holding-AB…).',
        },
        include_all: {
          type: 'boolean',
          description: 'When true, ignore the company-context filter (entity_type, employees, vat_registered) and return all skills. Default false.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skills: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              name: { type: 'string' },
              summary: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              tier: { type: 'string', enum: ['workflow', 'horizontal', 'vertical', 'modifier'] },
            },
            required: ['slug', 'name', 'summary', 'tier'],
          },
        },
        count: { type: 'number' },
        hidden_count: { type: 'number', description: 'Skills hidden by company-context filter. Re-call with include_all=true to see them.' },
        company_context: {
          type: 'object',
          additionalProperties: false,
          description: 'Snapshot of the filter inputs used to compute the list — useful when debugging "why isn\'t skill X showing up?".',
          properties: {
            entity_type: { type: ['string', 'null'] },
            has_employees: { type: 'boolean' },
            vat_registered: { type: 'boolean' },
          },
        },
      },
      required: ['skills', 'count', 'hidden_count', 'company_context'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const tag = (args.tag as string | undefined)?.toLowerCase().trim()
      const tier = (args.tier as SkillTier | undefined)
      const includeAll = args.include_all === true

      // Resolve company context — read once per call. Failures degrade
      // gracefully: an unresolved field means "don't filter on it" so a
      // misconfigured company still gets the full skill list.
      const [settings, employeeCount] = await Promise.all([
        supabase
          .from('company_settings')
          .select('entity_type, vat_registered')
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('employees')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('is_active', true),
      ])
      const entityType = (settings.data?.entity_type as string | undefined) ?? null
      const vatRegistered = Boolean(settings.data?.vat_registered)
      const hasEmployees = (employeeCount.count ?? 0) > 0

      const all = await loadAllSkills(supabase)

      // First pass: tier + tag filter (unchanged).
      const tagFiltered = all.filter((s) => {
        if (tier && s.tier !== tier) return false
        if (tag && !s.tags.some((t) => t.toLowerCase() === tag)) return false
        return true
      })

      // Second pass: applicability filter — skipped when include_all=true so
      // agents can always escape to the full list. Skills without an
      // applicability declaration are always shown (universal).
      const applicable = includeAll
        ? tagFiltered
        : tagFiltered.filter((s) => {
            if (!s.applicability) return true
            const a = s.applicability
            if (a.entity_type && a.entity_type !== 'both' && entityType && entityType !== a.entity_type) return false
            if (a.requires?.includes('employees') && !hasEmployees) return false
            if (a.requires?.includes('vat_registered') && !vatRegistered) return false
            return true
          })

      return {
        skills: applicable.map((s) => ({
          slug: s.slug,
          name: s.name,
          summary: s.summary,
          tags: s.tags,
          tier: s.tier,
        })),
        count: applicable.length,
        hidden_count: tagFiltered.length - applicable.length,
        company_context: {
          entity_type: entityType,
          has_employees: hasEmployees,
          vat_registered: vatRegistered,
        },
      }
    },
  },

  {
    name: 'gnubok_load_skill',
    description: 'Load a skill body by slug. Workflow slugs are flat (e.g. "month-end-close"); atom slugs match registry ids (e.g. "vertical/konsult-it", "modifier/holding-ab"). Call gnubok_list_skills to find slugs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Skill slug — workflow slug ("month-end-close", "quarterly-vat-review", "year-end-close", "invoicing-rules", "payroll-monthly") or atom id ("vertical/konsult-it", "modifier/holding-ab", "horizontal/swedish-vat", …).' },
      },
      required: ['slug'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string' },
        name: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        tier: { type: 'string', enum: ['workflow', 'horizontal', 'vertical', 'modifier'] },
        body: { type: 'string', description: 'Full skill content as Markdown' },
      },
      required: ['slug', 'name', 'body', 'tier'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const slug = (args.slug as string | undefined)?.trim()
      if (!slug) throw new Error('slug is required')
      const skill = await findSkill(slug, supabase)
      if (!skill) {
        const all = await loadAllSkills(supabase)
        const available = all.map((s) => s.slug).join(', ')
        throw new Error(`Skill not found: "${slug}". Available skills: ${available}`)
      }
      // Workflow-tier skills are the closed-form processes (month-end-close,
      // year-end-close, payroll-monthly). Loading one is a strong signal the
      // agent is starting that workflow — emit so we can track completion
      // rates. Atom skills are reference material and don't trigger this.
      if (skill.tier === 'workflow' && actor) {
        emitWorkflowStarted({ slug: skill.slug, actor, userId, companyId })
      }
      return {
        slug: skill.slug,
        name: skill.name,
        summary: skill.summary,
        tags: skill.tags,
        tier: skill.tier,
        body: skill.body,
      }
    },
  },

  {
    name: 'gnubok_remember_fact',
    description: 'Capture a durable fact, preference, pattern, or correction about the company. Use mid-conversation when the user says something the agent should remember next time. Writes immediately — does not stage. Use sparingly for foundational signal, not for one-off context.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: {
          type: 'string',
          description: 'The full fact text in the user\'s language. Self-contained — readable without prior context. Example: "Företaget hyr lagerplats av AB Foo, hyresfaktura kommer 25:e varje månad."',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'pattern', 'correction'],
          description: 'fact = verifiable statement, preference = user-stated choice, pattern = observed regularity, correction = agent learned from a user fix. Default fact.',
        },
        source_ref: {
          type: 'string',
          description: 'Optional pointer to where this fact came from (e.g. "conversation:<uuid>:turn-3").',
        },
        relevance_score: {
          type: 'number',
          description: 'How important this memory is for future prompts. 0.0–1.0. Default 0.8 for agent-captured facts.',
        },
      },
      required: ['content'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        content: { type: 'string' },
        created_at: { type: 'string' },
      },
      required: ['id', 'kind', 'content', 'created_at'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const content = (args.content as string | undefined)?.trim()
      if (!content || content.length < 2) throw new Error('content is required (min 2 chars)')
      const kind = (args.kind as string | undefined) ?? 'fact'
      if (!['fact', 'preference', 'pattern', 'correction'].includes(kind)) {
        throw new Error(`invalid kind: ${kind}`)
      }
      const rawScore = args.relevance_score
      const score =
        typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 1 ? rawScore : 0.8

      // Dedup guard: the agent re-remembers the same fact constantly (e.g.
      // "Vercel = omvänd skattskyldighet" on every Vercel categorization).
      // Before inserting, compare against existing active memories by
      // word-set Jaccard similarity. A near-duplicate (≥0.82) is treated as
      // already-known: we touch its updated_at + nudge relevance instead of
      // writing a new row, so agent_memory doesn't fill with paraphrases.
      // Bounded to the 300 most-recent active rows — dedup-on-write keeps
      // the working set small enough that this stays cheap.
      const { data: existing } = await supabase
        .from('agent_memory')
        .select('id, kind, content, created_at, relevance_score')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(300)

      const incomingTokens = tokenizeForDedup(content)
      const dupe = (existing ?? []).find(
        (m: { content: string }) =>
          jaccardSimilarity(incomingTokens, tokenizeForDedup(m.content)) >= 0.82,
      ) as { id: string; kind: string; content: string; created_at: string; relevance_score: number } | undefined

      if (dupe) {
        // Already known. Bump relevance toward the new score (max) and
        // refresh updated_at so recency-ordered recall still surfaces it.
        await supabase
          .from('agent_memory')
          .update({
            relevance_score: Math.max(dupe.relevance_score ?? 0, score),
            updated_at: new Date().toISOString(),
          })
          .eq('id', dupe.id)
        return {
          id: dupe.id,
          kind: dupe.kind,
          content: dupe.content,
          created_at: dupe.created_at,
        }
      }

      const { data, error } = await supabase
        .from('agent_memory')
        .insert({
          company_id: companyId,
          kind,
          content,
          source: 'agent_learned',
          source_ref: (args.source_ref as string | undefined) ?? null,
          relevance_score: score,
          is_active: true,
          created_by_user_id: userId,
        })
        .select('id, kind, content, created_at')
        .single()
      if (error) throw new Error(`Failed to remember fact: ${error.message}`)
      return data
    },
  },

  {
    name: 'gnubok_forget_fact',
    description: 'Deactivate a memory entry by id. Use when the user explicitly asks to forget something or supersedes it. The row is kept for audit (is_active=false) but no longer surfaces in prompts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The memory entry id from a prior gnubok_remember_fact call.' },
        reason: { type: 'string', description: 'Optional short note about why this is being forgotten (for audit).' },
      },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        is_active: { type: 'boolean' },
      },
      required: ['id', 'is_active'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const id = (args.id as string | undefined)?.trim()
      if (!id) throw new Error('id is required')
      const { data, error } = await supabase
        .from('agent_memory')
        .update({ is_active: false })
        .eq('id', id)
        .eq('company_id', companyId)
        .select('id, is_active')
        .single()
      if (error) throw new Error(`Failed to forget fact: ${error.message}`)
      return data
    },
  },

  {
    name: 'gnubok_feedback',
    description: 'Report agent-side feedback: missing tool, wrong description, skill gap, or a positive signal. Goes to event_log for product-team triage. Rate-limited 1/min/key.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        context: {
          type: 'string',
          description: 'What you were trying to do and what blocked you — or what worked well. Free text, max 2000 chars.',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral'],
          description: 'Direction of the feedback. Default: negative.',
        },
        suggestion: {
          type: 'string',
          description: 'Optional concrete suggestion (e.g. "add a tool for X", "rename Y arg").',
        },
        tool_name: {
          type: 'string',
          description: 'Optional specific tool the feedback concerns.',
        },
        skill_slug: {
          type: 'string',
          description: 'Optional specific skill the feedback concerns.',
        },
      },
      required: ['context'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recorded: { type: 'boolean' },
        message: { type: 'string' },
      },
      required: ['recorded', 'message'],
    },
    annotations: {
      // Not read-only: this writes a telemetry event to the bus and mutates the
      // in-process rate-limit map. readOnlyHint is about side effects, not whether
      // business state changes — so it must be false even though no ledger is touched.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, _supabase, actor) {
      const context = (args.context as string | undefined)?.trim()
      if (!context) throw new Error('context is required')
      if (context.length > 2000) throw new Error('context is too long (max 2000 chars)')

      const sentiment = ((args.sentiment as string | undefined) ?? 'negative') as 'positive' | 'negative' | 'neutral'
      const suggestion = (args.suggestion as string | undefined)?.trim() || null
      const toolName = (args.tool_name as string | undefined)?.trim() || null
      const skillSlug = (args.skill_slug as string | undefined)?.trim() || null

      // Rate-limit per API key (or per user when no key id). 1 per 60 s.
      // In-memory + single-process — leaky bucket would be cleaner but the
      // signal here is product-team triage, not security; over-counting is
      // fine, occasional under-counting is fine.
      const rateKey = actor?.id ?? userId
      const now = Date.now()
      const last = feedbackRateLimit.get(rateKey)
      if (last && now - last < FEEDBACK_RATE_LIMIT_MS) {
        const waitSec = Math.ceil((FEEDBACK_RATE_LIMIT_MS - (now - last)) / 1000)
        throw new Error(`gnubok_feedback is rate-limited. Try again in ${waitSec}s.`)
      }
      feedbackRateLimit.set(rateKey, now)

      void eventBus
        .emit({
          type: 'agent.feedback',
          payload: {
            context,
            sentiment,
            suggestion,
            toolName,
            skillSlug,
            sessionId: actor?.sessionId ?? null,
            actorType: actor?.type ?? 'api_key',
            actorId: actor?.id ?? null,
            actorLabel: actor?.label ?? null,
            userId,
            companyId,
          },
        })
        .catch((err) => console.error('[mcp] agent.feedback emit failed:', err))

      return {
        recorded: true,
        message: 'Thanks — feedback queued for product-team review. We aggregate signal weekly.',
      }
    },
  },

  {
    name: 'gnubok_get_agent_briefing',
    description: 'Bootstrap this company\'s specialized accountant context in one call: profile_summary, the atoms loaded for the company (metadata only — call gnubok_load_skill for bodies), and the top-30 active memories. Call once at session start.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile_summary: {
          type: ['string', 'null'],
          description: 'Composer-generated one-paragraph summary of the company. Null if no agent profile exists yet (composer has not run).',
        },
        atoms: {
          type: 'array',
          description: 'Atoms (horizontal/vertical/modifier skills) loaded for this company. Metadata only — call gnubok_load_skill(id) for the body.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Atom id (e.g. "horizontal/swedish-vat", "vertical/konsult-it", "modifier/holding-ab"). Use as gnubok_load_skill slug.' },
              tier: { type: 'string', enum: ['horizontal', 'vertical', 'modifier'] },
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['id', 'tier', 'title', 'description'],
          },
        },
        memory: {
          type: 'array',
          description: 'Top-30 active memories (facts, preferences, patterns, corrections) ranked by relevance and recency.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              kind: { type: 'string', enum: ['fact', 'preference', 'pattern', 'correction'] },
              content: { type: 'string' },
              relevance_score: { type: ['number', 'null'] },
            },
            required: ['id', 'kind', 'content'],
          },
        },
      },
      required: ['profile_summary', 'atoms', 'memory'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, _userId, supabase) {
      const [profileRes, memoryRes] = await Promise.all([
        supabase
          .from('agent_profiles')
          .select('profile_summary, horizontal_atoms, vertical_atoms, modifier_atoms')
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('agent_memory')
          .select('id, kind, content, relevance_score')
          .eq('company_id', companyId)
          .eq('is_active', true)
          .order('relevance_score', { ascending: false, nullsFirst: false })
          .order('last_accessed_at', { ascending: false, nullsFirst: false })
          .limit(30),
      ])

      if (profileRes.error) throw new Error(`Failed to load agent profile: ${profileRes.error.message}`)
      if (memoryRes.error) throw new Error(`Failed to load agent memory: ${memoryRes.error.message}`)

      const profile = profileRes.data as
        | {
            profile_summary: string | null
            horizontal_atoms: string[] | null
            vertical_atoms: string[] | null
            modifier_atoms: string[] | null
          }
        | null
      const memoryRows = (memoryRes.data ?? []) as Array<{
        id: string
        kind: string
        content: string
        relevance_score: number | null
      }>

      const atomIds = [
        ...(profile?.horizontal_atoms ?? []),
        ...(profile?.vertical_atoms ?? []),
        ...(profile?.modifier_atoms ?? []),
      ]

      let atoms: Array<{ id: string; tier: string; title: string; description: string }> = []
      if (atomIds.length > 0) {
        const { data: atomRows, error: atomErr } = await supabase
          .from('agent_atom_registry')
          .select('id, tier, title, description')
          .in('id', atomIds)
          .eq('is_active', true)
        if (atomErr) throw new Error(`Failed to load atom metadata: ${atomErr.message}`)
        atoms = ((atomRows ?? []) as Array<{
          id: string
          tier: string
          title: string | null
          description: string
        }>).map((r) => ({
          id: r.id,
          tier: r.tier,
          title: r.title ?? r.id,
          description: r.description,
        }))
      }

      return {
        profile_summary: profile?.profile_summary ?? null,
        atoms,
        memory: memoryRows.map((m) => ({
          id: m.id,
          kind: m.kind,
          content: m.content,
          relevance_score: m.relevance_score,
        })),
      }
    },
  },

  {
    name: 'gnubok_create_transactions',
    description: 'Stage one or more transactions for the user to approve. Each item creates a separate pending operation; commit each via gnubok_approve_pending_operation when the user authorises. Useful for ingesting rows from external sources (Airtable, CSVs, etc.). Max 10 per call.',
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staged_count: { type: 'number', description: 'Number of items successfully staged.' },
        operations: {
          type: 'array',
          items: STAGED_OPERATION_SCHEMA,
          description: 'One staged-operation result per input item, in the same order.',
        },
      },
      required: ['staged_count', 'operations'],
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transactions: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: 'Up to 10 transactions to stage. Each becomes its own pending operation.',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Transaction date (YYYY-MM-DD).' },
              amount: { type: 'number', description: 'Positive = income, negative = expense.' },
              description: { type: 'string', description: 'Free-text description shown in /transactions.' },
              currency: { type: 'string', description: 'ISO 4217 code. Default SEK.' },
              bank_connection_id: { type: 'string', description: 'Optional UUID of a bank_connections row to associate with.' },
              external_id: { type: 'string', description: 'Optional external reference (e.g., Airtable record ID). Shown in the preview; the DB enforces uniqueness per user, so the second commit of the same external_id will fail at approval.' },
            },
            required: ['date', 'amount', 'description'],
          },
        },
      },
      required: ['transactions'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const items = args.transactions as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('transactions must be a non-empty array.')
      }
      if (items.length > 10) {
        throw new Error('transactions exceeds the per-call limit of 10. Split into multiple calls.')
      }

      const operations = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const date = item.date as string
        const amount = Number(item.amount)
        const description = ((item.description as string) ?? '').trim()
        const currency = ((item.currency as string) || 'SEK').toUpperCase()
        const bankConnectionId = (item.bank_connection_id as string) || null
        const externalId = (item.external_id as string) || null

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error(`transactions[${i}].date must be in YYYY-MM-DD format.`)
        }
        if (!Number.isFinite(amount)) {
          throw new Error(`transactions[${i}].amount must be a finite number.`)
        }
        if (!description) {
          throw new Error(`transactions[${i}].description is required.`)
        }

        const params = {
          date,
          amount,
          description,
          currency,
          bank_connection_id: bankConnectionId,
          external_id: externalId,
        }

        const sign = amount >= 0 ? '+' : ''
        const titleSuffix = externalId ? ` [${externalId}]` : ''
        const title = `Ny transaktion: ${description} ${sign}${amount} ${currency}${titleSuffix}`

        const staged = await stagePendingOperation(
          supabase, companyId, userId, 'create_transaction',
          title,
          params,
          params, // params ARE the preview
          actor,
          {
            description: 'Once approved, the transaction lands in /transactions as uncategorized. Use gnubok_categorize_transaction to book it.',
            tool: 'gnubok_categorize_transaction',
          },
          { dateForPeriodCheck: date },
        )

        operations.push(staged)
      }

      return {
        staged_count: operations.length,
        operations,
      }
    },
  },

  {
    name: 'gnubok_list_uncategorized_transactions',
    description: 'List bank transactions with no journal entry yet, newest first. Paginated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results to return, 1–100 (default 20)' },
        offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
      },
    },
    outputSchema: paginatedSchema('transactions', {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        date: { type: 'string' },
        description: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        merchant_name: { type: 'string' },
        reference: { type: 'string' },
        is_business: { type: 'boolean' },
        category: { type: 'string' },
      },
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
      const offset = Math.max(0, Number(args.offset) || 0)

      // Get total count
      const { count: totalCount, error: countError } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('journal_entry_id', null)

      if (countError) throw new Error(`Database error: ${countError.message}`)

      const { data, error } = await supabase
        .from('transactions')
        .select(
          'id, date, description, amount, currency, merchant_name, reference, is_business, category'
        )
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .order('date', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw new Error(`Database error: ${error.message}`)

      const total = totalCount ?? 0
      const hasMore = total > offset + (data?.length ?? 0)

      return {
        transactions: data,
        count: data?.length ?? 0,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + (data?.length ?? 0) } : {}),
      }
    },
  },

  {
    name: 'gnubok_list_transactions_without_documents',
    description: 'List BANK TRANSACTIONS booked without an attached underlag. For imported/manual verifikat (no bank tx row) call gnubok_list_verifikat_without_documents — this tool only covers bank-driven entries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results to return, 1–100 (default 20)' },
        offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
        since: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Only return transactions on or after this date.' },
      },
    },
    outputSchema: paginatedSchema('transactions', {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        date: { type: 'string' },
        description: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        merchant_name: { type: 'string' },
        reference: { type: 'string' },
        is_business: { type: 'boolean' },
        category: { type: 'string' },
        journal_entry_id: { type: 'string' },
      },
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
      const offset = Math.max(0, Number(args.offset) || 0)
      const since = typeof args.since === 'string' ? args.since : null

      let countQuery = supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .not('journal_entry_id', 'is', null)
        .is('document_id', null)
      if (since) countQuery = countQuery.gte('date', since)

      const { count: totalCount, error: countError } = await countQuery
      if (countError) throw new Error(`Database error: ${countError.message}`)

      let dataQuery = supabase
        .from('transactions')
        .select(
          'id, date, description, amount, currency, merchant_name, reference, is_business, category, journal_entry_id'
        )
        .eq('company_id', companyId)
        .not('journal_entry_id', 'is', null)
        .is('document_id', null)
      if (since) dataQuery = dataQuery.gte('date', since)

      const { data, error } = await dataQuery
        .order('date', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw new Error(`Database error: ${error.message}`)

      const total = totalCount ?? 0
      const hasMore = total > offset + (data?.length ?? 0)

      return {
        transactions: data,
        count: data?.length ?? 0,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + (data?.length ?? 0) } : {}),
      }
    },
  },

  {
    name: 'gnubok_list_verifikat_without_documents',
    description: 'List POSTED journal entries (verifikat) that have no document_attachments row. Covers SIE-imported, manual and salary vouchers that the transactions-based tool misses. Newest first, paginated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results to return, 1–100 (default 20)' },
        offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
        since: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Only return entries on or after this date.' },
        min_amount: { type: 'number', description: 'Optional minimum gross amount (sum of debits) to filter low-value entries. Default 0.' },
      },
    },
    outputSchema: paginatedSchema('verifikat', {
      type: 'object',
      additionalProperties: false,
      properties: {
        journal_entry_id: { type: 'string' },
        voucher_series: { type: 'string' },
        voucher_number: { type: 'number' },
        entry_date: { type: 'string' },
        description: { type: 'string' },
        source_type: { type: 'string' },
        gross_amount: { type: 'number' },
      },
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
      const offset = Math.max(0, Number(args.offset) || 0)
      const since = typeof args.since === 'string' ? args.since : null
      const minAmount = typeof args.min_amount === 'number' && Number.isFinite(args.min_amount)
        ? args.min_amount
        : 0

      // PostgREST left-join filter: journal_entries left-joined to
      // document_attachments and filtered to rows where the join produced
      // no document. The filter syntax `document_attachments.id=is.null`
      // applies the predicate post-join (Supabase: foreign-table is-null).
      let query = supabase
        .from('journal_entries')
        .select(
          'id, voucher_series, voucher_number, entry_date, description, source_type, document_attachments!left(id), journal_entry_lines(debit_amount)',
          { count: 'exact' },
        )
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .is('document_attachments.id', null)
      if (since) query = query.gte('entry_date', since)

      const { data, error, count } = await query
        .order('entry_date', { ascending: false })
        .order('voucher_number', { ascending: false })
        .range(offset, offset + limit - 1)
      if (error) throw new Error(`Database error: ${error.message}`)

      const rows = ((data ?? []) as Array<{
        id: string
        voucher_series: string
        voucher_number: number
        entry_date: string
        description: string
        source_type: string
        journal_entry_lines: { debit_amount: number | string }[] | null
      }>).map((e) => {
        const lines = e.journal_entry_lines ?? []
        const gross = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
        return {
          journal_entry_id: e.id,
          voucher_series: e.voucher_series,
          voucher_number: e.voucher_number,
          entry_date: e.entry_date,
          description: e.description,
          source_type: e.source_type,
          gross_amount: Math.round(gross * 100) / 100,
        }
      })

      const filtered = minAmount > 0 ? rows.filter((r) => r.gross_amount >= minAmount) : rows

      const total = count ?? 0
      const hasMore = total > offset + filtered.length
      return {
        verifikat: filtered,
        count: filtered.length,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + filtered.length } : {}),
      }
    },
  },

  {
    name: 'gnubok_categorize_transaction',
    description: 'Categorize a bank transaction. Stages the journal entry; commit via gnubok_approve_pending_operation when the user authorises. If the row has an attached underlag, the tool reads its extracted_data and rejects vat_treatment="reverse_charge" when the seller already charged VAT.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string', description: 'UUID of the transaction to categorize' },
        category: { type: 'string', description: 'Transaction category', enum: [...VALID_CATEGORIES] },
        vat_treatment: { type: 'string', description: 'VAT treatment override. Defaults to standard_25 for business expenses. Set reverse_charge ONLY when the underlag confirms the seller did NOT charge VAT (omvänd skattskyldighet). An invoice with foreign VAT already debited is NOT reverse charge.', enum: [...VALID_VAT_TREATMENTS] },
        notes: { type: 'string', description: 'Audit-trail context appended to the verifikation description. For category=representation use this to record deltagare + syfte ("Anna Andersson (Acme AB), kundmöte om Y"). For project work, include the project ref. Keep under 200 chars; pure metadata, not a re-description of the transaction.' },
      },
      required: ['transaction_id', 'category'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      // Compute the preview (accounts, amounts, VAT lines)
      const result = await categorizeTransactionCore(
        args.transaction_id as string,
        args.category as TransactionCategory,
        args.vat_treatment as VatTreatment | undefined,
        userId,
        companyId,
        supabase,
        false // preview mode — execution happens at approval time via gnubok_approve_pending_operation
      )

      // If already has a journal entry, pass through as-is
      if (result.success && result.journal_entry_created === false) {
        const { transaction: _tx, ...publicResult } = result
        return publicResult
      }

      // Fetch transaction description (and date for period_status) for the title
      const { data: tx } = await supabase
        .from('transactions')
        .select('description, merchant_name, amount, currency, date')
        .eq('id', args.transaction_id as string)
        .eq('company_id', companyId)
        .single()

      const txDesc = tx
        ? `${tx.merchant_name || tx.description || 'Transaktion'} ${tx.amount} ${tx.currency}`
        : String(args.transaction_id)

      // Stage for user approval
      return stagePendingOperation(supabase, companyId, userId, 'categorize_transaction',
        `Kategorisera: ${txDesc}`,
        {
          transaction_id: args.transaction_id,
          category: args.category,
          vat_treatment: args.vat_treatment || null,
          notes: typeof args.notes === 'string' && args.notes.trim().length > 0
            ? (args.notes as string).trim()
            : null,
        },
        {
          debit_account: result.debit_account,
          credit_account: result.credit_account,
          amount: result.amount,
          currency: result.currency,
          vat_lines: result.vat_lines || [],
          category: result.category,
          underlag: result.underlag ?? null,
        },
        actor,
        {
          description: 'Once approved, the journal entry is posted. Continue with gnubok_list_uncategorized_transactions to keep clearing the backlog, or lock the period once it is empty.',
          tool: 'gnubok_list_uncategorized_transactions',
        },
        tx?.date ? { dateForPeriodCheck: tx.date } : {},
      )
    },
  },

  // ── Receipt matcher tool ──────────────────────────────────────

  {
    name: 'gnubok_receipt_matcher',
    description: 'Open an interactive widget for drag-and-drop receipt-to-transaction matching. Renders inline in compatible clients.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max transactions to show, 1–50 (default 20)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transactions: { type: 'array', items: { type: 'object' } },
        categories: { type: 'array', items: { type: 'string' } },
        vat_treatments: { type: 'array', items: { type: 'string' } },
      },
      required: ['transactions', 'categories', 'vat_treatments'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: 'ui://receipt-matcher/app.html' } },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)

      const { data, error } = await supabase
        .from('transactions')
        .select(
          'id, date, description, amount, currency, merchant_name, reference, is_business, category'
        )
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .order('date', { ascending: false })
        .limit(limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      return {
        transactions: data ?? [],
        categories: [...VALID_CATEGORIES],
        vat_treatments: [...VALID_VAT_TREATMENTS],
      }
    },
  },

  // ── Customer tools ───────────────────────────────────────────

  {
    name: 'gnubok_list_customers',
    description: 'List all customers for the active company. Use to look up customer_id for invoice creation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customers: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['customers', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      const { data, error } = await supabase
        .from('customers')
        .select('id, name, customer_type, email, org_number, vat_number, default_payment_terms, city, country')
        .eq('company_id', companyId)
        .order('name')

      if (error) throw new Error(`Database error: ${error.message}`)

      return { customers: data, count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_customer',
    description: 'Stage a new customer. Stages for user approval — NOT created until approved in the web app. EU VAT numbers trigger VIES validation.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Customer name' },
        customer_type: {
          type: 'string',
          enum: ['individual', 'swedish_business', 'eu_business', 'non_eu_business'],
          description: 'Customer type',
        },
        email: { type: 'string', description: 'Email address' },
        org_number: { type: 'string', description: 'Swedish org number' },
        vat_number: { type: 'string', description: 'EU VAT number' },
        payment_terms: { type: 'number', description: 'Payment terms in days (default 30)' },
        address: { type: 'string', description: 'Street address' },
        postal_code: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string', description: 'Country (default Sweden)' },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate inputs and return the would-be preview without staging or creating. No DB writes, no side-effects.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Random per-operation UUID. Repeat calls with the same key + same payload return the original response (24h TTL). Different payload → IDEMPOTENCY_KEY_REUSE error.',
        },
      },
      required: ['name', 'customer_type'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true, // safe to retry with idempotency_key
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const name = args.name as string
      const customerType = args.customer_type as string

      if (!name?.trim()) throw new Error('Customer name is required.')
      if (!['individual', 'swedish_business', 'eu_business', 'non_eu_business'].includes(customerType)) {
        throw new Error('Invalid customer_type. Must be: individual, swedish_business, eu_business, non_eu_business')
      }

      const params = {
        name: name.trim(),
        customer_type: customerType,
        email: (args.email as string) || null,
        org_number: (args.org_number as string) || null,
        vat_number: (args.vat_number as string) || null,
        payment_terms: Number(args.payment_terms) || 30,
        address: (args.address as string) || null,
        postal_code: (args.postal_code as string) || null,
        city: (args.city as string) || null,
        country: (args.country as string) || 'Sweden',
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_customer',
        `Ny kund: ${params.name}`,
        params,
        params, // params ARE the preview for customers
        actor,
        {
          description: 'Once approved, you can invoice this customer with gnubok_create_invoice using the returned customer_id.',
          tool: 'gnubok_create_invoice',
        },
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  // ── Invoice tools ────────────────────────────────────────────

  {
    name: 'gnubok_list_invoices',
    description: 'List invoices for the active company, newest first. Optional status filter.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited'],
          description: 'Filter by invoice status',
        },
        limit: { type: 'number', description: 'Max results (default 50, max 100)' },
      },
    },
    outputSchema: paginatedSchema('invoices', { type: 'object' }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 100)
      const status = args.status as string | undefined

      let query = supabase
        .from('invoices')
        .select('id, invoice_number, status, customer_id, total, currency, invoice_date, due_date, document_type, customers(name)', { count: 'exact' })
        .eq('company_id', companyId)

      if (status) {
        query = query.eq('status', status)
      }

      const { data, error, count } = await query
        .order('invoice_date', { ascending: false })
        .limit(limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      const invoices = (data ?? []).map((inv: Record<string, unknown>) => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        status: inv.status,
        customer_name: (inv.customers as Record<string, unknown>)?.name ?? null,
        total: inv.total,
        currency: inv.currency,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        document_type: inv.document_type,
      }))

      return {
        invoices,
        count: invoices.length,
        total_count: count ?? invoices.length,
      }
    },
  },

  {
    name: 'gnubok_create_invoice',
    description: 'Stage a new invoice. Validates inputs, calculates VAT preview. Stages for user approval — invoice number assigned at approval.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'st, tim, dag, mån' },
              unit_price: { type: 'number', description: 'Price per unit excl. VAT' },
              vat_rate: { type: 'number', description: 'VAT rate 0–100 (optional override)' },
            },
            required: ['description', 'quantity', 'unit', 'unit_price'],
          },
          description: 'Invoice line items',
        },
        invoice_date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (default from payment terms)' },
        currency: { type: 'string', enum: ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] },
        our_reference: { type: 'string' },
        your_reference: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['customer_id', 'items'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const customerId = args.customer_id as string
      const items = args.items as Array<{
        description: string
        quantity: number
        unit: string
        unit_price: number
        vat_rate?: number
      }>

      if (!customerId) throw new Error('customer_id is required. Use gnubok_list_customers to find IDs.')
      if (!items?.length) throw new Error('At least one item is required.')

      for (const [i, item] of items.entries()) {
        if (!item.description?.trim()) throw new Error(`Item ${i + 1}: description is required`)
        if (!item.quantity || item.quantity <= 0) throw new Error(`Item ${i + 1}: quantity must be positive`)
        if (!item.unit?.trim()) throw new Error(`Item ${i + 1}: unit is required (st, tim, dag)`)
        if (item.unit_price == null) throw new Error(`Item ${i + 1}: unit_price is required`)
      }

      const today = new Date().toISOString().split('T')[0]
      const currency = ((args.currency as string) || 'SEK') as Currency
      const invoiceDate = (args.invoice_date as string) || today

      // Fetch customer (full row for VAT rules)
      const { data: customer, error: custError } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId)
        .eq('company_id', companyId)
        .single()

      if (custError || !customer) {
        throw new Error('Customer not found. Use gnubok_list_customers to find valid IDs.')
      }

      // VAT rules from customer type (same logic as web UI)
      const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
      const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
      const allowedRates = new Set(availableRates.map((r) => r.rate))

      // Calculate per-item VAT
      const subtotal = items.reduce((s, item) => s + item.quantity * item.unit_price, 0)
      let vatAmount = 0
      for (const item of items) {
        const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
        if (!allowedRates.has(itemRate)) {
          throw new Error(
            `VAT rate ${itemRate}% is not allowed for customer type "${customer.customer_type}". ` +
            `Allowed rates: ${availableRates.map((r) => r.rate + '%').join(', ')}`
          )
        }
        const lineTotal = item.quantity * item.unit_price
        vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
      }
      const total = subtotal + vatAmount

      // Due date from payment terms if not provided
      let dueDate = args.due_date as string | undefined
      if (!dueDate) {
        const d = new Date(invoiceDate)
        d.setDate(d.getDate() + (customer.default_payment_terms || 30))
        dueDate = d.toISOString().split('T')[0]
      }

      // Stage for user approval instead of creating directly
      return stagePendingOperation(supabase, companyId, userId, 'create_invoice',
        `Ny faktura: ${customer.name} ${Math.round(total * 100) / 100} ${currency}`,
        {
          customer_id: customerId,
          items,
          invoice_date: invoiceDate,
          due_date: dueDate,
          currency,
          our_reference: (args.our_reference as string) || null,
          your_reference: (args.your_reference as string) || null,
          notes: (args.notes as string) || null,
        },
        {
          customer_name: customer.name,
          customer_type: customer.customer_type,
          items: items.map(item => ({
            ...item,
            line_total: item.quantity * item.unit_price,
            vat_rate: item.vat_rate ?? vatRules.rate,
          })),
          subtotal: Math.round(subtotal * 100) / 100,
          vat_amount: Math.round(vatAmount * 100) / 100,
          total: Math.round(total * 100) / 100,
          currency,
          vat_treatment: vatRules.treatment,
          invoice_date: invoiceDate,
          due_date: dueDate,
        },
        actor,
        {
          description: 'Once approved, the invoice is created as a draft. Send it with gnubok_send_invoice or use gnubok_mark_invoice_as_sent if delivered outside the system.',
          tool: 'gnubok_send_invoice',
        }
      )
    },
  },

  // ── Report tools ─────────────────────────────────────────────

  {
    name: 'gnubok_get_trial_balance',
    description: 'Trial balance (huvudbok) for a fiscal period — all account balances with debit/credit totals. Defaults to most recent period.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: { type: 'array', items: { type: 'object' } },
        total_debit: { type: 'number' },
        total_credit: { type: 'number' },
        is_balanced: { type: 'boolean' },
        period_name: { type: 'string' },
        period_start: { type: 'string' },
        period_end: { type: 'string' },
        account_count: { type: 'number' },
      },
      required: ['rows', 'total_debit', 'total_credit', 'is_balanced'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      // If no period specified, find the most recent one
      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id, name')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first to auto-create a period.')
        }
        periodId = periods.id
      }

      // Get period info
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      // Aggregate journal entry lines
      const { data: lines, error } = await supabase
        .from('journal_entry_lines')
        .select('account_number, debit_amount, credit_amount, journal_entries!inner(status, user_id, fiscal_period_id)')
        .eq('journal_entries.company_id', companyId)
        .eq('journal_entries.fiscal_period_id', periodId)
        .in('journal_entries.status', ['posted', 'reversed'])

      if (error) throw new Error(`Database error: ${error.message}`)

      // Get account names
      const { data: accounts } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('company_id', companyId)

      const accountMap = new Map((accounts ?? []).map((a: { account_number: string; account_name: string }) => [a.account_number, a.account_name]))

      // Aggregate by account
      const totals = new Map<string, { debit: number; credit: number }>()
      for (const line of lines ?? []) {
        const acc = line.account_number
        const existing = totals.get(acc) ?? { debit: 0, credit: 0 }
        existing.debit += Number(line.debit_amount) || 0
        existing.credit += Number(line.credit_amount) || 0
        totals.set(acc, existing)
      }

      const rows = Array.from(totals.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([accNum, t]) => {
          const net = Math.round((t.debit - t.credit) * 100) / 100
          return {
            account_number: accNum,
            account_name: accountMap.get(accNum) ?? accNum,
            period_debit: Math.round(t.debit * 100) / 100,
            period_credit: Math.round(t.credit * 100) / 100,
            closing_debit: net > 0 ? net : 0,
            closing_credit: net < 0 ? Math.abs(net) : 0,
          }
        })

      const totalDebit = Math.round(rows.reduce((s, r) => s + r.closing_debit, 0) * 100) / 100
      const totalCredit = Math.round(rows.reduce((s, r) => s + r.closing_credit, 0) * 100) / 100

      return {
        rows,
        total_debit: totalDebit,
        total_credit: totalCredit,
        is_balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        period_name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        account_count: rows.length,
      }
    },
  },

  {
    name: 'gnubok_get_vat_report',
    description: 'VAT declaration (momsdeklaration, SKV 4700) for a period. Returns all rutor; ruta49 = VAT to pay (positive) or refund (negative). Pass render_ui=true to also open the review widget (claude.ai / Desktop).',
    outputSchema: VAT_REPORT_OUTPUT_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_type: {
          type: 'string',
          enum: ['monthly', 'quarterly', 'yearly'],
          description: 'Period type',
        },
        year: { type: 'number', description: 'Year (e.g. 2025)' },
        period: { type: 'number', description: '1–12 for monthly, 1–4 for quarterly, 1 for yearly' },
        render_ui: {
          type: 'boolean',
          description: 'When true, also render the interactive momsdeklaration review widget (claude.ai / Claude Desktop). The structured rutor are returned either way. Default false.',
        },
      },
      required: ['period_type', 'year', 'period'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Renders the VAT widget only when the caller passes render_ui=true (the
    // dispatcher emits result-level _meta in that case). This is the merged
    // report+widget surface; gnubok_vat_review_widget remains as an alias.
    uiResourceUri: 'ui://vat-review/app.html',
    async execute(args, companyId, _userId, supabase) {
      return computeVatReport(args, companyId, supabase)
    },
  },

  {
    name: 'gnubok_vat_review_widget',
    description: 'Open the interactive VAT review widget for a period. Equivalent to gnubok_get_vat_report(render_ui=true); kept as an alias for clients pinned to this tool name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_type: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'], description: 'Period type' },
        year: { type: 'number', description: 'Year (e.g. 2025)' },
        period: { type: 'number', description: '1–12 for monthly, 1–4 for quarterly, 1 for yearly' },
      },
      required: ['period_type', 'year', 'period'],
    },
    outputSchema: VAT_REPORT_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: 'ui://vat-review/app.html' } },
    async execute(args, companyId, _userId, supabase) {
      return computeVatReport(args, companyId, supabase)
    },
  },

  {
    name: 'gnubok_vat_close_check',
    description: "Answer 'can I close VAT?' in one call. Returns SKV 4700 rutor + blocker scan (uncategorized, unapproved supplier invoices, reconciliation diff, missing receipts ≥ 4000 kr, reverse-charge mirroring) + period sanity ratios + Skatteverket deadline + ready_to_close.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_type: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'], description: 'Period type' },
        year: { type: 'number', description: 'Year (e.g. 2026)' },
        period: { type: 'number', description: '1–12 for monthly, 1–4 for quarterly, 1 for yearly' },
      },
      required: ['period_type', 'year', 'period'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'object' },
        period_label: { type: 'string' },
        rutor: { type: 'object' },
        payment: {
          type: 'object',
          properties: {
            net_due: { type: 'number' },
            direction: { type: 'string', enum: ['pay', 'refund', 'zero'] },
            deadline: { type: ['string', 'null'] },
            deadline_label: { type: ['string', 'null'] },
            moms_period: { type: ['string', 'null'] },
          },
        },
        blockers: { type: 'array', items: { type: 'object' } },
        sanity: { type: 'object' },
        ready_to_close: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['period', 'rutor', 'payment', 'blockers', 'sanity', 'ready_to_close', 'summary'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      return computeVatCloseCheck(args, companyId, supabase)
    },
  },

  // ── KPI & Income Statement tools ─────────────────────────────

  {
    name: 'gnubok_get_kpi_report',
    description: 'Business KPIs for a fiscal period: gross margin, net result, cash position, receivables, expense ratio, payment days, VAT liability, monthly trend.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first.')
        }
        periodId = periods.id
      }

      // Verify period belongs to user
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      // Run queries in parallel (same as the KPI API route)
      const [incomeStatement, trialBalance, arLedger, monthlyBreakdown, paidInvoices] =
        await Promise.all([
          generateIncomeStatement(supabase, companyId, periodId!),
          generateTrialBalance(supabase, companyId, periodId!),
          generateARLedger(supabase, companyId),
          generateMonthlyBreakdown(supabase, companyId, periodId!),
          supabase
            .from('invoices')
            .select('invoice_date, paid_at')
            .eq('company_id', companyId)
            .eq('status', 'paid')
            .not('paid_at', 'is', null),
        ])

      const grossMargin = calculateGrossMargin(incomeStatement)
      const cashPosition = calculateCashPosition(trialBalance.rows)
      const expenseRatio = calculateExpenseRatio(incomeStatement)
      const avgPaymentDays = calculateAvgPaymentDays(
        (paidInvoices.data ?? []) as { invoice_date: string; paid_at: string }[]
      )

      // AR ledger uses entries, each with invoices that have outstanding amounts
      const outstandingReceivables = arLedger.total_outstanding
      const overdueReceivables = arLedger.total_overdue

      // VAT liability from trial balance
      const getClosing = (accNum: string) => {
        const row = trialBalance.rows.find((r) => r.account_number === accNum)
        if (!row) return 0
        return row.closing_credit - row.closing_debit
      }
      const vatLiability = Math.round(
        (getClosing('2611') + getClosing('2621') + getClosing('2631') -
          getClosing('2641') - getClosing('2645')) * 100
      ) / 100

      return {
        period_name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        gross_margin: grossMargin,
        net_result: incomeStatement.net_result,
        cash_position: cashPosition,
        outstanding_receivables: Math.round(outstandingReceivables * 100) / 100,
        overdue_receivables: Math.round(overdueReceivables * 100) / 100,
        expense_ratio: expenseRatio,
        avg_payment_days: avgPaymentDays,
        paid_invoice_count: paidInvoices.data?.length ?? 0,
        vat_liability: vatLiability,
        total_revenue: incomeStatement.total_revenue,
        total_expenses: incomeStatement.total_expenses,
        months: monthlyBreakdown.months,
      }
    },
  },

  {
    name: 'gnubok_get_income_statement',
    description: 'Income statement (resultaträkning) for a fiscal period: revenue, expenses, net result by account category.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first.')
        }
        periodId = periods.id
      }

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      const result = await generateIncomeStatement(supabase, companyId, periodId!)
      result.period = { start: period.period_start, end: period.period_end }

      return {
        period_name: period.name,
        ...result,
      }
    },
  },

  // ── Invoice Operations ───────────────────────────────────────

  {
    name: 'gnubok_mark_invoice_as_paid',
    description: 'Mark an invoice as paid and create the payment journal entry. Stages for approval. Status must be sent or overdue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice' },
        payment_date: { type: 'string', description: 'Payment date YYYY-MM-DD (default: today)' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invoiceError || !invoice) throw new Error('Invoice not found')
      if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
        throw new Error('Invoice can only be marked as paid when status is "sent" or "overdue"')
      }

      const paymentDate = (args.payment_date as string) || new Date().toISOString().split('T')[0]

      return stagePendingOperation(supabase, companyId, userId, 'mark_invoice_paid',
        `Betald: ${invoice.invoice_number} ${invoice.customer?.name || ''} ${invoice.total} ${invoice.currency}`,
        { invoice_id: invoiceId, payment_date: paymentDate },
        {
          invoice_number: invoice.invoice_number,
          customer_name: invoice.customer?.name,
          total: invoice.total,
          currency: invoice.currency,
          payment_date: paymentDate,
        },
        actor,
        {
          description: 'Once approved, the payment is booked (15xx → 19xx). Use gnubok_get_ar_ledger to confirm the customer balance reflects it.',
          tool: 'gnubok_get_ar_ledger',
        },
        { dateForPeriodCheck: paymentDate },
      )
    },
  },

  {
    name: 'gnubok_send_invoice',
    description: 'Send invoice via email with PDF attachment. Stages for approval. Requires customer email + email service configured.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to send' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const emailService = getEmailService()
      if (!emailService.isConfigured()) {
        throw new Error('Email service not configured. Ensure RESEND_API_KEY and RESEND_FROM_EMAIL are set.')
      }

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invoiceError || !invoice) throw new Error('Invoice not found')

      const customer = invoice.customer as Customer
      if (!customer.email) throw new Error('Customer has no email address. Update customer details first.')

      return stagePendingOperation(supabase, companyId, userId, 'send_invoice',
        `Skicka: ${invoice.invoice_number} till ${customer.email}`,
        { invoice_id: invoiceId },
        {
          invoice_number: invoice.invoice_number,
          customer_name: customer.name,
          customer_email: customer.email,
          total: invoice.total,
          currency: invoice.currency,
        },
        actor,
        {
          description: 'After the customer pays, mark the invoice paid via gnubok_mark_invoice_as_paid (or match it to the inbound bank transaction with gnubok_match_transaction_to_invoice).',
          tool: 'gnubok_mark_invoice_as_paid',
          args: { invoice_id: invoiceId },
        }
      )
    },
  },

  {
    name: 'gnubok_mark_invoice_as_sent',
    description: 'Mark a draft invoice as sent without sending email (when delivered manually). Stages for approval. Status must be draft.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the draft invoice' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invoiceError || !invoice) throw new Error('Invoice not found')
      if (invoice.status !== 'draft') throw new Error('Only draft invoices can be marked as sent')

      return stagePendingOperation(supabase, companyId, userId, 'mark_invoice_sent',
        `Markera skickad: ${invoice.invoice_number} ${invoice.customer?.name || ''}`,
        { invoice_id: invoiceId },
        {
          invoice_number: invoice.invoice_number,
          customer_name: invoice.customer?.name,
          total: invoice.total,
          currency: invoice.currency,
        },
        actor,
        {
          description: 'Once approved, the invoice moves to "sent". Track its payment via gnubok_mark_invoice_as_paid when the customer pays.',
          tool: 'gnubok_mark_invoice_as_paid',
          args: { invoice_id: invoiceId },
        }
      )
    },
  },

  // ── Supplier Operations (Read-Only) ──────────────────────────

  {
    name: 'gnubok_list_suppliers',
    description: 'List all suppliers (leverantörer) with contact and payment details, sorted by name.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suppliers: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['suppliers', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, supplier_type, email, phone, org_number, vat_number, default_expense_account, default_payment_terms, default_currency, city, country')
        .eq('company_id', companyId)
        .order('name', { ascending: true })

      if (error) throw new Error(`Database error: ${error.message}`)

      return { suppliers: data ?? [], count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_supplier',
    description: 'Stage a new supplier (leverantör). Stages for user approval — NOT created until approved in the web app. Use to add a vendor before booking a supplier invoice or matching expenses.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 255, description: 'Supplier name' },
        supplier_type: {
          type: 'string',
          enum: ['swedish_business', 'eu_business', 'non_eu_business'],
          description: 'Supplier type (default swedish_business). eu_business requires vat_number.',
        },
        email: { type: 'string', maxLength: 255, format: 'email', description: 'Email address' },
        phone: { type: 'string', maxLength: 50, description: 'Phone number' },
        org_number: {
          type: 'string',
          maxLength: 20,
          pattern: '^\\d{6}-?\\d{4}$|^\\d{12}$',
          description: 'Swedish org number (10 digits with optional hyphen XXXXXX-XXXX, or 12 digits).',
        },
        vat_number: {
          type: 'string',
          maxLength: 20,
          description: 'EU VAT number with country prefix (e.g. SE556677778800, DE123456789). Required when supplier_type is eu_business.',
        },
        address_line1: { type: 'string', maxLength: 255, description: 'Street address' },
        address_line2: { type: 'string', maxLength: 255 },
        postal_code: { type: 'string', maxLength: 20 },
        city: { type: 'string', maxLength: 100 },
        country: {
          type: 'string',
          maxLength: 2,
          pattern: '^[A-Za-z]{2}$',
          description: 'ISO 3166-1 alpha-2 country code (default SE)',
        },
        bankgiro: {
          type: 'string',
          maxLength: 20,
          pattern: '^\\d{3,4}-?\\d{4}$',
          description: 'Swedish Bankgiro number (7-8 digits with valid Luhn check digit).',
        },
        plusgiro: {
          type: 'string',
          maxLength: 20,
          pattern: '^\\d{1,7}-?\\d{1}$',
          description: 'Swedish Plusgiro number (2-8 digits).',
        },
        bank_account: { type: 'string', maxLength: 50, description: 'Bank account number' },
        iban: {
          type: 'string',
          maxLength: 34,
          pattern: '^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$',
          description: 'IBAN (ISO 13616). Country code + 2 check digits + alphanumeric.',
        },
        bic: {
          type: 'string',
          maxLength: 11,
          pattern: '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$',
          description: 'BIC/SWIFT code (8 or 11 chars).',
        },
        default_expense_account: {
          type: 'string',
          maxLength: 10,
          pattern: '^[4567]\\d{3}$',
          description: '4-digit BAS expense account (class 4, 5, 6, or 7). e.g. "5010".',
        },
        default_payment_terms: {
          type: 'integer',
          minimum: 0,
          maximum: 365,
          description: 'Payment terms in days (default 30). Use 0 for due-on-receipt.',
        },
        default_currency: {
          type: 'string',
          minLength: 3,
          maxLength: 3,
          description: 'Default invoice currency, 3-letter ISO code (default SEK).',
        },
        notes: { type: 'string', maxLength: 2000 },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate inputs and return the would-be preview without staging or creating. No DB writes, no side-effects.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Random per-operation UUID. Repeat calls with the same key + same payload return the original response (24h TTL). Different payload → IDEMPOTENCY_KEY_REUSE error.',
        },
      },
      required: ['name'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      // Server-side validation (defense in depth): MCP transport already
      // checks the JSON Schema, but we re-validate with Zod so financial
      // identifiers (IBAN, BIC, bankgiro Luhn, org_number, VAT format) are
      // rejected at the ingestion boundary rather than persisted.
      // Strip MCP control fields before parsing — the strict schema rejects
      // unknown keys to satisfy ASVS V4.5 field-allow-listing.
      const { dry_run, idempotency_key, ...supplierArgs } = args
      let params
      try {
        params = CreateSupplierParamsSchema.parse(supplierArgs)
      } catch (err) {
        if (err instanceof z.ZodError) {
          const issue = err.issues[0]
          const path = issue?.path?.join('.') ?? 'params'
          throw new Error(`Invalid ${path}: ${issue?.message ?? 'validation failed'}`)
        }
        throw err
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_supplier',
        `Ny leverantör: ${params.name}`,
        params,
        params,
        actor,
        {
          description: 'Once approved, you can book supplier invoices against this supplier with gnubok_create_supplier_invoice_from_inbox using the returned supplier_id.',
          tool: 'gnubok_create_supplier_invoice_from_inbox',
        },
        {
          dryRun: Boolean(dry_run),
          idempotencyKey: typeof idempotency_key === 'string' ? idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_list_supplier_invoices',
    description: 'List supplier invoices (leverantörsfakturor), sorted by due date. Optional status filter; "to_pay" combines approved+overdue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          description: 'Filter: registered, approved, overdue, paid, to_pay, all (default)',
          enum: ['registered', 'approved', 'overdue', 'paid', 'to_pay', 'all'],
        },
        limit: { type: 'number', description: 'Max results 1–100 (default 50)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoices: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['invoices', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 100)
      const status = (args.status as string) || 'all'

      let query = supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date, due_date, status, total, total_sek, currency, vat_treatment, remaining_amount, supplier:suppliers(id, name)')
        .eq('company_id', companyId)

      if (status !== 'all') {
        if (status === 'to_pay') {
          query = query.in('status', ['approved', 'overdue'])
        } else {
          query = query.eq('status', status)
        }
      }

      const { data, error } = await query.order('due_date', { ascending: true }).limit(limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      return { invoices: data ?? [], count: data?.length ?? 0 }
    },
  },

  // ── Counterparty Templates & Suggestions ─────────────────────

  {
    name: 'gnubok_get_counterparty_templates',
    description: 'List active counterparty categorization templates — learned patterns from prior categorizations used for auto-matching new transactions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results 1–200 (default 100)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        templates: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['templates', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 100), 200)

      const { data, error } = await supabase
        .from('categorization_templates')
        .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, line_pattern, occurrence_count, confidence, last_seen_date, source')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('occurrence_count', { ascending: false })
        .limit(limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      return {
        templates: (data ?? []).map((t) => ({
          ...t,
          counterparty_name_display: formatCounterpartyName(t.counterparty_name),
        })),
        count: data?.length ?? 0,
      }
    },
  },

  {
    name: 'gnubok_suggest_categories',
    description: 'Suggest categories for uncategorized transactions using mapping rules, pattern matching, history, and counterparty templates. Up to 20 transactions per call.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 20 transaction UUIDs',
        },
      },
      required: ['transaction_ids'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suggestions: { type: 'object' },
        counterparty_matches: { type: 'object' },
      },
      required: ['suggestions', 'counterparty_matches'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const ids = args.transaction_ids as string[]
      if (!ids || ids.length === 0) throw new Error('transaction_ids is required (non-empty array)')
      const limitedIds = ids.slice(0, 20)

      // Fetch transactions
      const { data: transactions, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .eq('company_id', companyId)
        .in('id', limitedIds)

      if (txError) throw new Error(`Database error: ${txError.message}`)
      if (!transactions || transactions.length === 0) throw new Error('No transactions found')

      // Fetch mapping rules
      const { data: mappingRules } = await supabase
        .from('mapping_rules')
        .select('*')
        .or(`company_id.eq.${companyId},company_id.is.null`)
        .eq('is_active', true)
        .order('priority', { ascending: false })

      // Build category history from past categorizations
      const { data: historicalTxns } = await supabase
        .from('transactions')
        .select('category')
        .eq('company_id', companyId)
        .not('is_business', 'is', null)
        .neq('category', 'uncategorized')
        .neq('category', 'private')
        .limit(200)

      const categoryHistory: Record<string, number> = {}
      for (const tx of historicalTxns || []) {
        if (tx.category) categoryHistory[tx.category] = (categoryHistory[tx.category] || 0) + 1
      }

      // Batch counterparty template matching
      const counterpartyMatches = await findCounterpartyTemplatesBatch(
        supabase, companyId, transactions as Transaction[]
      )

      // Generate suggestions per transaction
      const suggestions: Record<string, unknown[]> = {}
      const counterpartyResult: Record<string, unknown> = {}

      for (const tx of transactions) {
        suggestions[tx.id] = getSuggestedCategories(
          tx as Transaction, mappingRules ?? [], categoryHistory
        )

        const cpMatch = counterpartyMatches.get(tx.id)
        if (cpMatch) {
          counterpartyResult[tx.id] = {
            template_name: formatCounterpartyName(cpMatch.template.counterparty_name),
            debit_account: cpMatch.template.debit_account,
            credit_account: cpMatch.template.credit_account,
            category: cpMatch.template.category,
            confidence: cpMatch.confidence,
            match_method: cpMatch.matchMethod,
            occurrence_count: cpMatch.template.occurrence_count,
          }
        }
      }

      return { suggestions, counterparty_matches: counterpartyResult }
    },
  },

  // ── Accounts & Chart of Accounts ─────────────────────────────

  {
    name: 'gnubok_list_accounts',
    description: 'List chart of accounts (kontoplan). account_class: 1=assets, 2=liabilities, 3=revenue, 4–7=expenses, 8=financial.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_class: { type: 'number', description: 'Filter by class (1–8)' },
        active_only: { type: 'boolean', description: 'Only active accounts (default: true)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accounts: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['accounts', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const activeOnly = args.active_only !== false
      const accountClass = args.account_class as number | undefined

      let query = supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, account_class, account_group, account_type, normal_balance, is_active, description')
        .eq('company_id', companyId)
        .order('sort_order')

      if (activeOnly) query = query.eq('is_active', true)
      if (accountClass !== undefined) query = query.eq('account_class', accountClass)

      const { data, error } = await query

      if (error) throw new Error(`Database error: ${error.message}`)

      return { accounts: data ?? [], count: data?.length ?? 0 }
    },
  },

  // ── Reports ──────────────────────────────────────────────────

  {
    name: 'gnubok_get_balance_sheet',
    description: 'Balance sheet (balansräkning) for a fiscal period: assets, equity, and liabilities sections with totals + balance check.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) throw new Error('No fiscal periods found. Create one first.')
        periodId = periods.id
      }

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      const result = await generateBalanceSheet(supabase, companyId, periodId!)

      return {
        period_name: period.name,
        ...result,
        period: { start: period.period_start, end: period.period_end },
      }
    },
  },

  {
    name: 'gnubok_get_general_ledger',
    description: 'General ledger (huvudbok) for a fiscal period: per-account opening balance, entries, closing balance. Optional account range filter. For ad-hoc cross-account, amount, or free-text line queries use gnubok_query_journal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
        account_from: { type: 'string', description: 'Starting account number filter' },
        account_to: { type: 'string', description: 'Ending account number filter' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) throw new Error('No fiscal periods found.')
        periodId = periods.id
      }

      const accountFrom = args.account_from as string | undefined
      const accountTo = args.account_to as string | undefined

      return await generateGeneralLedger(supabase, companyId, periodId!, accountFrom, accountTo)
    },
  },

  {
    name: 'gnubok_query_journal',
    description: "Flexible journal-line query — replaces chained ledger calls for ad-hoc questions. Filters: accounts, date range, amount range, voucher series/number, source type, status, project, cost center, free-text. Returns lines with parent voucher metadata + totals.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_from: { type: 'string', description: 'Lowest account number (inclusive). E.g. "4000" with account_to "4999" → all class-4 expenses.' },
        account_to: { type: 'string', description: 'Highest account number (inclusive)' },
        accounts: { type: 'array', items: { type: 'string' }, description: 'Specific account numbers (overrides account_from/account_to). Up to 50.' },
        date_from: { type: 'string', description: 'Earliest entry date (YYYY-MM-DD, inclusive)' },
        date_to: { type: 'string', description: 'Latest entry date (YYYY-MM-DD, inclusive)' },
        amount_min: { type: 'number', description: 'Minimum line amount (absolute value of debit OR credit)' },
        amount_max: { type: 'number', description: 'Maximum line amount (absolute value)' },
        text: { type: 'string', maxLength: 200, description: 'Free-text search in entry description and line description (max 200 chars)' },
        voucher_series: { type: 'string', description: 'Filter by voucher series (e.g. "A")' },
        voucher_number_from: { type: 'number', description: 'Lowest voucher number (inclusive)' },
        voucher_number_to: { type: 'number', description: 'Highest voucher number (inclusive)' },
        source_type: { type: 'string', description: 'Filter by source: bank_transaction, invoice_created, supplier_invoice, currency_revaluation, year_end, opening_balance, etc.' },
        status: { type: 'string', enum: ['posted', 'reversed', 'all'], description: 'Default: posted' },
        project: { type: 'string', description: 'Filter by project code' },
        cost_center: { type: 'string', description: 'Filter by cost center' },
        limit: { type: 'number', minimum: 1, maximum: 500, description: 'Max lines returned 1–500 (default 100). Aggregate totals are computed over the full match set even when truncated.' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lines: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean', description: 'True if more matching lines exist than were returned' },
        total_lines: { type: 'number', description: 'Total lines matching ALL filters (incl. amount). When amount_min/amount_max is set this reflects the filtered set, not the wider DB-side match.' },
        returned_lines: { type: 'number' },
        amount_filter_applied_post_fetch: { type: 'boolean', description: 'True if amount_min/amount_max was applied client-side after the DB fetch.' },
        db_matched_pre_amount_filter: { type: ['number', 'null'], description: 'Pre-amount-filter DB match count when amount_filter_applied_post_fetch is true; null otherwise.' },
        totals: {
          type: 'object',
          properties: {
            debit: { type: 'number' },
            credit: { type: 'number' },
            net: { type: 'number', description: 'debit minus credit (positive = net debit)' },
          },
        },
        applied_filters: { type: 'object' },
      },
      required: ['lines', 'total_lines', 'returned_lines', 'totals'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 100), 500)
      const status = (args.status as string) || 'posted'
      const accounts = args.accounts as string[] | undefined
      const accountFrom = args.account_from as string | undefined
      const accountTo = args.account_to as string | undefined

      if (accounts && accounts.length > 50) {
        throw new Error('accounts list capped at 50 — use account_from/account_to for ranges')
      }

      const dateFrom = args.date_from as string | undefined
      const dateTo = args.date_to as string | undefined
      const voucherSeries = args.voucher_series as string | undefined
      const vnFrom = args.voucher_number_from as number | undefined
      const vnTo = args.voucher_number_to as number | undefined
      const sourceType = args.source_type as string | undefined
      const project = args.project as string | undefined
      const costCenter = args.cost_center as string | undefined

      // Each text-search leg needs its own builder instance — PostgREST
      // query builders are not reusable across awaits. The factory closes
      // over the resolved filter values above.
      const buildBaseQuery = () => {
        let q = supabase
          .from('journal_entry_lines')
          .select(
            'id, account_number, debit_amount, credit_amount, currency, line_description, project, cost_center, sort_order, journal_entries!inner(id, voucher_number, voucher_series, entry_date, description, source_type, status, company_id)',
            { count: 'exact' }
          )
          .eq('journal_entries.company_id', companyId)

        if (status === 'all') {
          q = q.in('journal_entries.status', ['posted', 'reversed'])
        } else {
          q = q.eq('journal_entries.status', status)
        }

        if (accounts && accounts.length > 0) {
          q = q.in('account_number', accounts)
        } else {
          if (accountFrom) q = q.gte('account_number', accountFrom)
          if (accountTo) q = q.lte('account_number', accountTo)
        }

        if (dateFrom) q = q.gte('journal_entries.entry_date', dateFrom)
        if (dateTo) q = q.lte('journal_entries.entry_date', dateTo)

        if (voucherSeries) q = q.eq('journal_entries.voucher_series', voucherSeries)
        if (typeof vnFrom === 'number') q = q.gte('journal_entries.voucher_number', vnFrom)
        if (typeof vnTo === 'number') q = q.lte('journal_entries.voucher_number', vnTo)

        if (sourceType) q = q.eq('journal_entries.source_type', sourceType)

        if (project) q = q.eq('project', project)
        if (costCenter) q = q.eq('cost_center', costCenter)

        return q
      }

      const applyOrderAndLimit = <T extends ReturnType<typeof buildBaseQuery>>(q: T): T =>
        q
          .order('entry_date', { foreignTable: 'journal_entries', ascending: false })
          .order('voucher_number', { foreignTable: 'journal_entries', ascending: false })
          .order('sort_order', { ascending: true })
          .limit(limit) as T

      type LineRow = {
        id: string
        account_number: string
        debit_amount: number
        credit_amount: number
        currency: string | null
        line_description: string | null
        project: string | null
        cost_center: string | null
        sort_order: number
        journal_entries: {
          id: string
          voucher_number: number
          voucher_series: string
          entry_date: string
          description: string
          source_type: string
          status: string
        }
      }

      // Free-text search runs as two parallel .ilike() queries — one against
      // line_description (base table) and one against journal_entries.description
      // (embedded resource). PostgREST's flat .or() filter cannot span a base
      // column and an embedded-resource column ("failed to parse logic tree"),
      // so we issue two queries and merge by line id. Same pattern as
      // lib/invoices/duplicate-payment-candidates.ts.
      const text = (args.text as string | undefined)?.trim()
      let data: LineRow[] = []
      let dbMatched = 0
      // True when at least one text-search leg filled its per-leg fetch
      // window — i.e. more matches probably exist on the DB side that didn't
      // make it into the merge. Drives the `truncated` signal honestly even
      // when the merged distinct set fits inside `limit`.
      let legCapHit = false

      if (text) {
        // Length guard — defence in depth against pathological inputs even
        // though .ilike() parameterises the value (compliance A.8.28).
        if (text.length > 200) {
          throw new Error('text filter must be 200 characters or shorter')
        }

        // LIKE wildcards `%` and `_` are escaped so a search for "2_441"
        // matches the literal string. Comma stripping is intentionally NOT
        // applied here: the previous implementation needed it because the
        // value was interpolated into PostgREST's OR DSL where `,` is the
        // separator. The .ilike() path passes the pattern as a parameterised
        // filter operand where `,` is a literal — stripping would mangle
        // searches for real commas in line descriptions.
        const escaped = text.replace(/[%]/g, '\\%').replace(/_/g, '\\_')
        const pattern = `%${escaped}%`

        // Fetch up to 2× limit per leg to reduce global-ordering loss when
        // one leg is much more selective than the other (e.g. 150 line
        // matches vs 5 entry matches with limit=100). Hard-capped at 500
        // rows per leg so a caller-supplied `limit` near its own ceiling
        // can't fan out to 2× very large queries. The final post-merge
        // slice still caps at `limit`; the wider per-leg window just gives
        // the merge a better tail to choose from.
        const legLimit = Math.min(limit * 2, 500)

        const buildLeg = (column: 'line_description' | 'journal_entries.description') =>
          buildBaseQuery()
            .ilike(column, pattern)
            .order('entry_date', { foreignTable: 'journal_entries', ascending: false })
            .order('voucher_number', { foreignTable: 'journal_entries', ascending: false })
            .order('sort_order', { ascending: true })
            .limit(legLimit)

        const [byLine, byEntry] = await Promise.all([
          buildLeg('line_description'),
          buildLeg('journal_entries.description'),
        ])
        if (byLine.error || byEntry.error) {
          log.warn('query_journal text-search failed', {
            companyId,
            userId,
            byLine: byLine.error?.message ?? null,
            byEntry: byEntry.error?.message ?? null,
          })
          throw new Error('Database error while running text search')
        }

        const merged = new Map<string, LineRow>()
        for (const row of (byLine.data ?? []) as unknown as LineRow[]) merged.set(row.id, row)
        for (const row of (byEntry.data ?? []) as unknown as LineRow[]) {
          if (!merged.has(row.id)) merged.set(row.id, row)
        }
        data = Array.from(merged.values())
          .sort((a, b) => {
            const ad = a.journal_entries.entry_date
            const bd = b.journal_entries.entry_date
            if (ad !== bd) return ad < bd ? 1 : -1
            const av = a.journal_entries.voucher_number
            const bv = b.journal_entries.voucher_number
            if (av !== bv) return bv - av
            return a.sort_order - b.sort_order
          })
          .slice(0, limit)

        // Honest distinct-row count among what we fetched. If a leg hit its
        // window cap, more distinct matches may exist; `legCapHit` carries
        // that signal downstream so `truncated` isn't faked false.
        dbMatched = merged.size
        legCapHit =
          (byLine.data?.length ?? 0) >= legLimit ||
          (byEntry.data?.length ?? 0) >= legLimit
      } else {
        const res = await applyOrderAndLimit(buildBaseQuery())
        if (res.error) {
          log.warn('query_journal failed', { companyId, userId, error: res.error.message })
          throw new Error('Database error while running journal query')
        }
        data = (res.data ?? []) as unknown as LineRow[]
        dbMatched = res.count ?? data.length
      }

      // Apply amount filter post-fetch — PostgREST can't OR an abs(debit) >= n
      // with abs(credit) >= n cleanly. Lines are debit XOR credit, so checking
      // max(debit, credit) works.
      const amountMin = args.amount_min as number | undefined
      const amountMax = args.amount_max as number | undefined
      const amountFilterApplied = typeof amountMin === 'number' || typeof amountMax === 'number'
      const filtered = data.filter((r) => {
        const lineAmount = Math.max(Number(r.debit_amount) || 0, Number(r.credit_amount) || 0)
        if (typeof amountMin === 'number' && lineAmount < amountMin) return false
        if (typeof amountMax === 'number' && lineAmount > amountMax) return false
        return true
      })

      // Compute totals on the fetched-and-filtered set. Note: when truncated,
      // these are totals of the returned slice, not the full match. The
      // truncated flag tells the agent whether to issue a narrower query.
      let totalDebit = 0
      let totalCredit = 0
      const lines = filtered.map((r) => {
        totalDebit += Number(r.debit_amount) || 0
        totalCredit += Number(r.credit_amount) || 0
        return {
          line_id: r.id,
          journal_entry_id: r.journal_entries.id,
          voucher_series: r.journal_entries.voucher_series,
          voucher_number: r.journal_entries.voucher_number,
          entry_date: r.journal_entries.entry_date,
          entry_description: r.journal_entries.description,
          source_type: r.journal_entries.source_type,
          status: r.journal_entries.status,
          account_number: r.account_number,
          debit: Number(r.debit_amount) || 0,
          credit: Number(r.credit_amount) || 0,
          line_description: r.line_description,
          project: r.project,
          cost_center: r.cost_center,
          currency: r.currency,
        }
      })

      // PostgREST's `count` is computed before the post-fetch amount filter,
      // so when amount_min/amount_max is set it reflects the wider DB-side
      // match — not the lines actually returned. Reporting that as
      // `total_lines` would mislead an agent into chasing a truncated tail
      // that has already been filtered out client-side. When the amount
      // filter ran, anchor `total_lines` and `truncated` to the filtered
      // result, and surface the pre-filter count + a flag separately so an
      // agent can still tell the DB matched more (it just didn't pass the
      // amount predicate).
      const total_lines = amountFilterApplied ? lines.length : dbMatched
      const truncated = amountFilterApplied
        ? data.length >= limit && lines.length === limit
        : dbMatched > lines.length || legCapHit
      return {
        lines,
        truncated,
        total_lines,
        returned_lines: lines.length,
        amount_filter_applied_post_fetch: amountFilterApplied,
        db_matched_pre_amount_filter: amountFilterApplied ? dbMatched : null,
        totals: {
          debit: Math.round(totalDebit * 100) / 100,
          credit: Math.round(totalCredit * 100) / 100,
          net: Math.round((totalDebit - totalCredit) * 100) / 100,
        },
        applied_filters: {
          account_from: accountFrom ?? null,
          account_to: accountTo ?? null,
          accounts: accounts ?? null,
          date_from: dateFrom ?? null,
          date_to: dateTo ?? null,
          amount_min: amountMin ?? null,
          amount_max: amountMax ?? null,
          text: text ?? null,
          voucher_series: voucherSeries ?? null,
          voucher_number_from: vnFrom ?? null,
          voucher_number_to: vnTo ?? null,
          source_type: sourceType ?? null,
          status,
          project: project ?? null,
          cost_center: costCenter ?? null,
        },
      }
    },
  },

  {
    name: 'gnubok_get_ar_ledger',
    description: 'Accounts receivable ledger (kundreskontra): outstanding customer invoices with aging.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        as_of_date: { type: 'string', description: 'Balance date YYYY-MM-DD (default: today)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const asOfDate = args.as_of_date as string | undefined
      return await generateARLedger(supabase, companyId, asOfDate)
    },
  },

  {
    name: 'gnubok_get_supplier_ledger',
    description: 'Accounts payable ledger (leverantörsreskontra): outstanding supplier invoices with aging.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        as_of_date: { type: 'string', description: 'Balance date YYYY-MM-DD (default: today)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const asOfDate = args.as_of_date as string | undefined
      return await generateSupplierLedger(supabase, companyId, asOfDate)
    },
  },

  // ── Transaction Matching ─────────────────────────────────────

  {
    name: 'gnubok_match_transaction_to_invoice',
    description: 'Match a bank transaction (income, amount>0) to a customer invoice. Confirm tx date/amount and invoice number/customer match before staging — preview mirrors what you pass. Supports partial payments and auto-storno of prior categorization.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string', description: 'UUID of the bank transaction' },
        invoice_id: { type: 'string', description: 'UUID of the invoice to match' },
      },
      required: ['transaction_id', 'invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const transactionId = args.transaction_id as string
      const invoiceId = args.invoice_id as string
      if (!transactionId || !invoiceId) throw new Error('transaction_id and invoice_id are required')

      // Validate both exist and are matchable
      const { data: transaction, error: txError } = await supabase
        .from('transactions')
        .select('id, description, merchant_name, amount, currency, date, invoice_id')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .single()

      if (txError || !transaction) throw new Error('Transaction not found')
      if (transaction.amount <= 0) throw new Error('Only income transactions (amount > 0) can be matched to invoices')
      if (transaction.invoice_id) throw new Error('Transaction is already linked to an invoice')

      const { data: invoice, error: invError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invError || !invoice) throw new Error('Invoice not found')
      if (invoice.status !== 'sent' && invoice.status !== 'overdue' && invoice.status !== 'partially_paid') {
        throw new Error('Invoice is not in a matchable state (must be sent, overdue, or partially_paid)')
      }

      const txDesc = transaction.merchant_name || transaction.description || transactionId

      return stagePendingOperation(supabase, companyId, userId, 'match_transaction_invoice',
        `Matcha: ${txDesc} → ${invoice.invoice_number}`,
        { transaction_id: transactionId, invoice_id: invoiceId },
        {
          transaction_description: txDesc,
          transaction_amount: transaction.amount,
          transaction_currency: transaction.currency,
          // Surface both dates so the reviewer can spot a material mismatch
          // between the payment and the invoice it's being matched against
          // before approving.
          transaction_date: transaction.date,
          invoice_number: invoice.invoice_number,
          invoice_total: invoice.total,
          invoice_currency: invoice.currency,
          invoice_date: invoice.invoice_date,
          customer_name: (invoice.customer as Record<string, unknown>)?.name as string,
        },
        actor,
        {
          description: 'After approval the transaction is linked and the invoice is marked paid. Use gnubok_get_ar_ledger to verify the customer balance.',
          tool: 'gnubok_get_ar_ledger',
        }
      )
    },
  },

  {
    name: 'gnubok_match_batch_allocate',
    description: 'Allocate 1 bank tx across N customer OR N supplier invoices (samlingsbetalning, BFL 5 kap 6§). Use when one receipt covers many invoices, or one transfer pays many bills. Customer kind requires income tx; supplier kind requires expense. Never mix kinds. Stages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string' },
        allocations: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['customer_invoice', 'supplier_invoice'] },
              invoice_id: { type: 'string' },
              supplier_invoice_id: { type: 'string' },
              amount: { type: 'number', exclusiveMinimum: 0, description: 'Amount in TX currency. Cross-currency = bank-credited SEK.' },
            },
            required: ['kind', 'amount'],
          },
        },
      },
      required: ['transaction_id', 'allocations'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const transactionId = args.transaction_id as string
      const allocations = args.allocations as Array<{
        kind: 'customer_invoice' | 'supplier_invoice'
        invoice_id?: string
        supplier_invoice_id?: string
        amount: number
      }>
      if (!transactionId) throw new Error('transaction_id is required')
      if (!Array.isArray(allocations) || allocations.length === 0) {
        throw new Error('allocations is required (non-empty array)')
      }

      const { data: transaction, error: txError } = await supabase
        .from('transactions')
        .select('id, description, merchant_name, amount, currency, date, journal_entry_id')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .single()
      if (txError || !transaction) throw new Error('Transaction not found')
      if (transaction.journal_entry_id) throw new Error('Transaction is already booked')
      if (transaction.amount === 0) throw new Error('Transaction has zero amount')

      // Direction guard mirrors the RPC: customer_invoice → income, supplier_invoice → expense.
      const hasCustomer = allocations.some((a) => a.kind === 'customer_invoice')
      const hasSupplier = allocations.some((a) => a.kind === 'supplier_invoice')
      if (hasCustomer && hasSupplier) {
        throw new Error('Cannot mix customer_invoice and supplier_invoice allocations in one batch')
      }
      if (hasCustomer && transaction.amount <= 0) {
        throw new Error('Customer allocations require an income transaction (amount > 0)')
      }
      if (hasSupplier && transaction.amount >= 0) {
        throw new Error('Supplier allocations require an expense transaction (amount < 0)')
      }

      // Per-allocation guard (Greptile P1): each row must carry the
      // correct ID for its kind. The inputSchema marks both invoice_id
      // and supplier_invoice_id as optional because they're mutually
      // exclusive — but the JSON-Schema vocabulary can't express "X
      // required iff Y=A". Check explicitly here. Round-8: also reject
      // unexpected extra IDs (V4.5) — a customer_invoice row supplying
      // supplier_invoice_id silently leaks the extra ID into preview_data.
      for (const [i, a] of allocations.entries()) {
        if (a.kind === 'customer_invoice') {
          if (!a.invoice_id) {
            throw new Error(`allocations[${i}]: invoice_id is required when kind=customer_invoice`)
          }
          if (a.supplier_invoice_id) {
            throw new Error(`allocations[${i}]: supplier_invoice_id must not be set when kind=customer_invoice`)
          }
        } else if (a.kind === 'supplier_invoice') {
          if (!a.supplier_invoice_id) {
            throw new Error(`allocations[${i}]: supplier_invoice_id is required when kind=supplier_invoice`)
          }
          if (a.invoice_id) {
            throw new Error(`allocations[${i}]: invoice_id must not be set when kind=supplier_invoice`)
          }
        }
      }

      // Tenant-isolation pre-check (OWASP V8.2.1): verify every
      // referenced invoice belongs to this company BEFORE staging.
      // The RPC also re-checks this, but failing fast at the MCP
      // layer gives the agent a clear error instead of an opaque
      // BATCH_INVOICE_NOT_FOUND code at commit time.
      const invoiceIds = allocations
        .filter((a) => a.kind === 'customer_invoice')
        .map((a) => a.invoice_id!)
      const supplierInvoiceIds = allocations
        .filter((a) => a.kind === 'supplier_invoice')
        .map((a) => a.supplier_invoice_id!)
      // Belt-and-suspenders (CC6.1): assert both count equality AND the
      // missing-set is empty. The Supabase REST client de-dupes by PK so
      // count >= unique input length is enough on its own, but the
      // explicit guard prevents an undefined-row edge case in the JSON
      // response from silently passing.
      if (invoiceIds.length > 0) {
        const uniqueIds = Array.from(new Set(invoiceIds))
        const { data: found } = await supabase
          .from('invoices')
          .select('id')
          .in('id', uniqueIds)
          .eq('company_id', companyId)
        const foundRows = found ?? []
        const foundSet = new Set(foundRows.map((r) => r.id))
        const missing = uniqueIds.filter((id) => !foundSet.has(id))
        if (missing.length > 0 || foundRows.length !== uniqueIds.length) {
          throw new Error(`Invoices not found for this company: ${missing.join(', ') || '(count mismatch)'}`)
        }
      }
      if (supplierInvoiceIds.length > 0) {
        const uniqueIds = Array.from(new Set(supplierInvoiceIds))
        const { data: found } = await supabase
          .from('supplier_invoices')
          .select('id')
          .in('id', uniqueIds)
          .eq('company_id', companyId)
        const foundRows = found ?? []
        const foundSet = new Set(foundRows.map((r) => r.id))
        const missing = uniqueIds.filter((id) => !foundSet.has(id))
        if (missing.length > 0 || foundRows.length !== uniqueIds.length) {
          throw new Error(`Supplier invoices not found for this company: ${missing.join(', ') || '(count mismatch)'}`)
        }
      }

      const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0)
      const txAbs = Math.abs(transaction.amount)
      // 0.005 SEK tolerance is for floating-point equalisation only,
      // NOT a rounding allowance. The RPC `match_batch_allocate`
      // re-enforces the same guard (BATCH_AMOUNT_EXCEEDS_TX /
      // BATCH_AMOUNT_BELOW_TX) authoritatively (per PR #607 round 3),
      // and the verifikat lines balance exactly to the öre.
      if (Math.abs(totalAllocated - txAbs) > 0.005) {
        throw new Error(
          `Allocations sum (${totalAllocated.toFixed(2)}) must equal transaction amount (${txAbs.toFixed(2)})`
        )
      }

      const txDesc = transaction.merchant_name || transaction.description || transactionId
      // Swedish plurals: kundfaktura → kundfakturor (not kundfakturaor).
      // Same for leverantörsfaktura → leverantörsfakturor.
      const noun = hasCustomer ? 'kundfaktura' : 'leverantörsfaktura'
      const summary = `${allocations.length} ${allocations.length === 1 ? noun : `${noun.slice(0, -1)}or`}`

      return stagePendingOperation(supabase, companyId, userId, 'match_batch_allocate',
        `Fördela: ${txDesc} → ${summary}`,
        { transaction_id: transactionId, allocations },
        // GDPR Art.25: transaction_description is included in preview_data
        // so the user can recognise the tx at approval time (merchant_name
        // or fallback to bank description). Same trade-off documented on
        // gnubok_link_transaction_to_journal_entry — it's the minimum
        // signal needed for an informed approval. Counterparty-identifying
        // invoice IDs stay in params (audit trail); they are NOT echoed
        // back into preview_data beyond aggregate counts.
        {
          transaction_description: txDesc,
          transaction_amount: transaction.amount,
          transaction_currency: transaction.currency,
          transaction_date: transaction.date,
          allocations_count: allocations.length,
          allocations_kind: hasCustomer ? 'customer_invoice' : 'supplier_invoice',
          total_allocated: totalAllocated,
        },
        actor,
        {
          description: 'After approval the combined verifikat is created and each invoice is advanced. Verify with gnubok_get_ar_ledger (customer) or gnubok_get_supplier_ledger.',
          tool: hasCustomer ? 'gnubok_get_ar_ledger' : 'gnubok_get_supplier_ledger',
        },
        { dateForPeriodCheck: transaction.date }
      )
    },
  },

  {
    name: 'gnubok_link_transaction_to_journal_entry',
    description: 'Link 1 bank tx to an already-posted verifikat (no new bokföring). Use when the user booked the affärshändelse manually. Pass invoice_id to also settle a kundfaktura. Stages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string' },
        journal_entry_id: { type: 'string' },
        invoice_id: { type: 'string', description: 'Optional kundfaktura to settle alongside the link.' },
      },
      required: ['transaction_id', 'journal_entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const transactionId = args.transaction_id as string
      const journalEntryId = args.journal_entry_id as string
      const invoiceId = (args.invoice_id as string | undefined) ?? undefined
      if (!transactionId || !journalEntryId) {
        throw new Error('transaction_id and journal_entry_id are required')
      }

      // Tenant-isolation + state pre-checks (OWASP V8.2.1). The commit
      // handler re-validates authoritatively; failing fast at stage time
      // gives the agent a clean error before the user is asked to approve.
      const { data: tx, error: txError } = await supabase
        .from('transactions')
        .select('id, date, amount, currency, journal_entry_id, description, merchant_name')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (txError || !tx) throw new Error('Transaction not found')
      if (tx.journal_entry_id) {
        throw new Error('Transaction is already linked to a journal entry')
      }

      const { data: je, error: jeError } = await supabase
        .from('journal_entries')
        .select('id, status, voucher_series, voucher_number, entry_date')
        .eq('id', journalEntryId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (jeError || !je) throw new Error('Journal entry not found')
      if (je.status !== 'posted') {
        throw new Error(`Journal entry must be posted (status=${je.status})`)
      }

      let invoicePreview: { invoice_number: string | null; remaining: number | null; will_be_fully_paid: boolean } | null = null
      if (invoiceId) {
        // GDPR Art.5(1)(c): only the columns the preview displays. We need
        // remaining_amount for the will-be-fully-paid math, invoice_number
        // for the staged-op title, and currency so we can fast-fail the
        // mismatch before the user is asked to approve (the commit handler
        // re-checks authoritatively via LINK_TX_INVOICE_CURRENCY_MISMATCH).
        const { data: invoice, error: invError } = await supabase
          .from('invoices')
          .select('id, invoice_number, status, currency, remaining_amount')
          .eq('id', invoiceId)
          .eq('company_id', companyId)
          .maybeSingle()
        if (invError || !invoice) throw new Error('Invoice not found')
        if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
          throw new Error(`Invoice is not in an open state (status=${invoice.status})`)
        }
        // Currency-mismatch pre-stage check (swedish-compliance PR #614
        // round 8). The link-to-existing-voucher contract requires tx and
        // invoice currency to match — cross-currency settlement must go
        // through the match-invoice flow that posts 3960/7960 FX-diff
        // lines via buildInvoicePaymentClearingLines. Failing fast here
        // saves the user an approval round-trip.
        if (tx.currency !== invoice.currency) {
          throw new Error(
            `Transaction currency (${tx.currency}) does not match invoice currency (${invoice.currency}). Cross-currency settlement must go through the match-invoice flow.`
          )
        }
        // Explicit NaN guard (A.8.28): silently treating a malformed numeric
        // column as 0 would let a bogus preview pass to the user. The DB
        // column is NUMERIC NOT NULL on remaining_amount once status leaves
        // 'draft', so a NaN here means something upstream is broken.
        const remaining = Number(invoice.remaining_amount)
        const txAmount = Number(tx.amount)
        if (!Number.isFinite(remaining) || !Number.isFinite(txAmount)) {
          throw new Error('Invoice remaining_amount or tx amount is not a finite number')
        }
        const newRemaining = Math.max(0, Math.round((remaining - txAmount) * 100) / 100)
        invoicePreview = {
          invoice_number: (invoice.invoice_number as string | null) ?? null,
          remaining: newRemaining,
          will_be_fully_paid: newRemaining <= 0,
        }
      }

      // Period-lock check uses the LATER of tx.date and je.entry_date so a
      // tx in an open period attached to a verifikat in a locked period
      // surfaces the period_status envelope correctly. Mirrors the same
      // logic in gnubok_bulk_book_transactions.
      const txDate = tx.date as string
      const jeDate = je.entry_date as string
      const periodCheckDate = jeDate > txDate ? jeDate : txDate

      // Centralised verifikat-label format (formatVoucherLabel) — keeps the
      // MCP staging preview and the committed audit-trail label byte-identical,
      // so BFL 5 kap 7§ traceability holds even if the format ever changes.
      const voucherLabel = formatVoucherLabel(
        je.voucher_series as string | null,
        je.voucher_number as number | null,
      )
      const txDesc = (tx.merchant_name as string | null) || (tx.description as string | null) || transactionId.slice(0, 8)

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'link_transaction_journal_entry',
        invoiceId
          ? `Länka ${txDesc} → verifikat ${voucherLabel} + faktura ${invoicePreview?.invoice_number ?? invoiceId.slice(0, 8)}`
          : `Länka ${txDesc} → verifikat ${voucherLabel}`,
        { transaction_id: transactionId, journal_entry_id: journalEntryId, invoice_id: invoiceId ?? null },
        // GDPR Art.25: voucher_description is intentionally OMITTED from
        // preview_data — it can carry free-text merchant/counterparty PII
        // and the voucher_label alone uniquely identifies the verifikat for
        // the user's approval decision. Same reasoning as the per-tx
        // description handling elsewhere in this file.
        {
          transaction_description: txDesc,
          transaction_amount: tx.amount,
          transaction_currency: tx.currency,
          transaction_date: txDate,
          voucher_label: voucherLabel,
          voucher_date: jeDate,
          invoice_id: invoiceId ?? null,
          invoice_number: invoicePreview?.invoice_number ?? null,
          invoice_remaining_after: invoicePreview?.remaining ?? null,
          will_be_fully_paid: invoicePreview?.will_be_fully_paid ?? null,
        },
        actor,
        {
          description: invoiceId
            ? 'After approval the tx attaches to the existing verifikat and the invoice flips to paid/partially_paid. No new bokföring. Verify with gnubok_get_ar_ledger.'
            : 'After approval the tx attaches to the existing verifikat. No new bokföring. Verify with gnubok_query_journal.',
          tool: invoiceId ? 'gnubok_get_ar_ledger' : 'gnubok_query_journal',
        },
        { dateForPeriodCheck: periodCheckDate }
      )
    },
  },

  {
    name: 'gnubok_bulk_book_transactions',
    description: 'Bulk-book N bank txs on the same date into 1 samlingsverifikat (BFL 5 kap 6§). Two paths: link N txs to an existing posted verifikat, or create a new verifikat from caller-supplied lines. All txs must share date + direction. Docs on the txs inherit. Stages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tx_ids: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string' } },
        existing_journal_entry_id: { type: 'string' },
        new_entry: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 500 },
            lines: {
              type: 'array',
              minItems: 2,
              maxItems: 200,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  account_number: { type: 'string', pattern: '^\\d{4}$' },
                  debit_amount: { type: 'number', minimum: 0 },
                  credit_amount: { type: 'number', minimum: 0 },
                  currency: { type: 'string', minLength: 3, maxLength: 3 },
                  line_description: { type: 'string', maxLength: 200 },
                },
                required: ['account_number', 'debit_amount', 'credit_amount', 'currency'],
              },
            },
          },
          required: ['description', 'lines'],
        },
      },
      required: ['tx_ids'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const txIds = args.tx_ids as string[]
      const existingJeId = (args.existing_journal_entry_id as string | undefined) ?? null
      const newEntry = (args.new_entry as { description: string; lines: unknown[] } | undefined) ?? null
      if (!Array.isArray(txIds) || txIds.length === 0) throw new Error('tx_ids is required (non-empty)')
      if ((existingJeId == null) === (newEntry == null)) {
        throw new Error('Provide exactly one of existing_journal_entry_id or new_entry')
      }

      // Balance pre-check on the create-new path (compliance-swarm V2.3
      // / swedish-compliance). The RPC also rejects with
      // BULK_BOOK_UNBALANCED, but failing fast here lets the agent get
      // a clear error before staging is even attempted.
      // The 0.005 tolerance is for floating-point equalisation only,
      // NOT a rounding allowance per BFL 5 kap 4–5§. The RPC enforces
      // exact balance to the öre on insert.
      if (newEntry) {
        const lines = (newEntry as { lines?: Array<{ debit_amount?: number; credit_amount?: number }> }).lines
        if (Array.isArray(lines) && lines.length > 0) {
          // Reject NaN / non-finite values explicitly (A.8.28).
          // `Number(x) || 0` silently treats NaN as 0; that would let
          // a malformed amount pass the balance check by accident.
          // Round-8 addition: reject debit=0 && credit=0 "ghost" lines
          // (BFL 5 kap 6§ — every line must represent a real
          // bokföringspost with a non-zero amount).
          for (const [i, l] of lines.entries()) {
            const d = Number(l.debit_amount)
            const c = Number(l.credit_amount)
            if (!Number.isFinite(d) || !Number.isFinite(c)) {
              throw new Error(`new_entry.lines[${i}]: debit_amount and credit_amount must be finite numbers`)
            }
            if (d === 0 && c === 0) {
              throw new Error(`new_entry.lines[${i}]: debit_amount and credit_amount cannot both be zero (BFL 5 kap 6§)`)
            }
          }
          const totalDebit = lines.reduce((s, l) => s + Number(l.debit_amount), 0)
          const totalCredit = lines.reduce((s, l) => s + Number(l.credit_amount), 0)
          if (Math.abs(totalDebit - totalCredit) > 0.005) {
            throw new Error(
              `new_entry.lines must balance — debits=${totalDebit.toFixed(2)} credits=${totalCredit.toFixed(2)}`
            )
          }
        }
      }

      const { data: txs, error: txError } = await supabase
        .from('transactions')
        .select('id, amount, currency, date, journal_entry_id')
        .in('id', txIds)
        .eq('company_id', companyId)
      if (txError || !txs || txs.length !== txIds.length) {
        throw new Error('One or more transactions not found')
      }
      const booked = txs.find((t) => t.journal_entry_id != null)
      if (booked) throw new Error(`Transaction ${booked.id} is already booked`)
      const dates = new Set(txs.map((t) => t.date))
      if (dates.size > 1) throw new Error('All transactions must share the same date')
      // Reject zero-amount txs (round-8 / A.8.28). The direction computation
      // below treats amount === 0 as 'expense' (amount > 0 is false), which
      // would then mis-classify a real income tx in the same batch. Mirrors
      // the explicit zero-amount guard in gnubok_match_batch_allocate.
      const zeroAmountTx = txs.find((t) => t.amount === 0)
      if (zeroAmountTx) throw new Error(`Transaction ${zeroAmountTx.id} has zero amount`)
      const direction = txs[0]!.amount > 0 ? 'income' : 'expense'
      if (txs.some((t) => (direction === 'income' ? t.amount < 0 : t.amount > 0))) {
        throw new Error('All transactions must share the same direction (all income or all expense)')
      }
      // Currency homogeneity (swedish-compliance): a samlingsverifikat
      // combining e.g. SEK + EUR txs without explicit FX lines violates
      // BFL 5 kap 2§ (alla belopp skall uttryckas i svenska kronor)
      // read together with the valutakurs rules in BFL 5 kap 6§.
      // Cross-currency batches should go through gnubok_match_batch_allocate
      // (which handles the FX diff on 7960/3960). Reject mixed currencies here.
      const currencies = new Set(txs.map((t) => t.currency))
      if (currencies.size > 1) {
        // Route the agent to the cross-currency-capable tool rather
        // than letting it retry with hand-built FX lines.
        throw new Error(
          'All transactions must share the same currency. For cross-currency allocations, use gnubok_match_batch_allocate (which handles the FX diff on 7960/3960).'
        )
      }

      const txSum = txs.reduce((s, t) => s + t.amount, 0)
      const txDate = txs[0]!.date as string

      // For link-existing branch, also fetch the target JE and use the
      // LATER of tx_date and JE.entry_date for period-lock check
      // (swedish-compliance): otherwise a tx in an open period could be
      // attached to a verifikat in a closed period and the guard
      // would miss it. Same query also enforces tenant isolation on
      // the JE (OWASP V8.2.1) before the RPC sees the ID.
      let periodCheckDate = txDate
      if (existingJeId) {
        const { data: je, error: jeError } = await supabase
          .from('journal_entries')
          .select('id, entry_date, status')
          .eq('id', existingJeId)
          .eq('company_id', companyId)
          .maybeSingle()
        if (jeError || !je) {
          throw new Error('Existing journal entry not found for this company')
        }
        if (je.status !== 'posted') {
          throw new Error(`Existing journal entry must be posted (status=${je.status})`)
        }
        // Pass the later date so the period-lock guard fires on whichever
        // side is in a locked/closed period.
        periodCheckDate = (je.entry_date as string) > txDate ? (je.entry_date as string) : txDate
      }

      return stagePendingOperation(supabase, companyId, userId, 'bulk_book_transactions',
        existingJeId
          ? `Länka ${txIds.length} transaktioner till verifikat (${txDate})`
          : `Samlingsverifikation: ${txIds.length} transaktioner ${txDate}`,
        {
          tx_ids: txIds,
          existing_journal_entry_id: existingJeId,
          new_entry: newEntry,
        },
        // GDPR Art.25: preview_data carries only aggregate counts + the
        // shared date/direction — no per-tx descriptions, no per-line
        // descriptions, no counterparty IDs. The user-facing approval
        // dialog reconstructs detail from the tx_ids list at render time
        // rather than persisting denormalized PII here. Same privacy-by-
        // design rationale as gnubok_link_transaction_to_journal_entry.
        {
          tx_count: txIds.length,
          tx_date: txDate,
          tx_sum: txSum,
          direction,
          mode: existingJeId ? 'link_existing' : 'create_new',
        },
        actor,
        {
          description: 'After approval the verifikat carries the combined business event. Verify with gnubok_query_journal or gnubok_get_reconciliation_status.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: periodCheckDate }
      )
    },
  },

  {
    name: 'gnubok_find_voucher_candidates_for_invoice',
    description: 'List posted verifikat that credit kundfordran (1510) and could be the payment for this invoice. Use before gnubok_link_invoice_to_voucher when the user wants to mark a faktura paid against an existing verifikation (no new bokföring).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to find candidates for' },
        limit: { type: 'number', description: 'Max candidates to return (default 10, max 50)' },
      },
      required: ['invoice_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string' },
        invoice_status: { type: 'string' },
        candidates: { type: 'array', items: { type: 'object' } },
      },
      required: ['invoice_id', 'candidates'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')
      const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50)

      const { data: invoice, error } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, customer_id, customer:customers(id, name)'
        )
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()
      if (error || !invoice) throw new Error('Invoice not found')

      if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
        return {
          invoice_id: invoiceId,
          invoice_status: invoice.status,
          candidates: [],
        }
      }

      const candidates = await findMatchingVouchersForInvoice(
        supabase,
        companyId,
        invoice as never,
        { limit },
      )
      return {
        invoice_id: invoiceId,
        invoice_status: invoice.status,
        candidates,
      }
    },
  },

  {
    name: 'gnubok_link_invoice_to_voucher',
    description: 'Markera en faktura som betald genom att länka till en befintlig verifikation som redan krediterar kundfordran (1510). Ingen ny verifikation skapas. Hitta kandidater med gnubok_find_voucher_candidates_for_invoice först.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to mark paid' },
        journal_entry_id: { type: 'string', description: 'UUID of the existing posted verifikat to link' },
        notes: { type: 'string', description: 'Optional note stored on the invoice_payments row' },
      },
      required: ['invoice_id', 'journal_entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      const journalEntryId = args.journal_entry_id as string
      const notes = (args.notes as string | undefined) ?? undefined
      if (!invoiceId || !journalEntryId) {
        throw new Error('invoice_id and journal_entry_id are required')
      }

      const { data: invoice, error: invErr } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, customer_id, customer:customers(id, name)'
        )
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()
      if (invErr || !invoice) throw new Error('Invoice not found')
      if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
        throw new Error('Invoice is not in a matchable state (must be sent, overdue, or partially_paid)')
      }

      const validation = await validateVoucherForInvoiceLink(
        supabase,
        companyId,
        invoice as never,
        journalEntryId,
      )
      if (!validation.ok) {
        throw new Error(
          `${validation.code}${validation.details ? `: ${JSON.stringify(validation.details)}` : ''}`,
        )
      }

      const voucherLabel = validation.voucher.voucher_series && validation.voucher.voucher_number != null
        ? `${validation.voucher.voucher_series}-${validation.voucher.voucher_number}`
        : journalEntryId.slice(0, 8)

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'link_invoice_voucher',
        `Länka verifikat ${voucherLabel} → faktura ${invoice.invoice_number ?? invoiceId.slice(0, 8)}`,
        { invoice_id: invoiceId, journal_entry_id: journalEntryId, notes },
        {
          invoice_number: invoice.invoice_number,
          invoice_currency: invoice.currency,
          invoice_remaining: invoice.remaining_amount,
          voucher_label: voucherLabel,
          voucher_date: validation.voucher.entry_date,
          voucher_description: validation.voucher.description,
          ar_credit_amount: validation.arCreditAmount,
          payment_amount: validation.paymentAmount,
          will_be_fully_paid: validation.isFullyPaid,
          remaining_after: validation.remainingAfter,
          customer_name: (invoice.customer as unknown as { name?: string } | null)?.name ?? null,
        },
        actor,
        {
          description: 'After approval the invoice transitions to paid (or partially_paid). No new verifikat is created — the existing voucher is the payment posting.',
          tool: 'gnubok_get_ar_ledger',
        },
      )
    },
  },

  {
    name: 'gnubok_find_voucher_candidates_for_supplier_invoice',
    description: 'List posted verifikat that debit leverantörsskuld (2440) and could be the payment for this supplier invoice. Use before gnubok_link_supplier_invoice_to_voucher when marking a leverantörsfaktura paid against an existing verifikation (no new bokföring).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_invoice_id: { type: 'string', description: 'UUID of the supplier invoice to find candidates for' },
        limit: { type: 'number', description: 'Max candidates to return (default 10, max 50)' },
      },
      required: ['supplier_invoice_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_invoice_id: { type: 'string' },
        invoice_status: { type: 'string' },
        candidates: { type: 'array', items: { type: 'object' } },
      },
      required: ['supplier_invoice_id', 'candidates'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const supplierInvoiceId = args.supplier_invoice_id as string
      if (!supplierInvoiceId) throw new Error('supplier_invoice_id is required')
      const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50)

      const { data: invoice, error } = await supabase
        .from('supplier_invoices')
        .select(
          'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, supplier:suppliers(id, name)'
        )
        .eq('id', supplierInvoiceId)
        .eq('company_id', companyId)
        .single()
      if (error || !invoice) throw new Error('Supplier invoice not found')

      if (!['registered', 'approved', 'overdue', 'partially_paid'].includes(invoice.status)) {
        return {
          supplier_invoice_id: supplierInvoiceId,
          invoice_status: invoice.status,
          candidates: [],
        }
      }

      const candidates = await findMatchingVouchersForSupplierInvoice(
        supabase,
        companyId,
        invoice as never,
        { limit },
      )
      return {
        supplier_invoice_id: supplierInvoiceId,
        invoice_status: invoice.status,
        candidates,
      }
    },
  },

  {
    name: 'gnubok_link_supplier_invoice_to_voucher',
    description: 'Markera en leverantörsfaktura som betald genom att länka till en befintlig verifikation som redan debiterar leverantörsskuld (2440). Ingen ny verifikation skapas. Hitta kandidater med gnubok_find_voucher_candidates_for_supplier_invoice först.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_invoice_id: { type: 'string', description: 'UUID of the supplier invoice to mark paid' },
        journal_entry_id: { type: 'string', description: 'UUID of the existing posted verifikat to link' },
        notes: { type: 'string', description: 'Optional note stored on the supplier_invoice_payments row' },
      },
      required: ['supplier_invoice_id', 'journal_entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const supplierInvoiceId = args.supplier_invoice_id as string
      const journalEntryId = args.journal_entry_id as string
      const notes = (args.notes as string | undefined) ?? undefined
      if (!supplierInvoiceId || !journalEntryId) {
        throw new Error('supplier_invoice_id and journal_entry_id are required')
      }

      const { data: invoice, error: invErr } = await supabase
        .from('supplier_invoices')
        .select(
          'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, supplier:suppliers(id, name)'
        )
        .eq('id', supplierInvoiceId)
        .eq('company_id', companyId)
        .single()
      if (invErr || !invoice) throw new Error('Supplier invoice not found')
      if (!['registered', 'approved', 'overdue', 'partially_paid'].includes(invoice.status)) {
        throw new Error('Supplier invoice is not in a matchable state (must be registered, approved, overdue, or partially_paid)')
      }

      const validation = await validateVoucherForSupplierInvoiceLink(
        supabase,
        companyId,
        invoice as never,
        journalEntryId,
      )
      if (!validation.ok) {
        throw new Error(
          `${validation.code}${validation.details ? `: ${JSON.stringify(validation.details)}` : ''}`,
        )
      }

      const voucherLabel = validation.voucher.voucher_series && validation.voucher.voucher_number != null
        ? `${validation.voucher.voucher_series}-${validation.voucher.voucher_number}`
        : journalEntryId.slice(0, 8)

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'link_supplier_invoice_voucher',
        `Länka verifikat ${voucherLabel} → leverantörsfaktura ${invoice.supplier_invoice_number ?? supplierInvoiceId.slice(0, 8)}`,
        { supplier_invoice_id: supplierInvoiceId, journal_entry_id: journalEntryId, notes },
        {
          supplier_invoice_number: invoice.supplier_invoice_number,
          invoice_currency: invoice.currency,
          invoice_remaining: invoice.remaining_amount,
          voucher_label: voucherLabel,
          voucher_date: validation.voucher.entry_date,
          voucher_description: validation.voucher.description,
          ap_debit_amount: validation.apDebitAmount,
          payment_amount: validation.paymentAmount,
          will_be_fully_paid: validation.isFullyPaid,
          remaining_after: validation.remainingAfter,
          supplier_name: (invoice.supplier as unknown as { name?: string } | null)?.name ?? null,
        },
        actor,
        {
          description: 'After approval the supplier invoice transitions to paid (or partially_paid). No new verifikat is created — the existing voucher is the payment posting.',
          tool: 'gnubok_get_supplier_ledger',
        },
      )
    },
  },

  {
    name: 'gnubok_auto_match_period',
    description: "Bulk reconciliation: scan unmatched income transactions in a date range and propose invoice matches with confidence + reasoning. dry_run=true (default) previews without staging; dry_run=false stages every match above confidence_threshold as a pending operation.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date_from: { type: 'string', description: 'Period start YYYY-MM-DD' },
        date_to: { type: 'string', description: 'Period end YYYY-MM-DD' },
        confidence_threshold: { type: 'number', description: 'Minimum confidence to propose (0..1, default 0.9). Lower for more matches; raise for safety.' },
        dry_run: { type: 'boolean', description: 'If true (default), preview proposals without staging. If false, stage each above-threshold match as a pending operation.' },
        max_transactions: { type: 'number', description: 'Cap on transactions to process this call (default 100, max 500). Use multiple calls or narrower date ranges for very large periods.' },
      },
      required: ['date_from', 'date_to'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dry_run: { type: 'boolean' },
        confidence_threshold: { type: 'number' },
        scanned_transactions: { type: 'number' },
        proposed_matches: { type: 'number' },
        below_threshold: { type: 'number' },
        no_match_found: { type: 'number' },
        truncated: { type: 'boolean' },
        proposals: { type: 'array', items: { type: 'object' } },
        staged_count: { type: 'number' },
        stage_failures: { type: 'array', items: { type: 'object' } },
      },
      required: ['dry_run', 'scanned_transactions', 'proposed_matches', 'proposals'],
    },
    annotations: {
      readOnlyHint: false,  // can stage when dry_run=false
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const dateFrom = args.date_from as string
      const dateTo = args.date_to as string
      if (!dateFrom || !dateTo) throw new Error('date_from and date_to are required')

      const confidenceThreshold = typeof args.confidence_threshold === 'number'
        ? Math.max(0, Math.min(1, args.confidence_threshold))
        : 0.9
      const dryRun = args.dry_run !== false
      const maxTransactions = Math.min(Math.max(1, Number(args.max_transactions) || 100), 500)

      // Fetch unmatched income transactions in window. We require positive
      // amount because findMatchingInvoices only matches income; expenses are
      // out of scope for this tool.
      const { data: transactions, error: txError } = await supabase
        .from('transactions')
        .select('id, description, merchant_name, amount, currency, date, reference, journal_entry_id, invoice_id')
        .eq('company_id', companyId)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .gt('amount', 0)
        .is('journal_entry_id', null)
        .is('invoice_id', null)
        .order('date', { ascending: true })
        .limit(maxTransactions + 1)

      if (txError) throw new Error(`Failed to fetch transactions: ${txError.message}`)

      const txList = (transactions ?? []).slice(0, maxTransactions)
      const truncated = (transactions ?? []).length > maxTransactions

      type Proposal = {
        transaction_id: string
        transaction_date: string
        transaction_amount: number
        transaction_currency: string
        transaction_description: string
        invoice_id: string
        invoice_number: string | null
        invoice_total: number
        customer_name: string | null
        confidence: number
        match_reason: string
        decision: 'propose' | 'below_threshold' | 'no_match'
      }

      const proposals: Proposal[] = []
      let belowThreshold = 0
      let noMatchFound = 0

      for (const tx of txList) {
        const matches = await findMatchingInvoices(
          supabase,
          companyId,
          tx as never,
        )
        if (matches.length === 0) {
          noMatchFound++
          continue
        }
        const best = matches[0]
        const baseProposal: Omit<Proposal, 'decision'> = {
          transaction_id: tx.id as string,
          transaction_date: tx.date as string,
          transaction_amount: Number(tx.amount) || 0,
          transaction_currency: tx.currency as string,
          transaction_description: (tx.merchant_name as string) || (tx.description as string) || '',
          invoice_id: best.invoice.id,
          invoice_number: best.invoice.invoice_number,
          invoice_total: best.invoice.total,
          customer_name: (best.invoice.customer as { name?: string } | undefined)?.name ?? null,
          confidence: Math.round(best.confidence * 1000) / 1000,
          match_reason: best.matchReason,
        }
        if (best.confidence < confidenceThreshold) {
          proposals.push({ ...baseProposal, decision: 'below_threshold' as const })
          belowThreshold++
        } else {
          proposals.push({ ...baseProposal, decision: 'propose' as const })
        }
      }

      const proposed = proposals.filter((p) => p.decision === 'propose')

      // Dry-run path: return proposals with reasoning, no side-effects
      if (dryRun) {
        return {
          dry_run: true,
          confidence_threshold: confidenceThreshold,
          scanned_transactions: txList.length,
          proposed_matches: proposed.length,
          below_threshold: belowThreshold,
          no_match_found: noMatchFound,
          truncated,
          proposals,
          staged_count: 0,
          stage_failures: [],
        }
      }

      // Commit path: stage each above-threshold match through pending_operations.
      // Per-item failure isolation — one bad match doesn't kill the rest.
      const stageFailures: { transaction_id: string; invoice_id: string; error: string }[] = []
      let stagedCount = 0
      for (const p of proposed) {
        try {
          await stagePendingOperation(
            supabase,
            companyId,
            userId,
            'match_transaction_invoice',
            `Matcha: ${p.transaction_description || p.transaction_id} → ${p.invoice_number}`,
            { transaction_id: p.transaction_id, invoice_id: p.invoice_id },
            {
              transaction_description: p.transaction_description,
              transaction_amount: p.transaction_amount,
              transaction_currency: p.transaction_currency,
              invoice_number: p.invoice_number,
              invoice_total: p.invoice_total,
              customer_name: p.customer_name,
              auto_match_confidence: p.confidence,
              auto_match_reason: p.match_reason,
            },
            actor,
          )
          stagedCount++
        } catch (err) {
          stageFailures.push({
            transaction_id: p.transaction_id,
            invoice_id: p.invoice_id,
            error: err instanceof Error ? err.message : 'Unknown stage error',
          })
        }
      }

      return {
        dry_run: false,
        confidence_threshold: confidenceThreshold,
        scanned_transactions: txList.length,
        proposed_matches: proposed.length,
        below_threshold: belowThreshold,
        no_match_found: noMatchFound,
        truncated,
        proposals,
        staged_count: stagedCount,
        stage_failures: stageFailures,
      }
    },
  },

  // ── Fiscal Periods ───────────────────────────────────────────

  {
    name: 'gnubok_list_fiscal_periods',
    description: 'List all fiscal periods (räkenskapsperioder) with status: active (open), locked (no new entries), or closed (year-end completed).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        periods: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['periods', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      const { data, error } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, opening_balances_set')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })

      if (error) throw new Error(`Database error: ${error.message}`)

      const periods = (data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        period_start: p.period_start,
        period_end: p.period_end,
        opening_balances_set: p.opening_balances_set,
        status: p.is_closed ? 'closed' : p.locked_at ? 'locked' : 'active',
      }))

      return { periods, count: periods.length }
    },
  },

  // ── Reconciliation ───────────────────────────────────────────

  {
    name: 'gnubok_get_reconciliation_status',
    description: 'Bank reconciliation status: matched/unmatched counts, match rate, bank vs ledger balance, difference. Optional date range.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const dateFrom = args.date_from as string | undefined
      const dateTo = args.date_to as string | undefined
      return await getReconciliationStatus(supabase, companyId, dateFrom, dateTo)
    },
  },

  // ── Document Inbox Tools ────────────────────────────────────

  {
    name: 'gnubok_upload_document',
    description: 'Upload a PDF/JPEG/PNG/HEIC/WebP (max 20 MB) to the inbox. Runs deterministic field extraction on text-based PDFs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_name: { type: 'string', description: 'File name with extension (e.g. "faktura.pdf")' },
        file_content_base64: { type: 'string', description: 'Base64-encoded file content' },
        mime_type: { type: 'string', description: 'MIME type (optional, inferred from extension)' },
      },
      required: ['file_name', 'file_content_base64'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string' },
        inbox_item_id: { type: 'string' },
        status: { type: 'string' },
        extracted_data: { type: 'object' },
        matched_supplier_id: { type: 'string' },
      },
      required: ['document_id', 'inbox_item_id', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const fileName = args.file_name as string
      const base64Content = args.file_content_base64 as string
      let mimeType = args.mime_type as string | undefined

      if (!mimeType) {
        const ext = fileName.split('.').pop()?.toLowerCase()
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          heic: 'image/heic',
          webp: 'image/webp',
        }
        mimeType = ext ? mimeMap[ext] : undefined
        if (!mimeType) throw new Error(`Cannot infer MIME type from extension: .${ext}`)
      }

      const allowedMimeTypes = new Set([
        'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp',
      ])
      if (!allowedMimeTypes.has(mimeType)) {
        throw new Error(`Unsupported file type: ${mimeType}. Allowed: PDF, JPEG, PNG, HEIC, WebP`)
      }

      const buffer = Buffer.from(base64Content, 'base64')
      if (buffer.byteLength > MAX_DOCUMENT_SIZE) {
        throw new Error(`File too large (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB)`)
      }

      const doc = await uploadDocument(supabase, userId, companyId, {
        name: fileName,
        buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        type: mimeType,
      }, { upload_source: 'api' })

      const { data: extracted } = await extractInvoiceFields({
        buffer,
        mimeType,
        fileName,
      })

      let matchedSupplierId: string | null = null
      if (extracted.supplier.orgNumber) {
        const { data: s } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .eq('org_number', extracted.supplier.orgNumber)
          .limit(1)
          .maybeSingle()
        if (s) matchedSupplierId = s.id
      }

      const { data: inbox, error: inboxError } = await supabase
        .from('invoice_inbox_items')
        .insert({
          company_id: companyId,
          user_id: userId,
          status: 'received',
          source: 'upload',
          document_id: doc.id,
          extracted_data: extracted as unknown as Record<string, unknown>,
          matched_supplier_id: matchedSupplierId,
        })
        .select('id, status')
        .single()

      if (inboxError) throw new Error(`Failed to create inbox item: ${inboxError.message}`)

      return {
        document_id: doc.id,
        inbox_item_id: inbox.id,
        status: inbox.status,
        extracted_data: extracted,
        matched_supplier_id: matchedSupplierId,
      }
    },
  },

  {
    name: 'gnubok_list_inbox_items',
    description: 'List document inbox items. Each has a `processed` flag covering all terminal links (transaction match, supplier invoice, or journal entry), so a booked receipt counts as done. unprocessed_only=true returns only docs still needing handling.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['received', 'error'], description: 'Filter by status' },
        unprocessed_only: { type: 'boolean', description: 'When true, only return items with no terminal link yet (not matched to a transaction, supplier invoice, or journal entry) — i.e. documents that still need handling. Default false.' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['items', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)
      const status = args.status as string | undefined
      const unprocessedOnly = args.unprocessed_only === true

      let query = supabase
        .from('invoice_inbox_items')
        .select('id, status, source, created_at, extracted_data, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, email_from, email_subject, error_message')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        // Fetch a wider window when filtering client-side so the limit
        // applies to the post-filter set rather than truncating before it.
        .limit(unprocessedOnly ? 200 : limit)

      if (status) query = query.eq('status', status)

      const { data, error } = await query
      if (error) throw new Error(`Database error: ${error.message}`)

      const mapped = (data || []).map((item) => {
        const extracted = item.extracted_data as Record<string, unknown> | null
        let vendorName: string | null = null
        let amount: number | null = null
        let invoiceDate: string | null = null

        if (extracted) {
          const supplier = extracted.supplier as Record<string, unknown> | undefined
          const invoice = extracted.invoice as Record<string, unknown> | undefined
          const totals = extracted.totals as Record<string, unknown> | undefined
          vendorName = (supplier?.name as string) || null
          amount = (totals?.total as number) || null
          invoiceDate = (invoice?.invoiceDate as string) || null
        }

        // An item is "processed" once it has ANY terminal link: matched to a
        // bank transaction, converted to a supplier invoice, or booked
        // directly to a journal entry. Surfacing only the supplier fields
        // (as before) made receipts booked against bank transactions look
        // loose — and risked the agent flagging them as duplicates.
        const processed = !!(
          item.matched_transaction_id ||
          item.created_supplier_invoice_id ||
          item.created_journal_entry_id
        )

        return {
          id: item.id,
          status: item.status,
          source: item.source,
          created_at: item.created_at,
          vendor_name: vendorName,
          amount,
          invoice_date: invoiceDate,
          processed,
          matched_supplier_id: item.matched_supplier_id,
          matched_transaction_id: item.matched_transaction_id,
          created_supplier_invoice_id: item.created_supplier_invoice_id,
          created_journal_entry_id: item.created_journal_entry_id,
          email_from: item.email_from,
          email_subject: item.email_subject,
          error_message: item.error_message,
        }
      })

      const filtered = unprocessedOnly ? mapped.filter((i) => !i.processed) : mapped
      const items = filtered.slice(0, limit)

      return { items, count: items.length }
    },
  },

  {
    name: 'gnubok_get_inbox_item',
    description: 'Get a single inbox item with complete extracted data, supplier match, email metadata, and timestamps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string', description: 'UUID of the inbox item' },
      },
      required: ['inbox_item_id'],
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const id = args.inbox_item_id as string

      const { data, error } = await supabase
        .from('invoice_inbox_items')
        .select('*, document_attachments(id, file_name, mime_type, file_size_bytes, created_at)')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!data) throw new Error('Inbox item not found')

      return data
    },
  },

  {
    name: 'gnubok_create_supplier_invoice_from_inbox',
    description: "Atomic: turn an OCR'd inbox item into a staged supplier invoice. Resolves supplier (matched or via org_number/name), assembles line items from extracted_data, applies VAT + FX, attaches the source document. Stages for human review; honors dry_run.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string', description: 'UUID of the inbox item to convert' },
        supplier_id_override: { type: 'string', description: 'Force this supplier UUID instead of the matched/extracted one' },
        vat_treatment_override: { type: 'string', enum: ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt'], description: 'Override extracted VAT treatment' },
        due_date_override: { type: 'string', description: 'Override extracted due date (YYYY-MM-DD)' },
        notes: { type: 'string', description: 'Optional notes appended to the supplier invoice' },
        dry_run: { type: 'boolean', description: 'If true, return the assembled payload without staging (default false)' },
        idempotency_key: { type: 'string', description: 'UUID. Repeat calls with same key + payload return cached response.' },
      },
      required: ['inbox_item_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const inboxItemId = args.inbox_item_id as string
      if (!inboxItemId) throw new Error('inbox_item_id is required')
      const dryRun = args.dry_run === true
      const idempotencyKey = args.idempotency_key as string | undefined

      // Fetch the inbox item with the attached source document
      const { data: inbox, error: inboxErr } = await supabase
        .from('invoice_inbox_items')
        .select('id, status, extracted_data, matched_supplier_id, created_supplier_invoice_id, document_id')
        .eq('id', inboxItemId)
        .eq('company_id', companyId)
        .single()

      if (inboxErr || !inbox) throw new Error('Inbox item not found')
      if (inbox.created_supplier_invoice_id) {
        throw new Error(`Inbox item already converted to supplier invoice ${inbox.created_supplier_invoice_id}`)
      }

      const extracted = (inbox.extracted_data as Record<string, unknown> | null) ?? null
      if (!extracted) throw new Error('Inbox item has no extracted_data — re-run extraction first')

      const supplierExt = extracted.supplier as Record<string, unknown> | undefined
      const invoiceExt = extracted.invoice as Record<string, unknown> | undefined
      const totalsExt = extracted.totals as Record<string, unknown> | undefined
      const lineItemsExt = (extracted.lineItems as Array<Record<string, unknown>> | undefined) ?? []

      // Resolve supplier — explicit override > matched > org_number lookup > name lookup
      const supplierIdOverride = args.supplier_id_override as string | undefined
      let supplierId: string | null = supplierIdOverride ?? (inbox.matched_supplier_id as string | null) ?? null
      let supplierResolution: 'override' | 'matched' | 'lookup_org_number' | 'lookup_name' | 'unresolved' =
        supplierIdOverride ? 'override' : inbox.matched_supplier_id ? 'matched' : 'unresolved'

      if (!supplierId) {
        const orgNumber = supplierExt?.organizationNumber as string | undefined
        const supplierName = supplierExt?.name as string | undefined
        if (orgNumber) {
          const { data } = await supabase
            .from('suppliers')
            .select('id')
            .eq('company_id', companyId)
            .eq('org_number', orgNumber)
            .maybeSingle()
          if (data) {
            supplierId = data.id
            supplierResolution = 'lookup_org_number'
          }
        }
        if (!supplierId && supplierName) {
          const { data } = await supabase
            .from('suppliers')
            .select('id')
            .eq('company_id', companyId)
            .ilike('name', supplierName)
            .maybeSingle()
          if (data) {
            supplierId = data.id
            supplierResolution = 'lookup_name'
          }
        }
      }

      if (!supplierId) {
        throw new Error(
          `Cannot resolve supplier from extracted data. Pass supplier_id_override, or create the supplier first (extracted name: ${supplierExt?.name ?? 'unknown'}, org: ${supplierExt?.organizationNumber ?? 'unknown'}).`
        )
      }

      // Assemble core invoice fields
      const currency = (invoiceExt?.currency as string) || 'SEK'
      const invoiceDate = (invoiceExt?.invoiceDate as string) || null
      const dueDate = (args.due_date_override as string | undefined) ?? (invoiceExt?.dueDate as string | undefined) ?? null
      const supplierInvoiceNumber = (invoiceExt?.invoiceNumber as string) || ''
      if (!invoiceDate) throw new Error('Extracted invoice has no invoice date')
      if (!supplierInvoiceNumber) throw new Error('Extracted invoice has no invoice number')

      const total = Number(totalsExt?.total) || 0
      const subtotal = Number(totalsExt?.subtotal) || 0
      const vatAmount = Number(totalsExt?.vat) || 0

      // VAT treatment: explicit override wins, else heuristic from extracted data
      const vatTreatment = (args.vat_treatment_override as string | undefined)
        ?? (invoiceExt?.vatTreatment as string | undefined)
        ?? 'standard_25'

      // FX: if non-SEK, fetch rate at fakturadatum (best-effort; agent can re-stage on failure)
      let exchangeRate: number | null = null
      if (currency !== 'SEK' && invoiceDate) {
        try {
          const result = await fetchExchangeRate(currency as Currency, new Date(invoiceDate))
          exchangeRate = result?.rate ?? null
        } catch {
          exchangeRate = null  // Agent will be informed via preview; can override later
        }
      }

      // Translate extracted line items into the supplier_invoice_items shape.
      // Default account 4000 (varuinköp/inköp) when extraction didn't pin one.
      const lineItems = lineItemsExt.map((li, idx) => ({
        line_number: idx + 1,
        description: (li.description as string) ?? `Position ${idx + 1}`,
        quantity: Number(li.quantity) || 1,
        unit: (li.unit as string) ?? 'st',
        unit_price: Number(li.unit_price ?? li.unitPrice ?? li.amount) || 0,
        line_total: Number(li.line_total ?? li.lineTotal ?? li.amount) || 0,
        account_number: (li.account_number as string | undefined) ?? '4000',
        vat_rate: Number(li.vat_rate ?? li.vatRate) || 0,
        vat_amount: Number(li.vat_amount ?? li.vatAmount) || 0,
      }))

      const params = {
        inbox_item_id: inboxItemId,
        supplier_id: supplierId,
        document_id: inbox.document_id,
        supplier_invoice_number: supplierInvoiceNumber,
        invoice_date: invoiceDate,
        due_date: dueDate,
        currency,
        exchange_rate: exchangeRate,
        vat_treatment: vatTreatment,
        subtotal: Math.round(subtotal * 100) / 100,
        vat_amount: Math.round(vatAmount * 100) / 100,
        total: Math.round(total * 100) / 100,
        notes: (args.notes as string | undefined) ?? null,
        items: lineItems,
      }

      const previewData = {
        inbox_item_id: inboxItemId,
        supplier_id: supplierId,
        supplier_resolution: supplierResolution,
        extracted_supplier_name: supplierExt?.name ?? null,
        extracted_org_number: supplierExt?.organizationNumber ?? null,
        supplier_invoice_number: supplierInvoiceNumber,
        invoice_date: invoiceDate,
        due_date: dueDate,
        currency,
        exchange_rate: exchangeRate,
        exchange_rate_source: exchangeRate !== null ? 'riksbanken' : currency === 'SEK' ? 'not_applicable' : 'lookup_failed',
        vat_treatment: vatTreatment,
        subtotal: params.subtotal,
        vat_amount: params.vat_amount,
        total: params.total,
        line_count: lineItems.length,
        items_preview: lineItems.slice(0, 5),
        will: 'register supplier invoice (status=registered), attach the inbox document, post a registration journal entry on confirm — leverantörsskuld (2440) credited and the cost/VAT split debited per the per-line VAT rules',
      }

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'create_supplier_invoice_from_inbox',
        `Leverantörsfaktura: ${supplierInvoiceNumber} (${(supplierExt?.name as string) ?? 'okänd'})`,
        params,
        previewData,
        actor,
        {
          description: 'After approval, attest via gnubok_approve_supplier_invoice and pay via the bank flow.',
          tool: 'gnubok_get_inbox_item',
          args: { inbox_item_id: inboxItemId },
        },
        { dryRun, idempotencyKey },
      )
    },
  },

  {
    name: 'gnubok_list_unmatched_documents',
    description: 'List inbox documents not yet attached to any bank transaction or supplier invoice. Returns vendor/amount/currency/date hints. The amount is in the invoice currency — FX-normalise before comparing to transactions.amount.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        cursor: { type: 'string', description: 'Composite "<created_at>__<inbox_item_id>" from previous page (exclusive). Pass next_cursor verbatim.' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
        next_cursor: { type: 'string', description: 'Pass as cursor on next call. Absent = no more pages.' },
      },
      required: ['items', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)
      const cursor = typeof args.cursor === 'string' ? args.cursor : null

      // Composite cursor: "<created_at>__<id>". Falls back to plain timestamp
      // for backward compat with older callers.
      let cursorTs: string | null = null
      let cursorId: string | null = null
      if (cursor) {
        const sep = cursor.indexOf('__')
        if (sep === -1) {
          cursorTs = cursor
        } else {
          cursorTs = cursor.slice(0, sep)
          cursorId = cursor.slice(sep + 2)
        }
      }

      // Pull recent inbox items with a document, no supplier invoice yet, then
      // filter out those whose document is already pinned to a transaction.
      // Two-step query because PostgREST doesn't expose anti-joins.
      const fetchSize = limit * 2
      let inboxQuery = supabase
        .from('invoice_inbox_items')
        .select('id, document_id, source, email_from, email_subject, email_received_at, extracted_data, created_at')
        .eq('company_id', companyId)
        .not('document_id', 'is', null)
        .is('created_supplier_invoice_id', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(fetchSize)

      if (cursorTs && cursorId) {
        // (created_at, id) < (cursorTs, cursorId) — keyset pagination
        inboxQuery = inboxQuery.or(
          `created_at.lt.${cursorTs},and(created_at.eq.${cursorTs},id.lt.${cursorId})`
        )
      } else if (cursorTs) {
        inboxQuery = inboxQuery.lt('created_at', cursorTs)
      }

      const { data: inboxRows, error: inboxError } = await inboxQuery
      if (inboxError) throw new Error(`Database error: ${inboxError.message}`)
      if (!inboxRows || inboxRows.length === 0) {
        return { items: [], count: 0 }
      }

      const docIds = inboxRows.map((r) => r.document_id).filter((d): d is string => d != null)
      const { data: txMatches, error: txError } = await supabase
        .from('transactions')
        .select('document_id')
        .eq('company_id', companyId)
        .in('document_id', docIds)

      if (txError) throw new Error(`Database error: ${txError.message}`)
      const matchedDocIds = new Set((txMatches || []).map((t) => t.document_id))

      const unmatched = inboxRows
        .filter((r) => r.document_id && !matchedDocIds.has(r.document_id))
        .slice(0, limit)
        .map((item) => {
          const extracted = item.extracted_data as Record<string, unknown> | null
          let vendorName: string | null = null
          let orgNumber: string | null = null
          let amount: number | null = null
          let currency: string | null = null
          let invoiceDate: string | null = null
          let paymentReference: string | null = null

          if (extracted) {
            const supplier = extracted.supplier as Record<string, unknown> | undefined
            const invoice = extracted.invoice as Record<string, unknown> | undefined
            const totals = extracted.totals as Record<string, unknown> | undefined
            vendorName = (supplier?.name as string) || null
            orgNumber = (supplier?.orgNumber as string) || null
            amount = (totals?.total as number) || null
            // Surface currency alongside amount so the agent doesn't compare a
            // non-SEK invoice numerically to a SEK transaction. transactions.amount
            // is in transactions.currency; if these don't match, the agent must
            // FX-normalise before ranking matches. Defaulting to null when absent
            // (rather than 'SEK') makes the missing-currency case explicit.
            currency = (invoice?.currency as string) || null
            invoiceDate = (invoice?.invoiceDate as string) || null
            paymentReference = (invoice?.paymentReference as string) || null
          }

          return {
            inbox_item_id: item.id,
            document_id: item.document_id,
            source: item.source,
            created_at: item.created_at,
            email_from: item.email_from,
            email_subject: item.email_subject,
            email_received_at: item.email_received_at,
            vendor_name: vendorName,
            org_number: orgNumber,
            amount,
            currency,
            invoice_date: invoiceDate,
            payment_reference: paymentReference,
          }
        })

      // Pagination contract: emit next_cursor whenever the caller might be
      // missing rows. Two cases:
      //   (a) slice was full → cursor on last returned item (next page picks up
      //       any leftover unmatched rows we filtered past);
      //   (b) slice was short but inbox query returned a full batch → cursor on
      //       last inspected row (more unmatched may exist deeper in the inbox).
      // Only suppress the cursor when we exhausted the inbox stream entirely.
      let nextCursor: string | null = null
      if (unmatched.length === limit) {
        const last = unmatched[unmatched.length - 1]
        nextCursor = `${last.created_at}__${last.inbox_item_id}`
      } else if (inboxRows.length === fetchSize) {
        const last = inboxRows[inboxRows.length - 1]
        nextCursor = `${last.created_at}__${last.id}`
      }

      return {
        items: unmatched,
        count: unmatched.length,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      }
    },
  },

  {
    name: 'gnubok_get_document_content',
    description: 'Get a 5-minute signed download URL for a document so the agent can read its contents (e.g. with vision). Use after gnubok_list_unmatched_documents to inspect a specific PDF before deciding which transaction it matches.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document_attachments row' },
      },
      required: ['document_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string' },
        file_name: { type: 'string' },
        mime_type: { type: 'string' },
        size_bytes: { type: 'number' },
        signed_url: { type: 'string' },
        expires_at: { type: 'string' },
      },
      required: ['document_id', 'file_name', 'signed_url', 'expires_at'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const documentId = args.document_id as string
      if (!documentId) throw new Error('document_id is required')

      const { data: doc, error: docError } = await supabase
        .from('document_attachments')
        .select('id, file_name, mime_type, file_size_bytes, storage_path')
        .eq('id', documentId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (docError) throw new Error(`Database error: ${docError.message}`)
      if (!doc) throw new Error('Document not found')

      const ttlSeconds = 300
      const { data: signed, error: signError } = await supabase.storage
        .from('documents')
        .createSignedUrl(doc.storage_path, ttlSeconds)

      if (signError || !signed) {
        throw new Error(`Failed to create signed URL: ${signError?.message ?? 'unknown error'}`)
      }

      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()

      return {
        document_id: doc.id,
        file_name: doc.file_name,
        mime_type: doc.mime_type,
        size_bytes: doc.file_size_bytes,
        signed_url: signed.signedUrl,
        expires_at: expiresAt,
      }
    },
  },

  {
    name: 'gnubok_attach_document_to_transaction',
    description: 'Stage attaching a document to a bank transaction. Verify tx (date, amount, counterparty) and document (filename, vendor, amount) match first — the preview shown to the human reviewer mirrors what you pass here. Stages for approval.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string', description: 'UUID of the bank transaction' },
        document_id: { type: 'string', description: 'UUID of the document_attachments row' },
        idempotency_key: { type: 'string', description: 'Optional UUID to dedupe retries' },
        dry_run: { type: 'boolean', description: 'Preview without staging' },
      },
      required: ['transaction_id', 'document_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const transactionId = args.transaction_id as string
      const documentId = args.document_id as string
      if (!transactionId) throw new Error('transaction_id is required')
      if (!documentId) throw new Error('document_id is required')

      const { data: tx, error: txError } = await supabase
        .from('transactions')
        .select('id, description, merchant_name, amount, currency, date, document_id')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (txError || !tx) throw new Error('Transaction not found')

      const { data: doc, error: docError } = await supabase
        .from('document_attachments')
        .select('id, file_name, mime_type')
        .eq('id', documentId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (docError || !doc) throw new Error('Document not found')

      // If the tx already has a different doc pinned, fetch its identity so the
      // human approver sees "replaces X.pdf with Y.pdf" rather than just a flag.
      // Required by BFL 5 kap 5 § rättelse (the approver must know what's being
      // displaced before authorising the change).
      type ExistingDoc = { id: string; file_name: string; journal_entry_id: string | null }
      let existingDoc: ExistingDoc | null = null
      if (tx.document_id && tx.document_id !== documentId) {
        const { data: prev } = await supabase
          .from('document_attachments')
          .select('id, file_name, journal_entry_id')
          .eq('id', tx.document_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (prev) {
          existingDoc = prev as unknown as ExistingDoc
        }
      }

      // Pull the matching invoice_inbox_items extracted_data so the approver
      // sees vendor/amount/currency/date — the same hints the agent had when
      // choosing this attachment. Mirrors the BFL 5 kap 6 § informed-rättelse
      // intent: the human authorising the link should see what's on the doc.
      let docVendorName: string | null = null
      let docAmount: number | null = null
      let docCurrency: string | null = null
      let docInvoiceDate: string | null = null
      const { data: inbox } = await supabase
        .from('invoice_inbox_items')
        .select('extracted_data')
        .eq('document_id', documentId)
        .eq('company_id', companyId)
        .limit(1)
        .maybeSingle()
      if (inbox?.extracted_data) {
        const ext = inbox.extracted_data as Record<string, unknown>
        const supplier = ext.supplier as Record<string, unknown> | undefined
        const invoice = ext.invoice as Record<string, unknown> | undefined
        const totals = ext.totals as Record<string, unknown> | undefined
        docVendorName = (supplier?.name as string) || null
        docAmount = (totals?.total as number) || null
        docCurrency = (invoice?.currency as string) || null
        docInvoiceDate = (invoice?.invoiceDate as string) || null
      }

      return stagePendingOperation(
        supabase, companyId, userId, 'attach_document_to_transaction',
        `Koppla bilaga: ${doc.file_name} → ${tx.merchant_name || tx.description || transactionId}`,
        { transaction_id: transactionId, document_id: documentId },
        {
          transaction_description: tx.merchant_name || tx.description,
          transaction_amount: tx.amount,
          transaction_currency: tx.currency,
          transaction_date: tx.date,
          document_file_name: doc.file_name,
          document_mime_type: doc.mime_type,
          document_vendor_name: docVendorName,
          document_amount: docAmount,
          document_currency: docCurrency,
          document_invoice_date: docInvoiceDate,
          will_overwrite_existing: existingDoc != null,
          existing_document_id: existingDoc?.id ?? null,
          existing_document_file_name: existingDoc?.file_name ?? null,
          existing_document_is_rakenskapsinformation: existingDoc?.journal_entry_id != null,
        },
        actor,
        {
          description: 'Once approved, the receipt is linked to the transaction. If the transaction is still uncategorized, follow up with gnubok_categorize_transaction.',
          tool: 'gnubok_categorize_transaction',
          args: { transaction_id: transactionId },
        },
        {
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
          dryRun: args.dry_run === true,
          // Pin the period-status envelope to the transaction date so the
          // approver sees locked/closed periods on the same row that
          // categorize_transaction surfaces them — the attach silently
          // becomes part of the verifikation underlag once categorize
          // propagates it (BFL 5 kap 6 § rättelse-räkenskapsinformation).
          dateForPeriodCheck: typeof tx.date === 'string' ? tx.date : undefined,
        }
      )
    },
  },
  // ── Payroll (Lönehantering) ──────────────────────────────────
  {
    name: 'gnubok_list_employees',
    description: 'List employees for the active company. Personnummer returned masked (YYYYMMDD-XXXX).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        active_only: { type: 'boolean', description: 'Only active employees (default: true)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        employees: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['employees', 'count'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const activeOnly = args.active_only !== false
      let query = supabase
        .from('employees')
        .select('id, first_name, last_name, personnummer, personnummer_last4, employment_type, monthly_salary, hourly_rate, employment_degree, tax_table_number, tax_column, salary_type, is_active')
        .eq('company_id', companyId)
      if (activeOnly) query = query.eq('is_active', true)
      const { data, error } = await query.order('last_name')
      if (error) throw new Error(`Database error: ${error.message}`)
      const employees = (data || []).map(e => ({ ...e, personnummer: maskPersonnummer(decryptPersonnummer(e.personnummer as string)) }))
      return { employees, count: employees.length }
    },
  },
  {
    name: 'gnubok_get_salary_run',
    description: 'Get salary run with status, totals, per-employee breakdown (gross, tax, net, avgifter, vacation accrual) and step-by-step calculation breakdown.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        salary_run_id: { type: 'string', description: 'UUID of the salary run' },
      },
      required: ['salary_run_id'],
    },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const id = args.salary_run_id as string
      const { data: run, error } = await supabase
        .from('salary_runs')
        .select('*')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (error || !run) throw new Error('Salary run not found')
      const { data: employees } = await supabase
        .from('salary_run_employees')
        .select('*, employee:employees(first_name, last_name, personnummer, personnummer_last4)')
        .eq('salary_run_id', id)
      return { ...run, employees: (employees || []).map(e => ({ ...e, employee: e.employee ? { ...(e.employee as Record<string, unknown>), personnummer: maskPersonnummer(decryptPersonnummer((e.employee as Record<string, unknown>).personnummer as string)) } : null })) }
    },
  },
  {
    name: 'gnubok_get_salary_journal',
    description: 'Salary journal (lönejournal) for a year: per-employee per-month rows + yearly totals.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        year: { type: 'number', description: 'Year to report on' },
      },
      required: ['year'],
    },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const { generateSalaryJournal } = await import('@/lib/reports/salary-journal')
      return generateSalaryJournal(supabase, companyId, args.year as number)
    },
  },
  {
    name: 'gnubok_create_salary_run',
    description: 'Stage creation of a draft salary run for a period + base lines for all active employees. Commit via gnubok_approve_pending_operation; then run gnubok_calculate_salary_run. Final booking happens in the web UI.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_year: { type: 'number', description: 'Year' },
        period_month: { type: 'number', description: 'Month (1-12)' },
        payment_date: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
      },
      required: ['period_year', 'period_month', 'payment_date'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const { period_year, period_month, payment_date } = args as { period_year: number; period_month: number; payment_date: string }
      if (!Number.isInteger(period_year) || period_year < 1900 || period_year > 9999) {
        throw new Error('period_year must be a 4-digit year')
      }
      if (!Number.isInteger(period_month) || period_month < 1 || period_month > 12) {
        throw new Error('period_month must be 1-12')
      }
      if (typeof payment_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) {
        throw new Error('payment_date must be YYYY-MM-DD')
      }

      // Preview: count active employees and surface base monthly salaries so
      // the approver knows what would be seeded. No writes here — the commit
      // path re-runs createSalaryRunWithEmployees atomically.
      const { count: employeeCount } = await supabase
        .from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('is_active', true)

      const period = `${period_year}-${String(period_month).padStart(2, '0')}`
      return stagePendingOperation(
        supabase, companyId, userId, 'create_salary_run',
        `Skapa löneutbetalning: ${period} (${employeeCount ?? 0} anställda)`,
        { period_year, period_month, payment_date },
        {
          period,
          payment_date,
          employee_count: employeeCount ?? 0,
        },
        actor,
        {
          description: 'After approval, calculate tax, avgifter and totals.',
          tool: 'gnubok_calculate_salary_run',
        },
        { dateForPeriodCheck: payment_date },
      )
    },
  },
  {
    name: 'gnubok_calculate_salary_run',
    description: 'Calculate a draft salary run: tax, avgifter, vacation accrual, totals. Run must be in draft status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        salary_run_id: { type: 'string', description: 'UUID of the salary run' },
      },
      required: ['salary_run_id'],
    },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const id = args.salary_run_id as string
      if (!id) throw new Error('salary_run_id is required')
      // Call the extracted calculation lib directly — no self-fetch / forged
      // cookie, no NEXT_PUBLIC_APP_URL dependency. The lib enforces draft status
      // and owner-by-company itself.
      const { runSalaryCalculation } = await import('@/lib/salary/run-calculation')
      const { createLogger } = await import('@/lib/logger')
      const { randomUUID } = await import('node:crypto')
      const result = await runSalaryCalculation({
        supabase,
        companyId,
        salaryRunId: id,
        log: createLogger('mcp/calculate_salary_run'),
        requestId: randomUUID(),
      })
      if (!result.ok) {
        throw new Error(`Salary calculation failed: ${result.code}`)
      }
      return {
        salary_run_id: id,
        status: (result.run as { status?: string }).status ?? 'draft',
        warnings: result.warnings,
        message: 'Calculation complete. Review and book the run in the web UI.',
        next: {
          description: 'Review the calculated run; approval and booking happen in the web UI.',
          tool: 'gnubok_get_salary_run',
          args: { salary_run_id: id },
        },
      }
    },
  },
  {
    name: 'gnubok_generate_agi',
    description: 'Stage AGI XML generation (Arbetsgivardeklaration) for a salary run. High-risk: produces statutory Skatteverket underlag (BFL 7-year retention). Commit via gnubok_approve_pending_operation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        salary_run_id: { type: 'string', description: 'UUID of the salary run' },
      },
      required: ['salary_run_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.salary_run_id as string
      if (!id) throw new Error('salary_run_id is required')

      const { data: run } = await supabase
        .from('salary_runs')
        .select('id, status, period_year, period_month, payment_date')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!run) throw new Error('Salary run not found')
      if (run.status === 'draft') {
        throw new Error('Salary run must be past draft before AGI can be generated')
      }

      const period = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
      return stagePendingOperation(
        supabase, companyId, userId, 'generate_agi',
        `Generera AGI: ${period}`,
        { salary_run_id: id },
        {
          period,
          status: run.status,
          payment_date: run.payment_date,
          retention_years: 7,
        },
        actor,
        undefined,
        run.payment_date ? { dateForPeriodCheck: run.payment_date } : {},
      )
    },
  },

  // ── Stream 1 Phase 1: Bookkeeping write (high-risk, always staged) ──

  {
    name: 'gnubok_close_period',
    description: 'Stage period close (irreversible per BFL). Requires period locked + year-end closing entry posted. High-risk — always staged, never auto-committed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to close' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period, error: fetchError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Period is already closed')
      if (!period.locked_at) throw new Error('Period must be locked before closing — call gnubok_lock_period first')
      if (!period.closing_entry_id) throw new Error('Year-end closing entry must exist before the period can be closed')

      return stagePendingOperation(supabase, companyId, userId, 'close_period',
        `Stäng period: ${period.name} (${period.period_start} – ${period.period_end})`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          locked_at: period.locked_at,
          closing_entry_id: period.closing_entry_id,
          irreversible: true,
        },
        actor,
        {
          description: 'Closing is irreversible. Verify the balance sheet and income statement first.',
          tool: 'gnubok_get_balance_sheet',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_lock_period',
    description: 'Stage period lock — blocks new entries. Requires zero unbooked business transactions. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to lock' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period, error: fetchError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Period is already closed')
      if (period.locked_at) throw new Error('Period is already locked')

      const { count: unbookedCount } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_business', true)
        .gte('date', period.period_start)
        .lte('date', period.period_end)

      if (unbookedCount && unbookedCount > 0) {
        throw new Error(
          `Kan inte låsa period: ${unbookedCount} affärstransaktion(er) saknar bokföring. Bokför alla transaktioner först.`
        )
      }

      return stagePendingOperation(supabase, companyId, userId, 'lock_period',
        `Lås period: ${period.name} (${period.period_start} – ${period.period_end})`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          unbooked_business_transactions: 0,
        },
        actor,
        {
          description: 'After locking, run year-end closing before the period can be closed via gnubok_close_period. Verify balances first with gnubok_get_trial_balance.',
          tool: 'gnubok_get_trial_balance',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_uncategorize_transaction',
    description: 'Stage uncategorize: reverses linked journal entry via storno (never deletes) and clears the category. Stages for approval.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string', description: 'UUID of the transaction to uncategorize' },
      },
      required: ['transaction_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const transactionId = args.transaction_id as string
      if (!transactionId) throw new Error('transaction_id is required')

      const { data: tx, error: txError } = await supabase
        .from('transactions')
        .select('id, description, merchant_name, amount, currency, date, category, journal_entry_id')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .single()

      if (txError || !tx) throw new Error('Transaction not found')
      if (!tx.journal_entry_id) throw new Error('Transaction has no journal entry to reverse')

      const { data: entry } = await supabase
        .from('journal_entries')
        .select('id, voucher_number, voucher_series, status')
        .eq('id', tx.journal_entry_id)
        .eq('company_id', companyId)
        .single()

      if (!entry || entry.status !== 'posted') {
        throw new Error('Linked journal entry is not posted — nothing to reverse')
      }

      return stagePendingOperation(supabase, companyId, userId, 'uncategorize_transaction',
        `Återta kategorisering: ${tx.merchant_name || tx.description || transactionId}`,
        { transaction_id: transactionId, journal_entry_id: tx.journal_entry_id },
        {
          transaction_description: tx.merchant_name || tx.description,
          amount: tx.amount,
          currency: tx.currency,
          date: tx.date,
          current_category: tx.category,
          will_reverse_voucher: `${entry.voucher_series}${entry.voucher_number}`,
          method: 'storno (reversal entry, never deletes)',
        },
        actor,
        {
          description: 'After approval the transaction is uncategorized again — book it with the correct category via gnubok_categorize_transaction.',
          tool: 'gnubok_categorize_transaction',
          args: { transaction_id: transactionId },
        }
      )
    },
  },

  {
    name: 'gnubok_export_sie',
    description: 'Generate SIE-4 file for a fiscal period (standard Swedish bookkeeping interchange format). Returns SIE text content.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to export' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string' },
        byte_size: { type: 'number' },
        fiscal_period_id: { type: 'string' },
        company_name: { type: 'string' },
        generated_at: { type: 'string' },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: company } = await supabase
        .from('company_settings')
        .select('company_name, org_number')
        .eq('company_id', companyId)
        .single()

      if (!company) throw new Error('Company settings not found')

      const sieContent = await generateSIEExport(supabase, companyId, {
        fiscal_period_id: fiscalPeriodId,
        company_name: company.company_name || 'Unknown',
        org_number: company.org_number,
      })

      return {
        content: sieContent,
        byte_size: Buffer.byteLength(sieContent, 'utf8'),
        fiscal_period_id: fiscalPeriodId,
        company_name: company.company_name,
        org_number: company.org_number,
        generated_at: new Date().toISOString(),
      }
    },
  },

  {
    name: 'gnubok_audit_package',
    description: "Single-call audit package for a fiscal period: SIE-4 + reports (trial balance, income statement, balance sheet, general ledger, journal register, VAT) + receipts + audit log + voucher gaps, zipped. Returns a 1-hour signed download URL. Long-running on large datasets.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to package' },
        include_documents: { type: 'boolean', description: 'Include receipts/document binaries in the zip (default true)' },
        estimate_only: { type: 'boolean', description: 'Return size estimate without generating (default false)' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        download_url: { type: ['string', 'null'], description: 'Signed Supabase Storage URL valid for 1 hour. Null when estimate_only=true.' },
        storage_path: { type: ['string', 'null'] },
        file_name: { type: 'string' },
        size_bytes: { type: 'number' },
        size_limit_bytes: { type: 'number' },
        within_limit: { type: 'boolean' },
        period: { type: 'object' },
        generated_at: { type: 'string' },
        expires_at: { type: ['string', 'null'] },
        estimate_only: { type: 'boolean' },
      },
      required: ['file_name', 'size_bytes', 'period', 'generated_at', 'estimate_only'],
    },
    annotations: {
      readOnlyHint: false,  // produces a Storage artifact
      destructiveHint: false,
      idempotentHint: true,  // repeat calls produce equivalent archives, fresh URL
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const includeDocuments = args.include_documents !== false
      const estimateOnly = args.estimate_only === true
      const SIZE_LIMIT_BYTES = 80 * 1024 * 1024

      // Verify period belongs to the company
      const { data: period, error: periodErr } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      if (periodErr || !period) throw new Error('Fiscal period not found')

      const generatedAt = new Date().toISOString()

      // Pre-flight size estimate — also serves the estimate-only path
      const estimate = await estimateArchiveSize(supabase, companyId, 'period', fiscalPeriodId)
      const sizeBytes = estimate.total_bytes
      const withinLimit = sizeBytes <= SIZE_LIMIT_BYTES

      const fileName = `arkiv_${period.name.replace(/[^\w-]/g, '_')}_${fiscalPeriodId.slice(0, 8)}.zip`

      if (estimateOnly) {
        return {
          download_url: null,
          storage_path: null,
          file_name: fileName,
          size_bytes: sizeBytes,
          size_limit_bytes: SIZE_LIMIT_BYTES,
          within_limit: withinLimit,
          period: {
            id: period.id,
            name: period.name,
            period_start: period.period_start,
            period_end: period.period_end,
          },
          generated_at: generatedAt,
          expires_at: null,
          estimate_only: true,
        }
      }

      if (includeDocuments && !withinLimit) {
        throw new Error(
          `Archive would exceed ${Math.round(SIZE_LIMIT_BYTES / 1024 / 1024)} MB (estimate: ${Math.round(sizeBytes / 1024 / 1024)} MB). Retry with include_documents=false to omit receipt binaries.`
        )
      }

      // Generate the archive (long-running)
      const zipBuffer = await generateFullArchive(supabase, companyId, {
        scope: 'period',
        period_id: fiscalPeriodId,
        include_documents: includeDocuments,
      })

      // Upload to Storage under a per-user audit-packages folder
      const storagePath = `${userId}/audit-packages/${Date.now()}_${fileName}`
      const { error: uploadErr } = await supabase.storage
        .from('documents')
        .upload(storagePath, new Uint8Array(zipBuffer), {
          contentType: 'application/zip',
          upsert: false,
        })
      if (uploadErr) throw new Error(`Failed to upload archive: ${uploadErr.message}`)

      // Sign for 1 hour
      const SIGNED_URL_TTL_SECONDS = 3600
      const { data: signed, error: signErr } = await supabase.storage
        .from('documents')
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
      if (signErr || !signed) {
        // Best-effort cleanup of the uploaded blob if signing failed
        await supabase.storage.from('documents').remove([storagePath])
        throw new Error(`Failed to sign archive URL: ${signErr?.message ?? 'unknown error'}`)
      }

      const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString()

      return {
        download_url: signed.signedUrl,
        storage_path: storagePath,
        file_name: fileName,
        size_bytes: zipBuffer.byteLength,
        size_limit_bytes: SIZE_LIMIT_BYTES,
        within_limit: true,
        period: {
          id: period.id,
          name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
        },
        generated_at: generatedAt,
        expires_at: expiresAt,
        estimate_only: false,
      }
    },
  },

  // ── Stream 1 Phase 1 follow-up: year-end, opening balances, revaluation,
  //    voucher gaps, supplier-invoice lifecycle, proforma conversion ──

  {
    name: 'gnubok_year_end_readiness',
    description: "Pre-flight before irreversible gnubok_run_year_end. Returns ready (bool) + ordered blockers (drafts, voucher gaps, sequence mismatches, unbalanced trial balance, FX revaluation needed) + warnings + optional preview of the closing entry. Use this before staging year-end.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to year-end' },
        include_preview: { type: 'boolean', description: 'If true, also return the would-be closing journal entry preview (default false)' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'object' },
        ready: { type: 'boolean' },
        blockers: { type: 'array', items: { type: 'object' } },
        warnings: { type: 'array', items: { type: 'string' } },
        draft_count: { type: 'number' },
        unexplained_voucher_gap_count: { type: 'number' },
        sequence_mismatch_count: { type: 'number' },
        trial_balance_balanced: { type: 'boolean' },
        preview: { type: ['object', 'null'] },
        summary: { type: 'string' },
      },
      required: ['ready', 'blockers', 'warnings', 'summary'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      const includePreview = args.include_preview === true
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      // Fetch period for context (the validate function returns errors if not found,
      // but agents benefit from period metadata in the response)
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id, continuity_verified')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found')

      const validation = await validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId)

      // Reshape error strings into structured blockers so the agent (and any
      // dashboard) can render and act on each one independently. The lib
      // returns flat strings; we tag each with a `kind` heuristic for routing.
      const blockers = validation.errors.map((message) => {
        let kind: string = 'other'
        if (/draft journal entries/i.test(message)) kind = 'draft_entries'
        else if (/voucher gap/i.test(message)) kind = 'unexplained_voucher_gap'
        else if (/Sequence counter integrity/i.test(message)) kind = 'sequence_mismatch'
        else if (/Trial balance is not balanced/i.test(message)) kind = 'trial_balance_unbalanced'
        else if (/already closed/i.test(message)) kind = 'period_already_closed'
        else if (/has not yet ended/i.test(message)) kind = 'period_not_ended'
        else if (/closing entry already exists/i.test(message)) kind = 'closing_entry_exists'
        else if (/continuity check failed/i.test(message)) kind = 'opening_balance_continuity'
        else if (/Fiscal period not found/i.test(message)) kind = 'period_not_found'
        return { kind, severity: 'high' as const, message }
      })

      let preview = null
      if (includePreview && validation.ready) {
        try {
          preview = await previewYearEndClosing(supabase, companyId, userId, fiscalPeriodId)
        } catch (err) {
          // Preview is opportunistic — never fail the readiness check on it.
          preview = { error: err instanceof Error ? err.message : 'Preview unavailable' }
        }
      }

      const summary = validation.ready
        ? validation.warnings.length > 0
          ? `Klart för bokslut. ${validation.warnings.length} varning(ar) att granska.`
          : 'Klart för bokslut.'
        : `Inte klart: ${blockers.length} blockerare måste åtgärdas.`

      return {
        period: {
          id: period.id,
          name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          is_closed: period.is_closed,
          locked_at: period.locked_at,
          closing_entry_id: period.closing_entry_id,
          continuity_verified: period.continuity_verified,
        },
        ready: validation.ready,
        blockers,
        warnings: validation.warnings,
        draft_count: validation.draftCount,
        unexplained_voucher_gap_count: validation.unexplainedGaps.length,
        sequence_mismatch_count: validation.sequenceMismatches.length,
        trial_balance_balanced: validation.trialBalanceBalanced,
        preview,
        summary,
      }
    },
  },

  {
    name: 'gnubok_run_year_end',
    description: 'Stage year-end closing: zero result accounts (class 3–8) into 2099, lock period, create next period, seed opening balances. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to close out' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('id', fiscalPeriodId).eq('company_id', companyId).single()

      if (!period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Period is already closed')

      return stagePendingOperation(supabase, companyId, userId, 'run_year_end',
        `Bokslut: ${period.name}`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          will: 'zero result accounts into 2099, lock period, create next period, generate opening balances',
        },
        actor,
        {
          description: 'After year-end, the period is locked and ready for closing via gnubok_close_period.',
          tool: 'gnubok_close_period',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_set_opening_balances',
    description: 'Stage opening-balance entry: copy class 1–2 closing balances from a closed period into the next period.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        closed_period_id: { type: 'string', description: 'UUID of the closed source period' },
        next_period_id: { type: 'string', description: 'UUID of the next (target) period' },
      },
      required: ['closed_period_id', 'next_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const closedId = args.closed_period_id as string
      const nextId = args.next_period_id as string
      if (!closedId || !nextId) throw new Error('closed_period_id and next_period_id are required')

      // Resolve human-readable period names so the approver doesn't see two raw
      // UUIDs in the staged-ops list. Both lookups are scoped to the company so
      // a mis-typed UUID from another tenant just yields a thin (but safe) title.
      const [{ data: closed }, { data: next }] = await Promise.all([
        supabase.from('fiscal_periods').select('name, period_end').eq('id', closedId).eq('company_id', companyId).maybeSingle(),
        supabase.from('fiscal_periods').select('name, period_start').eq('id', nextId).eq('company_id', companyId).maybeSingle(),
      ])
      const closedLabel = closed?.name ?? closedId
      const nextLabel = next?.name ?? nextId

      return stagePendingOperation(supabase, companyId, userId, 'set_opening_balances',
        `Ingående balans: ${closedLabel} → ${nextLabel}`,
        { closed_period_id: closedId, next_period_id: nextId },
        {
          closed_period_id: closedId,
          closed_period_name: closed?.name ?? null,
          next_period_id: nextId,
          next_period_name: next?.name ?? null,
          will: 'create opening balance entry from closed-period trial balance',
        },
        actor,
        {
          description: 'After approval, verify the opening balance matches the closed period\'s UB via gnubok_get_trial_balance on the next period.',
          tool: 'gnubok_get_trial_balance',
          args: { fiscal_period_id: nextId },
        }
      )
    },
  },

  {
    name: 'gnubok_run_currency_revaluation',
    description: 'Stage currency revaluation: revalue open FX receivables/payables to closing-date rate (posts 3960/7960). One per period max.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
        closing_date: { type: 'string', description: 'Revaluation date (YYYY-MM-DD)' },
      },
      required: ['fiscal_period_id', 'closing_date'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      const closingDate = args.closing_date as string
      if (!fiscalPeriodId || !closingDate) throw new Error('fiscal_period_id and closing_date are required')

      return stagePendingOperation(supabase, companyId, userId, 'run_currency_revaluation',
        `Valutaomvärdering ${closingDate}`,
        { fiscal_period_id: fiscalPeriodId, closing_date: closingDate },
        { fiscal_period_id: fiscalPeriodId, closing_date: closingDate, posts_to: ['3960', '7960'] },
        actor,
        {
          description: 'After approval, confirm the new FX-adjusted balances via gnubok_get_balance_sheet.',
          tool: 'gnubok_get_balance_sheet',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_list_voucher_gaps',
    description: 'List voucher number gaps in a fiscal period (BFNAR 2013:2 audit requirement). Each gap shows whether it has an explanation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string' },
        voucher_series: { type: 'string', description: 'Optional series filter (e.g. "A")' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        gaps: { type: 'array', items: { type: 'object' } },
        total_gaps: { type: 'number' },
        unexplained_gaps: { type: 'number' },
      },
      required: ['gaps', 'total_gaps', 'unexplained_gaps'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      const voucherSeries = args.voucher_series as string | undefined

      let seriesQuery = supabase
        .from('voucher_sequences').select('voucher_series')
        .eq('company_id', companyId).eq('fiscal_period_id', fiscalPeriodId)
      if (voucherSeries) seriesQuery = seriesQuery.eq('voucher_series', voucherSeries)

      const { data: seriesRows } = await seriesQuery
      if (!seriesRows || seriesRows.length === 0) {
        return { gaps: [], total_gaps: 0, unexplained_gaps: 0 }
      }

      const allGaps: Array<{ series: string; gap_start: number; gap_end: number; explanation: unknown }> = []
      for (const row of seriesRows) {
        const { data: gaps } = await supabase.rpc('detect_voucher_gaps', {
          p_company_id: companyId,
          p_fiscal_period_id: fiscalPeriodId,
          p_series: row.voucher_series,
        })
        if (gaps) {
          for (const gap of gaps as Array<{ gap_start: number; gap_end: number }>) {
            allGaps.push({ series: row.voucher_series, gap_start: gap.gap_start, gap_end: gap.gap_end, explanation: null })
          }
        }
      }

      if (allGaps.length > 0) {
        const { data: explanations } = await supabase
          .from('voucher_gap_explanations')
          .select('id, voucher_series, gap_start, gap_end, explanation, created_at')
          .eq('company_id', companyId).eq('fiscal_period_id', fiscalPeriodId)
        if (explanations) {
          const map = new Map(explanations.map((e) => [`${e.voucher_series}:${e.gap_start}:${e.gap_end}`, e]))
          for (const g of allGaps) {
            g.explanation = map.get(`${g.series}:${g.gap_start}:${g.gap_end}`) ?? null
          }
        }
      }

      return {
        gaps: allGaps,
        total_gaps: allGaps.length,
        unexplained_gaps: allGaps.filter((g) => !g.explanation).length,
      }
    },
  },

  {
    name: 'gnubok_explain_voucher_gap',
    description: 'Stage explanation for a voucher gap (BFNAR 2013:2 compliance — every gap needs a documented reason).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string' },
        voucher_series: { type: 'string' },
        gap_start: { type: 'number' },
        gap_end: { type: 'number' },
        explanation: { type: 'string', description: 'Swedish prose: why the gap exists' },
      },
      required: ['fiscal_period_id', 'voucher_series', 'gap_start', 'gap_end', 'explanation'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const explanation = args.explanation as string
      if (!explanation?.trim()) throw new Error('explanation is required')

      return stagePendingOperation(supabase, companyId, userId, 'explain_voucher_gap',
        `Förklara verifikationslucka ${args.voucher_series}:${args.gap_start}-${args.gap_end}`,
        {
          fiscal_period_id: args.fiscal_period_id,
          voucher_series: args.voucher_series,
          gap_start: args.gap_start,
          gap_end: args.gap_end,
          explanation: explanation.trim(),
        },
        {
          voucher_series: args.voucher_series,
          gap_start: args.gap_start,
          gap_end: args.gap_end,
          explanation: explanation.trim(),
        },
        actor,
        {
          description: 'After approval, run gnubok_list_voucher_gaps again to confirm all gaps in the period now have explanations (BFNAR 2013:2).',
          tool: 'gnubok_list_voucher_gaps',
          args: { fiscal_period_id: args.fiscal_period_id },
        }
      )
    },
  },

  {
    name: 'gnubok_approve_supplier_invoice',
    description: 'Stage approval of a registered supplier invoice (registered → approved). High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { supplier_invoice_id: { type: 'string' } },
      required: ['supplier_invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.supplier_invoice_id as string
      if (!id) throw new Error('supplier_invoice_id is required')

      const { data: inv } = await supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date, total, currency, status, supplier:suppliers(name)')
        .eq('id', id).eq('company_id', companyId).single()
      if (!inv) throw new Error('Supplier invoice not found')
      if (inv.status !== 'registered') throw new Error('Kan bara godkänna registrerade fakturor')

      return stagePendingOperation(supabase, companyId, userId, 'approve_supplier_invoice',
        `Godkänn leverantörsfaktura ${inv.supplier_invoice_number}`,
        { supplier_invoice_id: id },
        {
          supplier_invoice_number: inv.supplier_invoice_number,
          supplier_name: (inv.supplier as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          invoice_date: inv.invoice_date,
        },
        actor,
        {
          description: 'After approval the invoice is attested and ready for payment. When paid, match the outbound bank transaction via gnubok_match_transaction_to_invoice.',
          tool: 'gnubok_get_supplier_ledger',
        },
        inv.invoice_date ? { dateForPeriodCheck: inv.invoice_date } : {},
      )
    },
  },

  {
    name: 'gnubok_credit_supplier_invoice',
    description: 'Stage credit-note (kreditfaktura) for a supplier invoice: mirror invoice with negative effect + reverses registration JE (accrual).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { supplier_invoice_id: { type: 'string' } },
      required: ['supplier_invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.supplier_invoice_id as string
      if (!id) throw new Error('supplier_invoice_id is required')

      const { data: inv } = await supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, total, currency, status, supplier:suppliers(name)')
        .eq('id', id).eq('company_id', companyId).single()
      if (!inv) throw new Error('Supplier invoice not found')
      if (inv.status === 'credited') throw new Error('Fakturan har redan krediterats')

      return stagePendingOperation(supabase, companyId, userId, 'credit_supplier_invoice',
        `Kreditera leverantörsfaktura ${inv.supplier_invoice_number}`,
        { supplier_invoice_id: id },
        {
          supplier_invoice_number: inv.supplier_invoice_number,
          supplier_name: (inv.supplier as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          method: 'creates KREDIT- mirror invoice + reverses registration JE (accrual)',
        },
        actor,
        {
          description: 'After approval the credit note is posted and the leverantörsskuld cleared. Verify with gnubok_get_supplier_ledger.',
          tool: 'gnubok_get_supplier_ledger',
        }
      )
    },
  },

  {
    name: 'gnubok_convert_invoice',
    description: 'Stage conversion of a proforma invoice to a real invoice. Allocates F-series number, copies items, marks proforma cancelled.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { invoice_id: { type: 'string' } },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.invoice_id as string
      if (!id) throw new Error('invoice_id is required')

      const { data: inv } = await supabase
        .from('invoices')
        .select('id, document_type, status, total, currency, customer:customers(name)')
        .eq('id', id).eq('company_id', companyId).single()
      if (!inv) throw new Error('Invoice not found')
      if (inv.document_type !== 'proforma') throw new Error('Endast proformafakturor kan konverteras')
      if (inv.status === 'cancelled') throw new Error('Denna proformafaktura har redan makuleras')

      const customerName = (inv.customer as { name?: string } | null)?.name ?? 'okänd kund'
      return stagePendingOperation(supabase, companyId, userId, 'convert_invoice',
        `Konvertera proforma → faktura: ${customerName} ${Math.round(Number(inv.total) * 100) / 100} ${inv.currency}`,
        { invoice_id: id },
        {
          customer_name: (inv.customer as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          will: 'allocate F-series number, copy items, cancel proforma',
        },
        actor,
        {
          description: 'After conversion, send the new invoice with gnubok_send_invoice.',
          tool: 'gnubok_send_invoice',
        }
      )
    },
  },

  {
    name: 'gnubok_unlock_period',
    description: 'Stage period unlock — clears locked_at so entries can be posted again. Cannot unlock a closed period. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to unlock' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period, error: fetchError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Cannot unlock a closed period')
      if (!period.locked_at) throw new Error('Period is not locked')

      return stagePendingOperation(supabase, companyId, userId, 'unlock_period',
        `Lås upp period: ${period.name} (${period.period_start} – ${period.period_end})`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          locked_at: period.locked_at,
          will: 'clear locked_at — new entries can be posted into the period again',
        },
        actor,
        {
          description: 'After approval, post the rättelse via gnubok_correct_entry or new entries via gnubok_create_voucher, then re-lock with gnubok_lock_period.',
          tool: 'gnubok_lock_period',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_credit_invoice',
    description: 'Stage credit note (kreditfaktura) for a customer invoice: KR- prefixed mirror invoice + reverses original JE (accrual). Original must be sent/paid/overdue and not already credited.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to credit' },
        reason: { type: 'string', description: 'Optional reason note (Swedish, shown on the credit note)' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.invoice_id as string
      const reason = args.reason as string | undefined
      if (!id) throw new Error('invoice_id is required')

      const { data: inv } = await supabase
        .from('invoices')
        .select('id, invoice_number, document_type, status, total, currency, customer:customers(name)')
        .eq('id', id).eq('company_id', companyId).single()

      if (!inv) throw new Error('Invoice not found')
      if (inv.document_type && inv.document_type !== 'invoice') {
        throw new Error('Credit notes can only be created from standard invoices')
      }
      if (inv.status === 'credited') throw new Error('Fakturan har redan krediterats')
      if (!['sent', 'paid', 'overdue'].includes(inv.status)) {
        throw new Error('Endast skickade, betalda eller förfallna fakturor kan krediteras')
      }

      return stagePendingOperation(supabase, companyId, userId, 'credit_invoice',
        `Kreditera faktura ${inv.invoice_number}`,
        { invoice_id: id, reason },
        {
          invoice_number: inv.invoice_number,
          customer_name: (inv.customer as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          reason: reason || null,
          method: 'creates KR- mirror invoice + reverses original JE (accrual)',
        },
        actor,
        {
          description: 'After approval the credit note posts and the kundfordring is cleared. If a refund is owed to the customer, book the outbound payment when it leaves the bank.',
          tool: 'gnubok_get_ar_ledger',
        }
      )
    },
  },

  {
    name: 'gnubok_import_sie',
    description: 'Stage SIE-file import (types 1–4, CP437/UTF-8/Latin-1). On commit creates fiscal period, opening balances, and journal entries. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_content: { type: 'string', description: 'Full SIE file contents' },
        filename: { type: 'string', description: 'Original filename' },
        mappings: {
          type: 'array',
          description: 'Account mappings: { sourceAccount, sourceName, targetAccount, targetName, confidence, matchType, isOverride }',
          items: { type: 'object' },
        },
        create_fiscal_period: { type: 'boolean' },
        import_opening_balances: { type: 'boolean' },
        import_transactions: { type: 'boolean' },
        voucher_series: { type: 'string', description: 'Override voucher series for imported vouchers' },
      },
      required: ['file_content', 'filename', 'mappings'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fileContent = args.file_content as string
      const filename = args.filename as string
      const mappings = args.mappings as unknown[] | undefined

      if (!fileContent || !filename || !Array.isArray(mappings)) {
        throw new Error('file_content, filename, and mappings are required')
      }

      // Parse + validate at stage time so the approver sees real content (which
      // entries, what balances) and a broken/unbalanced file is rejected HERE,
      // not after they approve a blind byte count. commitImportSie re-parses on
      // commit (defense-in-depth — the staged string could be tampered).
      const { parseSIEFile, validateSIEFile } = await import('@/lib/import/sie-parser')
      let parsed
      try {
        parsed = parseSIEFile(fileContent)
      } catch (e) {
        throw new Error(`SIE-filen kunde inte tolkas: ${e instanceof Error ? e.message : 'okänt fel'}`)
      }
      const validation = validateSIEFile(parsed)
      if (!validation.valid) {
        throw new Error(`SIE-filen är ogiltig och importeras inte: ${validation.errors.join('; ')}`)
      }

      const ibCurrent = parsed.openingBalances.filter((b) => b.yearIndex === 0)
      const ibTotal = Math.round(ibCurrent.reduce((s, b) => s + b.amount, 0) * 100) / 100

      // Mapping-coverage check. The executor's per-voucher loop silently
      // skips any line whose account is not in `mappings`, so an empty or
      // non-overlapping mapping set produces a committed import with
      // journal_entries_created=0 that then claims the (company_id,
      // file_hash) slot in the partial unique index and blocks retry.
      // Refuse to stage when the mapping wouldn't cover a single account
      // present in the file.
      const importOB = Boolean(args.import_opening_balances)
      const sourceAccountsInFile = new Set<string>()
      for (const v of parsed.vouchers) for (const l of v.lines) sourceAccountsInFile.add(l.account)
      if (importOB) for (const b of ibCurrent) sourceAccountsInFile.add(b.account)
      const mappedSources = new Set(
        (mappings as Array<{ sourceAccount?: unknown; targetAccount?: unknown }>)
          .filter((m) => typeof m?.targetAccount === 'string' && m.targetAccount.length > 0 && typeof m?.sourceAccount === 'string')
          .map((m) => m.sourceAccount as string),
      )
      const coveredAccounts = [...sourceAccountsInFile].filter((a) => mappedSources.has(a))
      const accountsMapped = { covered: coveredAccounts.length, total: sourceAccountsInFile.size }
      const wouldSkipAllVouchers = sourceAccountsInFile.size > 0 && coveredAccounts.length === 0

      if (wouldSkipAllVouchers) {
        const sample = [...sourceAccountsInFile].slice(0, 8).join(', ')
        throw new Error(
          `Kontomappningarna täcker inga konton i SIE-filen — alla ` +
            `${parsed.stats.totalVouchers} verifikationer skulle hoppas över ` +
            `och importen skulle skapa 0 verifikat. Filen innehåller ` +
            `${sourceAccountsInFile.size} unika källkonton (t.ex. ${sample}). ` +
            `Bifoga "mappings" där sourceAccount matchar #KONTO-numren i filen ` +
            `och targetAccount är ett giltigt BAS-konto.`,
        )
      }

      return stagePendingOperation(supabase, companyId, userId, 'import_sie',
        `SIE-import: ${filename}`,
        {
          file_content: fileContent,
          filename,
          mappings,
          create_fiscal_period: Boolean(args.create_fiscal_period),
          import_opening_balances: Boolean(args.import_opening_balances),
          import_transactions: Boolean(args.import_transactions),
          voucher_series: args.voucher_series,
        },
        {
          filename,
          file_size_bytes: fileContent.length,
          mappings_count: mappings.length,
          accounts_mapped: accountsMapped,
          would_skip_all_vouchers: wouldSkipAllVouchers,
          company_name: parsed.header.companyName,
          org_number: parsed.header.orgNumber,
          fiscal_year: { start: parsed.stats.fiscalYearStart, end: parsed.stats.fiscalYearEnd },
          account_count: parsed.stats.totalAccounts,
          voucher_count: parsed.stats.totalVouchers,
          transaction_line_count: parsed.stats.totalTransactionLines,
          opening_balance: { total: ibTotal, is_balanced: ibTotal === 0 },
          warnings: validation.warnings,
          create_fiscal_period: Boolean(args.create_fiscal_period),
          import_opening_balances: Boolean(args.import_opening_balances),
          import_transactions: Boolean(args.import_transactions),
          will: 'create fiscal period + opening balances + journal entries from the parsed SIE',
        },
        actor,
        {
          description: 'After commit, verify the imported balances with gnubok_get_trial_balance and check continuity via the IB/UB of adjacent periods.',
          tool: 'gnubok_get_trial_balance',
        }
      )
    },
  },

  {
    name: 'gnubok_undo_sie_import',
    description: 'Stage undo of a completed SIE import: hard-deletes its entries (transactions + opening balance), detaches docs, resets voucher_sequences, marks the row \'undone\' so the file can be re-imported. Use after a botched import. Period must be open. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        import_id: { type: 'string', description: 'UUID of the sie_imports row to undo. Must be status=\'completed\'.' },
        reason: { type: 'string', maxLength: 500, description: 'Optional human-readable reason — shown in pending_operations review.' },
      },
      required: ['import_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const importId = args.import_id as string
      const reason = typeof args.reason === 'string' ? args.reason : undefined

      if (!importId) throw new Error('import_id is required')
      if (reason !== undefined && reason.length > 500) {
        throw new Error('reason must be 500 characters or fewer')
      }

      // Pre-flight mirrors undoSIEImport: confirm row exists, belongs to
      // this company, is in 'completed' status, and (if linked) the fiscal
      // period is open + unlocked. Surfacing rejection at stage-time keeps
      // the agent honest about what the approver is being asked to confirm.
      type ImportRow = {
        id: string
        filename: string
        fiscal_year_start: string | null
        fiscal_year_end: string | null
        transactions_count: number | null
        opening_balance_entry_id: string | null
        status: string
        fiscal_period_id: string | null
        imported_at: string | null
      }
      const { data, error: lookupErr } = await supabase
        .from('sie_imports')
        .select('id, filename, fiscal_year_start, fiscal_year_end, transactions_count, opening_balance_entry_id, status, fiscal_period_id, imported_at')
        .eq('id', importId)
        .eq('company_id', companyId)
        .maybeSingle()
      const importRow = data as ImportRow | null

      if (lookupErr) {
        throw new Error(`Kunde inte slå upp SIE-import ${importId}: ${lookupErr.message}`)
      }
      if (!importRow) {
        throw new Error(`SIE-import hittades inte: ${importId}`)
      }
      if (importRow.status !== 'completed') {
        throw new Error(`Bara slutförda importer kan ångras (nuvarande status: ${importRow.status}).`)
      }

      let fiscalPeriodName: string | null = null
      if (importRow.fiscal_period_id) {
        const { data: period } = await supabase
          .from('fiscal_periods')
          .select('name, is_closed, locked_at')
          .eq('id', importRow.fiscal_period_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (period?.is_closed || period?.locked_at) {
          throw new Error(
            `Räkenskapsåret "${period.name ?? 'okänt'}" är låst eller stängt. ` +
            `Öppna perioden innan du ångrar importen.`,
          )
        }
        fiscalPeriodName = (period as { name?: string } | null)?.name ?? null
      }

      return stagePendingOperation(supabase, companyId, userId, 'undo_sie_import',
        `Ångra SIE-import: ${importRow.filename}`,
        { import_id: importId },
        {
          import: {
            id: importRow.id,
            filename: importRow.filename,
            fiscal_year: { start: importRow.fiscal_year_start, end: importRow.fiscal_year_end },
            fiscal_period_name: fiscalPeriodName,
            transactions_count: importRow.transactions_count ?? 0,
            has_opening_balance_entry: Boolean(importRow.opening_balance_entry_id),
            imported_at: importRow.imported_at,
          },
          reason: reason ?? null,
          will: 'hard-delete the import\'s journal entries (transactions + opening balance), detach user-attached documents, reset voucher_sequences, and mark the sie_imports row as \'undone\' so the file can be re-imported',
        },
        actor,
        {
          description: 'After commit, re-stage the SIE import with corrected mappings via gnubok_import_sie.',
          tool: 'gnubok_import_sie',
        },
      )
    },
  },

  // ── Phase 4: arbitrary-line bookkeeping primitives ───────────────

  {
    name: 'gnubok_create_voucher',
    description: 'Stage a manual verifikation with arbitrary balanced lines. Use for capitalization (1010), period-end accruals, FX adjustments, rättelseposter outside categorize_transaction. Pass inbox_item_id to book a kvitto direct — links inbox + attaches doc. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry_date: { type: 'string', description: 'Voucher date (YYYY-MM-DD)' },
        description: { type: 'string', description: 'Verifikationstext (required, min 1 char)' },
        fiscal_period_id: { type: 'string', description: 'UUID of fiscal period. If omitted, resolved from entry_date.' },
        voucher_series: { type: 'string', description: 'Single letter A–Z. Defaults to A.' },
        notes: { type: 'string', description: 'Internal notes (max 2000 chars) — visible on the verifikation but not on reports.' },
        inbox_item_id: { type: 'string', description: 'Optional inbox item UUID to book directly. On confirm, the inbox item is linked to the new verifikat and its OCR document is attached to the journal entry. Fails if the inbox item is already booked (as voucher) or converted (to supplier invoice).' },
        lines: {
          type: 'array',
          description: 'At least 2 balanced lines. sum(debit_amount) === sum(credit_amount), both > 0.',
          items: {
            type: 'object',
            properties: {
              account_number: { type: 'string', description: '4-digit BAS account number, e.g. "1010"' },
              debit_amount: { type: 'number', description: 'Debit amount in SEK (≥ 0)' },
              credit_amount: { type: 'number', description: 'Credit amount in SEK (≥ 0)' },
              line_description: { type: 'string' },
              currency: { type: 'string', description: 'ISO 4217, defaults to SEK' },
              amount_in_currency: { type: 'number', description: 'Original amount if currency is not SEK' },
              exchange_rate: { type: 'number' },
              tax_code: { type: 'string', description: 'Free-text tag — does NOT drive momsdeklaration ruta mapping. The BAS account number is what determines which ruta the line lands in (e.g. 2641 → ruta 48, 2614 → ruta 30). Pick the correct account first.' },
              cost_center: { type: 'string' },
              project: { type: 'string' },
            },
            required: ['account_number'],
          },
        },
      },
      required: ['entry_date', 'description', 'lines'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const entryDate = args.entry_date as string
      const description = args.description as string
      const rawLines = args.lines as Array<Record<string, unknown>> | undefined

      if (!entryDate || !description || !Array.isArray(rawLines) || rawLines.length < 2) {
        throw new Error('entry_date, description, and at least two lines are required')
      }

      // Normalize so validateBalance + preview see consistent numeric types.
      const lines = rawLines.map((l) => ({
        account_number: String(l.account_number ?? ''),
        debit_amount: Number(l.debit_amount) || 0,
        credit_amount: Number(l.credit_amount) || 0,
        line_description: l.line_description ? String(l.line_description) : undefined,
        currency: l.currency ? String(l.currency) : undefined,
        amount_in_currency: l.amount_in_currency !== undefined ? Number(l.amount_in_currency) : undefined,
        exchange_rate: l.exchange_rate !== undefined ? Number(l.exchange_rate) : undefined,
        tax_code: l.tax_code ? String(l.tax_code) : undefined,
        cost_center: l.cost_center ? String(l.cost_center) : undefined,
        project: l.project ? String(l.project) : undefined,
      }))

      // Pre-flight: catch unbalanced lines before staging so the agent gets a
      // tight feedback loop instead of a rejected pending_operation later.
      const balance = validateBalance(lines)
      if (!balance.valid) {
        throw new Error(
          `Lines are not balanced: debits ${balance.totalDebit} SEK, credits ${balance.totalCredit} SEK. ` +
          'Both must be positive and equal.'
        )
      }

      // Resolve fiscal period. Two paths:
      //   1. Caller supplied fiscal_period_id → verify it exists and is open.
      //   2. Omitted → look up the open period covering entry_date.
      // Both paths converge on a Swedish-language error if no valid open
      // period is available. (NOTE: the executor re-checks period_lock at
      // commit time — this staging gate is advisory and exists for UX, the
      // commit-time guard is the authoritative one. Don't remove it as
      // "redundant".)
      let fiscalPeriodId = (args.fiscal_period_id as string | undefined) ?? null
      if (fiscalPeriodId) {
        const { data: period, error: periodErr } = await supabase
          .from('fiscal_periods')
          .select('id, is_closed, period_start, period_end, name')
          .eq('id', fiscalPeriodId)
          .eq('company_id', companyId)
          .maybeSingle()
        if (periodErr || !period) {
          throw new Error(`Fiscal period ${fiscalPeriodId} not found for this company.`)
        }
        if (period.is_closed) {
          throw new Error(
            `Räkenskapsperioden "${period.name ?? fiscalPeriodId}" är låst. ` +
            'Lås upp perioden, eller välj en öppen period.'
          )
        }
        // Defense in depth: also verify the supplied period actually covers
        // entry_date so the engine's EntryDateOutsideFiscalPeriodError surfaces
        // as a Swedish message rather than a generic engine error.
        if (entryDate < period.period_start || entryDate > period.period_end) {
          throw new Error(
            `Datumet ${entryDate} ligger utanför "${period.name ?? 'perioden'}" (${period.period_start}–${period.period_end}).`
          )
        }
      } else {
        fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
      }
      if (!fiscalPeriodId) {
        throw new Error(`No open fiscal period covers ${entryDate}. Open a period or pick a different date.`)
      }

      // Resolve account names for the preview so the approver reads
      // "1010 Balanserade utgifter / 2440 Leverantörsskulder" rather than
      // bare numbers. Also gate: refuse to stage when any line references an
      // unknown or inactive account so the approver isn't shown a voucher
      // that would fail at commit time anyway.
      const accountNumbers = [...new Set(lines.map((l) => l.account_number))]
      const { data: accounts } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, is_active')
        .eq('company_id', companyId)
        .in('account_number', accountNumbers)
      const accountInfo = new Map<string, { name: string; active: boolean }>()
      for (const a of accounts || []) {
        accountInfo.set(a.account_number as string, {
          name: (a.account_name as string) ?? '',
          active: Boolean(a.is_active),
        })
      }
      const unknownAccounts = accountNumbers.filter((n) => !accountInfo.has(n))
      const inactiveAccounts = accountNumbers.filter(
        (n) => accountInfo.has(n) && !accountInfo.get(n)!.active,
      )
      if (unknownAccounts.length > 0 || inactiveAccounts.length > 0) {
        const parts: string[] = []
        if (unknownAccounts.length > 0) {
          parts.push(`saknas i kontoplanen: ${unknownAccounts.join(', ')}`)
        }
        if (inactiveAccounts.length > 0) {
          parts.push(`inaktiva: ${inactiveAccounts.join(', ')}`)
        }
        throw new Error(
          `Kan inte skapa verifikation. Konton ${parts.join('; ')}. ` +
          'Aktivera dem i kontoplanen eller välj andra konton.'
        )
      }

      const previewLines = lines.map((l) => ({
        account_number: l.account_number,
        account_name: accountInfo.get(l.account_number)?.name ?? null,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description ?? null,
      }))

      // Optional inbox-direct booking. Validate at staging so the agent gets a
      // tight rejection signal — once staged, an already-booked inbox item
      // would only surface at commit time with a generic 409. The executor
      // re-checks idempotently via UNIQUE constraint on
      // invoice_inbox_items.created_journal_entry_id.
      const inboxItemId = (args.inbox_item_id as string | undefined) ?? null
      let inboxDocumentId: string | null = null
      if (inboxItemId) {
        const { data: inbox, error: inboxErr } = await supabase
          .from('invoice_inbox_items')
          .select('id, document_id, created_journal_entry_id, created_supplier_invoice_id')
          .eq('id', inboxItemId)
          .eq('company_id', companyId)
          .single()
        if (inboxErr || !inbox) {
          throw new Error(`Inbox item ${inboxItemId} not found for this company.`)
        }
        if (inbox.created_journal_entry_id) {
          throw new Error(
            `Inbox item is already booked as journal entry ${inbox.created_journal_entry_id}. ` +
            'Use gnubok_correct_entry or gnubok_reverse_entry if it needs to be changed.'
          )
        }
        if (inbox.created_supplier_invoice_id) {
          throw new Error(
            `Inbox item is already converted to supplier invoice ${inbox.created_supplier_invoice_id}. ` +
            'Cancel that path before booking it as a verifikat.'
          )
        }
        inboxDocumentId = (inbox.document_id as string | null) ?? null
      }

      // NOTE: source_type is intentionally NOT included in the staged params.
      // The executor hardcodes 'manual' so a tampered or future direct-staged
      // pending_operations row can't misrepresent the entry's origin.
      return stagePendingOperation(supabase, companyId, userId, 'create_voucher',
        `Manuell verifikation: ${description}`,
        {
          entry_date: entryDate,
          description,
          fiscal_period_id: fiscalPeriodId,
          voucher_series: (args.voucher_series as string) || undefined,
          notes: (args.notes as string) || undefined,
          inbox_item_id: inboxItemId,
          document_id: inboxDocumentId,
          lines,
        },
        {
          entry_date: entryDate,
          description,
          fiscal_period_id: fiscalPeriodId,
          voucher_series: (args.voucher_series as string) || 'A',
          total_debit: balance.totalDebit,
          total_credit: balance.totalCredit,
          line_count: lines.length,
          lines: previewLines,
          inbox_item_id: inboxItemId,
          document_attached: Boolean(inboxDocumentId),
          will: inboxItemId
            ? 'create a posted journal entry with a fresh sequential voucher number, link the inbox item to it, and attach the OCR document to the verifikat'
            : 'create a posted journal entry with a fresh sequential voucher number',
        },
        actor,
        {
          description: 'After commit, confirm the new verifikation lands on the right accounts with gnubok_get_general_ledger or gnubok_query_journal.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: entryDate },
      )
    },
  },

  {
    name: 'gnubok_correct_entry',
    description: 'Stage a rättelse for a posted verifikation per BFL 5 kap 5§ — storno + new corrected entry in the original period (never in-place edit). Use for partial fixes like 2641 → 2614/2645 while preserving the expense leg. Account drives momsdeklaration ruta, not tax_code. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry_id: { type: 'string', description: 'Journal entry UUID OR voucher ref like "A-113". Prefer voucher refs: UUIDs reused from earlier tool output are frequently hallucinated by LLM callers.' },
        lines: {
          type: 'array',
          description: 'Replacement lines (≥ 2, balanced). Use the same accounts as the original where unchanged.',
          items: {
            type: 'object',
            properties: {
              account_number: { type: 'string' },
              debit_amount: { type: 'number' },
              credit_amount: { type: 'number' },
              line_description: { type: 'string' },
              currency: { type: 'string' },
              amount_in_currency: { type: 'number' },
              exchange_rate: { type: 'number' },
              tax_code: { type: 'string', description: 'Free-text tag — does NOT drive momsdeklaration ruta. Pick the correct BAS account first.' },
              cost_center: { type: 'string' },
              project: { type: 'string' },
            },
            required: ['account_number'],
          },
        },
      },
      required: ['entry_id', 'lines'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const entryRef = args.entry_id as string
      const rawLines = args.lines as Array<Record<string, unknown>> | undefined

      if (!entryRef || !Array.isArray(rawLines) || rawLines.length < 2) {
        throw new Error('entry_id and at least two lines are required')
      }

      const lines = rawLines.map((l) => ({
        account_number: String(l.account_number ?? ''),
        debit_amount: Number(l.debit_amount) || 0,
        credit_amount: Number(l.credit_amount) || 0,
        line_description: l.line_description ? String(l.line_description) : undefined,
        currency: l.currency ? String(l.currency) : undefined,
        amount_in_currency: l.amount_in_currency !== undefined ? Number(l.amount_in_currency) : undefined,
        exchange_rate: l.exchange_rate !== undefined ? Number(l.exchange_rate) : undefined,
        tax_code: l.tax_code ? String(l.tax_code) : undefined,
        cost_center: l.cost_center ? String(l.cost_center) : undefined,
        project: l.project ? String(l.project) : undefined,
      }))

      const balance = validateBalance(lines)
      if (!balance.valid) {
        throw new Error(
          `Correction lines not balanced: debits ${balance.totalDebit}, credits ${balance.totalCredit}. ` +
          'Both must be positive and equal.'
        )
      }

      const entryId = await resolveJournalEntryRef(supabase, companyId, entryRef)

      // Pre-flight: the executor checks again, but failing fast here gives the
      // agent a clearer error message than waiting until commit-time.
      // The Supabase types don't infer through `fiscal_periods!inner(...)`,
      // so we type the row shape manually rather than fight the generics.
      type OriginalRow = {
        id: string
        status: string
        entry_date: string
        description: string
        voucher_number: number
        voucher_series: string
        fiscal_period_id: string
        fiscal_periods: { name?: string; is_closed?: boolean; locked_at?: string | null } | { name?: string; is_closed?: boolean; locked_at?: string | null }[] | null
        lines: Array<{
          account_number: string
          debit_amount: number | string
          credit_amount: number | string
          line_description: string | null
        }> | null
      }
      const { data, error: origErr } = await supabase
        .from('journal_entries')
        .select(
          'id, status, entry_date, description, voucher_number, voucher_series, fiscal_period_id, ' +
          'fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(name, is_closed, locked_at), lines:journal_entry_lines(account_number, debit_amount, credit_amount, line_description)'
        )
        .eq('id', entryId)
        .eq('company_id', companyId)
        .maybeSingle()
      const original = data as OriginalRow | null

      if (origErr) {
        throw new Error(`Database error looking up journal entry ${entryId}: ${origErr.message}`)
      }
      if (!original) {
        throw new Error(
          `Journal entry not found: id=${entryId}. ` +
          `If this UUID came from an earlier tool result, re-fetch via gnubok_query_journal — ` +
          `UUIDs are frequently hallucinated when reused across turns. You can also pass a voucher ref like "A-113".`
        )
      }
      if (original.status !== 'posted') {
        throw new Error(`Only posted entries can be corrected. Current status: ${original.status}.`)
      }
      const periodInfo = Array.isArray(original.fiscal_periods)
        ? original.fiscal_periods[0]
        : original.fiscal_periods
      if (periodInfo?.is_closed || periodInfo?.locked_at) {
        throw new Error(
          `Fiscal period "${periodInfo.name ?? 'okänd'}" is locked or closed. Unlock the period, or use omprövning for already-filed VAT.`
        )
      }

      const originalLines = original.lines || []

      return stagePendingOperation(supabase, companyId, userId, 'correct_entry',
        `Rättelse: V${original.voucher_series}${original.voucher_number} — ${original.description}`,
        {
          entry_id: entryId,
          lines,
        },
        {
          original: {
            entry_id: entryId,
            voucher: `${original.voucher_series}${original.voucher_number}`,
            entry_date: original.entry_date,
            description: original.description,
            lines: originalLines.map((l) => ({
              account_number: l.account_number,
              debit_amount: Number(l.debit_amount),
              credit_amount: Number(l.credit_amount),
              line_description: l.line_description,
            })),
          },
          correction: {
            total_debit: balance.totalDebit,
            total_credit: balance.totalCredit,
            line_count: lines.length,
            lines: lines.map((l) => ({
              account_number: l.account_number,
              debit_amount: l.debit_amount,
              credit_amount: l.credit_amount,
              line_description: l.line_description ?? null,
            })),
          },
          will: 'post a storno that mirrors the original, then post a new corrected entry, then mark the original as reversed (BFL 5 kap 5§)',
        },
        actor,
        {
          description: 'After commit, the original is marked reversed and a corrected verifikation lands in its place. Confirm both with gnubok_query_journal.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: original.entry_date },
      )
    },
  },

  {
    name: 'gnubok_reverse_journal_entry',
    description: 'Stage a storno: inverts debits/credits; original stays visible per BFL 5 kap. Use only when the affärshändelse should never have been booked (duplicate, ghost, test). If booked wrong, use gnubok_correct_entry; for refunds, gnubok_credit_invoice. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry_id: { type: 'string', description: 'Journal entry UUID OR voucher ref like "A-113". Prefer voucher refs: UUIDs reused from earlier tool output are frequently hallucinated by LLM callers.' },
        reversal_date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Optional ISO yyyy-MM-dd date for the storno verifikation. Defaults to today (Swedish timezone). Period attribution always follows the original entry, regardless of this date.' },
        reason: { type: 'string', maxLength: 500, description: 'Optional human-readable reason — shown in pending_operations review. Not stored on the storno itself. Max 500 chars.' },
      },
      required: ['entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const entryRef = args.entry_id as string
      const reversalDate = typeof args.reversal_date === 'string' ? args.reversal_date : undefined
      const reason = typeof args.reason === 'string' ? args.reason : undefined

      if (!entryRef) {
        throw new Error('entry_id is required')
      }
      // Belt-and-braces runtime check: inputSchema declares the pattern, but the
      // MCP dispatcher does not always enforce it — validate again here so a
      // malformed date never reaches the pending_operations payload.
      if (reversalDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(reversalDate)) {
        throw new Error('reversal_date must be ISO yyyy-MM-dd')
      }
      if (reason !== undefined && reason.length > 500) {
        throw new Error('reason must be 500 characters or fewer')
      }

      const entryId = await resolveJournalEntryRef(supabase, companyId, entryRef)

      // Pre-flight mirrors commitReverseEntry: posted + period not closed/locked.
      // Failing fast gives a clearer Swedish error than waiting until commit-time.
      // Both is_closed and locked_at are checked so the staging-time signal
      // matches the commit-time gate; without locked_at, an agent could see
      // staged:true with period_status:locked and only discover the rejection
      // at commit time.
      type OriginalRow = {
        id: string
        status: string
        entry_date: string
        description: string
        voucher_number: number
        voucher_series: string
        fiscal_period_id: string
        fiscal_periods: { name?: string; is_closed?: boolean; locked_at?: string | null } | { name?: string; is_closed?: boolean; locked_at?: string | null }[] | null
        lines: Array<{
          account_number: string
          debit_amount: number | string
          credit_amount: number | string
          line_description: string | null
        }> | null
      }
      const { data, error: origErr } = await supabase
        .from('journal_entries')
        .select(
          'id, status, entry_date, description, voucher_number, voucher_series, fiscal_period_id, ' +
          'fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(name, is_closed, locked_at), lines:journal_entry_lines(account_number, debit_amount, credit_amount, line_description)'
        )
        .eq('id', entryId)
        .eq('company_id', companyId)
        .maybeSingle()
      const original = data as OriginalRow | null

      if (origErr) {
        throw new Error(`Database error looking up journal entry ${entryId}: ${origErr.message}`)
      }
      if (!original) {
        throw new Error(
          `Journal entry not found: id=${entryId}. ` +
          `If this UUID came from an earlier tool result, re-fetch via gnubok_query_journal — ` +
          `UUIDs are frequently hallucinated when reused across turns. You can also pass a voucher ref like "A-113".`
        )
      }
      if (original.status !== 'posted') {
        throw new Error(`Only posted entries can be reversed. Current status: ${original.status}.`)
      }
      const periodInfo = Array.isArray(original.fiscal_periods)
        ? original.fiscal_periods[0]
        : original.fiscal_periods
      if (periodInfo?.is_closed || periodInfo?.locked_at) {
        throw new Error(
          `Fiscal period "${periodInfo.name ?? 'okänd'}" is locked or closed. Unlock the period, or use omprövning for already-filed VAT.`
        )
      }

      const originalLines = original.lines || []
      const reversedPreviewLines = originalLines.map((l) => ({
        account_number: l.account_number,
        debit_amount: Number(l.credit_amount),
        credit_amount: Number(l.debit_amount),
        line_description: `Reversal: ${l.line_description ?? ''}`,
      }))

      // If the original touches output/input VAT accounts (2610–2670), a storno
      // is correct ONLY if the moms period covering entry_date has not yet been
      // filed with Skatteverket. For filed periods the legal path is an
      // omprövning (rättelse-omprövning per ML 2023:200, SFL 22 kap). gnubok
      // doesn't track per-VAT-period filing status today, so we surface a
      // soft warning rather than block — the human approver decides.
      const vatAccounts = originalLines
        .map((l) => l.account_number)
        .filter((acc) => /^26[1-7]\d$/.test(acc))
      const vatWarning = vatAccounts.length > 0
        ? `Original innehåller momskonton (${[...new Set(vatAccounts)].join(', ')}). Om momsperioden är inlämnad till Skatteverket krävs omprövning (ML 2023:200) — storno räcker inte. Bekräfta att perioden inte är inlämnad innan godkännande.`
        : null

      return stagePendingOperation(supabase, companyId, userId, 'reverse_entry',
        `Makulering: V${original.voucher_series}${original.voucher_number} — ${original.description}`,
        {
          entry_id: entryId,
          reversal_date: reversalDate,
        },
        {
          original: {
            entry_id: entryId,
            voucher: `${original.voucher_series}${original.voucher_number}`,
            entry_date: original.entry_date,
            description: original.description,
            lines: originalLines.map((l) => ({
              account_number: l.account_number,
              debit_amount: Number(l.debit_amount),
              credit_amount: Number(l.credit_amount),
              line_description: l.line_description,
            })),
          },
          reversal: {
            entry_date: reversalDate ?? null,
            fiscal_period_id: original.fiscal_period_id,
            line_count: reversedPreviewLines.length,
            lines: reversedPreviewLines,
          },
          reason: reason ?? null,
          ...(vatWarning ? { warnings: [vatWarning] } : {}),
          will: 'post a storno that mirrors the original with debits and credits swapped, link via reverses_id, and leave the original visible (BFL 5 kap, makulering)',
        },
        actor,
        {
          description: 'After commit, the storno is posted and the original stays visible. Confirm with gnubok_query_journal.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: original.entry_date },
      )
    },
  },

  // ─── Phase 4-7: bokslut wizard surfaces exposed to agents ───────────

  {
    name: 'gnubok_propose_dispositioner',
    description:
      'Read-only proposal of bokslutsdispositioner for a fiscal period: periodiseringsfond (avsättning + obligatorisk återföring), överavskrivningar, SLP, bolagsskatt. Call before staging postings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    // Output is the same DispositionsProposal shape returned by GET
    // /bokslutsdispositioner — surface as a permissive object so the
    // strict-schema test passes without duplicating the type tree here.
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { buildDispositionsProposal } = await import('@/lib/bokslut/dispositions-proposal-builder')
      return buildDispositionsProposal(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_propose_accruals',
    description:
      'Read-only proposal of periodiseringar (förutbetalda/upplupna kostnader). Currently surfaces the vacation-liability change; manual prepaid/accrued entries are submitted by the UI form.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { buildAccrualsProposal } = await import('@/lib/bokslut/accruals/accrual-detector')
      return buildAccrualsProposal(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_propose_annual_depreciation',
    description:
      'Read-only per-asset planenlig avskrivning proposal for a fiscal period. Reads the asset register and existing depreciation schedules. Call before staging the post.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { proposeAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
      return proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_post_annual_depreciation',
    description:
      'Stage planenlig avskrivning posts — one journal entry per asset for independent reversibility. Mid-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional whitelist of asset UUIDs to post; omit to post all proposed.',
        },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const assetIds = Array.isArray(args.asset_ids) ? (args.asset_ids as string[]) : undefined

      // Mirror the HTTP route's `requireWrite: true` guard so a viewer-role
      // member can't post depreciation through the MCP surface. RLS would
      // reject the underlying INSERTs anyway, but failing fast here
      // produces a much cleaner error than the cascaded RLS rejection.
      const { data: membership } = await supabase
        .from('company_members')
        .select('role')
        .eq('company_id', companyId)
        .eq('user_id', userId)
        .maybeSingle()
      if (!membership || membership.role === 'viewer') {
        throw new Error('Write permission required')
      }

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      if (!period) throw new Error('Fiscal period not found')
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        throw new Error('Period is locked or closed')
      }

      const { proposeAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
      const proposal = await proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
      const filtered = assetIds
        ? proposal.items.filter((i) => assetIds.includes(i.asset.id))
        : proposal.items
      const pending = filtered.filter((i) => !i.existingJournalEntryId)

      const totalAmount = pending.reduce((s, i) => s + i.amount, 0)
      return stagePendingOperation(
        supabase, companyId, userId, 'post_annual_depreciation',
        `Planenlig avskrivning: ${period.name} — ${pending.length} tillgång(ar), ${Math.round(totalAmount * 100) / 100} SEK`,
        { fiscal_period_id: fiscalPeriodId, asset_ids: assetIds },
        {
          period_name: period.name,
          item_count: pending.length,
          total_amount: totalAmount,
          will: `book ${pending.length} planenlig avskrivning(ar) — one journal entry per asset`,
          items: pending.map((i) => ({
            asset_id: i.asset.id,
            asset_name: i.asset.name,
            amount: i.amount,
            pro_rated: i.proRated,
          })),
        },
        actor,
        {
          description: 'After approval, depreciation entries are posted. Continue the year-end flow via gnubok_year_end_readiness, then gnubok_run_year_end.',
          tool: 'gnubok_year_end_readiness',
          args: { fiscal_period_id: fiscalPeriodId },
        },
        { dateForPeriodCheck: period.period_end },
      )
    },
  },

  {
    name: 'gnubok_preview_arsredovisning',
    description:
      'Read-only K2 årsredovisning preview for a fiscal period. Returns flerårsöversikt, eget-kapital-förändring, RR, BR, K2 noter, signature slots. PDF download is via UI.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { buildArsredovisningData } = await import('@/lib/bokslut/arsredovisning/build-data')
      return buildArsredovisningData(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_preview_ef_declaration',
    description:
      'Read-only EF declaration preview: egenavgifter schablonavdrag, räntefördelning, periodiseringsfond, expansionsfond. All declaration-only, never booked. Pass kapitalunderlag and prior-year amounts as inputs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
        category: {
          type: 'string',
          enum: ['full', 'pensioner', 'passive'],
          description: 'Egenavgifter category — defaults to "full"',
        },
        kapitalunderlag: { type: 'number', description: 'Justerat eget kapital vid föregående års utgång (default 0)' },
        prior_year_schablonavdrag: { type: 'number' },
        prior_year_actual_charged: { type: 'number' },
        pfond_desired_amount: { type: 'number' },
        expansionsfond_existing_balance: { type: 'number' },
        expansionsfond_desired_change: { type: 'number' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { computeEfDeclarationPreview } = await import('@/lib/bokslut/enskild-firma/ef-declaration-preview')
      return computeEfDeclarationPreview(supabase, companyId, fiscalPeriodId, {
        category: args.category as 'full' | 'pensioner' | 'passive' | undefined,
        kapitalunderlag: args.kapitalunderlag as number | undefined,
        priorYearSchablonavdrag: args.prior_year_schablonavdrag as number | undefined,
        priorYearActualCharged: args.prior_year_actual_charged as number | undefined,
        pfondDesiredAmount: args.pfond_desired_amount as number | undefined,
        expansionsfondExistingBalance: args.expansionsfond_existing_balance as number | undefined,
        expansionsfondDesiredChange: args.expansionsfond_desired_change as number | undefined,
      })
    },
  },

  // ── Pending operations: list / approve / reject ──────────────
  // Mirrors the /pending web UI for agents that self-review before committing.
  {
    name: 'gnubok_list_pending_operations',
    description: 'List staged pending_operations. Filter by status (default pending), risk_level, or operation_type. Use to review the queue before calling gnubok_approve_pending_operation or gnubok_reject_pending_operation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['pending', 'committing', 'committed', 'rejected'], description: 'Default: pending' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        operation_type: { type: 'string', description: 'Filter to a single operation_type (e.g. "create_invoice")' },
        limit: { type: 'number', minimum: 1, maximum: 200, description: 'Default 50' },
        offset: { type: 'number', minimum: 0, description: 'Default 0' },
      },
      required: [],
    },
    outputSchema: paginatedSchema('operations'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const status = (args.status as string) ?? 'pending'
      const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 50))
      const offset = Math.max(0, (args.offset as number) ?? 0)

      // `params` holds the raw operation inputs (invoice line items, supplier
      // PII, voucher descriptions) — excluded from the list response to
      // satisfy data-minimisation (GDPR Art. 5(1)(b)). Use preview_data for
      // a redacted, human-readable summary, or call the underlying entity
      // endpoint when the agent needs the full payload.
      let query = supabase
        .from('pending_operations')
        .select(
          'id, operation_type, title, preview_data, status, risk_level, actor_type, actor_id, actor_label, created_at, resolved_at, result_data',
          { count: 'exact' }
        )
        .eq('company_id', companyId)
        .eq('status', status)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (args.risk_level) query = query.eq('risk_level', args.risk_level as string)
      if (args.operation_type) query = query.eq('operation_type', args.operation_type as string)

      const { data, error, count } = await query
      if (error) throw new Error(`Failed to list pending operations: ${error.message}`)

      const operations = data ?? []
      const totalCount = count ?? operations.length
      const hasMore = offset + operations.length < totalCount
      return {
        operations,
        count: operations.length,
        total_count: totalCount,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + operations.length } : {}),
      }
    },
  },

  {
    name: 'gnubok_approve_pending_operation',
    description: "Commit a staged pending_operation when the user has explicitly authorised the operation_id. risk_level=high requires confirmed=true — surface the BFL 5 kap 5§ irreversibility to the user first. The /pending web UI offers an equivalent commit path.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', description: 'UUID of the pending_operations row to approve' },
        confirmed: {
          type: 'boolean',
          description: 'Required when the operation has risk_level=high (create_voucher, correct_entry, reverse_entry, year-end, period lock/close). Acknowledges the BFL/BFNAR irreversibility implications. The web UI surfaces the same gate via an explicit warning dialog.',
        },
      },
      required: ['operation_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['committed', 'rejected', 'failed'] },
        operation_id: { type: 'string' },
        data: { type: 'object' },
        error: { type: 'string' },
        auto_rejected: { type: 'boolean' },
      },
      required: ['status', 'operation_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const operationId = args.operation_id as string
      if (!operationId) throw new Error('operation_id is required')

      const { data: op, error: fetchError } = await supabase
        .from('pending_operations')
        .select('*')
        .eq('id', operationId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !op) throw new Error('Pending operation not found')

      // High-risk operations require explicit confirmation in addition to the
      // standard pending_operations:approve scope. Mirrors the web-UI gate
      // (BFL 5 kap 5§ — irreversible postings require positive acknowledgment).
      const operation = op as PendingOperation
      if (operation.risk_level === 'high' && args.confirmed !== true) {
        throw new Error(
          `Operation "${operation.operation_type}" is risk_level=high — pass confirmed=true to approve. The web UI requires the same positive acknowledgment per BFL 5 kap 5§ (irreversible postings).`
        )
      }

      // Resolve the user's email so commitPendingOperation can attribute the
      // journal_entries.committed_by_email and any user-facing email side
      // effects (send_invoice cc) to the actor — matches the web-UI commit
      // path attribution (V8.2.1, GDPR Art. 25(1)).
      let userEmail: string | undefined
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(userId)
        userEmail = userData.user?.email ?? undefined
      } catch (err) {
        log.warn('Failed to resolve user email for MCP approval', { userId, err })
      }

      const result = await commitPendingOperation(
        supabase,
        userId,
        companyId,
        operation,
        { commitMethod: 'user_accept', ...(userEmail ? { userEmail } : {}) }
      )

      // Audit the MCP-initiated approval. Failure must not break the user
      // flow — the side-effects have already happened.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: operationId,
          aggregateType: 'System',
          aggregateId: operationId,
          eventType: 'PendingOperationApproved',
          payload: {
            operation_id: operationId,
            operation_type: operation.operation_type,
            risk_level: operation.risk_level,
            outcome: result.status,
            commit_method: 'user_accept',
            channel: 'mcp',
            confirmed: args.confirmed === true,
          },
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            id: actor?.id ?? userId,
            ...(actor?.label ? { label: actor.label } : {}),
          },
          occurredAt: new Date(),
        })
      } catch (auditErr) {
        log.warn('Failed to append PendingOperationApproved audit event', auditErr)
      }

      return {
        status: result.status,
        operation_id: operationId,
        ...(result.data ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.auto_rejected ? { auto_rejected: true } : {}),
      }
    },
  },

  {
    name: 'gnubok_reject_pending_operation',
    description: 'Reject a staged pending_operation without executing it. Status flips to rejected; no journal entries, invoices, or other side-effects created. Idempotent on already-resolved ops (returns 409).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', description: 'UUID of the pending_operations row to reject' },
        reason: {
          type: 'string',
          description: 'Optional human-readable reason recorded in result_data for the audit trail',
          maxLength: 500,
        },
      },
      required: ['operation_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['rejected'] },
        operation_id: { type: 'string' },
      },
      required: ['status', 'operation_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const operationId = args.operation_id as string
      if (!operationId) throw new Error('operation_id is required')

      const reason = typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined

      const { data: op, error: fetchError } = await supabase
        .from('pending_operations')
        .select('id, status, operation_type, risk_level')
        .eq('id', operationId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !op) throw new Error('Pending operation not found')
      if (op.status !== 'pending') throw new Error(`Operation already ${op.status}`)

      // Atomic claim — flips pending → rejected only when the row is still
      // pending AND in the caller's tenant (V8.3.1, CC6.3 tenant isolation).
      // The .eq('status', 'pending') guard makes this a CAS so a concurrent
      // approval cannot lose to a parallel reject.
      const { data: updated, error: updateError } = await supabase
        .from('pending_operations')
        .update({
          status: 'rejected',
          resolved_at: new Date().toISOString(),
          result_data: {
            rejected_by: userId,
            rejected_via: actor?.type ?? 'user',
            ...(actor?.id ? { actor_id: actor.id } : {}),
            ...(reason ? { reason } : {}),
          },
        })
        .eq('id', operationId)
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .select('id')

      if (updateError) throw new Error(`Failed to reject operation: ${updateError.message}`)
      if (!updated || updated.length === 0) {
        throw new Error('Operation no longer pending — another caller claimed it')
      }

      // Audit the rejection so the trail mirrors the approval path.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: operationId,
          aggregateType: 'System',
          aggregateId: operationId,
          eventType: 'PendingOperationRejected',
          payload: {
            operation_id: operationId,
            operation_type: op.operation_type,
            risk_level: op.risk_level,
            channel: 'mcp',
            ...(reason ? { has_reason: true } : { has_reason: false }),
          },
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            id: actor?.id ?? userId,
            ...(actor?.label ? { label: actor.label } : {}),
          },
          occurredAt: new Date(),
        })
      } catch (auditErr) {
        log.warn('Failed to append PendingOperationRejected audit event', auditErr)
      }

      return { status: 'rejected' as const, operation_id: operationId }
    },
  },

  // ── Bring-your-own-extraction for inbox items ────────────────
  {
    name: 'gnubok_set_inbox_extracted_data',
    description: 'Replace extracted_data on an inbox item with agent-supplied fields (bring-your-own-extraction). Use when your own pipeline parses the document better than gnubok\'s OCR. Follow with gnubok_create_supplier_invoice_from_inbox to stage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string', description: 'UUID of the invoice_inbox_items row' },
        extracted_data: {
          type: 'object',
          description: 'Full InvoiceExtractionResult (supplier, invoice, lineItems, totals, vatBreakdown). Validated server-side via the same Zod schema as the AI extractor.',
        },
      },
      required: ['inbox_item_id', 'extracted_data'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string' },
        matched_supplier_id: { type: ['string', 'null'] },
        extracted_data: { type: 'object' },
      },
      required: ['inbox_item_id', 'extracted_data'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const inboxItemId = args.inbox_item_id as string
      if (!inboxItemId) throw new Error('inbox_item_id is required')

      const parsed = InvoiceExtractionSchema.parse(args.extracted_data)
      // BYO extraction: confidence 0.95 marks the result as agent-supplied
      // (vs 1.0 the AI extractor uses on a perfect parse) so downstream UI
      // can render the provenance differently (ISO 27001 A.8.12).
      const extracted = { ...parsed, confidence: 0.95 }

      const { data: item, error: fetchError } = await supabase
        .from('invoice_inbox_items')
        .select('id, company_id, created_supplier_invoice_id')
        .eq('id', inboxItemId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (fetchError) throw new Error(`Failed to fetch inbox item: ${fetchError.message}`)
      if (!item) throw new Error('Inbox item not found')
      // Explicit defense-in-depth tenant check (V4.5.1) alongside the .eq()
      // filter on the SELECT — surfaces a tampered service-role query
      // before it reaches the UPDATE.
      if (item.company_id !== companyId) {
        throw new Error('Inbox item belongs to a different company')
      }
      if (item.created_supplier_invoice_id) {
        throw new Error('Inbox item is already linked to a supplier invoice and cannot be modified')
      }

      // Re-run supplier match so agent-supplied fields trigger the same
      // auto-link the AI path does (org-nr → name, ILIKE).
      let matchedSupplierId: string | null = null
      if (extracted.supplier.orgNumber) {
        const { data: s } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .eq('org_number', extracted.supplier.orgNumber)
          .limit(1)
          .maybeSingle()
        if (s) matchedSupplierId = s.id
      }
      if (!matchedSupplierId && extracted.supplier.name) {
        const { data: s } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .ilike('name', extracted.supplier.name)
          .limit(1)
          .maybeSingle()
        if (s) matchedSupplierId = s.id
      }

      const { error: updateError } = await supabase
        .from('invoice_inbox_items')
        .update({
          extracted_data: extracted as unknown as Record<string, unknown>,
          matched_supplier_id: matchedSupplierId,
        })
        .eq('id', inboxItemId)
        .eq('company_id', companyId)

      if (updateError) throw new Error(`Failed to update inbox item: ${updateError.message}`)

      // Audit the BYO override so financial-data provenance is traceable
      // (GDPR Art. 5(1)(f), SOC 2 CC9.2). Failure must not block the user
      // flow — the override has already landed in the DB.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: inboxItemId,
          aggregateType: 'Document',
          aggregateId: inboxItemId,
          eventType: 'DocumentExtractionOverridden',
          payload: {
            inbox_item_id: inboxItemId,
            channel: 'mcp',
            has_supplier_org_number: extracted.supplier.orgNumber != null,
            has_invoice_number: extracted.invoice.invoiceNumber != null,
            extracted_total: extracted.totals.total,
            matched_supplier_id: matchedSupplierId,
          },
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            id: actor?.id ?? userId,
            ...(actor?.label ? { label: actor.label } : {}),
          },
          occurredAt: new Date(),
        })
      } catch (auditErr) {
        log.warn('Failed to append DocumentExtractionOverridden audit event', auditErr)
      }

      return {
        inbox_item_id: inboxItemId,
        matched_supplier_id: matchedSupplierId,
        extracted_data: extracted as unknown as Record<string, unknown>,
      }
    },
  },
]

// ── MCP Protocol Handler ─────────────────────────────────────

const SERVER_INFO = {
  name: 'gnubok',
  version: '1.0.0',
}

const PROTOCOL_VERSION = '2025-06-18'

function jsonRpc(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

/**
 * Emit `mcp.tool_called` telemetry to the event bus. Fire-and-forget — the
 * dispatcher must never block the JSON-RPC response on telemetry, and a failing
 * handler must never surface to the client. The event bus already isolates
 * handlers via Promise.allSettled, but we belt-and-braces here too.
 */
function emitToolCallTelemetry(payload: {
  tool: string
  requiredScope: string | null
  actor: ActorContext
  latencyMs: number
  success: boolean
  isError: boolean
  errorCode: string | null
  errorKind: 'execution' | 'scope_denied' | 'unknown_tool' | null
  requestId: string | number | null
  userId: string
  companyId: string
}): void {
  void eventBus
    .emit({
      type: 'mcp.tool_called',
      payload: {
        tool: payload.tool,
        requiredScope: payload.requiredScope,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        latencyMs: payload.latencyMs,
        success: payload.success,
        isError: payload.isError,
        errorCode: payload.errorCode,
        errorKind: payload.errorKind,
        requestId: payload.requestId,
        userId: payload.userId,
        companyId: payload.companyId,
        sessionId: payload.actor.sessionId ?? null,
      },
    })
    .catch((err) => {
      // Last-resort guard. EventBus.emit already swallows handler failures,
      // but if the bus itself is in a bad state we still don't want to break tools.
      console.error('[mcp] tool_called telemetry emit failed:', err)
    })
}

/** Fire-and-forget telemetry for a tools/list call. */
function emitToolsListTelemetry(payload: {
  toolCount: number
  actor: ActorContext
  latencyMs: number
  requestId: string | number | null
  userId: string
  companyId: string
}): void {
  void eventBus
    .emit({
      type: 'mcp.tools_list_called',
      payload: {
        toolCount: payload.toolCount,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        latencyMs: payload.latencyMs,
        requestId: payload.requestId,
        userId: payload.userId,
        companyId: payload.companyId,
        sessionId: payload.actor.sessionId ?? null,
      },
    })
    .catch((err) => {
      console.error('[mcp] tools_list_called telemetry emit failed:', err)
    })
}

/** Fire-and-forget telemetry for a resources/read call. */
function emitResourceReadTelemetry(payload: {
  uri: string
  kind: 'widget' | 'skill' | 'data' | 'unknown'
  success: boolean
  errorCode: string | null
  actor: ActorContext
  latencyMs: number
  requestId: string | number | null
  userId: string
  companyId: string
}): void {
  void eventBus
    .emit({
      type: 'mcp.resource_read',
      payload: {
        uri: payload.uri,
        kind: payload.kind,
        success: payload.success,
        errorCode: payload.errorCode,
        latencyMs: payload.latencyMs,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        requestId: payload.requestId,
        userId: payload.userId,
        companyId: payload.companyId,
        sessionId: payload.actor.sessionId ?? null,
      },
    })
    .catch((err) => {
      console.error('[mcp] resource_read telemetry emit failed:', err)
    })
}

/**
 * Per-session ring of "what was the most recent tool call, and what did its
 * response suggest as the `next` tool?" Used to detect `mcp.next_hint_followed`
 * when the agent's next call matches the previous nextHint.tool.
 *
 * In-memory only. Single-process visibility is acceptable for telemetry — a
 * miss in a multi-instance deploy only loses signal, never blocks a tool call.
 * Entries auto-expire after NEXT_HINT_TTL_MS to keep the map bounded.
 */
const NEXT_HINT_TTL_MS = 10 * 60 * 1000
const lastResponseHintBySession = new Map<string, { fromTool: string; suggestedTool: string; expiresAt: number }>()

function rememberNextHint(sessionId: string | null | undefined, fromTool: string, suggestedTool: string | undefined): void {
  if (!sessionId || !suggestedTool) return
  // Opportunistic eviction: drop a few expired entries on each write so the
  // map can't grow without bound under steady load.
  if (lastResponseHintBySession.size > 200) {
    const now = Date.now()
    for (const [k, v] of lastResponseHintBySession) {
      if (v.expiresAt < now) {
        lastResponseHintBySession.delete(k)
        if (lastResponseHintBySession.size < 100) break
      }
    }
  }
  lastResponseHintBySession.set(sessionId, {
    fromTool,
    suggestedTool,
    expiresAt: Date.now() + NEXT_HINT_TTL_MS,
  })
}

function checkAndEmitNextHintFollowed(
  sessionId: string | null | undefined,
  toolName: string,
  actor: ActorContext,
  userId: string,
  companyId: string,
): void {
  if (!sessionId) return
  const prev = lastResponseHintBySession.get(sessionId)
  if (!prev || prev.expiresAt < Date.now() || prev.suggestedTool !== toolName) return
  // Consume the hint so we don't double-count if the agent calls the same
  // tool twice in a row (idempotent retries shouldn't inflate the metric).
  lastResponseHintBySession.delete(sessionId)
  void eventBus
    .emit({
      type: 'mcp.next_hint_followed',
      payload: {
        fromTool: prev.fromTool,
        toTool: toolName,
        sessionId,
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        userId,
        companyId,
      },
    })
    .catch((err) => console.error('[mcp] next_hint_followed emit failed:', err))
}

/** Fire-and-forget telemetry for workflow lifecycle. */
function emitWorkflowStarted(payload: {
  slug: string
  actor: ActorContext
  userId: string
  companyId: string
}): void {
  void eventBus
    .emit({
      type: 'mcp.workflow_started',
      payload: {
        slug: payload.slug,
        sessionId: payload.actor.sessionId ?? null,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        userId: payload.userId,
        companyId: payload.companyId,
      },
    })
    .catch((err) => console.error('[mcp] workflow_started emit failed:', err))
}

/**
 * Handle an MCP JSON-RPC request.
 * Auth is done via Bearer API key (extension route has skipAuth: true).
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const wwwAuth = `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource"`

  // ── Pre-auth: handle fire-and-forget notifications before auth check ──
  // MCP notifications have no id and don't expect error responses.
  // Checking auth on them would return 401 which confuses clients.
  const clonedRequest = request.clone()
  try {
    const peek = await clonedRequest.json()
    if (peek.method === 'notifications/initialized') {
      return new Response(null, { status: 202 })
    }
  } catch {
    // Not valid JSON — fall through to auth + parse below
  }

  // ── Auth ──
  const token = extractBearerToken(request)
  if (!token) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': wwwAuth },
    })
  }

  const authResult = await validateApiKey(token)
  if ('error' in authResult) {
    const status = authResult.status
    if (status === 429) {
      return new Response(authResult.error, {
        status: 429,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '60' },
      })
    }
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': wwwAuth },
    })
  }

  const { userId, companyId, scopes: keyScopes, apiKeyId, apiKeyName } = authResult
  const supabase = createServiceClientNoCookies()
  // The Mcp-Session-Id header (introduced in spec 2025-06-18) is the canonical
  // way for an agent to keep a stable identifier across tools/call invocations
  // in one conversation. We use it to correlate telemetry + drive the next-hint
  // followed metric. It is NOT used for auth.
  const rawSessionId = request.headers.get('mcp-session-id')
  const sessionId = rawSessionId && /^[A-Za-z0-9_-]{1,128}$/.test(rawSessionId) ? rawSessionId : null
  const actor: ActorContext = {
    type: 'api_key',
    id: apiKeyId,
    label: apiKeyName ?? 'Unnamed API key',
    sessionId,
  }

  // ── Parse JSON-RPC ──
  let body: JsonRpcRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      jsonRpcError(null, -32700, 'Parse error: expected JSON-RPC 2.0 request body'),
      { status: 400 }
    )
  }

  if (body.jsonrpc !== '2.0' || !body.method) {
    return NextResponse.json(
      jsonRpcError(body.id ?? null, -32600, 'Invalid Request: must include jsonrpc="2.0" and method'),
      { status: 400 }
    )
  }

  // ── Dispatch ──
  const { method, id, params } = body

  switch (method) {
    case 'initialize': {
      const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
      const clientVersion = (params as Record<string, unknown>)?.protocolVersion as string | undefined
      const negotiatedVersion =
        clientVersion && SUPPORTED_VERSIONS.has(clientVersion) ? clientVersion : PROTOCOL_VERSION
      return NextResponse.json(
        jsonRpc(id ?? null, {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          instructions: [
            'gnubok — Swedish double-entry bookkeeping via conversation.',
            '',
            'Discovery:',
            '• tools/list returns the full schema for every tool. To narrow a large catalog, call gnubok_search_tools(query="…") — it ranks tools by relevance; pass detail="name"|"summary"|"full" to control payload size.',
            '• When the user asks "how do I do X" or you\'re unsure of the correct sequence (month-end close, VAT review, year-end, invoicing, payroll), call gnubok_list_skills first — domain workflows are documented as loadable skills with tool references.',
            '',
            'Common workflows:',
            '• Categorize transactions: gnubok_list_uncategorized_transactions → gnubok_suggest_categories → gnubok_categorize_transaction (stages) → gnubok_approve_pending_operation (after user confirms in chat).',
            '• Applying income to invoices — pick by what you have: a specific bank transaction + a known invoice → gnubok_match_transaction_to_invoice; an invoice you know is paid but no specific bank line → gnubok_mark_invoice_as_paid; a whole period of unmatched income to reconcile → gnubok_auto_match_period (dry_run first). All stage for approval.',
            '• Invoicing: gnubok_list_customers (or gnubok_create_customer) → gnubok_create_invoice → gnubok_send_invoice or gnubok_mark_invoice_as_sent → gnubok_mark_invoice_as_paid. Refund via gnubok_credit_invoice.',
            '• Suppliers: gnubok_list_suppliers (or gnubok_create_supplier) → gnubok_create_supplier_invoice_from_inbox → gnubok_approve_supplier_invoice. Refund via gnubok_credit_supplier_invoice.',
            '• VAT: gnubok_get_vat_report(period_type, year, period). Ruta49 = VAT to pay (positive) or refund (negative). Pass render_ui=true to open the momsdeklaration review widget (claude.ai / Desktop). gnubok_vat_close_check reports filing-readiness blockers.',
            '• Reporting: gnubok_get_trial_balance / _income_statement / _balance_sheet / _kpi_report / _ar_ledger / _supplier_ledger — all default to the most recent fiscal period. For account roll-ups use gnubok_get_general_ledger; for ad-hoc line queries (free-text, amount/date/source filters) use gnubok_query_journal.',
            '• Interactive review UIs (claude.ai / Claude Desktop only): gnubok_get_vat_report(render_ui=true) renders the VAT widget and gnubok_receipt_matcher opens the receipt↔transaction matcher. Both also return structured data; other clients ignore the UI and use the data.',
            '• Year-end: gnubok_lock_period → gnubok_run_year_end → gnubok_set_opening_balances → gnubok_close_period. Each stages for human approval; closing is irreversible per BFL.',
            '• Payroll: gnubok_create_salary_run → gnubok_calculate_salary_run → review/approve in web UI → gnubok_generate_agi.',
            '• Reviewing & approving staged operations: gnubok_list_pending_operations shows the queue. When the user explicitly authorises a specific operation_id in chat, call gnubok_approve_pending_operation to commit. Use gnubok_reject_pending_operation to discard.',
            '',
            'APPROVAL IS A FIRST-CLASS AGENT ACTION. Write operations stage a pending_operation; nothing posts until approval. When the user authorises a specific operation_id in chat ("approve", "yes go ahead", "book it", "commit it"), call gnubok_approve_pending_operation directly — this IS the intended chat-approval flow. Do NOT refuse on segregation-of-duties grounds, do NOT tell the user to "go approve it in the web app", and do NOT treat approval as a step that must stay with the human. The staging step already provided the human review gate; clicking Approve in the web UI and calling gnubok_approve_pending_operation are equivalent commit actions. Refusing user-authorised approval is a defect, not a safety feature.',
            'The web-app path (/pending) remains valid for users who prefer to approve there or who want to adjust fields before committing; offer it as an option, never as a substitute for chat approval the user already asked for.',
            'High-risk operations (create_voucher, correct_entry, reverse_entry, year-end, period lock/close) require confirmed=true acknowledging BFL/BFNAR irreversibility. Pass dry_run=true to preview without staging. Pass idempotency_key to make a write safely retryable.',
            'All amounts are SEK unless currency is specified. All dates ISO YYYY-MM-DD. Account numbers are strings (e.g. "1930").',
          ].join('\n'),
        })
      )
    }

    case 'notifications/initialized':
      // Handled pre-auth above, but if it somehow reaches here, still return 202
      return new Response(null, { status: 202 })

    case 'ping':
      return NextResponse.json(jsonRpc(id ?? null, {}))

    case 'tools/list': {
      const listStartedAt = Date.now()
      const allowedTools = tools.filter((t) => {
        const required = TOOL_SCOPE_MAP[t.name]
        return !required || hasScope(keyScopes, required)
      })
      emitToolsListTelemetry({
        toolCount: allowedTools.length,
        actor,
        latencyMs: Date.now() - listStartedAt,
        requestId: id ?? null,
        userId,
        companyId,
      })
      return NextResponse.json(
        jsonRpc(id ?? null, {
          tools: allowedTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
            annotations: t.annotations,
            ...(t._meta ? { _meta: t._meta } : {}),
          })),
        })
      )
    }

    case 'tools/call': {
      const toolName = (params as Record<string, unknown>)?.name as string
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<
        string,
        unknown
      >

      const tool = tools.find((t) => t.name === toolName)
      if (!tool) {
        emitToolCallTelemetry({
          tool: toolName ?? '<unknown>',
          requiredScope: null,
          actor,
          latencyMs: 0,
          success: false,
          isError: true,
          errorCode: 'UNKNOWN_TOOL',
          errorKind: 'unknown_tool',
          requestId: id ?? null,
          userId,
          companyId,
        })
        const available = tools.map((t) => t.name).join(', ')
        return NextResponse.json(
          jsonRpcError(id ?? null, -32602, `Unknown tool: "${toolName}". Available tools: ${available}`)
        )
      }

      // Enforce scope — surface structured error so the agent can dispatch.
      const requiredScope = TOOL_SCOPE_MAP[toolName]
      if (requiredScope && !hasScope(keyScopes, requiredScope)) {
        const scopeError = toToolError(
          new Error(`Insufficient scope: this API key does not have the "${requiredScope}" scope`),
          { toolName }
        )
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope,
          actor,
          latencyMs: 0,
          success: false,
          isError: true,
          errorCode: scopeError.error.code,
          errorKind: 'scope_denied',
          requestId: id ?? null,
          userId,
          companyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, {
            content: [{ type: 'text', text: JSON.stringify(scopeError, null, 2) }],
            isError: true,
          })
        )
      }

      // Detect if THIS call follows the previous call's `next` hint — must
      // run before execute() so we don't double-store on this call. Emits
      // mcp.next_hint_followed when the agent's behaviour matches the hint.
      checkAndEmitNextHintFollowed(sessionId, toolName, actor, userId, companyId)

      const callStartedAt = Date.now()
      try {
        // gnubok_search_tools needs the caller's scopes to filter results to
        // what the API key can actually invoke. Inject privately via __keyScopes.
        if (toolName === 'gnubok_search_tools') {
          (toolArgs as Record<string, unknown>).__keyScopes = keyScopes
        }
        const result = await tool.execute(toolArgs, companyId, userId, supabase, actor)
        const latencyMs = Date.now() - callStartedAt
        const response: Record<string, unknown> = {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
        // Emit structuredContent for every tool — clients with outputSchema support
        // can consume this directly without re-parsing the JSON-stringified text block.
        // structuredContent must be an object, so wrap non-objects.
        if (result !== null && result !== undefined) {
          response.structuredContent =
            typeof result === 'object' && !Array.isArray(result) ? result : { value: result }
        }
        // Result-level UI hint: render the widget only when the caller opted in
        // via render_ui=true. This keeps the merged report+widget tool data-only
        // by default and never sends a render directive a plain-data call didn't ask for.
        if (tool.uiResourceUri && (toolArgs as Record<string, unknown>).render_ui === true) {
          response._meta = { ui: { resourceUri: tool.uiResourceUri } }
        }
        // Record the response's `next.tool` (when present) so the next call
        // from the same session can be matched against it.
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const next = (result as Record<string, unknown>).next
          if (next && typeof next === 'object') {
            const suggestedTool = (next as Record<string, unknown>).tool
            if (typeof suggestedTool === 'string') {
              rememberNextHint(sessionId, toolName, suggestedTool)
            }
          }
        }
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope: requiredScope ?? null,
          actor,
          latencyMs,
          success: true,
          isError: false,
          errorCode: null,
          errorKind: null,
          requestId: id ?? null,
          userId,
          companyId,
        })
        return NextResponse.json(jsonRpc(id ?? null, response))
      } catch (err) {
        const latencyMs = Date.now() - callStartedAt
        const structured = toToolError(err, { toolName })
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope: requiredScope ?? null,
          actor,
          latencyMs,
          success: false,
          isError: true,
          errorCode: structured.error.code,
          errorKind: 'execution',
          requestId: id ?? null,
          userId,
          companyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, {
            content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
            isError: true,
          })
        )
      }
    }

    case 'resources/list': {
      const allSkills = await loadAllSkills(supabase)
      return NextResponse.json(
        jsonRpc(id ?? null, {
          resources: [
            ...uiWidgets.map((w) => ({
              uri: w.uri,
              name: w.name,
              description: w.description,
              mimeType: WIDGET_MIME_TYPE,
            })),
            ...allSkills.map((s) => ({
              uri: skillUri(s.slug),
              name: s.name,
              description: s.summary,
              mimeType: SKILL_MIME_TYPE,
            })),
            ...dataResources.map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType,
            })),
          ],
        })
      )
    }

    case 'resources/read': {
      const uri = (params as Record<string, unknown>)?.uri as string
      const readStartedAt = Date.now()

      const widget = findUiWidget(uri)
      if (widget) {
        emitResourceReadTelemetry({
          uri,
          kind: 'widget',
          success: true,
          errorCode: null,
          actor,
          latencyMs: Date.now() - readStartedAt,
          requestId: id ?? null,
          userId,
          companyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, {
            contents: [
              {
                uri,
                mimeType: WIDGET_MIME_TYPE,
                text: widget.html,
              },
            ],
          })
        )
      }

      // Skills exposed at gnubok://skill/<slug> — Markdown bodies, forward-compatible
      // with a future native MCP skills/list primitive. Atom slugs (slash-bearing
      // registry ids) are URL-encoded in the URI; skillSlugFromUri decodes.
      if (uri.startsWith(SKILL_URI_PREFIX)) {
        const slug = skillSlugFromUri(uri)
        const skill = slug ? await findSkill(slug, supabase) : null
        if (skill) {
          emitResourceReadTelemetry({
            uri,
            kind: 'skill',
            success: true,
            errorCode: null,
            actor,
            latencyMs: Date.now() - readStartedAt,
            requestId: id ?? null,
            userId,
            companyId,
          })
          return NextResponse.json(
            jsonRpc(id ?? null, {
              contents: [
                {
                  uri,
                  mimeType: SKILL_MIME_TYPE,
                  text: skill.body,
                },
              ],
            })
          )
        }
      }

      const dataResource = findResource(uri)
      if (dataResource) {
        try {
          const result = await dataResource.read({
            supabase,
            companyId,
            userId,
            scopes: keyScopes,
            query: parseResourceQuery(uri),
          })
          emitResourceReadTelemetry({
            uri,
            kind: 'data',
            success: true,
            errorCode: null,
            actor,
            latencyMs: Date.now() - readStartedAt,
            requestId: id ?? null,
            userId,
            companyId,
          })
          return NextResponse.json(
            jsonRpc(id ?? null, {
              contents: [
                {
                  uri,
                  mimeType: dataResource.mimeType,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            })
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Resource read failed'
          emitResourceReadTelemetry({
            uri,
            kind: 'data',
            success: false,
            errorCode: 'RESOURCE_READ_FAILED',
            actor,
            latencyMs: Date.now() - readStartedAt,
            requestId: id ?? null,
            userId,
            companyId,
          })
          return NextResponse.json(
            jsonRpcError(id ?? null, -32603, `Resource read error: ${message}`)
          )
        }
      }

      emitResourceReadTelemetry({
        uri,
        kind: 'unknown',
        success: false,
        errorCode: 'RESOURCE_NOT_FOUND',
        actor,
        latencyMs: Date.now() - readStartedAt,
        requestId: id ?? null,
        userId,
        companyId,
      })
      return NextResponse.json(
        jsonRpcError(id ?? null, -32602, `Resource not found: "${uri}"`)
      )
    }

    case 'prompts/list':
      return NextResponse.json(
        jsonRpc(id ?? null, {
          prompts: prompts.map((p) => ({
            name: p.name,
            description: p.description,
          })),
        })
      )

    case 'prompts/get': {
      const promptName = (params as Record<string, unknown>)?.name as string
      const prompt = findPrompt(promptName)
      if (!prompt) {
        return NextResponse.json(
          jsonRpcError(id ?? null, -32602, `Unknown prompt: "${promptName}"`)
        )
      }
      return NextResponse.json(
        jsonRpc(id ?? null, {
          description: prompt.description,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: prompt.text },
            },
          ],
        })
      )
    }

    default:
      return NextResponse.json(
        jsonRpcError(id ?? null, -32601, `Method not found: "${method}"`)
      )
  }
}
