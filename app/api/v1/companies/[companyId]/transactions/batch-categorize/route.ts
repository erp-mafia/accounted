/**
 * POST /api/v1/companies/{companyId}/transactions/batch-categorize
 *
 * Apply a single categorization to up to 100 transactions in one call.
 * Partial-success semantics: per-item failure does not roll back items
 * that succeeded. Each item is processed through the same orchestration
 * as the single :categorize endpoint, so it can fail individually for any
 * of the same reasons (invalid template, invalid mapping, race, etc.).
 *
 * Idempotent over the whole batch. Dry-runnable.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import {
  getTemplateById,
  buildMappingResultFromTemplate,
  validateTemplateForEntity,
} from '@/lib/bookkeeping/booking-templates'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import type { EntityType, Transaction, TransactionCategory } from '@/types'

const BatchItem = z.object({
  transaction_id: z.string().uuid(),
  categorization: CategorizeTransactionSchema,
})

const BatchRequest = z.object({
  items: z.array(BatchItem).min(1).max(100),
  all_or_nothing: z.boolean().optional().default(false),
})

const ResultItem = z.object({
  ok: z.boolean(),
  request_index: z.number().int().nonnegative(),
  transaction_id: z.string().uuid(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
})

const BatchResponse = z.object({
  results: z.array(ResultItem),
  summary: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
})

registerEndpoint({
  operation: 'transactions.batch-categorize',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/batch-categorize',
  summary: 'Categorize up to 100 transactions in one call (partial-success).',
  description:
    'Per-item categorization mirroring the single :categorize endpoint. Same `{ results, summary }` shape as the other bulk endpoints. all_or_nothing: true returns 501 NOT_IMPLEMENTED. Idempotent over the whole batch.',
  useWhen:
    'You have many transactions to categorize with the same logic (e.g. apply a booking template across a queue, mark a batch as private, override accounts on a series).',
  doNotUseFor:
    'Categorizing transactions with mixed logic: make multiple :categorize calls. Auto-categorization via templates: handled inside `ingest` for matching rows, no separate endpoint needed.',
  pitfalls: [
    'Max 100 items per call. Sequential processing.',
    'Idempotency-Key covers the WHOLE batch: replays return the cached full response.',
    'all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.',
  ],
  example: {
    request: {
      items: [
        { transaction_id: 'tx_1', categorization: { is_business: true, category: 'expense_office' } },
      ],
    },
    response: {
      data: {
        results: [{ ok: true, request_index: 0, transaction_id: 'tx_1', data: { journal_entry_id: 'je_…' } }],
        summary: { total: 1, succeeded: 1, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: BatchRequest },
  response: { success: dataEnvelope(BatchResponse) },
})

interface Item {
  ok: boolean
  request_index: number
  transaction_id: string
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

async function categorizeOne(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entityType: EntityType,
  index: number,
  transactionId: string,
  input: z.infer<typeof CategorizeTransactionSchema>,
  dryRun: boolean,
  log: Logger,
): Promise<Item> {
  const { data: transaction, error: fetchErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (fetchErr || !transaction) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: { code: 'TX_CATEGORIZE_TX_NOT_FOUND', message: 'Transaction not found.' },
    }
  }

  const { is_business, category } = input
  let finalCategory: TransactionCategory
  if (input.template_id) {
    const template = getTemplateById(input.template_id)
    if (!template) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'TX_CATEGORIZE_INVALID_TEMPLATE',
          message: 'Unknown template id.',
          details: { templateId: input.template_id },
        },
      }
    }
    const valid = validateTemplateForEntity(template, entityType)
    if (!valid.valid) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'TX_CATEGORIZE_INVALID_TEMPLATE',
          message: 'Template not valid for entity type.',
          details: { templateId: input.template_id, reason: valid.error },
        },
      }
    }
    finalCategory = is_business ? template.fallback_category : 'private'
  } else {
    finalCategory = is_business ? category || 'uncategorized' : 'private'
  }

  let mappingResult
  if (input.template_id) {
    const template = getTemplateById(input.template_id)!
    mappingResult = buildMappingResultFromTemplate(template, transaction as Transaction, entityType)
  } else {
    mappingResult = buildMappingResultFromCategory(
      finalCategory,
      transaction as Transaction,
      is_business,
      entityType,
      input.vat_treatment,
    )
  }
  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'TX_CATEGORIZE_INVALID_MAPPING',
        message: 'Could not resolve debit/credit accounts.',
      },
    }
  }

  // Pre-validate every account in the mapping against the company's
  // chart_of_accounts. Templates and category defaults can reference accounts
  // that aren't activated in this company's kontoplan; without this check the
  // engine throws AccountsNotInChartError mid-flight and the legacy
  // partial-success branch silently marks the row bokförd with no
  // verifikation. Validate in both dry-run and live paths so previews
  // surface the same actionable error. Standard BAS accounts merely absent
  // from the chart pass: the engine seeds them on demand.
  const missingAccounts = await findUnresolvableAccounts(
    supabase,
    companyId,
    collectMappingResultAccounts(mappingResult),
  )
  if (missingAccounts.length > 0) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'ACCOUNTS_NOT_IN_CHART',
        message: `Följande konton behöver aktiveras: ${missingAccounts.join(', ')}`,
        details: { account_numbers: missingAccounts },
      },
    }
  }

  if (dryRun) {
    return {
      ok: true,
      request_index: index,
      transaction_id: transactionId,
      data: {
        preview: {
          category: finalCategory,
          debit_account: mappingResult.debit_account,
          credit_account: mappingResult.credit_account,
          vat_lines: mappingResult.vat_lines,
          would_create_journal_entry: !transaction.journal_entry_id,
        },
      },
    }
  }

  // Already-categorized: just flip flags.
  if (transaction.journal_entry_id) {
    const { error: updateErr } = await supabase
      .from('transactions')
      .update({ is_business, category: finalCategory })
      .eq('id', transactionId)
      .eq('company_id', companyId)
    if (updateErr) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update flags.' },
      }
    }
    return {
      ok: true,
      request_index: index,
      transaction_id: transactionId,
      data: {
        journal_entry_created: false,
        journal_entry_id: transaction.journal_entry_id,
        category: finalCategory,
        already_had_journal_entry: true,
      },
    }
  }

  // Period-lock pre-check: same rationale as the single :categorize route.
  // A locked period surfaces as PERIOD_LOCKED on the per-item error rather
  // than a generic INTERNAL_ERROR from the trigger exception.
  const periodLock = await checkPeriodLock(supabase, companyId, transaction.date)
  if (periodLock.locked) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'PERIOD_LOCKED',
        message: 'Period is locked or closed; cannot post journal entry.',
        details: {
          transaction_date: transaction.date,
          reason: periodLock.reason,
          fiscal_period_id: periodLock.fiscal_period_id,
        },
      },
    }
  }

  let journalEntryId: string | null = null
  let journalEntryError: string | null = null
  try {
    const je = await createTransactionJournalEntry(
      supabase,
      companyId,
      userId,
      transaction as Transaction,
      mappingResult,
    )
    if (je) journalEntryId = je.id
  } catch (err) {
    log.error('batch-categorize: journal entry creation failed', err as Error, {
      request_index: index,
      transactionId,
    })
    // AccountsNotInChartError means an account was deactivated between our
    // pre-validation and the engine call (rare race). Return the per-item
    // failure WITHOUT the transaction update below so the row stays in
    // "Att bokföra": partial-success on a missing-account error would
    // mark it bokförd with no verifikation.
    if (err instanceof AccountsNotInChartError) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'ACCOUNTS_NOT_IN_CHART',
          message: `Följande konton behöver aktiveras: ${err.accountNumbers.join(', ')}`,
          details: { account_numbers: err.accountNumbers },
        },
      }
    }
    if (isBookkeepingError(err)) {
      journalEntryError = getErrorMessage(err, { context: 'transaction' })
    } else {
      journalEntryError = err instanceof Error ? err.message : 'Unknown error'
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from('transactions')
    .update({
      is_business,
      category: finalCategory,
      journal_entry_id: journalEntryId,
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .select('id')
  if (updateErr) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: { code: 'INTERNAL_ERROR', message: updateErr.message },
    }
  }
  if ((!updated || updated.length === 0) && journalEntryId) {
    // CAS race: storno the orphan (BFL 5 kap 5 §). Direct statusflip
    // would be blocked by enforce_journal_entry_immutability since the
    // engine writes the JE as posted. Same fix as the single :categorize
    // route. Storno keeps the verifikationsnummer series unbroken.
    try {
      await reverseEntry(supabase, companyId, userId, journalEntryId)
    } catch (revErr) {
      log.error('batch-categorize TX_CATEGORIZE_RACE: failed to storno orphaned JE', revErr as Error, {
        request_index: index,
        orphanJournalEntryId: journalEntryId,
      })
      // Document the gap so the orphan is traceable per BFL 5 kap 5 §.
      try {
        const { data: orphan } = await supabase
          .from('journal_entries')
          .select('fiscal_period_id, voucher_series, voucher_number')
          .eq('id', journalEntryId)
          .single()
        if (orphan && orphan.voucher_series) {
          // Same rationale as the single :categorize route: skip the gap row
          // when no series exists rather than filing under a fallback series
          // that an audit query won't find.
          await supabase.from('voucher_gap_explanations').insert({
            company_id: companyId,
            fiscal_period_id: orphan.fiscal_period_id,
            voucher_series: orphan.voucher_series,
            gap_number: orphan.voucher_number,
            explanation:
              'CAS-race orphan; automatisk storno misslyckades. Manuell reconciliation krävs.',
            created_by: userId,
          })
        }
      } catch (gapErr) {
        log.error('batch-categorize: failed to log voucher_gap_explanations', gapErr as Error, {
          request_index: index,
          orphanJournalEntryId: journalEntryId,
        })
      }
    }
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: { code: 'TX_CATEGORIZE_RACE', message: 'Concurrent state change.' },
    }
  }

  try {
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
  } catch (err) {
    log.warn('batch-categorize: event emit failed (non-critical)', err as Error)
  }

  return {
    ok: true,
    request_index: index,
    transaction_id: transactionId,
    data: {
      journal_entry_created: !!journalEntryId,
      journal_entry_id: journalEntryId,
      journal_entry_error: journalEntryError,
      category: finalCategory,
    },
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'transactions.batch-categorize',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = BatchRequest.safeParse(rawBody)
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
    const body = parsed.data

    if (body.all_or_nothing) {
      return v1ErrorResponseFromCode('NOT_IMPLEMENTED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'all_or_nothing',
          message: 'Use partial-success semantics (omit the flag or pass false).',
        },
      })
    }

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', ctx.companyId!)
      .single()
    const entityType: EntityType =
      (settings?.entity_type as EntityType) || 'enskild_firma'

    const results: Item[] = []
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]
      const r = await categorizeOne(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        entityType,
        i,
        item.transaction_id,
        item.categorization,
        ctx.dryRun,
        ctx.log,
      )
      results.push(r)
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    if (ctx.dryRun) {
      return dryRunPreview({ results, summary }, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok({ results, summary }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
