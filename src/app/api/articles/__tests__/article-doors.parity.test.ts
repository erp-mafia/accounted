/**
 * One article, two doors, one row.
 *
 * The dashboard's POST /api/articles and PATCH /api/articles/:id and the
 * approval of an agent's staged create_article / update_article used to write
 * through their own copies: the approval stored '' where the dashboard stores
 * null, checked the posting account against active chart rows only and
 * answered a duplicate article number with a raw database error. They now
 * share lib/articles/article-commands.ts; the same input must write the same
 * row, and refuse the same way, through each.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const { doors } = vi.hoisted(() => ({ doors: { dashboard: null as unknown } }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(doors.dashboard),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn() } }))

import { POST as dashboardPOST } from '../route'
import { PATCH as dashboardPATCH } from '../[id]/route'
import { commitPendingOperation } from '@/lib/pending-operations/commit'

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ARTICLE_ID = '3a9ac4d2-163a-4d43-8fa3-1b32827505fa'

/** The fields the doors used to store differently: empty texts and a lower-case currency. */
const createInput = { name: 'Takarbete ', price_excl_vat: 850, unit: 'tim', currency: 'sek', notes: '', ean: '', housework_type: 'bygg' }
const updateInput = { price_excl_vat: 900, notes: '', housework_type: '' }

const saved = { id: ARTICLE_ID, article_number: 'A-0001', name: 'Takarbete' }

function dashboardClient(tables: Record<string, unknown>) {
  const mock = createTableMockSupabase(tables as never)
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
  doors.dashboard = mock.supabase
  return mock
}

function stagedOp(type: string, params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: USER_ID,
    company_id: COMPANY_ID,
    operation_type: type,
    status: 'pending',
    title: 'Artikel',
    params,
    preview_data: {},
    result_data: null,
    risk_level: 'low',
    created_at: '2026-10-12T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-12T00:00:00Z',
  } as unknown as PendingOperation
}

function approvalClient(tables: Record<string, unknown>) {
  return createTableMockSupabase({
    // CAS claim, then the finalize update
    pending_operations: { data: { id: 'op-1' } },
    ...tables,
  } as never)
}

function jsonRequest(method: string, path: string, body: unknown) {
  return new Request(`https://x.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

beforeEach(() => vi.clearAllMocks())

describe('article create and update: every door writes the same row', () => {
  it('create inserts one row from the dashboard and the agent approval', async () => {
    const dashboard = dashboardClient({ articles: { data: saved } })
    const res = await dashboardPOST(jsonRequest('POST', '/api/articles', createInput), { params: Promise.resolve({}) } as never)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const approval = approvalClient({ articles: { data: saved } })
    const committed = await commitPendingOperation(approval.supabase as never, USER_ID, COMPANY_ID, stagedOp('create_article', createInput))
    expect(committed.status).toBe('committed')

    const fromDashboard = dashboard.findCall('articles', 'insert')?.[0]
    expect(fromDashboard).toMatchObject({
      name: 'Takarbete',
      unit: 'tim',
      currency: 'SEK',
      notes: null,
      ean: null,
      housework_type: 'BYGG',
    })
    expect(approval.findCall('articles', 'insert')?.[0]).toEqual(fromDashboard)
  })

  it('update sets the same columns from the dashboard and the agent approval', async () => {
    const dashboard = dashboardClient({ articles: { data: saved } })
    const res = await dashboardPATCH(jsonRequest('PATCH', `/api/articles/${ARTICLE_ID}`, updateInput), {
      params: Promise.resolve({ id: ARTICLE_ID }),
    } as never)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const approval = approvalClient({ articles: { data: saved } })
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('update_article', { article_id: ARTICLE_ID, ...updateInput }),
    )
    expect(committed.status).toBe('committed')

    const fromDashboard = dashboard.findCall('articles', 'update')?.[0]
    expect(fromDashboard).toEqual({ price_excl_vat: 900, notes: null, housework_type: null })
    expect(approval.findCall('articles', 'update')?.[0]).toEqual(fromDashboard)
  })

  it('both refuse a duplicate article number with ARTICLE_DUPLICATE_NUMBER', async () => {
    const duplicate = { articles: { data: null, error: { code: '23505', message: 'duplicate key' } } }
    dashboardClient(duplicate)
    const res = await dashboardPOST(jsonRequest('POST', '/api/articles', { ...createInput, article_number: 'A-0001' }), {
      params: Promise.resolve({}),
    } as never)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ARTICLE_DUPLICATE_NUMBER')

    const approval = approvalClient(duplicate)
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('create_article', { ...createInput, article_number: 'A-0001' }),
    )
    expect(committed).toMatchObject({ status: 'rejected', code: 'ARTICLE_DUPLICATE_NUMBER' })
  })

  it('both refuse a posting account that is not activated with ACCOUNTS_NOT_IN_CHART', async () => {
    const inactive = { chart_of_accounts: { data: { account_class: 3, is_active: false } } }
    dashboardClient(inactive)
    const res = await dashboardPOST(jsonRequest('POST', '/api/articles', { ...createInput, revenue_account: '3011' }), {
      params: Promise.resolve({}),
    } as never)
    expect((await res.json()).error.code).toBe('ACCOUNTS_NOT_IN_CHART')

    const approval = approvalClient(inactive)
    const committed = await commitPendingOperation(
      approval.supabase as never,
      USER_ID,
      COMPANY_ID,
      stagedOp('create_article', { ...createInput, revenue_account: '3011' }),
    )
    // Recoverable: the op stays pending so the approver can activate and retry.
    expect(committed).toMatchObject({ code: 'ACCOUNTS_NOT_IN_CHART', account_numbers: ['3011'], operation_status: 'pending' })
    expect(approval.findCall('articles', 'insert')).toBeUndefined()
  })
})
