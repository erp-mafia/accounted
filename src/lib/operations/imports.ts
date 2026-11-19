/**
 * Import follow-up actions served through the machine doors (see
 * ./types.ts): undo a bank file import, and undo or resume a durable SIE
 * import. Neither undo ever deletes a posted verifikat:
 *
 *   - a bank file undo deletes only the batch's UNBOOKED rows and reports
 *     the booked ones as skipped (lib/import/bank-file/undo-operation.ts);
 *   - an SIE undo queues a batch storno: every entry the import posted gets
 *     a reversing entry and stays in the ledger
 *     (lib/import/sie-job-action-service.ts).
 *
 * MCP: both undos stage (gnubok_undo_bank_import, gnubok_undo_sie_import).
 * The SIE resume is v1 only. Confirming the opening balance review an SIE
 * import raises on the next year is MCP only and staged
 * (gnubok_acknowledge_opening_balance_review, crm#1967): the dashboard's
 * review dialog runs the same service (lib/import/opening-balance/review.ts).
 */
import { after } from 'next/server'
import { z } from 'zod'
import { undoBankImport } from '@/lib/import/bank-file/undo-operation'
import { acknowledgeOpeningBalanceReview } from '@/lib/import/opening-balance/review'
import { requestSIEImportAction } from '@/lib/import/sie-job-action-service'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import { formatCurrency } from '@/lib/utils'
import type { ContinuityDiscrepancy } from '@/types'
import type { OperationOutcome } from './types'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

// ---------------------------------------------------------------------------
// imports.bank.undo
// ---------------------------------------------------------------------------

export const importsBankUndo = defineOperation({
  id: 'imports.bank.undo',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Undo a bank file import: delete the rows it created that are still unbooked.',
    description:
      'Hard-deletes every transaction the import created that is still unbooked (ignored rows included) and marks the import undone, so the same file can be imported again. Rows that are booked or linked to a verifikat, and rows with payment match history, are never touched: they are counted in skipped_booked and skipped_match_history, and their verifikat stay as they are (unlink or reverse them separately). Owner/admin only. Idempotent. Dry-runnable (the dry run counts what would be deleted and skipped).',
    useWhen: 'The wrong file, the wrong account or a duplicate file was imported and its rows should go.',
    doNotUseFor:
      'Removing single rows (DELETE /transactions/{id} for manual rows; ignore bank rows), bank-feed rows (they have no import), or SIE imports (POST /imports/sie/{id}/undo).',
    pitfalls: [
      'Only a completed import can be undone: 409 BANK_FILE_UNDO_NOT_COMPLETED otherwise.',
      'Owner or admin only: a member key gets 403 BANK_FILE_UNDO_FORBIDDEN.',
      'Booked rows survive the undo (skipped_booked > 0): to remove them, reverse their verifikat first, then delete or ignore the rows.',
      'Imports made before rows were stamped with their import id delete nothing (deleted_transactions 0).',
      'transaction_id (any row the import created) stands in for the import id over MCP, where import ids are not listed; the staged undo is pinned to the import it resolved to. Over v1 the path names the import: a body transaction_id is refused.',
    ],
    example: {
      // v1 sends no body: the path names the import.
      request: {},
      response: {
        data: { bank_file_import_id: '9a8b…', deleted_transactions: 212, skipped_booked: 3, skipped_match_history: 0 },
        meta: META,
      },
    },
  },
  input: z
    .object({
      bank_file_import_id: z.string().uuid().optional().describe('Or transaction_id of any row it created.'),
      transaction_id: z.string().uuid().optional(),
    })
    .refine((v) => Boolean(v.bank_file_import_id) !== Boolean(v.transaction_id), {
      message: 'Send bank_file_import_id or transaction_id, not both.',
    }),
  output: z.object({
    bank_file_import_id: z.string().uuid(),
    deleted_transactions: z.number(),
    skipped_booked: z.number().describe('Booked or verifikat-linked rows left untouched.'),
    skipped_match_history: z.number().describe('Unbooked rows kept because their match history is append-only.'),
  }),
  errorCodes: [
    'BANK_FILE_UNDO_NOT_FOUND',
    'BANK_FILE_UNDO_FORBIDDEN',
    'BANK_FILE_UNDO_NOT_COMPLETED',
    'BANK_FILE_UNDO_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/imports/bank/:id/undo',
    pathParams: { id: 'bank_file_import_id' },
  },
  mcp: {
    name: 'gnubok_undo_bank_import',
    title: 'Undo Bank Import',
    description:
      'Stage undoing a bank file import: deletes its still-unbooked rows and marks it undone for re-import. Booked rows and their verifikat stay (counted as skipped). Owner/admin only.',
    keywords: ['ångra bankimport', 'ångra import', 'bankfil', 'fel fil importerad', 'ta bort importerade transaktioner'],
    stage: {
      pendingType: 'undo_bank_import',
      title: () => 'Ångra bankfilsimport',
      // An agent sees transaction ids, not import ids (crm#1528): the
      // approval commits the import the dry run resolved, never a re-lookup.
      pinParams: (input, preview) => ({
        bank_file_import_id: (preview.bank_file_import_id as string | undefined) ?? input.bank_file_import_id,
      }),
    },
  },
  run: (ctx, { bank_file_import_id, transaction_id }, { dryRun }) =>
    undoBankImport(ctx, bank_file_import_id ?? { transactionId: transaction_id! }, { dryRun }),
})

