/**
 * Tests for POST /api/import/sie/parse.
 *
 * Runs through the real withRouteContext wrapper (auth/company deps mocked)
 * with the real SIE parser and encoding detection. Focus: the CP1252-mojibake
 * tripwire. A file whose text was mis-decoded UPSTREAM (CP437 bytes read as
 * windows-1252, then saved as UTF-8) decodes "correctly" here, so byte-level
 * detection can never catch it; the artifact scan must add a parse-issue
 * warning to the preview WITHOUT blocking the parse. The mojibake literals are
 * the subject under test and must stay byte-exact.
 *
 * The route has no 404 path: it operates on the uploaded file, not a stored
 * resource.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The period's unlinked IB verifikat has its own tests
// (opening-balance/unlinked.test.ts, opening-balances.test.ts); here the
// year has none, so the queued journal reads stay the report's own.
vi.mock('@/lib/import/opening-balance/unlinked', () => ({
  findUnlinkedOpeningBalance: vi.fn(async () => null),
}))
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ImportPreview, ParseIssue } from '@/lib/import/types'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

// Keep the real preview generator; stub only the DB-touching duplicate checks.
vi.mock('@/lib/import/sie-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/import/sie-import')>()
  return {
    ...actual,
    checkDuplicateImport: vi.fn().mockResolvedValue(null),
    checkDuplicatePeriodImport: vi.fn().mockResolvedValue(null),
  }
})

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

// A file whose text was mis-decoded upstream and re-saved as UTF-8. The BOM is
// what such a file realistically carries after an editor/tool re-save, and it
// pins detectEncoding to utf8: without intact C3-prefixed Swedish sequences the
// byte heuristic would otherwise read the U+201D/U+201E continuation bytes as
// CP437 and re-mangle the text before the scanner could see the signature.
const MOJIBAKE_SIE = '\uFEFF' + [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Migrerad AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "F”retagskonto"',
  '#KONTO 4056 "Ink”p tj„nster inom EU"',
  '#VER A 1 20240115 "L”neutbetalning"',
  '{',
  '#TRANS 1930 {} -100.00',
  '#TRANS 4056 {} 100.00',
  '}',
].join('\n')

const CLEAN_SIE = MOJIBAKE_SIE
  .replace('F”retagskonto', 'Företagskonto')
  .replace('Ink”p tj„nster inom EU', 'Inköp tjänster inom EU')
  .replace('L”neutbetalning', 'Löneutbetalning')

function fileRequest(content: string, filename = 'test.se'): Request {
  const formData = new FormData()
  formData.append('file', new File([content], filename, { type: 'text/plain' }))
  return new Request('http://localhost:3000/api/import/sie/parse', {
    method: 'POST',
    body: formData,
  })
}

type ParseResponse = {
  success: boolean
  parsed: { issues: ParseIssue[] }
  validation: { valid: boolean; warnings: string[] }
  preview: Pick<
    ImportPreview,
    'chart' | 'fiscalYear' | 'mappingStatus' | 'orgNumberMismatch' | 'companyOrgNumber' | 'openingBalanceContinuity'
  >
}

/** The file's year is not recorded: the chart, no year around it, no other year, the legal form. */
function enqueueNewYear() {
  enqueue({ data: [] })
  enqueue({ data: null })
  enqueue({ data: [] })
  enqueue({ data: [] })
  enqueue({ data: { entity_type: 'aktiebolag' } })
}

