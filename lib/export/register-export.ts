import {
  reportToWorkbook,
  exportFilename,
  UTF8_BOM,
} from '@/lib/reports/xlsx-export'

export type RegisterExportFormat = 'xlsx' | 'csv'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Normalize the `?format=` query param to a supported export format. */
export function parseExportFormat(raw: string | null): RegisterExportFormat {
  return raw === 'csv' ? 'csv' : 'xlsx'
}

/**
 * Build the download body + headers for a register export (customers,
 * suppliers, articles) in either xlsx or csv. CSV is a single sheet with a
 * UTF-8 BOM so Excel renders åäö correctly; both formats share the same
 * column/row spec so files round-trip back through the importer.
 */
export function buildRegisterExport(
  spec: Parameters<typeof reportToWorkbook>[0],
  opts: { format: RegisterExportFormat; slug: string; companyName: string; date: string },
): { buffer: Buffer; contentType: string; filename: string } {
  const { format, slug, companyName, date } = opts

  if (format === 'csv') {
    const buf = reportToWorkbook(spec, { bookType: 'csv' })
    return {
      buffer: Buffer.concat([Buffer.from(UTF8_BOM, 'utf-8'), buf]),
      contentType: 'text/csv; charset=utf-8',
      filename: exportFilename(slug, companyName, date, 'csv'),
    }
  }

  return {
    buffer: reportToWorkbook(spec),
    contentType: XLSX_MIME,
    filename: exportFilename(slug, companyName, date, 'xlsx'),
  }
}

/** Today's date as `YYYY-MM-DD` for export filenames. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
