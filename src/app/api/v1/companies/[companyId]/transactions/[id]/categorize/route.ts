/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/categorize
 *
 * Categorize a transaction and create the corresponding journal entry. A thin
 * v1 door over categorizeTransaction (lib/transactions/categorize-core.ts),
 * the one booking path the dashboard route, batch-categorize, the approval
 * executor and the MCP tool share: same mapping, templates, override,
 * double-booking guards (TRANSACTION_BOOK_POSSIBLE_DUPLICATE with the bound
 * force override; TX_CATEGORIZE_SUGGEST_SI_MATCH / _CI_MATCH with
 * confirm_no_match), period lock and compare-and-set write.
 *
 * Already-categorized fast path: if a posted verifikat already books the row,
 * only the is_business / category flags are updated. The JE is left intact
 * (it's immutable post-commit per BFL 5 kap 6 §).
 *
 * Fail-closed (issue #1947): if the verifikat cannot be created the request is
 * refused with a typed code and the transaction is left untouched, so it stays
 * in the unbooked queue. journal_entry_error in the 200 body is therefore
 * always null and kept only for response-shape compatibility.
 *
 * Hard blocks (accounted#130 step 2): a booking a booking review rule matches
 * is never booked from a key. It is staged as a categorize_transaction
 * pending operation for a person to approve in the app, answered 202 with
 * the pending operation (staged_because BOOKING_REVIEW_REQUIRED); a booking
 * named by a template id, which a staged operation cannot carry, is refused
 * with 409 BOOKING_REVIEW_REQUIRED instead.
 *
 * Dry-runnable: the service's dry run runs every read-only check the booking
 * runs and returns the resolved mapping without inserting the journal entry or
 * mutating the transaction; an honoured force writes its behandlingshistorik
 * record only on the live call.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { categorizeTransaction } from '@/lib/transactions/categorize-core'
import { stageBlockedCategorization } from '@/lib/booking-review/stage-categorization'
import { addHandles, STAGED_PENDING_OPERATION_HANDLES } from '@/lib/api/v1/handles'
import { toPendingOperationView } from '@/lib/pending-operations/view'

const CategorizeResponse = z.object({
  success: z.boolean(),
  journal_entry_created: z.boolean(),
  journal_entry_id: z.string().uuid().nullable(),
  journal_entry_error: z
    .string()
    .nullable()
    .describe(
      'Always null: a verifikat that cannot be created is refused with 409 TX_CATEGORIZE_JOURNAL_ENTRY_FAILED and nothing is written (issue #1947). Kept for response-shape compatibility.',
    ),
  document_link_warning: z.string().nullable().optional(),
  category: z.string(),
  already_had_journal_entry: z.boolean().optional(),
})

registerEndpoint({
  operation: 'transactions.categorize',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/categorize',
  summary: 'Categorize a transaction and create the journal entry.',
  description:
    'Resolves the BAS account mapping for the transaction (via category, booking template, or counterparty template), creates the corresponding verifikation, and updates the transaction with is_business / category / journal_entry_id. Idempotent on (transaction, key). Dry-runnable.',
  useWhen:
    'You\'re categorizing a bank transaction. Pass `is_business: true` plus either `category`, `template_id` (booking template), `counterparty_template_id`, or `account_override`. For private transactions, `is_business: false` is enough.',
  doNotUseFor:
    'Matching a payment to an invoice: use `:match-invoice` or `:match-supplier-invoice`, on an unbooked transaction. Uncategorizing: `:uncategorize`.',
  pitfalls: [
    'A bank line the ledger already books (a booked sibling transaction, or a voucher booking the same amount on the bank account such as a supplier invoice marked paid) is refused with 409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE and the candidate in `details.candidate`: link the transaction to that verifikat instead. Only if it is a genuinely separate event, resend with `force: true` plus `expected_duplicate_journal_entry_id` (or `expected_duplicate_transaction_id`) echoing the candidate; a stale id returns TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH.',
    'A plain 244x (supplier payment) or 151x (customer receipt) categorization that an open invoice covers is refused with 409 TX_CATEGORIZE_SUGGEST_SI_MATCH / TX_CATEGORIZE_SUGGEST_CI_MATCH: match the invoice via `:match-supplier-invoice` / `:match-invoice`, or pass `confirm_no_match: true` to keep the plain categorization.',
    'Already-categorized fast path: if the transaction already has a journal_entry_id, only flags get updated. The JE is immutable post-commit.',
    'account_override must exist and be active in the chart of accounts (else TX_CATEGORIZE_INVALID_ACCOUNT). It books the business side gross unless you also pass vat_treatment or vat_amount: the category default VAT is never carried onto an arbitrary account.',
    'vat_amount replaces the rate-based VAT line with the underlag\'s actual moms (e.g. dricks); it needs a rate-based treatment, else TX_CATEGORIZE_INVALID_VAT_AMOUNT.',
    'vat_treatment reverse_charge without reverse_charge_kind takes the box (20, 21 or 22) from the seller country on the row\'s underlag and the category; when they cannot tell it, 400 TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN (details.reason): send reverse_charge_kind. Never ruta 21 by default.',
    'A booking one of the company\'s blocks (booking review rules, Bokföringsregler > Spärrar in the app) matches is never booked from a key: it is staged for a person and answered 202 with the pending operation (staged_because BOOKING_REVIEW_REQUIRED). Approving it is web-only. With template_id or counterparty_template_id it cannot be staged and is refused with 409 BOOKING_REVIEW_REQUIRED.',
  ],
  example: {
    request: { is_business: true, category: 'expense_office' },
    response: {
      data: {
        success: true,
        journal_entry_created: true,
        journal_entry_id: 'je_…',
        category: 'expense_office',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CategorizeTransactionSchema },
  response: { success: dataEnvelope(CategorizeResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.categorize',
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

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const parsed = CategorizeTransactionSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const txLog = ctx.log.child({ transactionId: txId })
    const outcome = await categorizeTransaction(ctx.supabase, ctx.userId, ctx.companyId!, txId, parsed.data, {
      dryRun: ctx.dryRun,
      onBooked: 'update_flags',
      forceVia: 'api_force',
      reverseChargeBoxParam: 'reverse_charge_kind',
      log: ctx.log,
    })

    if (!outcome.ok) {
      if (outcome.code === 'ACCOUNTS_NOT_IN_CHART') {
        return v1ErrorResponse(
          new AccountsNotInChartError((outcome.details?.account_numbers as string[] | undefined) ?? []),
          txLog,
          { requestId: ctx.requestId },
        )
      }
      // A booking review rule matches (accounted#130 step 2): a key's
      // booking is staged for a person, never booked, and answered 202 with
      // the pending operation as ?stage=true answers elsewhere.
      if (outcome.code === 'BOOKING_REVIEW_REQUIRED') {
        const staged = await stageBlockedCategorization(ctx.supabase, {
          companyId: ctx.companyId!,
          userId: ctx.userId,
          transactionId: txId,
          booking: parsed.data,
          actor: { type: ctx.actor.type, id: ctx.apiKeyId ?? null, label: ctx.actor.label ?? null },
          log: txLog,
        })
        if (staged) {
          const view = addHandles(
            {
              ...toPendingOperationView(staged.row),
              ...(staged.periodStatus ? { period_status: staged.periodStatus } : {}),
              staged_because: 'BOOKING_REVIEW_REQUIRED',
            },
            STAGED_PENDING_OPERATION_HANDLES,
          ).value
          return ok(view, { requestId: ctx.requestId, status: 202 })
        }
      }
      return v1ErrorResponseFromCode(outcome.code, txLog, {
        requestId: ctx.requestId,
        details: outcome.details,
      })
    }

    // Dry-run stops here: the resolved mapping, no voucher number burnt and no
    // state mutated.
    if (outcome.dryRun) {
      const { preview } = outcome
      return dryRunPreview(
        {
          category: preview.category,
          mapping: {
            debit_account: preview.mappingResult.debit_account,
            credit_account: preview.mappingResult.credit_account,
            vat_lines: preview.mappingResult.vat_lines,
            all_lines_complete: preview.mappingResult.all_lines_complete ?? false,
          },
          would_create_journal_entry: preview.would_create_journal_entry,
          already_had_journal_entry: preview.already_had_journal_entry,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { booked } = outcome
    return ok(
      {
        success: true,
        journal_entry_created: booked.journal_entry_created,
        journal_entry_id: booked.journal_entry_id,
        journal_entry_error: null,
        category: booked.category,
        ...(booked.already_had_journal_entry ? { already_had_journal_entry: true } : {}),
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
