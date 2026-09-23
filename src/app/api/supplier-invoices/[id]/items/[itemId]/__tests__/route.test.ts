import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({ backfillStandardBASAccounts: vi.fn().mockResolvedValue(undefined) }))

import { PATCH, planAccountMove } from '../route'

const params = { params: Promise.resolve({ id: 'inv-1', itemId: 'item-1' }) }
const req = (body: unknown) => createMockRequest('http://localhost/api/supplier-invoices/inv-1/items/item-1', { method: 'PATCH', body })

describe('planAccountMove', () => {
  it('replaces an exact line one for one', () => {
    const plan = planAccountMove(
      [{ id: 'l1', account_number: '6580', debit_amount: 43640, credit_amount: 0, line_description: 'Juridiskt biträde' }, { id: 'l2', account_number: '2641', debit_amount: 10910, credit_amount: 0, line_description: null }],
      '6580', '6550', 43640, 'Juridiskt biträde',
    )
    expect(plan).toEqual({ strike: ['l1'], add: [{ account_number: '6550', debit_amount: 43640, credit_amount: 0, line_description: 'Juridiskt biträde' }] })
  })

  it('splits an aggregate line so the old account keeps the rest', () => {
    const plan = planAccountMove(
      [{ id: 'l1', account_number: '6580', debit_amount: 30548, credit_amount: 0, line_description: 'RosholmDell' }],
      '6580', '6550', 43640, 'Juridiskt biträde',
    )
    expect(plan).toEqual({
      strike: ['l1'],
      add: [
        { account_number: '6580', debit_amount: 0, credit_amount: 13092, line_description: 'RosholmDell' },
        { account_number: '6550', debit_amount: 43640, credit_amount: 0, line_description: 'Juridiskt biträde' },
      ],
    })
  })

  it('moves a negative line (a discount) on the credit side', () => {
    const plan = planAccountMove(
      [{ id: 'l1', account_number: '6580', debit_amount: 0, credit_amount: 13092, line_description: 'Rabatt' }],
      '6580', '6550', -13092, 'Rabatt',
    )
    expect(plan).toEqual({ strike: ['l1'], add: [{ account_number: '6550', debit_amount: 0, credit_amount: 13092, line_description: 'Rabatt' }] })
  })

  it('gives up when the entry holds nothing on the old account', () => {
    expect(planAccountMove([{ id: 'l1', account_number: '5420', debit_amount: 100, credit_amount: 0, line_description: null }], '6580', '6550', 100, 'x')).toBeNull()
  })
})

describe('PATCH /api/supplier-invoices/[id]/items/[itemId]', () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  })

  it('validates the account number', async () => {
    const res = await PATCH(req({ account_number: '65' }), params)
    expect(res.status).toBe(400)
  })

  it('is 404 for an invoice outside the company', async () => {
    enqueue({ data: null })
    const res = await PATCH(req({ account_number: '6550' }), params)
    expect(res.status).toBe(404)
  })

  it('refuses a settled invoice', async () => {
    enqueue({ data: { id: 'inv-1', status: 'paid', registration_journal_entry_id: 'je-1' } })
    const res = await PATCH(req({ account_number: '6550' }), params)
    expect(res.status).toBe(409)
  })

  it('updates the item and corrects the registration verifikat inline', async () => {
    enqueue({ data: { id: 'inv-1', status: 'registered', registration_journal_entry_id: 'je-1' } })
    enqueue({ data: { id: 'item-1', account_number: '6580', line_total: 43640, description: 'Juridiskt biträde' } })
    enqueue({ data: [{ id: 'item-1' }] }) // item update
    enqueue({ data: [{ id: 'l1', account_number: '6580', debit_amount: 43640, credit_amount: 0, line_description: null }] })
    enqueue({ data: { ok: true } }) // rpc
    const { status, body } = await parseJsonResponse<{ data: { changed: boolean; corrected: boolean } }>(await PATCH(req({ account_number: '6550' }), params))
    expect(status).toBe(200)
    expect(body.data).toEqual({ changed: true, corrected: true })
    expect(findCall('supplier_invoice_items', 'update')?.[0]).toEqual({ account_number: '6550' })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('correct_entry_lines_inline', expect.objectContaining({
      p_entry_id: 'je-1',
      p_strike_line_ids: ['l1'],
      p_new_lines: [{ account_number: '6550', debit_amount: 43640, credit_amount: 0, line_description: 'Juridiskt biträde', dimensions: {} }],
      p_user_id: 'user-1',
    }))
  })

  it('reverts the item when the correction is refused', async () => {
    enqueue({ data: { id: 'inv-1', status: 'registered', registration_journal_entry_id: 'je-1' } })
    enqueue({ data: { id: 'item-1', account_number: '6580', line_total: 100, description: 'x' } })
    enqueue({ data: [{ id: 'item-1' }] })
    enqueue({ data: [{ id: 'l1', account_number: '6580', debit_amount: 100, credit_amount: 0, line_description: null }] })
    enqueue({ data: null, error: { code: 'P0001', message: 'Perioden är låst' } })
    enqueue({ data: null }) // revert update
    const res = await PATCH(req({ account_number: '6550' }), params)
    expect(res.status).toBe(409)
    const updates = mockSupabase.from.mock.calls.filter((c: unknown[]) => c[0] === 'supplier_invoice_items').length
    expect(updates).toBeGreaterThanOrEqual(3)
  })

  it('is a no-op when the account is unchanged', async () => {
    enqueue({ data: { id: 'inv-1', status: 'registered', registration_journal_entry_id: 'je-1' } })
    enqueue({ data: { id: 'item-1', account_number: '6550', line_total: 100, description: 'x' } })
    const { body } = await parseJsonResponse<{ data: { changed: boolean } }>(await PATCH(req({ account_number: '6550' }), params))
    expect(body.data.changed).toBe(false)
  })
})
