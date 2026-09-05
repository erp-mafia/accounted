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
  preview: Pick<ImportPreview, 'chart' | 'fiscalYear' | 'mappingStatus'>
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

  it('adds a mojibake warning to the preview issues without blocking the parse', async () => {
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
    const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
    const body = (await response.json()) as ParseResponse

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.parsed.issues.some((i) => i.message.includes('felaktigt teckenkodad'))).toBe(false)
    expect(body.validation.warnings.some((w) => w.includes('felaktigt teckenkodad'))).toBe(false)
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

    it('reports match when a fiscal period already contains the file year', async () => {
      enqueue({ data: [] })
      enqueue({ data: { id: 'p-2024' } })

      const response = await POST(fileRequest(CLEAN_SIE), emptyParams)
      const body = (await response.json()) as ParseResponse

      expect(body.preview.fiscalYear).toEqual({ verdict: 'match', periodId: 'p-2024' })
    })

    it('reports create when no period overlaps the file year', async () => {
      enqueue({ data: [] })
      enqueue({ data: null })
      enqueue({ data: [] })

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
})
