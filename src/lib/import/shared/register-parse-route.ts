import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/** File types every register import accepts (Excel, CSV, OpenDocument). */
export const REGISTER_IMPORT_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.ods']
export const REGISTER_IMPORT_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** What a register parser (customers, suppliers, articles) returns for one file. */
export interface ParsedRegisterFile<TColumns, TRow> {
  filename: string
  sheet_name: string
  detected_columns: TColumns
  headers: string[]
  preview_rows: string[][]
  rows: TRow[]
  warnings: string[]
}

/** The parse answer every register import step reads. */
export interface RegisterParseResult<TColumns, TAnnotated> {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: TColumns
  headers: string[]
  preview_rows: string[][]
  rows: TAnnotated[]
  duplicate_count: number
  warnings: string[]
}

export interface RegisterParseRouteConfig<TColumns, TRow, TAnnotated> {
  /** withRouteContext operation, e.g. 'register_import.customers.parse'. */
  operation: string
  /** Register name in the failure log line, e.g. 'customer'. */
  register: string
  parse: (buffer: ArrayBuffer, filename: string, overrides: TColumns | undefined) => Promise<ParsedRegisterFile<TColumns, TRow>>
  /**
   * Checks the client's column mapping before it drives the parser; null
   * refuses it as REG_IMPORT_INVALID_COLUMN_OVERRIDES. Without it the parsed
   * JSON is used as sent.
   */
  validateOverrides?: (raw: unknown) => TColumns | null
  /**
   * Marks each row that matches a record the company already has, read with
   * the same matcher the execute step uses.
   */
  annotate: (
    supabase: SupabaseClient,
    companyId: string,
    rows: TRow[],
  ) => Promise<{ rows: TAnnotated[]; duplicateCount: number }>
}

/**
 * POST /api/import/<register>/parse: accepts an Excel/CSV file via FormData
 * (`file`, optional `column_overrides` JSON), auto-detects columns, parses
 * rows and annotates each with its duplicate match. The file checks, the
 * override parse and the answer are the same for every register; only the
 * parser and the matcher differ.
 */
export function registerParseRoute<TColumns, TRow, TAnnotated>(
  config: RegisterParseRouteConfig<TColumns, TRow, TAnnotated>,
) {
  return withRouteContext(config.operation, async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const columnOverridesRaw = formData.get('column_overrides') as string | null

    if (!file) {
      return errorResponseFromCode('REG_IMPORT_NO_FILE', log, { requestId })
    }

    if (file.size > REGISTER_IMPORT_MAX_FILE_SIZE) {
      return errorResponseFromCode('REG_IMPORT_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!REGISTER_IMPORT_EXTENSIONS.includes(ext)) {
      return errorResponseFromCode('REG_IMPORT_INVALID_FORMAT', log, {
        requestId,
        details: { extension: ext, allowed: REGISTER_IMPORT_EXTENSIONS },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    let columnOverrides: TColumns | undefined
    if (columnOverridesRaw) {
      let raw: unknown
      try {
        raw = JSON.parse(columnOverridesRaw)
      } catch {
        return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
      if (config.validateOverrides) {
        const validated = config.validateOverrides(raw)
        if (validated === null) {
          return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
        }
        columnOverrides = validated
      } else {
        columnOverrides = raw as TColumns
      }
    }

    try {
      const buffer = await file.arrayBuffer()
      const parsed = await config.parse(buffer, file.name, columnOverrides)
      const { rows, duplicateCount } = await config.annotate(supabase, companyId, parsed.rows)

      const result: RegisterParseResult<TColumns, TAnnotated> = {
        filename: parsed.filename,
        sheet_name: parsed.sheet_name,
        total_rows: rows.length,
        detected_columns: parsed.detected_columns,
        headers: parsed.headers,
        preview_rows: parsed.preview_rows,
        rows,
        duplicate_count: duplicateCount,
        warnings: parsed.warnings,
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error(`${config.register} import parse failed`, err as Error)
      return errorResponseFromCode('REG_IMPORT_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  })
}
