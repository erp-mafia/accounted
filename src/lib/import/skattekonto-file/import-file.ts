/**
 * The skattekontoutdrag file import as one service, for companies without a
 * Skatteverket connection (self-hosted, or before the connection exists).
 * Behind the dashboard's /api/import/skattekonto-file/execute route and the
 * v1 operation imports.skattekonto-file (lib/operations/skattekonto-file.ts).
 *
 * It stores skattekonto rows and books nothing: the rows land in
 * skattekonto_transactions (source file_import) and are booked later through
 * the skattekonto rules, exactly like API-synced rows.
 *
 * Rules for a whole file (the API door, which receives the file itself):
 *   - at most 10 MB, recognised as a skattekontoutdrag, at least one event;
 *   - a file already imported to completion is refused as a duplicate;
 *   - the two things the dashboard preview asks the user to confirm are
 *     refused unless confirmed: an organisation number in the header that is
 *     not the company's, and a statement that does not sum;
 *   - rows are deduplicated server-side against the table (never trusting a
 *     client's partition): duplicates skipped, upcoming rows the statement
 *     proves settled promoted in place.
 * A dry run parses, checks and counts and writes nothing.
 */
import { generateFileHash } from '@/lib/import/bank-file/parser'
import { normalizeOrgNumber } from '@/lib/import/shared/column-utils'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import {
  assignFileDedupKeys,
  partitionFileRows,
  type SkattekontoFileRowIdentity,
} from '@/lib/skatteverket/skattekonto-dedup'
import { executeSkattekontoFileImport, fetchExistingSkattekontoRows } from './import-service'
import { detectSkattekontoFile, parseSkattekontoFile } from './parser'

export const SKATTEKONTO_FILE_MAX_BYTES = 10 * 1024 * 1024

export interface RecordSkattekontoFileInput {
  rows: SkattekontoFileRowIdentity[]
  filename: string
  file_hash: string
  variant: 'csv' | 'skv'
  closing_saldo?: number | null
}

export interface SkattekontoFileImportResult {
  import_id: string
  imported: number
  duplicates: number
  promoted: number
  errors: number
  date_from: string
  date_to: string
  closing_saldo: number | null
}

/**
 * Record the import (skattekonto_file_imports, upserted on company + file
 * hash) and write the confirmed rows. Residual unique-constraint conflicts
 * count as duplicates, not failures.
 */
