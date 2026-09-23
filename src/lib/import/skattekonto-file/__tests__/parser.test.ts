import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectSkattekontoFile, parseSkattekontoFile } from '../parser'

beforeEach(() => {
  vi.clearAllMocks()
})

// Structure-exact mirror of a real 2026-08 export from Skatteverket's
// skattekonto e-service (name, orgnr and amounts sanitized; the real file is
// never committed). Every cell double-quoted, semicolon-delimited, CRLF,
// opening/closing saldo as marker rows, space thousands separator, and the
// invariant opening + sum(rows) = closing holds.
const MODERN_CSV = [
  '"Testbolaget AB";"556677-8899";""',
  '"";"";""',
  '"";"Ingående saldo 2026-05-03";"-500"',
  '"2026-06-06";"Kostnadsränta";"-10"',
  '"2026-07-04";"Kostnadsränta";"-5"',
  '"2026-07-11";"Inbetalning bokförd 260710";"24 000"',
  '"2026-07-13";"Arbetsgivaravgift juni 2026";"-15 000"',
  '"2026-07-13";"Avdragen skatt juni 2026";"-9 000"',
  '"2026-07-23";"Inbetalning bokförd 260722";"600"',
  '"2026-07-28";"Inbetalning bokförd 260727";"35 000"',
  '"2026-08-01";"Kostnadsränta";"-5"',
  '"2026-08-01";"Intäktsränta";"7"',
  '"";"Utgående saldo 2026-08-01";"35 087"',
  '',
].join('\r\n')

const MODERN_FILENAME = 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv'

// Legacy .skv shape: unquoted, headerless, trailing running-saldo column.
const LEGACY_SKV = [
  '2024-01-12;Debiterad preliminärskatt;-8000;-8000',
  '2024-01-14;Inbetalning bokförd 240113;8000;0',
  '2024-02-12;Debiterad preliminärskatt;-8000;-8000',
  '2024-02-13;Intäktsränta;12;-7988',
].join('\n')

// Bank fixtures (mirrored from the bank parser tests): must never detect.
const SEB_BANK_CSV = [
  'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;2024-01-14;12346;HEMKÖP FRIDHEMSPLAN;-432,50;12444,67',
].join('\n')

const NORDEA_BANK_CSV = [
  'Datum,Transaktion,Kategori,Belopp,Saldo',
  '2024-01-15,SPOTIFY AB,,"-99,00","12 345,67"',
  '2024-01-14,ICA MAXI LINDHAGEN,,"-432,50","12 444,67"',
].join('\n')

// A minimal semicolon bank export whose descriptions mention tax concepts:
// one vocabulary hit must not be enough to steal the file.
const GENERIC_BANK_WITH_TAX_PAYMENT = [
  '2024-01-12;Betalning moms Skatteverket;-12000',
  '2024-01-15;SPOTIFY AB;-99',
  '2024-01-20;Kortköp ICA;-432',
  '2024-01-25;Swish Anna;-200',
].join('\n')

describe('detectSkattekontoFile', () => {
  it('detects the modern export by content', () => {
    expect(detectSkattekontoFile(MODERN_CSV, 'nedladdad-fil.csv')).toBe(true)
  })

  it('detects by Skatteverket export filename', () => {
    expect(detectSkattekontoFile('', MODERN_FILENAME)).toBe(true)
  })

  it('detects .skv files by extension', () => {
    expect(detectSkattekontoFile(LEGACY_SKV, 'skattekonto.skv')).toBe(true)
  })

  it('detects legacy content via vocabulary plus row shape', () => {
    expect(detectSkattekontoFile(LEGACY_SKV, 'export.csv')).toBe(true)
  })

  it('does not detect SEB bank exports', () => {
    expect(detectSkattekontoFile(SEB_BANK_CSV, 'kontoutdrag.csv')).toBe(false)
  })

  it('does not detect Nordea bank exports', () => {
    expect(detectSkattekontoFile(NORDEA_BANK_CSV, 'export.csv')).toBe(false)
  })

  it('does not detect a bank file that merely pays Skatteverket', () => {
    expect(detectSkattekontoFile(GENERIC_BANK_WITH_TAX_PAYMENT, 'bank.csv')).toBe(false)
  })

  it('does not detect empty content', () => {
    expect(detectSkattekontoFile('', 'fil.csv')).toBe(false)
  })
})

