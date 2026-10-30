/**
 * GET/PATCH /api/company/accounting-policies: the K3 18.7 model for
 * internally generated intangible assets. The wrapper is real; the
 * companies read and write go through a table mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => requireAuthMock(...a) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  isCompanyAdmin: (...a: unknown[]) => isAdminMock(...a),
}))

import { GET, PATCH } from '../route'

const NO_PARAMS = { params: Promise.resolve({}) } as never

function client(company: Record<string, unknown> | null, assets: unknown[] = []) {
  return createTableMockSupabase({ companies: { data: company }, assets: { data: assets } })
}

function patch(body: unknown) {
  return PATCH(createMockRequest('/api/company/accounting-policies', { method: 'PATCH', body }), NO_PARAMS)
}

beforeEach(() => {
  vi.clearAllMocks()
  isAdminMock.mockResolvedValue(true)
})

describe('accounting policies route', () => {
  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await patch({ development_expenditure_model: 'capitalise' })).status).toBe(401)
  })

  it('400 for an unknown model, 403 for a member who is not an admin', async () => {
    const { supabase } = client({ accounting_framework: 'k3', development_expenditure_model: null })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    expect((await patch({ development_expenditure_model: 'both' })).status).toBe(400)
    isAdminMock.mockResolvedValue(false)
    expect((await patch({ development_expenditure_model: 'capitalise' })).status).toBe(403)
  })

  it('saves the aktiveringsmodell for a K3 company and reads it back', async () => {
    const { supabase, findCall } = client({ accounting_framework: 'k3', development_expenditure_model: null })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    const { status, body } = await parseJsonResponse<{ data: { development_expenditure_model: string } }>(
      await patch({ development_expenditure_model: 'capitalise' }),
    )
    expect(status).toBe(200)
    expect(body.data.development_expenditure_model).toBe('capitalise')
    // Through the audited RPC (behandlingshistorik), never a plain update:
    // the trigger behind it writes who changed the model and from what.
    expect(findCall('companies', 'update')).toBeUndefined()
    expect(findCall('rpc:set_development_expenditure_model', 'rpc')).toEqual([
      { p_company_id: 'company-1', p_model: 'capitalise', p_user_id: 'user-1', p_actor_type: 'user', p_actor_label: null },
    ])

    const read = await parseJsonResponse<{ data: { development_expenditure_model: string | null } }>(
      await GET(createMockRequest('/api/company/accounting-policies'), NO_PARAMS),
    )
    expect(read.status).toBe(200)
  })

  it('writes nothing when the model already stands', async () => {
    const { supabase, findCall } = client({ accounting_framework: 'k3', development_expenditure_model: 'capitalise' })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    expect((await patch({ development_expenditure_model: 'capitalise' })).status).toBe(200)
    expect(findCall('rpc:set_development_expenditure_model', 'rpc')).toBeUndefined()
  })

  it('500 when the database refuses the write', async () => {
    const { supabase, setTable } = client({ accounting_framework: 'k3', development_expenditure_model: null })
    setTable('rpc:set_development_expenditure_model', { error: { message: 'unauthorized accounting policy change' } })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    expect((await patch({ development_expenditure_model: 'capitalise' })).status).toBe(500)
  })

  it('422 for a K2 company, and when capitalised own development would be left behind', async () => {
    const k2 = client({ accounting_framework: 'k2', development_expenditure_model: null })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: k2.supabase })
    expect((await patch({ development_expenditure_model: 'capitalise' })).status).toBe(422)

    const withAssets = client(
      { accounting_framework: 'k3', development_expenditure_model: 'capitalise' },
      [{ bas_asset_account: '1010' }],
    )
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: withAssets.supabase })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await patch({ development_expenditure_model: 'expense' }),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('DEVELOPMENT_MODEL_REFUSED')
  })
})
