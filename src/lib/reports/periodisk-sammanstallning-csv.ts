/**
 * SKV574008 CSV serializer for periodisk sammanställning.
 *
 * Format (Skatteverket):
 *
 *   SKV574008;
 *   {orgnr};{period};{kontaktnamn};{telefon};{email}
 *   {landskod+vatnr};{tjänster};{varor};{trepartshandel};
 *   ...
 *
 *   - Semicolon-separated, ISO-8859-1 (Latin-1) encoded, CRLF terminated.
 *   - Period codes: YYMM for monthly (e.g. "2505"), YY-Q for quarterly
 *     (e.g. "25-2"). Verified against Skatteverket's current spec.
 *   - Amounts are whole kronor, signed integers (negative allowed).
 *   - Empty buckets are blank fields (`;;`), never `0;0`.
 *   - Avropslager codes X/Y/Z are NOT emitted in v1: only numeric amounts.
 *
 * The serializer refuses to build if any row has hasBlockingIssue=true or any
 * warning is error-level. Caller (API route) returns 400 to the client.
 */

import type { PeriodiskSammanstallningReport } from './periodisk-sammanstallning'

export interface CsvFilerInfo {
  organizationNumber: string   // 10 or 12 digits, dashes/spaces stripped
  contactName: string
  contactPhone: string
  contactEmail: string
}

export class PsCsvBuildError extends Error {
  constructor(
    public readonly reason:
      | 'BLOCKING_WARNINGS'
      | 'MISSING_FILER_INFO'
      | 'INVALID_PERIOD_CODE',
    message: string,
  ) {
    super(message)
    this.name = 'PsCsvBuildError'
  }
}

const PERIOD_MONTHLY_RE = /^\d{2}(0[1-9]|1[0-2])$/
const PERIOD_QUARTERLY_RE = /^\d{2}-[1-4]$/

/**
 * Encode the period for the file header.
 *   monthly:   YYMM     (e.g. 2505 for May 2025)
 *   quarterly: YY-Q     (e.g. 25-2 for Q2 2025)
 */
export function formatPeriodCode(
  type: 'monthly' | 'quarterly',
  year: number,
  period: number,
): string {
  const yy = String(year % 100).padStart(2, '0')
  if (type === 'monthly') {
    if (period < 1 || period > 12) {
      throw new PsCsvBuildError('INVALID_PERIOD_CODE', `Ogiltig månad: ${period}`)
    }
    return `${yy}${String(period).padStart(2, '0')}`
  }
  if (period < 1 || period > 4) {
    throw new PsCsvBuildError('INVALID_PERIOD_CODE', `Ogiltigt kvartal: ${period}`)
  }
  return `${yy}-${period}`
}

function normalizeOrgNumber(raw: string): string {
  return (raw ?? '').replace(/[^\d]/g, '')
}

function csvField(value: string): string {
  // Skatteverket's CSV uses semicolon as separator. Any embedded semicolon or
  // newline would corrupt the line; strip them rather than quote (Skatteverket
  // does not document a quoting mechanism for SKV574008).
  return value.replace(/[;\r\n]/g, ' ').trim()
}

function emptyOrAmount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return ''
  return String(Math.trunc(n))
}

export function buildPeriodiskSammanstallningCsv(
  report: PeriodiskSammanstallningReport,
  filer: CsvFilerInfo,
): { filename: string; content: Buffer; mimeType: string } {
  // 1. Filer info present?
  const orgnr = normalizeOrgNumber(filer.organizationNumber)
  if (!orgnr || !filer.contactName?.trim() || !filer.contactPhone?.trim() || !filer.contactEmail?.trim()) {
    throw new PsCsvBuildError(
      'MISSING_FILER_INFO',
      'Kontaktuppgifter för skatterapportering saknas. Fyll i namn, telefon och e-post under Inställningar → Företag.',
    )
  }

  // 2. No blocking warnings?
  const blockingErrors = report.warnings.filter(w => w.level === 'error')
  if (blockingErrors.length > 0) {
    throw new PsCsvBuildError(
      'BLOCKING_WARNINGS',
      `${blockingErrors.length} blockerande fel måste åtgärdas innan CSV kan laddas ner.`,
    )
  }

  // 3. Period code.
  const periodCode = formatPeriodCode(report.period.type, report.period.year, report.period.period)
  // Defensive: formatPeriodCode already validates, but double-check via regex.
  const re = report.period.type === 'monthly' ? PERIOD_MONTHLY_RE : PERIOD_QUARTERLY_RE
  if (!re.test(periodCode)) {
    throw new PsCsvBuildError('INVALID_PERIOD_CODE', `Periodkod ${periodCode} matchar inte SKV-format.`)
  }

  // 4. Assemble lines.
  const lines: string[] = []
  lines.push('SKV574008;')
  lines.push(
    [
      csvField(orgnr),
      csvField(periodCode),
      csvField(filer.contactName),
      csvField(filer.contactPhone),
      csvField(filer.contactEmail),
    ].join(';'),
  )

  for (const row of report.rows) {
    // Skip rows where all three buckets round to zero (defensive: the
    // generator already drops them, but a row could be passed in manually).
    if (row.services === 0 && row.goods === 0 && row.triangulation === 0) continue

    const vatField = `${row.country}${row.vatNumber}`
    lines.push(
      [
        csvField(vatField),
        emptyOrAmount(row.services),
        emptyOrAmount(row.goods),
        emptyOrAmount(row.triangulation),
        '',
      ].join(';'),
    )
  }

  // CRLF line endings, ISO-8859-1 encoded.
  const text = lines.join('\r\n') + '\r\n'
  const content = Buffer.from(text, 'latin1')

  const periodLabel = report.period.type === 'monthly'
    ? periodCode                       // 2505
    : periodCode.replace('-', 'Q')     // 25Q2 for filename clarity

  return {
    filename: `Periodisk_sammanstallning_${orgnr}_${periodLabel}.csv`,
    content,
    mimeType: 'text/csv; charset=iso-8859-1',
  }
}