// ---------------------------------------------------------------------------
// imports.sie.undo / imports.sie.resume
// ---------------------------------------------------------------------------

const SIE_IMPORT_ID = z.string().uuid().describe('The SIE import id (operation_id from POST /imports/sie).')

const SieActionOut = z.object({
  import_id: z.string().uuid(),
  action: z.enum(['undo', 'resume']),
  state: z.string().describe('The job state after the request, e.g. undoing, running, undone, completed.'),
  phase: z.string().nullable(),
  accepted: z.literal(true),
})

/**
 * Kick the SIE worker after the response is sent, as the dashboard routes
 * do. Outside a request scope (a test, a script) the worker cron picks the
 * job up instead.
 */
function kickSIEWorker(importId: string): void {
  try {
    after(async () => {
      await runSIEWorker({ importId })
    })
  } catch {
    /* no request scope: the worker cron runs the job */
  }
}

async function runSIEAction(
  outcome: Promise<OperationOutcome<z.infer<typeof SieActionOut>>>,
): Promise<OperationOutcome<z.infer<typeof SieActionOut>>> {
  const result = await outcome
  if (result.ok && !result.dryRun) kickSIEWorker(result.data.import_id)
  return result
}

export const importsSieUndo = defineOperation({
  id: 'imports.sie.undo',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Undo an SIE import by batch storno: every entry it posted is reversed, nothing is deleted.',
    description:
      'Queues a batch storno of the import: each verifikat the import posted gets a reversing entry (BFL 5 kap 5 §) and the originals stay in the ledger. Asynchronous: the answer carries state "undoing" and the worker finishes in the background (state "undone"). Refused while another SIE run is active, while a reversal of an imported voucher is already in progress, while an imported voucher has a live correction, or when a date a storno must carry is locked (the fiscal year is closed or locked, or the company lock date covers it). Owner/admin only. Idempotent. Dry-runnable (the dry run counts the entries that would be reversed).',
    useWhen: 'An SIE file was imported into the wrong company or year, or with a wrong mapping, and its entries must be cancelled before a corrected import.',
    doNotUseFor:
      'Removing single vouchers (POST /journal-entries/{id}/reverse), bank file imports (POST /imports/bank/{id}/undo), or legacy imports made before durable jobs (409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED: review them in the app).',
    pitfalls: [
      'Nothing is deleted: the ledger keeps both the imported entries and their reversals, and voucher numbers are never reused.',
      'Each storno is dated like the voucher it reverses. A closed or locked fiscal year, or a company lock date on or after the first imported voucher, returns 409 SIE_IMPORT_PERIOD_LOCKED before anything is queued; details.reason names the locked range and what to unlock (the user\'s decision).',
      'Another active run or a live correction returns 409 SIE_IMPORT_ACTION_CONFLICT with details.reason.',
      'Owner or admin only: a member key gets 403 FORBIDDEN.',
      'Undoing an already undone import answers its state unchanged.',
    ],
    example: {
      request: { reason: 'Importerad till fel räkenskapsår' },
      response: {
        data: { import_id: '7ce9…', action: 'undo', state: 'undoing', phase: 'undo', accepted: true },
        meta: META,
      },
    },
  },
  input: z.object({
    import_id: SIE_IMPORT_ID,
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('Why: shown to the approver, not stored.'),
  }),
  output: SieActionOut,
  errorCodes: ['NOT_FOUND', 'FORBIDDEN', 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', 'SIE_IMPORT_PERIOD_LOCKED', 'SIE_IMPORT_ACTION_CONFLICT'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/imports/sie/:id/undo',
    pathParams: { id: 'import_id' },
  },
  mcp: {
    name: 'gnubok_undo_sie_import',
    title: 'Undo SIE Import',
    description:
      'Stage batch undo of a completed or unfinished durable SIE import. Approval queues storno, retaining documents and history. Period must be open.',
    visibility: 'default',
    keywords: ['sie', 'ångra import'],
    hints: { destructive: true },
    stage: {
      pendingType: 'undo_sie_import',
      title: (_input, preview = {}) => ['Ångra SIE-import', preview.filename].filter(Boolean).join(': '),
      preview: (input, preview) => ({
        import_id: preview.import_id,
        filename: preview.filename,
        fiscal_year:
          preview.fiscal_year_start && preview.fiscal_year_end
            ? `${preview.fiscal_year_start} till ${preview.fiscal_year_end}`
            : null,
        voucher_count: preview.posted_entries_to_reverse,
        reason: input.reason ?? null,
        will:
          preview.would_change === false
            ? `Nothing to undo: the import is already ${preview.current_state}.`
            : 'Reverse exactly this batch with storno, retain documents and history, and release the period hold only when every undo checkpoint completes.',
      }),
      extras: () => ({
        next: {
          description: 'Poll until undone before submitting a new execution with corrected mappings.',
          tool: 'gnubok_sie_import_status',
        },
      }),
    },
  },
  run: (ctx, { import_id }, { dryRun }) => runSIEAction(requestSIEImportAction(ctx, import_id, 'undo', { dryRun })),
})

