/**
 * POST /api/v1/companies/{companyId}/imports/bank
 *
 * Bank-file import. Multipart upload — the file is the request body. The
 * route:
 *   1. Decodes the file (UTF-8 / Windows-1252 auto-detected).
 *   2. Detects the bank file format (SEB / Swedbank / Nordea / Handelsbanken
 *      / Lansforsakringar / Lunar / ICA Banken / Skandia / CAMT053 /
 *      Nordea Business / generic CSV) — or honors the optional `format`
 *      override.
 *   3. Parses transactions.
 *   4. Records a `bank_file_imports` row and ingests transactions via
 *      `ingestTransactions()`.
 *   5. Emits `transaction.synced` per ingested transaction.
 *   6. Records the result on the `operations` table for consistent
 *      polling-shape with SIE imports.
 *
 * Runs INLINE today. The dashboard's /api/import/bank-file/execute backs
 * the same `ingestTransactions` helper, so a v1 import is byte-equivalent.
 */

import { z } from 'zod'
import { accepted } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
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
  generateExternalId,
} from '@/lib/import/bank-file/parser'
import { ingestTransactions, type RawTransaction } from '@/lib/transactions/ingest'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'

const BankImportAccepted = z.object({
  operation_id: z.string().uuid(),
  type: z.literal('import.bank'),
  status: z.literal('queued'),
  poll_url: z.string(),
})

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB — matches dashboard