describe('parseSkattekontoFile: modern export', () => {
  const result = parseSkattekontoFile(MODERN_CSV, MODERN_FILENAME)

  it('parses all transaction rows', () => {
    expect(result.rows).toHaveLength(9)
    expect(result.stats).toEqual({
      total_rows: 9,
      parsed_rows: 9,
      skipped_rows: 0,
      unreadable_amount_rows: 0,
    })
    expect(result.variant).toBe('csv')
  })

  it('extracts company identity from the header row', () => {
    expect(result.company_name).toBe('Testbolaget AB')
    expect(result.org_number).toBe('556677-8899')
  })

  it('consumes saldo markers as metadata, never as rows', () => {
    expect(result.opening_saldo).toBe(-500)
    expect(result.closing_saldo).toBe(35087)
    expect(result.rows.some((r) => /saldo/i.test(r.transaktionstext))).toBe(false)
  })

  it('parses space-separated thousands and signs per SKV convention', () => {
    const inbetalning = result.rows.find(
      (r) => r.transaktionstext === 'Inbetalning bokförd 260710',
    )
    expect(inbetalning?.belopp).toBe(24000)
    const agi = result.rows.find(
      (r) => r.transaktionstext === 'Arbetsgivaravgift juni 2026',
    )
    expect(agi?.belopp).toBe(-15000)
  })

  it('validates the sum invariant', () => {
    expect(result.sum_valid).toBe(true)
    expect(result.events_sum).toBe(35087)
    expect(result.sum_difference).toBe(0)
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('extracts the date range', () => {
    expect(result.date_from).toBe('2026-06-06')
    expect(result.date_to).toBe('2026-08-01')
  })
})

describe('parseSkattekontoFile: legacy .skv', () => {
  const result = parseSkattekontoFile(LEGACY_SKV, 'skattekonto.skv')

  it('parses unquoted rows and ignores the trailing saldo column', () => {
    expect(result.variant).toBe('skv')
    expect(result.rows).toHaveLength(4)
    expect(result.rows[0]).toMatchObject({
      transaktionsdatum: '2024-01-12',
      transaktionstext: 'Debiterad preliminärskatt',
      belopp: -8000,
    })
  })

  it('has no header identity and no sum check without markers', () => {
    expect(result.org_number).toBeNull()
    expect(result.company_name).toBeNull()
    expect(result.sum_valid).toBeNull()
  })
})

describe('parseSkattekontoFile: robustness', () => {
  it('fails a statement whose closing saldo marker is missing', () => {
    const cutOff = MODERN_CSV.replace('"";"Utgående saldo 2026-08-01";"35 087"\r\n', '')
    const result = parseSkattekontoFile(cutOff, MODERN_FILENAME)
    expect(result.sum_valid).toBe(false)
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true)
  })

  it('fails a statement whose saldo amount is unreadable', () => {
    const garbled = MODERN_CSV.replace('"35 087"', '"trasigt"')
    const result = parseSkattekontoFile(garbled, MODERN_FILENAME)
    expect(result.sum_valid).toBe(false)
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true)
  })

  it('flags a sum mismatch as an error and reports the gap', () => {
    const truncated = MODERN_CSV.replace(
      '"2026-07-28";"Inbetalning bokförd 260727";"35 000"\r\n',
      '',
    )
    const result = parseSkattekontoFile(truncated, MODERN_FILENAME)
    expect(result.sum_valid).toBe(false)
    expect(result.events_sum).toBe(87)
    expect(result.sum_difference).toBe(35000)
    expect(result.rows).toHaveLength(8)
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true)
  })

  it('counts dated rows with unreadable amounts as missing from the sum', () => {
    const garbledRow = MODERN_CSV.replace(
      '"2026-07-28";"Inbetalning bokförd 260727";"35 000"',
      '"2026-07-28";"Inbetalning bokförd 260727";"trasigt"',
    )
    const result = parseSkattekontoFile(garbledRow, MODERN_FILENAME)
    expect(result.sum_valid).toBe(false)
    expect(result.stats.unreadable_amount_rows).toBe(1)
    expect(result.stats.skipped_rows).toBe(1)
    const error = result.issues.find((i) => i.severity === 'error')
    expect(error?.message).toContain('oläsbart belopp')
  })

  it('reads a typographic minus and an explicit plus sign', () => {
    const typographic = [
      '"2026-06-06";"Kostnadsränta";"−10"',
      '"2026-06-07";"Kostnadsränta";"–10"',
      '"2026-07-11";"Inbetalning bokförd 260710";"+24 000"',
    ].join('\n')
    const result = parseSkattekontoFile(typographic, 'export.csv')
    expect(result.rows.map((r) => r.belopp)).toEqual([-10, -10, 24000])
    expect(result.stats.skipped_rows).toBe(0)
  })

  it('reads marker saldo from a trailing running-saldo column', () => {
    const withSaldoColumn = [
      '"Testbolaget AB";"556677-8899";"";""',
      '"";"Ingående saldo 2026-05-03";"";"-500"',
      '"2026-06-06";"Kostnadsränta";"-10";"-510"',
      '"2026-07-11";"Inbetalning bokförd 260710";"24 000";"23 490"',
      '"";"Utgående saldo 2026-08-01";"";"23 490"',
    ].join('\r\n')
    const result = parseSkattekontoFile(withSaldoColumn, 'export.csv')
    expect(result.opening_saldo).toBe(-500)
    expect(result.closing_saldo).toBe(23490)
    expect(result.rows.map((r) => r.belopp)).toEqual([-10, 24000])
    expect(result.sum_valid).toBe(true)
  })

  it('checks a multi-section statement from the earliest opening to the latest closing', () => {
    const multiYear = [
      '"Testbolaget AB";"556677-8899";""',
      '"";"Ingående saldo 2025-01-01";"100"',
      '"2025-03-12";"Debiterad preliminärskatt";"-8 000"',
      '"2025-03-14";"Inbetalning bokförd 250313";"8 000"',
      '"";"Utgående saldo 2025-12-31";"100"',
      '"";"Ingående saldo 2026-01-01";"100"',
      '"2026-02-12";"Debiterad preliminärskatt";"-9 000"',
      '"2026-02-13";"Inbetalning bokförd 260212";"9 500"',
      '"";"Utgående saldo 2026-08-01";"600"',
    ].join('\r\n')
    const result = parseSkattekontoFile(multiYear, 'export.csv')
    expect(result.opening_saldo).toBe(100)
    expect(result.closing_saldo).toBe(600)
    expect(result.rows).toHaveLength(4)
    expect(result.sum_valid).toBe(true)
  })

  it('orders markers by their own date when the file lists newest first', () => {
    const newestFirst = [
      '"";"Utgående saldo 2026-08-01";"600"',
      '"2026-02-13";"Inbetalning bokförd 260212";"9 500"',
      '"2026-02-12";"Debiterad preliminärskatt";"-9 000"',
      '"";"Ingående saldo 2026-01-01";"100"',
      '"";"Utgående saldo 2025-12-31";"100"',
      '"2025-03-14";"Inbetalning bokförd 250313";"8 000"',
      '"2025-03-12";"Debiterad preliminärskatt";"-8 000"',
      '"";"Ingående saldo 2025-01-01";"100"',
    ].join('\r\n')
    const result = parseSkattekontoFile(newestFirst, 'export.csv')
    expect(result.opening_saldo).toBe(100)
    expect(result.closing_saldo).toBe(600)
    expect(result.sum_valid).toBe(true)
  })

  it('skips malformed rows with warnings', () => {
    const withBad = [
      '"2026-06-06";"Kostnadsränta";"-10"',
      '"inte-ett-datum";"Trasig rad";"-5"',
      '"2026-06-07";"";"-5"',
      '"2026-06-08";"Kostnadsränta";"abc"',
    ].join('\n')
    const result = parseSkattekontoFile(withBad, 'export.csv')
    expect(result.rows).toHaveLength(1)
    expect(result.stats.skipped_rows).toBe(3)
    expect(result.issues.filter((i) => i.severity === 'warning')).toHaveLength(3)
  })

  it('notes identical rows with an info issue and keeps both', () => {
    const duplicated = [
      '"2026-06-06";"Kostnadsränta";"-10"',
      '"2026-06-06";"Kostnadsränta";"-10"',
    ].join('\n')
    const result = parseSkattekontoFile(duplicated, 'export.csv')
    expect(result.rows).toHaveLength(2)
    expect(result.issues.some((i) => i.severity === 'info')).toBe(true)
  })

  it('strips a BOM before the header row', () => {
    const withBom = '\uFEFF' + MODERN_CSV
    const result = parseSkattekontoFile(withBom, MODERN_FILENAME)
    expect(result.org_number).toBe('556677-8899')
    expect(result.rows).toHaveLength(9)
  })

  it('handles empty content', () => {
    const result = parseSkattekontoFile('', 'export.csv')
    expect(result.rows).toHaveLength(0)
    expect(result.sum_valid).toBeNull()
  })

  it('tolerates a dated marker row without importing it', () => {
    const legacyMarkers = [
      '2024-01-01;Ingående saldo;0;0',
      '2024-01-12;Debiterad preliminärskatt;-8000;-8000',
      '2024-01-31;Utgående saldo;-8000;-8000',
    ].join('\n')
    const result = parseSkattekontoFile(legacyMarkers, 'skattekonto.skv')
    expect(result.rows).toHaveLength(1)
    expect(result.opening_saldo).toBe(0)
    expect(result.closing_saldo).toBe(-8000)
    expect(result.sum_valid).toBe(true)
  })
})
