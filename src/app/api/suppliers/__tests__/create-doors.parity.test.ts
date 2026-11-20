/**
 * One supplier, three doors, one row.
 *
 * The dashboard's POST /api/suppliers, the v1 POST /suppliers and the approval
 * of an agent's staged create_supplier used to insert through three copies:
 * the approval dropped clearing_number and account_number, and each door kept
 * its own defaults. They now share createSupplier
 * (lib/suppliers/create-supplier.ts); the same input must insert the same row
 * through each.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const { doors } = vi.hoisted(() => ({ doors: { dashboard: null as unknown } }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(doors.dashboard),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  getActiveCompanyId: vi.fn().mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as dashboardPOST } from '../route'
import { POST as v1POST } from '@/app/api/v1/companies/[companyId]/suppliers/route'
import { commitPendingOperation } from '@/lib/pending-operations/commit'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'user-1'

/** A payee paid by Swedish bank account: the two fields the approval dropped. */
const input = {
  name: 'Elnät AB',
  supplier_type: 'swedish_business',
  org_number: '556677-8899',
  clearing_number: '8327',
  account_number: '9123456',
  bankgiro: '5050-1055',
  email: '',
}

const row = { id: 'sup-1', name: 'Elnät AB' }

function insertedRow(findCall: (table: string, method: string) => unknown[] | undefined) {
  const inserted = findCall('suppliers', 'insert')?.[0] as Record<string, unknown> | undefined
  expect(inserted).toBeDefined()
  return inserted!
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['suppliers:write'],
    mode: 'live',
  } as never)
})

describe('supplier create: every door inserts the same row', () => {
  it('inserts one row from the dashboard, v1 and the agent approval', async () => {
    const dashboard = createQueuedMockSupabase()
    dashboard.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
    dashboard.enqueue({ data: row })
    doors.dashboard = dashboard.supabase
    const res = await dashboardPOST(
      new Request('https://x.test/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }) as never,
      { params: Promise.resolve({}) } as never,
    )
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const v1 = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      suppliers: { data: row, error: null },
    })
    vi.mocked(createServiceClientNoCookies).mockReturnValue(v1.supabase as never)
    const v1Res = await v1POST(
      new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-fixture-not-a-real-key',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
        },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )

    const approval = createQueuedMockSupabase()
    approval.enqueue({ data: { id: 'op-1' } }) // CAS claim
    approval.enqueue({ data: row }) // insert
    approval.enqueue({ data: null }) // finalize
    const committed = await commitPendingOperation(approval.supabase as never, USER_ID, COMPANY_ID, {
      id: 'op-1',
      user_id: USER_ID,
      company_id: COMPANY_ID,
      operation_type: 'create_supplier',
      status: 'pending',
      title: 'Ny leverantör: Elnät AB',
      params: input,
      preview_data: {},
      result_data: null,
      risk_level: 'medium',
      created_at: '2026-10-12T00:00:00Z',
      resolved_at: null,
      updated_at: '2026-10-12T00:00:00Z',
    } as unknown as PendingOperation)
    expect(committed.status).toBe('committed')

    const fromDashboard = insertedRow(dashboard.findCall)
    expect(fromDashboard).toMatchObject({
      clearing_number: '8327',
      account_number: '9123456',
      org_number: '5566778899',
      email: null,
      default_payment_terms: 30,
    })
    if (v1Res.status === 201) expect(insertedRow(v1.findCall)).toEqual(fromDashboard)
    else throw new Error(`v1 POST answered ${v1Res.status}: ${JSON.stringify(await v1Res.json())}`)
    expect(insertedRow(approval.findCall)).toEqual(fromDashboard)
  })
})
