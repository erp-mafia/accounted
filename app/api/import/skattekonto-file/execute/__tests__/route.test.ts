import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        transaktionsdatum: '2026-06-06',
        transaktionstext: 'Kostnadsränta',
        belopp: -10,
      },
      {
        transaktionsdatum: '2026-07-11',
        transaktionstext: 'Inbetalning bokförd 260710',
        belopp: 24000,
      },
    ],
    filename: 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv',
    file_hash: 'a'.repeat(64),
    variant: 'csv',
    closing_saldo: 23490,
    ...overrides,
  }
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/skattekonto-file/execute', {
    method: 'POST',
    body,
  })
}

describe('POST /api/import/skattekonto-file/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeRequest(makeBody()), emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 on invalid payload', async () => {
    const response = await POST(makeRequest({ filename: 'x.csv' }), emptyParams)
    expect(response.status).toBe(400)
  })

  it('imports new rows with file provenance', async () => {
    enqueue({ data: { id: 'imp-1' } }) // skattekonto_file_imports upsert
    enqueue({ data: [] }) // existing rows page
    enqueue({ data: null }) // insert batch
    enqueue({ data: null }) // final record update
    const { status, body } = await parseJsonResponse<{
      data: { import_id: string; imported: number; duplicates: number; promoted: number }
    }>(await POST(makeRequest(makeBody()), emptyParams))

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ import_id: 'imp-1', imported: 2, duplicates: 0, promoted: 0 })

    const inserts = findCalls('skattekonto_transactions', 'insert')
    expect(inserts).toHaveLength(1)
    const payload = inserts[0][0] as Array<Record<string, unknown>>
    expect(payload).toHaveLength(2)
    expect(payload[0]).toMatchObject({
      company_id: 'company-1',
      status: 'booked',
      source: 'file_import',
      file_import_id: 'imp-1',
      transaktionsidentitet: null,
      belopp_skatteverket: -10,
    })
    expect(payload[0].dedup_key).toMatch(/^h:[0-9a-f]{64}$/)
  })

  it('re-partitions server-side: rows already booked are skipped, not inserted', async () => {
    enqueue({ data: { id: 'imp-1' } }) // upsert record
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
    }) // existing rows
    enqueue({ data: null }) // insert batch (the remaining row)
    enqueue({ data: null }) // final record update
    const { status, body } = await parseJsonResponse<{
      data: { imported: number; duplicates: number }
    }>(await POST(makeRequest(makeBody()), emptyParams))

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ imported: 1, duplicates: 1 })
    const inserts = findCalls('skattekonto_transactions', 'insert')
    expect((inserts[0][0] as unknown[]).length).toBe(1)
  })

  it('promotes an upcoming row via UPDATE instead of inserting', async () => {
    enqueue({ data: { id: 'imp-1' } }) // upsert record
    enqueue({
      data: [
        {
          id: 'upcoming-1',
          dedup_key: 'h:deadbeef',
          status: 'upcoming',
          transaktionsdatum: '2026-06-06',
          transaktionstext: 'Kostnadsränta',
          belopp_skatteverket: -10,
        },
      ],
    }) // existing rows
    enqueue({ data: null }) // insert batch (remaining row)
    enqueue({ data: [{ id: 'upcoming-1' }] }) // promotion update returns the row
    enqueue({ data: null }) // final record update
    const { status, body } = await parseJsonResponse<{
      data: { imported: number; promoted: number }
    }>(await POST(makeRequest(makeBody()), emptyParams))

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ imported: 1, promoted: 1 })
    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toEqual({ status: 'booked' })
  })

  it('counts residual unique violations as duplicates via per-row fallback', async () => {
    enqueue({ data: { id: 'imp-1' } }) // upsert record
    enqueue({ data: [] }) // existing rows
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } }) // batch insert fails
    enqueue({ data: null }) // row 1 insert ok
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } }) // row 2 conflict
    enqueue({ data: null }) // final record update
    const { status, body } = await parseJsonResponse<{
      data: { imported: number; duplicates: number; errors: number }
    }>(await POST(makeRequest(makeBody()), emptyParams))

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ imported: 1, duplicates: 1, errors: 0 })
  })

  it('fails with 500 when the import record cannot be created', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(makeRequest(makeBody()), emptyParams),
    )
    expect(status).toBe(500)
    expect(body.error.code).toBe('SKATTEKONTO_FILE_IMPORT_RECORD_FAILED')
  })
})
