import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

const routeParams = { params: Promise.resolve({}) }

function makeReq(body: unknown) {
  return new Request('http://localhost/api/transactions/create-from-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Partial<{
  inbox_item_id: string
  amount: number
  transaction_date: string
  description: string
}> = {}) {
  return {
    inbox_item_id: VALID_UUID,
    amount: -100,
    transaction_date: '2026-05-12',
    description: 'Test supplier · INV-001',
    ...overrides,
  }
}

describe('POST /api/transactions/create-from-document', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
  })

  it('returns 400 when the body is invalid', async () => {
    const res = await POST(makeReq({ inbox_item_id: 'not-a-uuid', amount: 0 }), routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 400 when amount is zero (schema refine)', async () => {
    const res = await POST(makeReq(validBody({ amount: 0 })), routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when the inbox item is not in the user company', async () => {
    enqueue({ data: null, error: null }) // inbox item lookup misses
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(body.error).toBe('Inbox item not found')
  })

  it('returns 409 when the inbox item is already matched to a transaction', async () => {
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: 'doc-1',
        matched_transaction_id: 'tx-existing',
        created_supplier_invoice_id: null,
        extracted_data: null,
      },
      error: null,
    })
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toMatch(/redan kopplad/)
  })

  it('returns 409 when the inbox item is already booked as a supplier invoice', async () => {
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: 'doc-1',
        matched_transaction_id: null,
        created_supplier_invoice_id: 'si-existing',
        extracted_data: null,
      },
      error: null,
    })
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toMatch(/redan bokförd/)
  })

  it('creates the transaction and links the inbox item on the happy path', async () => {
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: 'doc-1',
        matched_transaction_id: null,
        created_supplier_invoice_id: null,
        extracted_data: { invoice: { currency: 'EUR' } },
      },
      error: null,
    })
    enqueue({ data: { id: 'new-tx-1' }, error: null }) // insert
    enqueue({ data: [{ id: VALID_UUID }], error: null }) // inbox update: one row affected

    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{
      data: { transaction_id: string; inbox_item_id: string; document_id: string }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.transaction_id).toBe('new-tx-1')
    expect(body.data.document_id).toBe('doc-1')
  })

  it('returns 409 and rolls back the orphan when a concurrent request linked first', async () => {
    // Race scenario: both requests pass the matched_transaction_id IS NULL
    // read; both insert their own transaction. The losing UPDATE matches
    // zero rows because the .is('matched_transaction_id', null) predicate
    // no longer holds. We delete the orphan and 409.
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: 'doc-1',
        matched_transaction_id: null,
        created_supplier_invoice_id: null,
        extracted_data: null,
      },
      error: null,
    })
    enqueue({ data: { id: 'orphan-tx' }, error: null }) // insert succeeds
    enqueue({ data: [], error: null }) // inbox update affects zero rows: lost the race
    enqueue({ data: null, error: null }) // rollback delete of the orphan

    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toMatch(/parallell begäran/)
  })

  it('coerces an unrecognised extracted currency to SEK before insert', async () => {
    // Defense-in-depth: the deterministic extractor can still emit garbage
    // for malformed PDFs. We must not let arbitrary strings reach the
    // transactions.currency column.
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: null,
        matched_transaction_id: null,
        created_supplier_invoice_id: null,
        extracted_data: { invoice: { currency: 'XYZ' } },
      },
      error: null,
    })
    enqueue({ data: { id: 'new-tx-3' }, error: null })
    enqueue({ data: [{ id: VALID_UUID }], error: null })

    const res = await POST(makeReq(validBody()), routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
  })

  it('returns 500 when the transaction insert fails', async () => {
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: null,
        matched_transaction_id: null,
        created_supplier_invoice_id: null,
        extracted_data: null,
      },
      error: null,
    })
    enqueue({ data: null, error: { message: 'db down' } }) // insert fails
    // Silence the console.error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(500)
    expect(body.error).toMatch(/Kunde inte skapa transaktion/)
    spy.mockRestore()
  })

  it('tolerates a failed inbox-link update: transaction exists, surface inbox_link_failed', async () => {
    enqueue({
      data: {
        id: VALID_UUID,
        document_id: 'doc-1',
        matched_transaction_id: null,
        created_supplier_invoice_id: null,
        extracted_data: null,
      },
      error: null,
    })
    enqueue({ data: { id: 'new-tx-2' }, error: null }) // insert ok
    enqueue({ data: null, error: { message: 'rls' } }) // link update fails
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(makeReq(validBody()), routeParams)
    const { status, body } = await parseJsonResponse<{
      data: { transaction_id: string; inbox_link_failed?: boolean }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.transaction_id).toBe('new-tx-2')
    expect(body.data.inbox_link_failed).toBe(true)
    spy.mockRestore()
  })
})