export const importsSieResume = defineOperation({
  id: 'imports.sie.resume',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Resume an interrupted SIE import from where it stopped.',
    description:
      'Re-queues a paused or interrupted durable SIE import (or an interrupted undo) so the worker continues from the last committed chunk; entries already posted are not posted again. A finished run (completed, undone, failed) is answered unchanged. Allowed to the user who ran the import and to owners/admins. Idempotent. Dry-runnable.',
    useWhen: 'An SIE import stopped part-way (state paused, or running with no progress) and should continue.',
    doNotUseFor: 'Starting a new import (POST /imports/sie) or cancelling one (POST /imports/sie/{id}/undo).',
    pitfalls: [
      'Another user\'s import needs an owner or admin key: 403 FORBIDDEN otherwise.',
      'Legacy imports made before durable jobs return 409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED.',
      'Resuming an undo that a lock stopped returns 409 SIE_IMPORT_PERIOD_LOCKED until the user unlocks the range in details.reason; it then continues from the last committed chunk.',
    ],
    example: {
      response: {
        data: { import_id: '7ce9…', action: 'resume', state: 'running', phase: 'vouchers', accepted: true },
        meta: META,
      },
    },
  },
  input: z.object({ import_id: SIE_IMPORT_ID }),
  output: SieActionOut,
  errorCodes: ['NOT_FOUND', 'FORBIDDEN', 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', 'SIE_IMPORT_PERIOD_LOCKED', 'SIE_IMPORT_ACTION_CONFLICT'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/imports/sie/:id/resume',
    pathParams: { id: 'import_id' },
  },
  run: (ctx, { import_id }, { dryRun }) => runSIEAction(requestSIEImportAction(ctx, import_id, 'resume', { dryRun })),
})

// ---------------------------------------------------------------------------
// imports.opening-balance-review.acknowledge
// ---------------------------------------------------------------------------

/**
 * What the approver and the agent see when the confirmation is staged:
 * labelled facts for the approval card, and the dry run's per-account rows
 * (previous_ub_net, current_ib_net, difference = UB minus IB) for the agent.
 */
function reviewStagePreview(preview: Record<string, unknown>): Record<string, unknown> {
  const discrepancies = Array.isArray(preview.discrepancies) ? (preview.discrepancies as ContinuityDiscrepancy[]) : []
  const matches = preview.ib_matches_previous_ub === true
  return {
    fiscal_period_id: preview.fiscal_period_id,
    review_token: preview.review_token,
    opening_balance_entry_id: preview.opening_balance_entry_id ?? null,
    fiscal_year: preview.period_name,
    previous_fiscal_year: preview.previous_period_name ?? null,
    ib_matches_previous_ub: matches,
    compared_accounts: preview.checked_accounts,
    // Öre shown: a difference can be a few öre.
    opening_balance_differences: discrepancies.map(
      (row) => `${row.account_number}: ${formatCurrency(row.difference, 'SEK', { minimumFractionDigits: 2 })}`,
    ),
    discrepancies,
    will: matches
      ? 'Confirm the review and clear it: the IB equals the previous year\'s UB on every account. No verifikat changes.'
      : 'Confirm the review and clear it although the IB differs from the previous year\'s UB on the accounts in discrepancies. No verifikat changes: correct the IB first if the differences are wrong.',
  }
}

