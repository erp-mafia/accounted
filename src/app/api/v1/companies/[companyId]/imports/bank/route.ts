/**
 * POST /api/v1/companies/{companyId}/imports/bank
 *
 * Bank-file import. Multipart upload: the file is the request body. The
 * route:
 *   1. Decodes the file (UTF-8 / UTF-16 / Windows-1252 auto-detected;
 *      BOMs handled at the byte level), or reads an Excel workbook
 *      (.xls / .xlsx) as semicolon text.
 *   2. Detects the bank file format (SEB / Swedbank / Nordea / Handelsbanken
 *      / Lansforsakringar / Lunar / ICA Banken / Skandia / CAMT053 /
 *      Nordea Business / Wise / generic CSV), or honors the optional `format`
 *      override.
 *   3. Parses transactions.
 *   4. Imports it with `importBankFile()`, the service behind the dashboard's
 *      /api/import/bank-file/execute too, so a v1 import has the same effects.
 *      The caller chooses no ledger, so the rows bind to the cash account the
 *      file names and nothing about the account can refuse the file.
 *   5. Records the result on the `operations` table for consistent
 *      polling-shape with SIE imports.
 *
 * Runs INLINE today.
 */

import { z } from 'zod'
import { accepted } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  startOperation,
  completeOperation,
  failOperation,
} from '@/lib/api/v1/operations'
import {
  parseBankFile,
  detectFileFormat,
  generateFileHash,
  unreadRows,
} from '@/lib/import/bank-file/parser'
import { importBankFile } from '@/lib/import/bank-file/import-file'
import { decodeBankFile } from '@/lib/import/bank-file/workbook'
import { headerLikeCells, unrecognizedColumnsMessages } from '@/lib/import/bank-file/columns'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'
import { BANK_FILE_FORMAT_IDS } from '@/lib/api/schemas'
import { archiveBankFileOriginal } from '@/lib/import/bank-file/arrival'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { apiKeyArrivalActor } from '@/lib/intake/arrivals'

// The same per-row ingest and budget as the dashboard's execute route.
export const maxDuration = 300

const BankImportAccepted = z.object({
  operation_id: z.string().uuid(),
  type: z.literal('import.bank'),
  status: z.literal('queued'),
  poll_url: z.string(),
})

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB: matches dashboard

// The canonical BankFileFormatId values a `format` override may name. The
// handler validates the parameter against it before anything reaches the
// format module.
const BankFormatEnum = z.enum(BANK_FILE_FORMAT_IDS)

const ImportQuery = z.object({
  format: BankFormatEnum.optional().describe(
    'Force this bank file format instead of auto-detection. Omit to auto-detect.',
  ),
})