export async function recordSkattekontoFileImport(
  ctx: OperationContext,
  input: RecordSkattekontoFileInput,
): Promise<OperationOutcome<SkattekontoFileImportResult>> {
  const { supabase, companyId, userId, log } = ctx
  const { rows, filename, file_hash, variant, closing_saldo } = input
  const dates = rows.map((r) => r.transaktionsdatum).sort()

  try {
    const { data: importRecord, error: importError } = await supabase
      .from('skattekonto_file_imports')
      .upsert(
        {
          company_id: companyId,
          user_id: userId,
          filename,
          file_hash,
          file_variant: variant,
          row_count: rows.length,
          date_from: dates[0],
          date_to: dates[dates.length - 1],
          closing_saldo: closing_saldo ?? null,
          status: 'processing',
        },
        { onConflict: 'company_id,file_hash' },
      )
      .select()
      .single()

    if (importError || !importRecord) {
      log.error('failed to create skattekonto_file_imports record', importError ?? new Error('no record returned'))
      return {
        ok: false,
        code: 'SKATTEKONTO_FILE_IMPORT_RECORD_FAILED',
        details: { reason: importError ? getUserErrorMessage(importError) : 'unknown' },
      }
    }

    const outcome = await executeSkattekontoFileImport(supabase, companyId, importRecord.id, rows)

    if (outcome.errors > 0) {
      log.error('skattekonto file import reported row errors', new Error(outcome.first_error ?? 'unknown'), {
        errorCount: outcome.errors,
      })
    }

    const { error: statusError } = await supabase
      .from('skattekonto_file_imports')
      .update({
        imported_count: outcome.imported,
        duplicate_count: outcome.duplicates,
        promoted_count: outcome.promoted,
        status: outcome.errors > 0 && outcome.imported === 0 ? 'failed' : 'completed',
        error_message:
          outcome.errors > 0 ? `${outcome.errors} rader kunde inte importeras: ${outcome.first_error ?? ''}` : null,
      })
      .eq('id', importRecord.id)
    if (statusError) {
      // The rows are written; only the record would misreport "processing".
      log.error('failed to finalize skattekonto_file_imports record', statusError)
    }

    return {
      ok: true,
      created: true,
      data: {
        import_id: importRecord.id,
        imported: outcome.imported,
        duplicates: outcome.duplicates,
        promoted: outcome.promoted,
        errors: outcome.errors,
        date_from: dates[0],
        date_to: dates[dates.length - 1],
        closing_saldo: closing_saldo ?? null,
      },
    }
  } catch (err) {
    log.error('skattekonto file execute failed', err as Error)
    return {
      ok: false,
      code: 'SKATTEKONTO_FILE_EXECUTE_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

export interface ImportSkattekontoFileInput {
  filename: string
  /** The file's bytes, base64. */
  content_base64: string
  confirm_org_number_mismatch?: boolean
  confirm_sum_mismatch?: boolean
}

export interface ImportSkattekontoFileResult extends SkattekontoFileImportResult {
  file_hash: string
  variant: 'csv' | 'skv'
  row_count: number
}

/** Parse a whole statement file, apply the file rules, then record it. */
export async function importSkattekontoFile(
  ctx: OperationContext,
  input: ImportSkattekontoFileInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ImportSkattekontoFileResult>> {
  const { supabase, companyId, log } = ctx

  const bytes = Buffer.from(input.content_base64, 'base64')
  if (bytes.length > SKATTEKONTO_FILE_MAX_BYTES) {
    return { ok: false, code: 'SKATTEKONTO_FILE_TOO_LARGE', details: { size_bytes: bytes.length } }
  }
  if (bytes.length === 0) return { ok: false, code: 'SKATTEKONTO_FILE_NOT_RECOGNIZED' }

  let parsed
  let fileHash: string
  try {
    const content = decodeFileContent(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer)
    fileHash = generateFileHash(content)

    const { data: existingImport } = await supabase
      .from('skattekonto_file_imports')
      .select('id, status, imported_count, created_at')
      .eq('company_id', companyId)
      .eq('file_hash', fileHash)
      .maybeSingle()
    if (existingImport && existingImport.status === 'completed') {
      return {
        ok: false,
        code: 'SKATTEKONTO_FILE_DUPLICATE',
        details: {
          import_id: existingImport.id,
          imported_count: existingImport.imported_count,
          imported_at: existingImport.created_at,
        },
      }
    }

    // Strict gate: a bank CSV sent here by mistake could otherwise parse
    // "well enough" and land bank rows on the skattekonto.
    if (!detectSkattekontoFile(content, input.filename)) {
      return { ok: false, code: 'SKATTEKONTO_FILE_NOT_RECOGNIZED' }
    }
    parsed = parseSkattekontoFile(content, input.filename)
  } catch (err) {
    log.error('skattekonto file parse failed', err as Error)
    return {
      ok: false,
      code: 'SKATTEKONTO_FILE_PARSE_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }

  if (parsed.rows.length === 0) return { ok: false, code: 'SKATTEKONTO_FILE_NO_ROWS' }

  // Wrong-company guard: the modern export names its orgnr in the header row
  // (legacy files have none). The dashboard asks the user to confirm.
  let orgNumberMismatch = false
  if (parsed.org_number) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('org_number')
      .eq('company_id', companyId)
      .maybeSingle()
    const companyOrg = normalizeOrgNumber(settings?.org_number ?? null)
    const fileOrg = normalizeOrgNumber(parsed.org_number)
    orgNumberMismatch = companyOrg !== null && fileOrg !== null && companyOrg !== fileOrg
  }
  if (orgNumberMismatch && !input.confirm_org_number_mismatch) {
    return {
      ok: false,
      code: 'SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH',
      details: { file_org_number: parsed.org_number, file_company_name: parsed.company_name },
    }
  }
  if (parsed.sum_valid === false && !input.confirm_sum_mismatch) {
    return {
      ok: false,
      code: 'SKATTEKONTO_FILE_SUM_MISMATCH',
      details: {
        opening_saldo: parsed.opening_saldo,
        closing_saldo: parsed.closing_saldo,
        events_sum: parsed.events_sum,
        sum_difference: parsed.sum_difference,
      },
    }
  }

  const rows: SkattekontoFileRowIdentity[] = parsed.rows.map((row) => ({
    transaktionsdatum: row.transaktionsdatum,
    transaktionstext: row.transaktionstext,
    belopp: row.belopp,
  }))

  if (options.dryRun) {
    const existing = await fetchExistingSkattekontoRows(
      supabase,
      companyId,
      parsed.date_from as string,
      parsed.date_to as string,
    )
    const partition = partitionFileRows(assignFileDedupKeys(rows), existing)
    return {
      ok: true,
      dryRun: true,
      preview: {
        filename: input.filename,
        file_hash: fileHash,
        variant: parsed.variant,
        row_count: rows.length,
        date_from: parsed.date_from,
        date_to: parsed.date_to,
        opening_saldo: parsed.opening_saldo,
        closing_saldo: parsed.closing_saldo,
        sum_valid: parsed.sum_valid,
        org_number_mismatch: orgNumberMismatch,
        would_import: partition.toInsert.length,
        would_skip_duplicates: partition.duplicates.length,
        would_promote: partition.promotions.length,
        issues: parsed.issues.slice(0, 20),
      },
    }
  }

  const recorded = await recordSkattekontoFileImport(ctx, {
    rows,
    filename: input.filename,
    file_hash: fileHash,
    variant: parsed.variant,
    closing_saldo: parsed.closing_saldo,
  })
  if (!recorded.ok || recorded.dryRun) return recorded
  return {
    ...recorded,
    data: { ...recorded.data, file_hash: fileHash, variant: parsed.variant, row_count: rows.length },
  }
}