export const importsOpeningBalanceReviewAcknowledge = defineOperation({
  id: 'imports.opening-balance-review.acknowledge',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Confirm the review of a year\'s ingående balanser that an SIE import of the year before raised.',
    description:
      'An SIE import, or its undo, flags the year after the imported year for review: that year\'s IB was not changed automatically and may no longer equal the changed year\'s utgående balanser. Confirming clears the review (the banner "Granska ingående balanser" and opening_balance_review in gnubok_sie_import_status) and records who confirmed it and when; no verifikat changes. The dry run compares the year\'s IB with the year before\'s UB per balance-sheet account, as GET /reports/continuity-check does, and lists every difference. As in the review dialog, a review can be confirmed with differences, so correct the IB first when they are wrong. Owner/admin only.',
    useWhen:
      'The banner "Granska ingående balanser för ..." shows, or gnubok_sie_import_status answers opening_balance_review with open true, and the year\'s IB has been checked against the year before\'s UB.',
    doNotUseFor:
      'Changing an IB (gnubok_correct_opening_balances for a booked one, gnubok_set_opening_balances_manual for a year without one), or a year with no open review (OB_REVIEW_NOT_PENDING).',
    pitfalls: [
      'Read discrepancies in the preview before staging: confirming leaves the IB as it is. When an account differs and should not, correct the IB (gnubok_correct_opening_balances) and preview again.',
      'The staged confirmation is pinned to the review and the IB verifikat the preview read: a new import or a corrected IB before the approval answers 409 OB_REVIEW_CHANGED; preview again.',
      'A year with no open review answers 409 OB_REVIEW_NOT_PENDING; an SIE import still running at the approval answers 409 OB_REVIEW_IMPORT_RUNNING.',
      'Owner or admin only: 403 FORBIDDEN otherwise.',
    ],
    example: {
      request: { fiscal_period_id: '7b3a…' },
      response: {
        data: { fiscal_period_id: '7b3a…', period_name: 'Räkenskapsår 2026', reviewed: true },
        meta: META,
      },
    },
  },
  input: z.object({
    fiscal_period_id: z
      .string()
      .uuid()
      .describe('The year whose IB waits for review: opening_balance_review.fiscal_period_id in gnubok_sie_import_status, or the year the banner names (gnubok_list_fiscal_periods).'),
    review_token: z
      .string()
      .uuid()
      .optional()
      .describe('opening_balance_review.review_token from gnubok_sie_import_status. Omit to take the year\'s open review.'),
    opening_balance_entry_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe('The IB verifikat that was reviewed (null when the year has none). Omit to take the year\'s current one.'),
  }),
  output: z.object({
    fiscal_period_id: z.string().uuid(),
    period_name: z.string(),
    reviewed: z.literal(true),
  }),
  errorCodes: ['OB_PERIOD_NOT_FOUND', 'OB_REVIEW_NOT_PENDING', 'OB_REVIEW_CHANGED', 'OB_REVIEW_IMPORT_RUNNING', 'FORBIDDEN'],
  mcp: {
    name: 'gnubok_acknowledge_opening_balance_review',
    title: 'Confirm Opening Balance Review (Granska Ingående Balanser)',
    description:
      'Stage confirming the opening balance review an SIE import raised (banner "Granska ingående balanser"). The preview compares the year\'s IB with the prior year\'s UB per account and lists differences: correct those first (gnubok_correct_opening_balances).',
    keywords: [
      'granska ingående balanser',
      'granskning ingående balans',
      'kvittera granskning',
      'bekräfta granskning',
      'ingående balans',
      'utgående balans',
      'ib ub',
      'sie',
      'reviewtoken',
      'nextperiodopeningbalancereview',
    ],
    stage: {
      pendingType: 'acknowledge_opening_balance_review',
      title: (_input, preview) =>
        `Bekräfta granskningen av ingående balanser för ${String(preview?.period_name ?? 'räkenskapsåret')}`,
      // The approval confirms the review the preview compared, never one a
      // later import raised or an IB corrected since.
      pinParams: (input, preview) => ({
        fiscal_period_id: input.fiscal_period_id,
        review_token: preview.review_token,
        opening_balance_entry_id: preview.opening_balance_entry_id ?? null,
      }),
      preview: (_input, preview) => reviewStagePreview(preview),
    },
  },
  run: (ctx, input, { dryRun }) => acknowledgeOpeningBalanceReview(ctx, input, { dryRun }),
})
