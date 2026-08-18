import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
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

const MODERN_CSV = [
  '"Testbolaget AB";"556677-8899";""',
  '"";"Ingående saldo 2026-05-03";"-500"',
  '"2026-06-06";"Kostnadsränta";"-10"',
  '"2026-07-11";"Inbetalning bokförd 260710";"24 000"',
  '"";"Utgående saldo 2026-08-01";"23 490"',
].join('\r\n')

const BANK_CSV = [
  'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
].join('\n')

function makeFileRequest(content: string | null, filename = 'Kontoutdrag.csv') {
  const formData = new FormData()
  if (content !== null) {
    formData.append('file', new File([content], filename, { type: 'text/csv' }))
  }
  return new Request('http://localhost:3000/api/import/skattekonto-file/parse', {
    method: 'POST',
    body: formData,
  })
}

async function jsonOf(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe('POST /api/import/skattekonto-file/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeFileRequest(MODERN_CSV), emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 when no file is attached', async () => {
    const { status, body } = await jsonOf(await POST(makeFileRequest(null), emptyParams))
    expect(status).toBe(400)
    expect(body.error.code).toBe('SKATTEKONTO_FILE_NO_FILE')
  })

  it('rejects an already-imported file with 409', async () => {
    enqueue({
      data: { id: 'imp-1', status: 'completed', imported_count: 9, created_at: '2026-08-01' },
    })
    const { status, body } = await jsonOf(await POST(makeFileRequest(MODERN_CSV), emptyParams))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SKATTEKONTO_FILE_DUPLICATE')
  })

  it('refuses files that are not skattekonto statements', async () => {
    enqueue({ data: null }) // no prior import
    const { status, body } = await jsonOf(
      await POST(makeFileRequest(BANK_CSV, 'kontoutdrag-bank.csv'), emptyParams),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('SKATTEKONTO_FILE_NOT_RECOGNIZED')
  })

  it('returns a statement that does not sum with the gap for the preview gate', async () => {
    enqueue({ data: null }) // no prior import
    enqueue({ data: { org_number: '556677-8899' } }) // company_settings
    enqueue({ data: [] }) // existing rows page
    const broken = MODERN_CSV.replace('"23 490"', '"99 999"')
    const { status, body } = await jsonOf(
      await POST(makeFileRequest(broken, 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv'), emptyParams),
    )
    expect(status).toBe(200)
    expect(body.data.parse_result.sum_valid).toBe(false)
    expect(body.data.parse_result.opening_saldo).toBe(-500)
    expect(body.data.parse_result.events_sum).toBe(23490)
    expect(body.data.parse_result.closing_saldo).toBe(99999)
    expect(body.data.parse_result.sum_difference).toBe(76509)
    // The rows are still returned: nothing is booked at import, so the user
    // can import the events that ARE in the file and confirm the gap.
    expect(body.data.parse_result.rows).toHaveLength(2)
  })

  it('still refuses a statement with no readable events', async () => {
    enqueue({ data: null }) // no prior import
    const empty = [
      '"Testbolaget AB";"556677-8899";""',
      '"";"Ingående saldo 2026-05-03";"-500"',
      '"";"Utgående saldo 2026-08-01";"-500"',
    ].join('\r\n')
    const { status, body } = await jsonOf(await POST(makeFileRequest(empty), emptyParams))
    expect(status).toBe(400)
    expect(body.error.code).toBe('SKATTEKONTO_FILE_NO_ROWS')
  })

  it('parses a valid statement and partitions against existing rows', async () => {
    enqueue({ data: null }) // no prior import
    enqueue({ data: { org_number: '556677-8899' } }) // company_settings
    enqueue({
      data: [
        {
          id: 'existing-1',
          dedup_key: 'id:42',
          status: 'booked',
          transaktionsdatum: '2026-06-06',
          transaktionstext: 'Kostnadsränta',
          belopp_skatteverket: -10,
        },
      ],
    }) // existing rows page
    const { status, body } = await jsonOf(await POST(makeFileRequest(MODERN_CSV), emptyParams))
    expect(status).toBe(200)
    expect(body.data.parse_result.rows).toHaveLength(2)
    expect(body.data.parse_result.closing_saldo).toBe(23490)
    expect(body.data.org_number_mismatch).toBe(false)
    // The Kostnadsränta row matches the existing booked id-keyed row by content.
    expect(body.data.duplicate_row_indexes).toEqual([0])
    expect(body.data.promotion_row_indexes).toEqual([])
    expect(body.data.file_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('flags an org number mismatch', async () => {
    enqueue({ data: null }) // no prior import
    enqueue({ data: { org_number: '5591112223' } }) // different company
    enqueue({ data: [] }) // existing rows page
    const { status, body } = await jsonOf(await POST(makeFileRequest(MODERN_CSV), emptyParams))
    expect(status).toBe(200)
    expect(body.data.org_number_mismatch).toBe(true)
  })
})
