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

  // The route passes the channel execute will stamp ('csv_<format>'), so the
  // preview sees what execute sees: a bank-feed twin worded differently is
  // the same payment when the bucket counts match.
  it('flags a cross-channel mirror twin, as execute will skip it', async () => {
    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        id: 'tx-feed', date: TX.date, amount: TX.amount,
        original_description: 'Bg 5050-1055 OCR 12345', description: 'Bg 5050-1055 OCR 12345',
        import_source: 'enable_banking', bank_connection_id: 'conn-1', currency: 'SEK',
        external_id: 'eb_scope_2024-06-15_-25000_0',
      }],
    }) // unbooked map: the feed's copy, no shared text
    enqueue({ data: [] }) // external_id chunk

    const res = await POST(makeRequest({ transactions: [TX], format: 'lunar' }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: DuplicatePreviewResult }>(res)

    expect(status).toBe(200)
    expect(body.data.duplicate_row_indexes).toEqual([0])
    expect(body.data.by_reason).toEqual({ external_id: 0, content_bridge: 1 })
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

  it('returns 400 for a settlement account outside class 19', async () => {
    const res = await POST(makeRequest({ transactions: [TX], format: 'lunar', settlement_account: '2440' }), { params: Promise.resolve({}) })

    expect(res.status).toBe(400)
  })

  // crm#1204: the wizard sends the ledger of the file's own account. The
  // preview then guards accounts as execute does: a feed row of ANOTHER bank
  // account is not this file's duplicate, a feed row of the same one is.
  describe('with the settlement account the file belongs to', () => {
    const feedRow = {
      id: 'tx-feed', date: TX.date, amount: TX.amount,
      original_description: TX.description, description: TX.description,
      import_source: 'enable_banking', bank_connection_id: 'conn-1', currency: 'SEK',
      external_id: 'eb_1', cash_account_id: 'ca-1931',
    }
    const cashAccounts = [
      { id: 'ca-1930', ledger_account: '1930', iban: 'SE5580000832799876543210', currency: 'SEK', enabled: true, bank_connection_id: 'conn-1' },
      { id: 'ca-1931', ledger_account: '1931', iban: 'SE1280000832791234567890', currency: 'SEK', enabled: true, bank_connection_id: 'conn-1' },
    ]

    it('flags the feed row of the same bank account', async () => {
      enqueue({ data: [] }) // booked map
      enqueue({ data: [feedRow] }) // unbooked map
      enqueue({ data: [] }) // external_id chunk
      enqueue({ data: cashAccounts }) // batch cash account

      const res = await POST(makeRequest({ transactions: [TX], format: 'swedbank', settlement_account: '1931' }), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ data: DuplicatePreviewResult }>(res)

      expect(status).toBe(200)
      expect(body.data.duplicate_row_indexes).toEqual([0])
    })

    it('does not flag the feed row of another bank account', async () => {
      enqueue({ data: [] })
      enqueue({ data: [feedRow] })
      enqueue({ data: [] })
      enqueue({ data: cashAccounts })

      const res = await POST(makeRequest({ transactions: [TX], format: 'swedbank', settlement_account: '1930' }), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ data: DuplicatePreviewResult }>(res)

      expect(status).toBe(200)
      expect(body.data.duplicate_count).toBe(0)
    })
  })
})
