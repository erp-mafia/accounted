import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
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
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
const createJournalEntryMock = vi.fn()
const reverseEntryMock = vi.fn()
const findFiscalPeriodMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
  reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
  findFiscalPeriod: (...args: unknown[]) => findFiscalPeriodMock(...args),
  getSwedishLocalDate: () => '2026-09-15',
}))

import { GET, POST } from '../route'
import { POST as APPLY } from '../[id]/apply/route'
import { POST as ROLLBACK } from '../[id]/rollback/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'mig-1' }) }

const PREVIEW = {
  ok: true,
  current_entity_type: 'aktiebolag',
  target_entity_type: 'ekonomisk_forening',
  same_form: false,
  empty_books_path_available: false,
  caller_role: 'owner',
  blockers: { journal_entries: 12, invoices: 0, supplier_invoices: 0, custom_accounts: 0, configured_account_references: 0 },
  decision_accounts: [
    { account: '2081', balance: 25000 },
    { account: '2893', balance: -3200.5 },
  ],
}

const PLANNED_ROW = {
  id: 'mig-1',
  company_id: 'company-1',
  user_id: 'user-1',
  from_entity_type: 'aktiebolag',
  to_entity_type: 'ekonomisk_forening',
  preview: PREVIEW,
  remap_plan: [],
  status: 'planned',
  applied_at: null,
  applied_by: null,
  rolled_back_at: null,
  reclassification_journal_entry_id: null,
  rollback_journal_entry_id: null,
  notes: null,
  created_at: '2026-09-15T10:00:00Z',
  updated_at: '2026-09-15T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  createJournalEntryMock.mockResolvedValue({ id: 'je-reclass' })
  reverseEntryMock.mockResolvedValue({ id: 'je-storno' })
  findFiscalPeriodMock.mockResolvedValue('period-1')
})

describe('GET /api/company/entity-type-migration', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/company/entity-type-migration'), routeParams)
    expect(res.status).toBe(401)
  })

  it('lists the company migrations', async () => {
    enqueue({ data: [PLANNED_ROW] })
    const { status, body } = await parseJsonResponse<{ data: { id: string }[] }>(
      await GET(createMockRequest('/api/company/entity-type-migration'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.map((m) => m.id)).toEqual(['mig-1'])
    expect(findCall('company_entity_type_migrations', 'eq')).toEqual(['company_id', 'company-1'])
  })
})

