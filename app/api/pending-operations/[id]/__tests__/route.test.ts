import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const requireCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: (...args: unknown[]) => requireCompanyIdMock(...args),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const mappingMock = vi.fn()
vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: (...args: unknown[]) => mappingMock(...args),
}))

import { PATCH } from '../route'

const mockUser = { id: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  requireWritePermissionMock.mockResolvedValue({ ok: true })
  requireCompanyIdMock.mockResolvedValue('company-1')
  mappingMock.mockReturnValue({
    debit_account: '5410',
    credit_account: '1930',
    vat_lines: [],
  })
})

describe('PATCH /api/pending-operations/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', {
        method: 'PATCH',
        body: { category: 'expense_software' },
      }),
      createMockRouteParams({ id: 'op-1' }),
    )
    expect(res.status).toBe(401)
  })

  it('blocks viewers', async () => {
    const { NextResponse } = await import('next/server')
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', {
        method: 'PATCH',
        body: { category: 'expense_software' },
      }),
      createMockRouteParams({ id: 'op-1' }),
    )
    expect(res.status).toBe(403)
  })

  it('rejects empty body', async () => {
    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', { method: 'PATCH', body: {} }),
      createMockRouteParams({ id: 'op-1' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when op not visible', async () => {
    enqueue({ data: null })
    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-x', {
        method: 'PATCH',
        body: { category: 'expense_software' },
      }),
      createMockRouteParams({ id: 'op-x' }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when op is no longer pending', async () => {
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        operation_type: 'categorize_transaction',
        status: 'committed',
        params: { transaction_id: 'tx-1', category: 'expense_other' },
        preview_data: {},
        title: '',
      },
    })
    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', {
        method: 'PATCH',
        body: { category: 'expense_software' },
      }),
      createMockRouteParams({ id: 'op-1' }),
    )
    expect(res.status).toBe(409)
  })

  it('returns 400 when operation_type is not editable', async () => {
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        operation_type: 'create_invoice',
        status: 'pending',
        params: {},
        preview_data: {},
        title: '',
      },
    })
    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', {
        method: 'PATCH',
        body: { category: 'expense_software' },
      }),
      createMockRouteParams({ id: 'op-1' }),
    )
    expect(res.status).toBe(400)
  })

  it('re-derives accounts and returns updated preview on category change', async () => {
    // Sequence:
    //   1. pending_operations lookup
    //   2. transactions lookup
    //   3. company_settings lookup
    //   4. pending_operations update → returns updated row
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        operation_type: 'categorize_transaction',
        status: 'pending',
        params: {
          transaction_id: 'tx-1',
          category: 'expense_other',
          vat_treatment: null,
        },
        preview_data: { debit_account: '6990', credit_account: '1930', amount: 500 },
        title: 'Kategorisera: X',
      },
    })
    enqueue({
      data: {
        id: 'tx-1',
        company_id: 'company-1',
        amount: -500,
        currency: 'SEK',
        date: '2026-05-10',
      },
    })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({
      data: {
        id: 'op-1',
        params: { transaction_id: 'tx-1', category: 'expense_software', vat_treatment: null },
        preview_data: {
          debit_account: '5410',
          credit_account: '1930',
          amount: 500,
          currency: 'SEK',
          vat_lines: [],
          category: 'expense_software',
        },
        title: 'Kategorisera: X',
        status: 'pending',
      },
    })

    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', {
        method: 'PATCH',
        body: { category: 'expense_software' },
      }),
      createMockRouteParams({ id: 'op-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { preview_data: { category: string; debit_account: string } }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.preview_data.category).toBe('expense_software')
    expect(body.data.preview_data.debit_account).toBe('5410')
    expect(mappingMock).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when mapping yields no accounts', async () => {
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        operation_type: 'categorize_transaction',
        status: 'pending',
        params: { transaction_id: 'tx-1', category: 'expense_other' },
        preview_data: {},
        title: '',
      },
    })
    enqueue({ data: { id: 'tx-1', amount: -100, currency: 'SEK' } })
    enqueue({ data: { entity_type: 'enskild_firma' } })
    mappingMock.mockReturnValueOnce({
      debit_account: null,
      credit_account: null,
      vat_lines: [],
    })

    const res = await PATCH(
      createMockRequest('/api/pending-operations/op-1', {
        method: 'PATCH',
        body: { category: 'private' },
      }),
      createMockRouteParams({ id: 'op-1' }),
    )
    expect(res.status).toBe(400)
  })
})
