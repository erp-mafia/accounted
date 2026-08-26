/**
 * Tests for POST /api/import/bank-file/parse, focused on the skattekonto
 * redirect: a skattekontoutdrag uploaded into the bank flow must be refused
 * with a pointer to the dedicated importer (its rows belong on 1630, not on
 * a bank account), while an explicit format override still forces a bank
 * parse as the escape hatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const SKATTEKONTO_CSV = [
  '"Testbolaget AB";"556677-8899";""',
  '"";"Ingående saldo 2026-05-03";"-500"',
  '"2026-06-06";"Kostnadsränta";"-10"',
  '"";"Utgående saldo 2026-06-06";"-510"',
].join('\r\n')

const SEB_BANK_CSV = [
  'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
].join('\n')

function makeFileRequest(content: string, filename: string, format?: string) {
  const formData = new FormData()
  formData.append('file', new File([content], filename, { type: 'text/csv' }))
  if (format) formData.append('format', format)
  return new Request('http://localhost:3000/api/import/bank-file/parse', {
    method: 'POST',
    body: formData,
  })
}

describe('POST /api/import/bank-file/parse (skattekonto redirect)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('refuses a skattekontoutdrag with a redirect error code', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(
      makeFileRequest(SKATTEKONTO_CSV, 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv'),
      emptyParams,
    )
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_SKATTEKONTO_DETECTED')
  })

  it('honors an explicit format override as the escape hatch', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(
      makeFileRequest(SKATTEKONTO_CSV, 'skattekonto.skv', 'generic_csv'),
      emptyParams,
    )
    // Not the redirect: the override forces a bank parse attempt.
    const body = await response.json()
    expect(body?.error?.code).not.toBe('BANK_FILE_SKATTEKONTO_DETECTED')
  })

  it('parses a real bank file normally', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag.csv'), emptyParams)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.detected_format).toBe('seb')
    expect(body.data.parse_result.transactions).toHaveLength(1)
  })
})