describe('POST /api/company/entity-type-migration (plan)', () => {
  it('refuses viewers (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(
      createMockRequest('/api/company/entity-type-migration', { method: 'POST', body: { entity_type: 'ekonomisk_forening' } }),
      routeParams,
    )
    expect(res.status).toBe(403)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects an unsupported form without calling the database', async () => {
    const res = await POST(
      createMockRequest('/api/company/entity-type-migration', { method: 'POST', body: { entity_type: 'handelsbolag' } }),
      routeParams,
    )
    expect(res.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('snapshots the preview and stores the proposals, all skipped', async () => {
    enqueue({ data: PREVIEW }) // preview rpc
    enqueue({ data: PLANNED_ROW }) // insert
    const { status, body } = await parseJsonResponse<{
      data: { migration: { id: string }; proposals: { account_from: string; decision: string; account_to: string | null }[] }
    }>(
      await POST(
        createMockRequest('/api/company/entity-type-migration', { method: 'POST', body: { entity_type: 'ekonomisk_forening' } }),
        routeParams,
      ),
    )
    expect(status).toBe(201)
    expect(body.data.migration.id).toBe('mig-1')
    expect(body.data.proposals).toEqual([
      expect.objectContaining({ account_from: '2081', account_to: '2083', decision: 'skipped' }),
      expect.objectContaining({ account_from: '2893', account_to: '2890', decision: 'skipped' }),
    ])
    expect(supabase.rpc).toHaveBeenCalledWith('preview_company_entity_type_change', {
      p_company_id: 'company-1',
      p_entity_type: 'ekonomisk_forening',
    })
    const inserted = findCall('company_entity_type_migrations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted).toMatchObject({ company_id: 'company-1', user_id: 'user-1', status: 'planned', from_entity_type: 'aktiebolag' })
  })

  it('sends a company with empty books to the direct correction (409)', async () => {
    enqueue({ data: { ...PREVIEW, empty_books_path_available: true } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(
        createMockRequest('/api/company/entity-type-migration', { method: 'POST', body: { entity_type: 'ekonomisk_forening' } }),
        routeParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ENTITY_TYPE_MIGRATION_EMPTY_BOOKS')
  })

  it('refuses a non-owner with 403', async () => {
    enqueue({ data: { ...PREVIEW, caller_role: 'admin' } })
    const res = await POST(
      createMockRequest('/api/company/entity-type-migration', { method: 'POST', body: { entity_type: 'ekonomisk_forening' } }),
      routeParams,
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /api/company/entity-type-migration/{id}/apply', () => {
  const plan = [
    { account_from: '2081', account_to: '2083', amount: 25000, decision: 'confirmed' },
    { account_from: '2893', account_to: null, amount: -3200.5, decision: 'skipped' },
  ]

  it('refuses a plan that leaves a decision account undecided, before touching the RPC', async () => {
    enqueue({ data: PLANNED_ROW }) // getMigration
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: { accounts: string[] } } }>(
      await APPLY(
        createMockRequest('/api/company/entity-type-migration/mig-1/apply', {
          method: 'POST',
          body: { remap_plan: [plan[0]] },
        }),
        idParams,
      ),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('ENTITY_TYPE_MIGRATION_UNDECIDED_ACCOUNT')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses when no open period covers the reclassification date, before the form flips', async () => {
    enqueue({ data: PLANNED_ROW })
    findFiscalPeriodMock.mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await APPLY(
        createMockRequest('/api/company/entity-type-migration/mig-1/apply', { method: 'POST', body: { remap_plan: plan } }),
        idParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ENTITY_TYPE_MIGRATION_NO_OPEN_PERIOD')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('flips the form through the RPC, books one reclassification verifikat and links it', async () => {
    enqueue({ data: PLANNED_ROW }) // getMigration
    enqueue({ data: { ok: true, migration_id: 'mig-1', entity_type: 'ekonomisk_forening', added_accounts: 7 } }) // rpc
    enqueue({ data: null }) // link update
    enqueue({ data: { ...PLANNED_ROW, status: 'applied', reclassification_journal_entry_id: 'je-reclass' } }) // re-read
    const { status, body } = await parseJsonResponse<{
      data: { reclassification_journal_entry_id: string | null; added_accounts: number; migration: { status: string } }
    }>(
      await APPLY(
        createMockRequest('/api/company/entity-type-migration/mig-1/apply', {
          method: 'POST',
          body: { remap_plan: plan, entry_date: '2026-09-15' },
        }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ reclassification_journal_entry_id: 'je-reclass', added_accounts: 7 })
    expect(body.data.migration.status).toBe('applied')
    expect(supabase.rpc).toHaveBeenCalledWith('apply_company_entity_type_migration', {
      p_migration_id: 'mig-1',
      p_remap_plan: plan,
    })
    expect(createJournalEntryMock).toHaveBeenCalledTimes(1)
    const input = createJournalEntryMock.mock.calls[0][3] as {
      source_type: string
      source_id: string
      entry_date: string
      lines: { account_number: string; debit_amount: number; credit_amount: number }[]
    }
    expect(input).toMatchObject({ source_type: 'system', source_id: 'mig-1', entry_date: '2026-09-15', fiscal_period_id: 'period-1' })
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2081', debit_amount: 25000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2083', debit_amount: 0, credit_amount: 25000 }),
    ])
    expect(findCall('company_entity_type_migrations', 'update')).toEqual([{ reclassification_journal_entry_id: 'je-reclass' }])
  })

  it('maps a stale plan to 409 and books nothing', async () => {
    enqueue({ data: PLANNED_ROW })
    enqueue({ data: { ok: false, code: 'ENTITY_TYPE_MIGRATION_STALE', reason: 'decision_accounts' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await APPLY(
        createMockRequest('/api/company/entity-type-migration/mig-1/apply', { method: 'POST', body: { remap_plan: plan } }),
        idParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ENTITY_TYPE_MIGRATION_STALE')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('books nothing when every remap is skipped', async () => {
    enqueue({ data: PLANNED_ROW })
    enqueue({ data: { ok: true, added_accounts: 7 } })
    enqueue({ data: { ...PLANNED_ROW, status: 'applied' } })
    const { status, body } = await parseJsonResponse<{ data: { reclassification_journal_entry_id: string | null } }>(
      await APPLY(
        createMockRequest('/api/company/entity-type-migration/mig-1/apply', {
          method: 'POST',
          body: { remap_plan: plan.map((p) => ({ ...p, decision: 'skipped', account_to: null })) },
        }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.reclassification_journal_entry_id).toBeNull()
    expect(findFiscalPeriodMock).not.toHaveBeenCalled()
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/company/entity-type-migration/{id}/rollback', () => {
  it('reverses the verifikat, links the storno and flips the form back', async () => {
    enqueue({ data: { ...PLANNED_ROW, status: 'applied', reclassification_journal_entry_id: 'je-reclass' } }) // getMigration
    enqueue({ data: null }) // link update
    enqueue({ data: { ok: true, migration_id: 'mig-1', entity_type: 'aktiebolag' } }) // rpc
    enqueue({ data: { ...PLANNED_ROW, status: 'rolled_back', rollback_journal_entry_id: 'je-storno' } }) // re-read
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(
      await ROLLBACK(
        createMockRequest('/api/company/entity-type-migration/mig-1/rollback', { method: 'POST', body: {} }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('rolled_back')
    expect(reverseEntryMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'je-reclass', '2026-09-15')
    expect(findCall('company_entity_type_migrations', 'update')).toEqual([{ rollback_journal_entry_id: 'je-storno' }])
    expect(supabase.rpc).toHaveBeenCalledWith('rollback_company_entity_type_migration', { p_migration_id: 'mig-1' })
  })

  it('refuses a migration that is not applied', async () => {
    enqueue({ data: PLANNED_ROW })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await ROLLBACK(
        createMockRequest('/api/company/entity-type-migration/mig-1/rollback', { method: 'POST', body: {} }),
        idParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ENTITY_TYPE_MIGRATION_NOT_APPLIED')
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })
})