describe('POST /api/import/sie/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    // The stored-mappings lookup (sie_account_mappings select).
    enqueue({ data: [] })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 when no file is attached', async () => {
    const formData = new FormData()
    const request = new Request('http://localhost:3000/api/import/sie/parse', {
      method: 'POST',
      body: formData,
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
  })

  it('keeps unused non-four-digit definitions visible as archive-only and out of target mappings', async () => {
    enqueueNewYear()
    const response = await POST(fileRequest(CLEAN_SIE + '\n#KONTO 999 "Unused"\n#KONTO 193000 "Unused subaccount"'), emptyParams)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.parsed.accounts.map((account: { number: string }) => account.number)).toContain('193000')
    expect(body.preview.archivedOnlyAccounts.map((account: { number: string }) => account.number)).toEqual(['999', '193000'])
    expect(body.mappings.map((mapping: { sourceAccount: string }) => mapping.sourceAccount)).not.toContain('193000')
    expect(body.mappingStats.unmapped).toBe(0)
    expect(body.preview.accountCount).toBe(4)
  })

  // #2546: SIE4I subsystem files carry the .si extension, which this route
  // rejected even though the MCP upload tool already accepted it.
  it.each(['test.se', 'test.sie', 'test.si', 'TEST.SI'])('accepts %s', async (filename) => {
    enqueue({ data: [] }) // company chart
    enqueue({ data: { id: 'p-2024' } }) // containing fiscal period

    const response = await POST(fileRequest(CLEAN_SIE, filename), emptyParams)
    expect(response.status).toBe(200)
  })

  // crm#1049, issue #108: CLEAN_SIE carries verifikat and no balances (a card
  // provider's or payroll's export). Over a year that already holds an import
  // it is parsed and offered as an append only, never as the replacement.
  it('offers a verifikat-only file for an already imported year as an append only', async () => {
    const { checkDuplicatePeriodImport } = await import('@/lib/import/sie-import')
    vi.mocked(checkDuplicatePeriodImport).mockResolvedValueOnce({
      id: 'import-2024', fiscal_year_start: '2024-01-01', fiscal_year_end: '2024-12-31',
    } as never)
    enqueue({ data: [] }) // company chart
    enqueue({ data: { id: 'p-2024' } }) // containing fiscal period

    const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
    const body = (await response.json()) as { existingImport?: { id: string }; appendOnly?: boolean }

    expect(response.status).toBe(200)
    expect(body.existingImport?.id).toBe('import-2024')
    expect(body.appendOnly).toBe(true)
  })

  it('still parses a whole-year file for an imported year (the replacement path)', async () => {
    const { checkDuplicatePeriodImport } = await import('@/lib/import/sie-import')
    vi.mocked(checkDuplicatePeriodImport).mockResolvedValueOnce({
      id: 'import-2024',
      fiscal_year_start: '2024-01-01',
      fiscal_year_end: '2024-12-31',
    } as never)
    enqueue({ data: [] }) // company chart
    enqueue({ data: { id: 'p-2024' } }) // containing fiscal period

    const withBalances = CLEAN_SIE.replace('#RAR 0 20240101 20241231', '#RAR 0 20240101 20241231\n#UB 0 1930 -100.00\n#RES 0 4056 100.00')
    const response = await POST(fileRequest(withBalances), emptyParams)
    const body = (await response.json()) as { existingImport?: { id: string } }

    expect(response.status).toBe(200)
    expect(body.existingImport?.id).toBe('import-2024')
    expect((body as { appendOnly?: boolean }).appendOnly).toBe(false)
  })

  // Fortnox's "Kundfakturor och inbetalningar" export: no #RAR, verifikat
  // over several years. The refusal used to come back as SIE_PARSE_FAILED
  // ("the file may be damaged") with the real sentence only in the logs.
  it('says a multi-year file without #RAR is a partial export, as a 400 the UI shows', async () => {
    reset()
    enqueue({ data: [] }) // fiscal_periods the file's dates touch: none
    const partial = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#PROGRAM "Fortnox" 3.62',
      '#VER B 1 20200115 "Kundfaktura"',
      '{',
      '#TRANS 1510 {} 125.00',
      '#TRANS 3001 {} -125.00',
      '}',
      '#VER C 1 20261103 "Inbetalning"',
      '{',
      '#TRANS 1930 {} 125.00',
      '#TRANS 1510 {} -125.00',
      '}',
    ].join('\n')

    const response = await POST(fileRequest(partial, 'Kundfakturor och inbetalningar_20200101-20261103.si'), emptyParams)
    expect(response.status).toBe(400)
    const body = await response.json()
    const { getErrorMessage } = await import('@/lib/errors/get-error-message')
    const shown = getErrorMessage(body)
    expect(shown).toContain('verifikationerna sträcker sig över mer än ett räkenskapsår (2020-01-15 till 2026-11-03)')
    expect(shown).toContain('Exportera i stället hela bokföringen som SIE typ 4')
    expect(shown).not.toContain('skadad')
  })

  it('answers a file that fails validation with its errors, as a 400', async () => {
    const unbalanced = CLEAN_SIE.replace('#TRANS 4056 {} 100.00', '#TRANS 4056 {} 90.00')
    const response = await POST(fileRequest(unbalanced), emptyParams)
    const body = (await response.json()) as { error: { code: string; details: { errors: string[] } } }
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('SIE_PARSE_VALIDATION_FAILED')
    expect(body.error.details.errors.join(' ')).toContain('balanserar inte')
  })

  it('returns 400 for a file extension that is not SIE', async () => {
    const response = await POST(fileRequest(CLEAN_SIE, 'test.txt'), emptyParams)
    const body = (await response.json()) as { error?: { code?: string; message?: string } }

    expect(response.status).toBe(400)
    expect(body.error?.code).toBe('SIE_PARSE_INVALID_TYPE')
    expect(body.error?.message).toContain('.si')
  })

  it('adds a mojibake warning to the preview issues without blocking the parse', async () => {
    enqueueNewYear()
    const response = await POST(fileRequest(MOJIBAKE_SIE), emptyParams)
    const body = (await response.json()) as ParseResponse

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.validation.valid).toBe(true)

    const issue = body.parsed.issues.find((i) => i.message.includes('felaktigt teckenkodad'))
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('warning')
    // Points at the first flagged string's line: #KONTO 1930 "F”retagskonto".
    expect(issue!.line).toBe(5)
    // validateSIEFile folds parse issues into the validation warnings too.
    expect(body.validation.warnings.some((w) => w.includes('felaktigt teckenkodad'))).toBe(true)
  })

  it('adds no mojibake warning for a clean file', async () => {
    enqueueNewYear()
    const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
    const body = (await response.json()) as ParseResponse

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.parsed.issues.some((i) => i.message.includes('felaktigt teckenkodad'))).toBe(false)
    expect(body.validation.warnings.some((w) => w.includes('felaktigt teckenkodad'))).toBe(false)
  })

  // #58 (1000-row cap): the preview read the stored mappings unpaged, so past
  // PostgREST's first 1,000 rows a remembered mapping fell back to a
  // suggestion, and the dashboard sends the previewed mappings to execute.
  it('keeps a remembered mapping that sits past the first 1,000 stored rows', async () => {
    reset()
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      source_account: String(100000 + i), source_name: null, target_account: '1930', confidence: 1, match_type: 'manual',
    }))
    enqueue({ data: filler }) // stored mappings, first page (full)
    enqueue({ data: [{ source_account: '4056', source_name: null, target_account: '4010', confidence: 1, match_type: 'manual' }] })
    enqueue({ data: [] }) // company chart
    enqueue({ data: { id: 'p-2024' } }) // containing fiscal period

    const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
    const body = (await response.json()) as { mappings: Array<{ sourceAccount: string; targetAccount: string; isOverride: boolean }> }

    expect(response.status).toBe(200)
    expect(body.mappings.find((m) => m.sourceAccount === '4056')).toMatchObject({ targetAccount: '4010', isOverride: true })
  })

  // Queue order after the stored-mappings select from beforeEach:
  //   chart_of_accounts page (fetchAllRows), fiscal_periods containing,
  //   fiscal_periods overlapping, journal_entries (only when replaceable).
  describe('chart and fiscal-year preview blocks', () => {
    const seededPeriod = {
      id: 'seeded-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
      name: 'Räkenskapsår 2024',
      is_closed: false,
      locked_at: null,
      opening_balances_set: false,
    }

    it('counts the file accounts against the company chart, not the BAS reference', async () => {
      enqueue({ data: [{ account_number: '1930' }] }) // company chart: 1930 only
      enqueue({ data: { id: 'p-2024' } }) // containing period

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(response.status).toBe(200)
      // Both file accounts map to BAS, so the reference-based stats say 2 mapped
      // while only one is new to this company.
      expect(body.preview.mappingStatus.mapped).toBe(2)
      expect(body.preview.chart).toEqual({
        toCreate: 1,
        existing: 1,
        sample: [{ number: '4056', name: expect.any(String) }],
      })
    })

    it('plans the chart with and without the file\'s unused definitions (#63)', async () => {
      enqueue({ data: [{ account_number: '1930' }] }) // company chart: 1930 only
      enqueue({ data: { id: 'p-2024' } }) // containing period

      const response = await POST(
        fileRequest(CLEAN_SIE.replace('#KONTO 1930',
          '#KONTO 2440 "Leverantörsskulder"\n#KONTO 6110 "Kontorsmateriel"\n#KONTO 6111 "Egen kostnad"\n#KONTO 1930')),
        emptyParams,
      )
      const body = (await response.json()) as ParseResponse & {
        preview: Pick<ImportPreview, 'unusedAccounts' | 'unusedOwnAccounts' | 'chartUsedOnly'>
      }

      expect(response.status).toBe(200)
      // Unused BAS accounts are left out by the option; the company's own 6111 is kept.
      expect(body.preview.unusedAccounts?.map((account) => account.number)).toEqual(['2440', '6110'])
      expect(body.preview.unusedOwnAccounts?.map((account) => account.number)).toEqual(['6111'])
      expect(body.preview.chart).toMatchObject({ toCreate: 4, existing: 1 })
      expect(body.preview.chartUsedOnly).toEqual({
        toCreate: 2,
        existing: 1,
        sample: [{ number: '4056', name: expect.any(String) }, { number: '6111', name: 'Egen kostnad' }],
      })
    })

    it('adds no second plan when the file uses every account it defines', async () => {
      enqueue({ data: [] }) // company chart
      enqueue({ data: { id: 'p-2024' } }) // containing period

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as { preview: Pick<ImportPreview, 'unusedAccounts' | 'chartUsedOnly'> }

      expect(body.preview.unusedAccounts).toEqual([])
      expect(body.preview.chartUsedOnly).toBeUndefined()
    })

    it('reports match when a fiscal period already contains the file year', async () => {
      enqueue({ data: [] })
      enqueue({ data: { id: 'p-2024' } })

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(body.preview.fiscalYear).toEqual({ verdict: 'match', periodId: 'p-2024' })
    })

    it('reports create when no period overlaps the file year', async () => {
      enqueueNewYear()

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(body.preview.fiscalYear).toEqual({ verdict: 'create', replacesEmptyPeriodId: null })
    })

    it('reports the conflict at preview that the import would otherwise refuse', async () => {
      enqueue({ data: [] })
      enqueue({ data: null })
      enqueue({ data: [{ ...seededPeriod, period_start: '2023-07-01', period_end: '2024-06-30' }] })
      enqueue({ data: [{ id: 'entry-1' }] }) // the overlapping period has entries

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(response.status).toBe(200)
      expect(body.preview.fiscalYear?.verdict).toBe('conflict')
      if (body.preview.fiscalYear?.verdict !== 'conflict') return
      expect(body.preview.fiscalYear.existingPeriod.id).toBe('seeded-2024')
      expect(body.preview.fiscalYear.message).toMatch(/2024-01-01 till 2024-12-31/)
      expect(body.preview.fiscalYear.message).toMatch(/Inställningar → Företag/)
    })
  })

  // crm#1099: a year imported on top of earlier bookkeeping opens on the
  // carried-forward balance, not the file's #IB. Queue order after the
  // stored-mappings select: chart_of_accounts page, fiscal_periods containing,
  // then the continuity check: fiscal_periods (the year's own IB verifikat,
  // crm#1272), journal_entries (prior activity), the
  // compute_prior_opening_balances RPC, fiscal_periods (missing years).
  describe('opening balance against the books', () => {
    const SECOND_YEAR = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Migrerad AB"',
      '#RAR 0 20190101 20191231',
      '#RAR -1 20180101 20181231',
      '#KONTO 1930 "Företagskonto"',
      '#KONTO 2990 "Övriga upplupna kostnader"',
      '#KONTO 3001 "Försäljning"',
      '#UB -1 1930 1000.00',
      '#UB -1 2990 -1000.00',
      '#IB 0 1930 1036.00',
      '#IB 0 2990 -1036.00',
      '#VER A 1 20190115 "Försäljning"',
      '{',
      '#TRANS 1930 {} 100.00',
      '#TRANS 3001 {} -100.00',
      '}',
    ].join('\n')

    it('shows the accounts where the books will open on another amount than the file', async () => {
      enqueue({ data: [] }) // company chart
      enqueue({ data: { id: 'p-2019' } }) // containing period
      enqueue({ data: null }) // the year has no IB verifikat of its own
      enqueue({ data: [{ id: 'entry-2018' }] }) // activity up to the year's end
      enqueue({
        data: [
          { account_number: '1930', debit: 1000, credit: 0 },
          { account_number: '2990', debit: 0, credit: 1000 },
        ],
      })
      enqueue({
        data: [
          { id: 'p-2018', name: 'Räkenskapsår 2018', period_start: '2018-01-01', period_end: '2018-12-31' },
          { id: 'p-2019', name: 'Räkenskapsår 2019', period_start: '2019-01-01', period_end: '2019-12-31' },
        ],
      })

      const response = await POST(fileRequest(SECOND_YEAR), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(response.status).toBe(200)
      expect(body.preview.openingBalanceContinuity).toEqual({
        carriedForward: true,
        differences: [
          { account: '1930', file: 1036, books: 1000, difference: -36 },
          { account: '2990', file: -1036, books: -1000, difference: 36 },
        ],
        // The books open on the file's own #UB -1: the file's #IB is the side that is off.
        fileOpeningOff: true,
        sourceEdits: [
          { account: '1930', previousClosing: 1000, opening: 1036, difference: 36 },
          { account: '2990', previousClosing: -1000, opening: -1036, difference: -36 },
        ],
        missingYears: [],
        noVouchers: false,
      })
    })

    it('says the file\'s IB is booked as it stands when the company has no earlier activity', async () => {
      enqueue({ data: [] })
      enqueue({ data: { id: 'p-2019' } })
      enqueue({ data: null }) // no IB verifikat of its own
      enqueue({ data: [] }) // no activity: the import books the file's #IB
      enqueue({ data: [] })

      const response = await POST(fileRequest(SECOND_YEAR), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(body.preview.openingBalanceContinuity?.carriedForward).toBe(false)
      expect(body.preview.openingBalanceContinuity?.differences).toEqual([])
    })
  })

  // Queue order after the stored-mappings select: chart_of_accounts page,
  // companies (only when the file has #ORGNR), fiscal_periods containing.
  describe('the file\'s #ORGNR against the company', () => {
    const withOrgnr = (orgnr: string) => CLEAN_SIE.replace('#RAR', `#ORGNR ${orgnr}\n#RAR`)

    it.each([
      ['556677-8899', '5599887766', true],
      ['16556677-8899', '5566778899', false],
    ])('file %s into company %s: mismatch %s', async (fileOrg, companyOrg, mismatch) => {
      enqueue({ data: [] })
      enqueue({ data: { org_number: companyOrg } })
      enqueue({ data: { id: 'p-2024' } })

      const response = await POST(fileRequest(withOrgnr(fileOrg)), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(response.status).toBe(200)
      expect(body.preview.orgNumberMismatch).toBe(mismatch)
      expect(body.preview.companyOrgNumber).toBe(companyOrg)
    })

    it('reports no mismatch for a file without #ORGNR', async () => {
      enqueue({ data: [] })
      enqueue({ data: { id: 'p-2024' } })

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(body.preview.orgNumberMismatch).toBe(false)
      expect(body.preview.fiscalYear).toEqual({ verdict: 'match', periodId: 'p-2024' })
    })
  })
})
