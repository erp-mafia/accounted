/**
 * Tests for POST /api/import/bank-file/check-duplicates: the advisory
 * duplicate preview the bank-file wizard calls after every (re-)parse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { generateExternalId } from '@/lib/import/bank-file/parser'
import type { DuplicatePreviewResult } from '@/lib/transactions/dedup-preview'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const TX = {
  date: '2024-06-15',
  description: 'ICA Maxi Solna',
  amount: -250.0,
  currency: 'SEK',
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/bank-file/check-duplicates', {
    method: 'POST',
    body,
  })
}

describe('POST /api/import/bank-file/check-duplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest({ transactions: [TX], format: 'lunar' }))

    expect(res.status).toBe(401)
  })

  it('returns 400 when transactions or format is missing', async () => {
    const noFormat = await POST(makeRequest({ transactions: [TX] }))
    expect(noFormat.status).toBe(400)

    const noTransactions = await POST(makeRequest({ format: 'lunar' }))
    expect(noTransactions.status).toBe(400)

    const emptyTransactions = await POST(makeRequest({ transactions: [], format: 'lunar' }))
    expect(emptyTransactions.status).toBe(400)
  })

  it('returns 400 for an unknown format id', async () => {
    const res = await POST(makeRequest({ transactions: [TX], format: 'not_a_bank' }))

    expect(res.status).toBe(400)
  })

  it('returns 400 when the transactions array exceeds the 20000-row cap', async () => {
    const oversized = Array.from({ length: 20001 }, () => TX)

    const res = await POST(makeRequest({ transactions: oversized, format: 'lunar' }))

    expect(res.status).toBe(400)
  })

  it('flags rows whose server-computed external_id already exists (id parity with execute)', async () => {
    // The stored id is computed with the SAME derivation the execute route
    // uses: generateExternalId(tx, format, index). The route only collides on
    // it if its own server-side computation is byte-identical.
    const storedId = generateExternalId(TX, 'lunar', 0)

    enqueue({ data: [] }) // booked map
    enqueue({ data: [] }) // unbooked map
    enqueue({ data: [{ external_id: storedId }] }) // external_id chunk

    const res = await POST(makeRequest({
      transactions: [TX, { ...TX, description: 'Coop Stockholm', amount: -99.5 }],
      format: 'lunar',
    }))
    const { status, body } = await parseJsonResponse<{ data: DuplicatePreviewResult }>(res)

    expect(status).toBe(200)
    expect(body.data.duplicate_row_indexes).toEqual([0])
    expect(body.data.duplicate_count).toBe(1)
    expect(body.data.by_reason).toEqual({ external_id: 1, content_bridge: 0 })
  })

  it('flags content-bridge duplicates against stored rows (happy path)', async () => {
    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        date: TX.date, amount: TX.amount,
        original_description: TX.description, description: TX.description,
        import_source: 'enable_banking', currency: 'SEK',
      }],
    }) // unbooked map: PSD2 twin of row 0
    enqueue({ data: [] }) // external_id chunk: no Layer-1 hit

    const res = await POST(makeRequest({
      transactions: [TX, { ...TX, description: 'Coop Stockholm' }],
      format: 'lunar',
    }))
    const { status, body } = await parseJsonResponse<{ data: DuplicatePreviewResult }>(res)

    expect(status).toBe(200)
    expect(body.data.duplicate_row_indexes).toEqual([0])
    expect(body.data.by_reason).toEqual({ external_id: 0, content_bridge: 1 })
  })
})