registerEndpoint({
  operation: 'imports.bank',
  method: 'POST',
  path: '/api/v1/companies/:companyId/imports/bank',
  summary: 'Import a bank-file (CSV / XML / CAMT053).',
  description:
    'Accepts a bank statement file (UTF-8 / Windows-1252, up to 10 MB) as multipart/form-data. Auto-detects the bank format (SEB, Swedbank, Handelsbanken, Nordea, Nordea Business, Lansforsakringar, Lunar, ICA Banken, Skandia, CAMT053, generic CSV) or honors a `format` override. Parses transactions, ingests them into the `transactions` table (NOT into journal entries — see BFL note in pitfalls), and emits `transaction.synced` events. Returns operation_id for polling.',
  useWhen:
    'Importing a bank statement export for a period. Common with PSD2 bank connections that don\'t auto-sync, or for legacy bank accounts.',
  doNotUseFor:
    'SIE bookkeeping import (use /imports/sie). Auto-bank sync (use the enable-banking extension). Single-transaction creation (use POST /transactions/ingest with a 1-element array).',
  pitfalls: [
    'File size cap: 10 MB. Larger files require splitting client-side.',
    '`format` query parameter is optional; auto-detection works for all supported banks. Pass `format` only to force a specific format. Accepted values: seb, swedbank, handelsbanken, nordea, nordea_business, lansforsakringar, ica_banken, skandia, lunar, northmill, generic_csv, camt053.',
    'Duplicate detection is by external_id (composed from date + amount + counterparty); a re-import of the same file with the same flag set typically deduplicates rather than creating doubles.',
    'BFL 5 kap 6-7 §§ note: this endpoint creates `transactions` rows (the underlag for a verifikation), NOT verifikationer themselves. The verifikation content requirements are in BFL 5 kap 6-7 §§; until each transaction is matched to an invoice/supplier-invoice (POST /transactions/{id}/match-*) or categorised (POST /transactions/{id}/categorize), the bookkeeping obligation isn\'t discharged. A successful import here means the data is ingested — not booked.',
    'A successful import returns operation_id; poll /operations/{id} for the final ingested/duplicates/errors counts.',
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
  request: { contentType: 'multipart/form-data' },
  response: { success: BankImportAccepted },
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
    // BANK_FILE_FORMAT_UNKNOWN — better to fail with VALIDATION_ERROR up
    // front so an attacker-supplied value never reaches the format module
    // (V2.2 / PI1.1 hardening).
    const formatParam = url.searchParams.get('format')
    const BankFormatEnum = z.enum([
      'nordea',
      'nordea_business',
      'seb',
      'swedbank',
      'handelsbanken',
      'lansforsakringar',
      'ica_banken',
      'skandia',
      'lunar',
      'northmill',
      'generic_csv',
      'camt053',
    ])
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

    // Decode the file. Bank files are typically Windows-1252 or UTF-8; we
    // try UTF-8 first and fall back if invalid replacement chars appear.
    const buffer = await file.arrayBuffer()
    const utf8 = new TextDecoder('utf-8').decode(buffer)
    const content = utf8.includes('�')
      ? new TextDecoder('windows-1252').decode(buffer)
      : utf8

    const fileHash = await generateFileHash(content)

    // Detect format (or honor explicit override).
    const format = formatOverride ?? detectFileFormat(content, file.name)?.id
    if (!format) {
      return v1ErrorResponseFromCode('BANK_FILE_FORMAT_UNKNOWN', ctx.log, {
        requestId: ctx.requestId,
        details: { filename: file.name },
      })
    }

    const parseResult = parseBankFile(content, file.name, format)
    if (parseResult.transactions.length === 0) {
      return v1ErrorResponseFromCode('BANK_FILE_NO_TRANSACTIONS', ctx.log, {
        requestId: ctx.requestId,
        details: { format, filename: file.name },
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
          format,
          file_hash: fileHash,
          transaction_count: parseResult.transactions.length,
        },
      },
      ctx.log,
    )

    try {
      // Cross-company collision pre-check. The `bank_file_imports` unique
      // constraint is `(user_id, file_hash)` — set when the table was
      // designed for the single-tenant single-company-per-user world. If
      // the same user is a member of two companies and uploads the same
      // file to both, a naive upsert with onConflict='user_id,file_hash'
      // would silently overwrite the first company's row with the second
      // company_id. Pre-check for that case and surface a structured
      // error so an agent sees the explicit conflict instead of a
      // silently-stolen row.
      //
      // A migration to widen the unique constraint to (user_id, file_hash,
      // company_id) is the proper fix; that's an engine-PR concern.
      const { data: existingImport } = await ctx.supabase
        .from('bank_file_imports')
        .select('id, company_id, filename, imported_at, status')
        .eq('user_id', ctx.userId)
        .eq('file_hash', fileHash)
        .maybeSingle()
      if (existingImport && (existingImport as { company_id: string }).company_id !== ctx.companyId) {
        // Log the cross-tenant collision details server-side for operator
        // investigation (CC7.2 — audit trail), but do NOT echo the other
        // company's id or the other import's id back to the caller. Doing
        // so would be a cross-tenant enumeration vector (V8.2.1 / CC6.1).
        // The caller sees a fixed error code + a generic message; the
        // server log carries enough context to debug.
        ctx.log.warn('bank import: cross-company file-hash collision', {
          fileHash,
          attemptedCompanyId: ctx.companyId,
          existingCompanyId: (existingImport as { company_id: string }).company_id,
          existingImportId: (existingImport as { id: string }).id,
        })
        await failOperation(
          ctx.supabase,
          {
            id: op.id,
            error: {
              code: 'BANK_IMPORT_DUPLICATE_OTHER_COMPANY',
              message: 'This file has already been imported into another company by this user.',
            },
          },
          ctx.log,
        )
        return v1ErrorResponseFromCode('BANK_IMPORT_DUPLICATE_OTHER_COMPANY', ctx.log, {
          requestId: ctx.requestId,
          // Deliberately empty details — see comment above.
        })
      }

      // Record the import row so the dashboard's "bank file imports" tab
      // shows v1 imports too. `upsert` on (user_id, file_hash) gives
      // duplicate-rerun protection for the same-company case.
      await ctx.supabase
        .from('bank_file_imports')
        .upsert(
          {
            user_id: ctx.userId,
            company_id: ctx.companyId!,
            filename: file.name,
            file_hash: fileHash,
            file_format: format,
            transaction_count: parseResult.transactions.length,
            status: 'processing',
            date_from: parseResult.date_from,
            date_to: parseResult.date_to,
          },
          { onConflict: 'user_id,file_hash' },
        )

      // Convert parsed transactions to the RawTransaction shape that
      // ingestTransactions expects. external_id stays stable so re-imports
      // are deduplicated server-side.
      const raw: RawTransaction[] = parseResult.transactions.map((t, idx) => ({
        external_id: generateExternalId(t, format, idx),
        date: t.date,
        amount: t.amount,
        currency: t.currency ?? 'SEK',
        description: t.description ?? null,
        counterparty: t.counterparty ?? null,
        reference: t.reference ?? null,
        source: 'bank_file',
      }))

      const ingestResult = await ingestTransactions(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        raw,
      )

      // Mark the bank_file_imports row complete. Scope by all three
      // identifying fields — `(user_id, file_hash)` is the unique
      // constraint today but adding `company_id` is defense in depth:
      // even if a concurrent same-user same-hash import in a different
      // company slipped past the pre-check, this update can never
      // overwrite the wrong company's status row.
      await ctx.supabase
        .from('bank_file_imports')
        .update({
          status: 'completed',
          imported_at: new Date().toISOString(),
          transaction_count: ingestResult.imported,
        })
        .eq('file_hash', fileHash)
        .eq('user_id', ctx.userId)
        .eq('company_id', ctx.companyId!)

      await completeOperation(
        ctx.supabase,
        {
          id: op.id,
          result: {
            format,
            file_hash: fileHash,
            transactions_imported: ingestResult.imported,
            transactions_duplicates: ingestResult.duplicates,
            transactions_reconciled: ingestResult.reconciled,
            transactions_auto_categorized: ingestResult.auto_categorized,
            transactions_errors: ingestResult.errors,
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
      await failOperation(
        ctx.supabase,
        {
          id: op.id,
          error: {
            code: 'BANK_IMPORT_FAILED',
            message: err instanceof Error ? err.message : 'Unknown failure during bank import.',
          },
        },
        ctx.log,
      )
      return v1ErrorResponseFromCode('BANK_IMPORT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { operation_id: op.id, reason: err instanceof Error ? err.message : 'unknown' },
      })
    }

    return accepted(op.id, 'import.bank', { requestId: ctx.requestId })
  },
)
