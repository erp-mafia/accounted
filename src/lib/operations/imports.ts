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
 * The bank undo has a new staged MCP tool (gnubok_undo_bank_import). The SIE
 * actions are v1 only: gnubok_undo_sie_import already stages the undo with
 * its own commit executor.
 */
import { after } from 'next/server'
import { z } from 'zod'
import { undoBankImport } from '@/lib/import/bank-file/undo-operation'
import { requestSIEImportAction } from '@/lib/import/sie-job-action-service'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
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
    ],
    example: {
      response: {
        data: { bank_file_import_id: '9a8b…', deleted_transactions: 212, skipped_booked: 3, skipped_match_history: 0 },
        meta: META,
      },
    },
  },
  input: z.object({
    bank_file_import_id: z.string().uuid().describe('The bank file import id (from GET /imports/bank or the import response).'),
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
      'Stage undoing a bank file import: deletes its still-unbooked rows and marks it undone so the file can be re-imported. Booked rows and their verifikat are never touched (reported as skipped). Owner/admin only.',
    keywords: ['ångra bankimport', 'ångra import', 'bankfil', 'fel fil importerad', 'ta bort importerade transaktioner'],
    stage: { pendingType: 'undo_bank_import', title: () => 'Ångra bankfilsimport' },
  },
  run: (ctx, { bank_file_import_id }, { dryRun }) => undoBankImport(ctx, bank_file_import_id, { dryRun }),
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
      'Queues a batch storno of the import: each verifikat the import posted gets a reversing entry (BFL 5 kap 5 §) and the originals stay in the ledger. Asynchronous: the answer carries state "undoing" and the worker finishes in the background (state "undone"). Refused while another SIE run is active, while a reversal of an imported voucher is already in progress, while an imported voucher has a live correction, or when the period is closed or locked. Owner/admin only. Idempotent. Dry-runnable (the dry run counts the entries that would be reversed).',
    useWhen: 'An SIE file was imported into the wrong company or year, or with a wrong mapping, and its entries must be cancelled before a corrected import.',
    doNotUseFor:
      'Removing single vouchers (POST /journal-entries/{id}/reverse), bank file imports (POST /imports/bank/{id}/undo), or legacy imports made before durable jobs (409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED: review them in the app).',
    pitfalls: [
      'Nothing is deleted: the ledger keeps both the imported entries and their reversals, and voucher numbers are never reused.',
      'A closed or locked period, another active run or a live correction returns 409 SIE_IMPORT_ACTION_CONFLICT with details.reason.',
      'Owner or admin only: a member key gets 403 FORBIDDEN.',
      'Undoing an already undone import answers its state unchanged.',
    ],
    example: {
      response: {
        data: { import_id: '7ce9…', action: 'undo', state: 'undoing', phase: 'undo', accepted: true },
        meta: META,
      },
    },
  },
  input: z.object({ import_id: SIE_IMPORT_ID }),
  output: SieActionOut,
  errorCodes: ['NOT_FOUND', 'FORBIDDEN', 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', 'SIE_IMPORT_ACTION_CONFLICT'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/imports/sie/:id/undo',
    pathParams: { id: 'import_id' },
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
  errorCodes: ['NOT_FOUND', 'FORBIDDEN', 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', 'SIE_IMPORT_ACTION_CONFLICT'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/imports/sie/:id/resume',
    pathParams: { id: 'import_id' },
  },
  run: (ctx, { import_id }, { dryRun }) => runSIEAction(requestSIEImportAction(ctx, import_id, 'resume', { dryRun })),
})