registerEndpoint({
  operation: 'imports.bank',
  method: 'POST',
  path: '/api/v1/companies/:companyId/imports/bank',
  summary: 'Import a bank-file (CSV / Excel / XML / CAMT053).',
  description:
    'Accepts a bank statement file (CSV in UTF-8 / UTF-16 / Windows-1252, an Excel workbook .xls / .xlsx, or camt.053 XML; up to 10 MB) as multipart/form-data. Auto-detects the bank format (SEB, Swedbank, Handelsbanken, Nordea, Nordea Business, Lansforsakringar, Lunar, ICA Banken, Skandia, Wise transaction history, Wise balance statement, the Mynt card export, CAMT053, generic CSV) or honors a `format` override. Parses transactions, ingests them into the `transactions` table (NOT into journal entries: see BFL note in pitfalls), and emits `transaction.synced` events. Returns operation_id for polling.',
  useWhen:
    'Importing a bank statement export for a period. Common with PSD2 bank connections that don\'t auto-sync, or for legacy bank accounts.',
  doNotUseFor:
    'SIE bookkeeping import (use /imports/sie). Auto-bank sync (use the enable-banking extension). Single-transaction creation (use POST /transactions/ingest with a 1-element array).',
  pitfalls: [
    'File size cap: 10 MB. Larger files require splitting client-side.',
    '`format` query parameter is optional; auto-detection works for all supported banks. Pass `format` only to force a specific format. Accepted values: seb, swedbank, handelsbanken, nordea, nordea_business, lansforsakringar, ica_banken, skandia, lunar, northmill, wise, wise_statement, mynt, generic_csv, camt053.',
    'Wise transaction-history rows with refunded or unknown statuses, unknown directions, or different source and target currencies are rejected instead of guessed. Import the matching per-currency Wise balance statements.',
    'Duplicate detection is by external_id (composed from format + date + description + amount + row index, or the camt.053 entry reference / Wise transfer id where the file carries one); a re-import of the same file typically deduplicates rather than creating doubles.',
    'Rows bind to the cash account the file names when the company already has it. A file covering a period a completed SIE import booked is matched against the imported vouchers and never auto-categorized.',
    'A row the parser cannot read is skipped and the rest are imported. The operation still ends succeeded, so read its result: `import_complete: false` means rows are missing, `transactions_skipped` counts them and `skipped_rows` names each with its row and reason. Correct the file and import it again: rows already in are recognised.',
    'A generic CSV whose amounts read a thousand apart under the two decimal marks ("349.000"), with no other amount settling which, is refused with 400 VALIDATION_ERROR and imports nothing. Write the amounts with two decimals.',
    'BFL 5 kap 6-7 §§ note: this endpoint creates `transactions` rows (the underlag for a verifikation), NOT verifikationer themselves. The verifikation content requirements are in BFL 5 kap 6-7 §§; until each transaction is matched to an invoice/supplier-invoice (POST /transactions/{id}/match-*) or categorised (POST /transactions/{id}/categorize), the bookkeeping obligation isn\'t discharged. A successful import here means the data is ingested: not booked.',
    'A successful import returns operation_id; poll /operations/{id} for the final ingested/duplicates/errors counts and whether the file was read to its last row (`import_complete`).',
  ],
  example: {
    response: {
      data: {
        operation_id: 'op_a8f1…',
        type: 'import.bank',
        status: 'queued',
        poll_url: '/api/v1/operations/op_a8f1…',
        webhook_event: 'operation.completed',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { contentType: 'multipart/form-data', query: ImportQuery },
  response: { success: dataEnvelope(BankImportAccepted) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'imports.bank',
  async (request, ctx) => {
    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Expected multipart/form-data with a `file` field.' },
      })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'file', message: 'Missing or invalid `file` field.' },
      })
    }
    if (file.size > MAX_FILE_SIZE) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'file',
          message: `File too large (${file.size} bytes). Max ${MAX_FILE_SIZE} bytes.`,
        },
      })
    }

    const url = new URL(request.url)
    // Validate `format` against the canonical BankFileFormatId enum BEFORE
    // letting it reach parseBankFile / detectFileFormat. A raw cast would
    // pass any string through and rely on the parser to surface
    // BANK_FILE_FORMAT_UNKNOWN: better to fail with VALIDATION_ERROR up
    // front so an attacker-supplied value never reaches the format module
    // (V2.2 / PI1.1 hardening).
    const formatParam = url.searchParams.get('format')
    let formatOverride: BankFileFormatId | null = null
    if (formatParam) {
      const parsed = BankFormatEnum.safeParse(formatParam)
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'format',
            message:
              'Unknown bank file format. Accepted: ' + BankFormatEnum.options.join(', '),
          },
        })
      }
      formatOverride = parsed.data
    }

    // Decode the file with the shared bank file decode (BOM-aware UTF-8 /
    // UTF-16 / Windows-1252, or a workbook read as semicolon text): one
    // decode implementation for every path.
    const buffer = await file.arrayBuffer()
    let content: string
    try {
      content = (await decodeBankFile(buffer, file.name)).content
    } catch (err) {
      ctx.log.warn('bank file workbook unreadable', err as Error)
      // A workbook the reader cannot open. This endpoint has published
      // VALIDATION_ERROR for it, and a changed code breaks a dated version
      // (versioning policy), so the code stays. The sentences and the next
      // step are the ones the app gives (BANK_FILE_WORKBOOK_UNREADABLE).
      const answer = getErrorEntry('BANK_FILE_WORKBOOK_UNREADABLE')!
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'file', message: 'The file looks like an Excel workbook but could not be read.' },
        messageSv: answer.message_sv,
        messageEn: answer.message_en,
        remediation: answer.remediation,
      })
    }

    const fileHash = await generateFileHash(content)

    // Detect format (or honor explicit override).
    const format = formatOverride ?? detectFileFormat(content, file.name)?.id
    if (!format) {
      // Name the columns the file has, so the caller can tell a wrong file
      // from a bank layout we do not know (crm#1236).
      const found = headerLikeCells(content)
      const foundSv = found.length > 0 ? found.join(', ') : 'ingen rubrikrad hittades'
      const foundEn = found.length > 0 ? found.join(', ') : 'no header row found'
      return v1ErrorResponseFromCode('BANK_FILE_FORMAT_UNKNOWN', ctx.log, {
        requestId: ctx.requestId,
        details: { filename: file.name, found_columns: found },
        messageSv: `Bankfilens format kunde inte identifieras. Kolumner i filen: ${foundSv}. En bankfil behöver minst en datumkolumn och en beloppskolumn.`,
        messageEn: `Bank file format could not be identified. Columns found: ${foundEn}. A bank file needs at least a date column and an amount column.`,
      })
    }

    const parseResult = parseBankFile(content, file.name, format)
    // parseBankFile may fall back to a detected sibling format when an
    // explicit override parses 0 transactions. Everything downstream (external
    // ids, import_source, stored file_format) must use the format the result
    // actually carries so ids equal what the auto-detect path would produce.
    const effectiveFormat = parseResult.format
    if (parseResult.transactions.length === 0 && parseResult.unrecognized_columns) {
      const columns = parseResult.unrecognized_columns
      const messages = unrecognizedColumnsMessages(parseResult.format_name, columns)
      return v1ErrorResponseFromCode('BANK_FILE_COLUMNS_UNRECOGNIZED', ctx.log, {
        requestId: ctx.requestId,
        details: { format: effectiveFormat, found_columns: columns.found, expected_columns: columns.expected },
        messageSv: messages.sv,
        messageEn: messages.en,
      })
    }
    const blockingIssues = parseResult.issues.filter((issue) => issue.severity === 'error')
    if (blockingIssues.length > 0) {
      // Cap the reported rows so a large malformed file cannot balloon the
      // error payload or the log sink; issue_count carries the full total.
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'file',
          message: 'The bank file contains rows that cannot be imported safely.',
          issues: blockingIssues.slice(0, 20),
          issue_count: blockingIssues.length,
        },
      })
    }
    if (parseResult.transactions.length === 0) {
      return v1ErrorResponseFromCode('BANK_FILE_NO_TRANSACTIONS', ctx.log, {
        requestId: ctx.requestId,
        details: { format: effectiveFormat, filename: file.name },
      })
    }

    const op = await startOperation(
      ctx.supabase,
      {
        companyId: ctx.companyId!,
        userId: ctx.userId,
        operationType: 'import.bank',
        params: {
          filename: file.name,
          file_size: file.size,
          format: effectiveFormat,
          file_hash: fileHash,
          transaction_count: parseResult.transactions.length,
        },
      },
      ctx.log,
    )

    // A lost bank row is a hole in the books: the rows that read are imported
    // and the answer names every row that did not.
    const unread = unreadRows(parseResult)

    const failed = async (reason: string) => {
      await failOperation(
        ctx.supabase,
        { id: op.id, error: { code: 'BANK_IMPORT_FAILED', message: reason } },
        ctx.log,
      )
      return v1ErrorResponseFromCode('BANK_IMPORT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { operation_id: op.id, reason },
      })
    }

    try {
      const outcome = await importBankFile(
        { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
        {
          transactions: parseResult.transactions,
          format: effectiveFormat,
          filename: file.name,
          fileHash,
          account: parseResult.account,
          unreadRows: unread,
          arrival: {
            fetchedBy: apiKeyArrivalActor(ctx),
            via: 'partner_api',
            keepOriginal: () => archiveBankFileOriginal(ctx.supabase, {
              companyId: ctx.companyId!, fileHash, filename: file.name, bytes: buffer, mime: file.type,
            }),
          },
        },
      )
      if (!outcome.ok) return await failed(String(outcome.details?.reason ?? 'unknown'))

      const { ingest } = outcome.data
      await completeOperation(
        ctx.supabase,
        {
          id: op.id,
          result: {
            format: effectiveFormat,
            file_hash: fileHash,
            import_complete: unread.length === 0,
            transactions_imported: ingest.imported,
            transactions_skipped: unread.length,
            skipped_rows: unread.map(({ row, message }) => ({ row, reason: message })),
            transactions_duplicates: ingest.duplicates,
            // Split by reason, so rows skipped on content (a judgement call)
            // are told apart from exact external_id matches.
            transactions_duplicates_by_reason: ingest.duplicates_by_reason ?? null,
            transactions_reconciled: ingest.reconciled,
            transactions_auto_categorized: ingest.auto_categorized,
            transactions_errors: ingest.errors,
            date_from: parseResult.date_from,
            date_to: parseResult.date_to,
          },
        },
        ctx.log,
      )
    } catch (err) {
      ctx.log.error('bank file import failed', err as Error, {
        operationId: op.id,
        userId: ctx.userId,
        companyId: ctx.companyId,
        filename: file.name,
        fileHash,
      })
      return failed(err instanceof Error ? getUserErrorMessage(err) : 'Unknown failure during bank import.')
    }

    return accepted(op.id, 'import.bank', { requestId: ctx.requestId })
  },
)
