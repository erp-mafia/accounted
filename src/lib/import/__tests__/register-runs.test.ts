import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const rpcMock = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  rpcClientForBulkDelete: vi.fn(async () => ({ rpc: (...a: unknown[]) => rpcMock(...a) })),
}))

const fetchAllRowsMock = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => fetchAllRowsMock(...a),
}))

import {
  diffUpdatedRows,
  recordRegisterImportRun,
  snapshotRowsForUndo,
  undoRegisterImport,
} from '../register-runs'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

function testLog(): Logger & { error: ReturnType<typeof vi.fn> } {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  }
  return log as unknown as Logger & { error: ReturnType<typeof vi.fn> }
}

describe('recordRegisterImportRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('records the created ids for the company and the importing user', async () => {
    enqueue({ data: { id: 'run-1' } })

    const id = await recordRegisterImportRun(
      supabase as never,
      {
        companyId: 'company-1',
        userId: 'user-1',
        kind: 'customers',
        created: [{ id: 'c1' }, { id: 'c2' }],
        updated: [],
        before: new Map(),
      },
      testLog(),
    )

    expect(id).toBe('run-1')
    expect(findCall('register_import_runs', 'insert')).toEqual([
      { company_id: 'company-1', user_id: 'user-1', kind: 'customers', created_ids: ['c1', 'c2'], updated_rows: [] },
    ])
  })

  it('records a run that only updated existing rows', async () => {
    enqueue({ data: { id: 'run-2' } })

    const id = await recordRegisterImportRun(
      supabase as never,
      {
        companyId: 'company-1',
        userId: 'user-1',
        kind: 'suppliers',
        created: [],
        updated: [{ id: 's1', name: 'Nytt namn', email: 'a@b.se' } as { id: string }],
        before: new Map([['s1', { id: 's1', name: 'Gammalt namn', email: 'a@b.se' }]]),
      },
      testLog(),
    )

    expect(id).toBe('run-2')
    expect(findCall('register_import_runs', 'insert')?.[0]).toMatchObject({
      created_ids: [],
      updated_rows: [{ id: 's1', before: { name: 'Gammalt namn' }, after: { name: 'Nytt namn' } }],
    })
  })

  it('records nothing when the import neither created nor changed anything', async () => {
    const id = await recordRegisterImportRun(
      supabase as never,
      {
        companyId: 'company-1',
        userId: 'user-1',
        kind: 'articles',
        created: [],
        updated: [{ id: 'a1', name: 'Samma' } as { id: string }],
        before: new Map([['a1', { id: 'a1', name: 'Samma' }]]),
      },
      testLog(),
    )

    expect(id).toBeNull()
    expect(findCalls('register_import_runs', 'insert')).toHaveLength(0)
  })

  it('logs and returns null instead of failing the import when the insert fails', async () => {
    enqueue({ error: { message: 'permission denied', code: '42501' } })
    const log = testLog()

    const id = await recordRegisterImportRun(
      supabase as never,
      { companyId: 'company-1', userId: 'user-1', kind: 'suppliers', created: [{ id: 's1' }], updated: [], before: new Map() },
      log,
    )

    expect(id).toBeNull()
    expect(log.error).toHaveBeenCalledTimes(1)
  })
})

describe('diffUpdatedRows', () => {
  const before = new Map<string, Record<string, unknown>>([
    ['c1', {
      id: 'c1', company_id: 'co', name: 'Gamla AB', email: null, phone: '08-1',
      invoice_email_cc_addresses: ['a@b.se'], updated_at: '2026-10-01T00:00:00Z', party_id: 'p1',
    }],
    ['c2', { id: 'c2', name: 'Oförändrad', email: 'x@y.se' }],
  ])

  it('keeps only the fields the import changed, never identity, timestamps or the party link', () => {
    const rows = diffUpdatedRows(before, new Set(), [
      {
        id: 'c1', company_id: 'co', name: 'Nya AB', email: 'ny@ab.se', phone: '08-1',
        invoice_email_cc_addresses: ['a@b.se'], updated_at: '2026-10-03T00:00:00Z', party_id: 'p2',
      } as { id: string },
    ])

    expect(rows).toEqual([
      { id: 'c1', before: { name: 'Gamla AB', email: null }, after: { name: 'Nya AB', email: 'ny@ab.se' } },
    ])
  })

  it('leaves out rows whose update changed nothing and rows this run created', () => {
    const rows = diffUpdatedRows(before, new Set(['c1']), [
      { id: 'c1', name: 'Nya AB' } as { id: string },
      { id: 'c2', name: 'Oförändrad', email: 'x@y.se' } as { id: string },
    ])

    expect(rows).toEqual([])
  })

  it('counts a row matched twice once: first snapshot, last result', () => {
    const rows = diffUpdatedRows(before, new Set(), [
      { id: 'c2', name: 'Första', email: 'x@y.se' } as { id: string },
      { id: 'c2', name: 'Andra', email: 'x@y.se' } as { id: string },
    ])

    expect(rows).toEqual([{ id: 'c2', before: { name: 'Oförändrad' }, after: { name: 'Andra' } }])
  })
})

describe('snapshotRowsForUndo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads nothing when duplicates are skipped', async () => {
    const snapshot = await snapshotRowsForUndo(supabase as never, 'company-1', 'customers', false)

    expect(snapshot.size).toBe(0)
    expect(fetchAllRowsMock).not.toHaveBeenCalled()
  })

  it('maps every row of the register by id when duplicates are updated', async () => {
    fetchAllRowsMock.mockResolvedValue([{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }])

    const snapshot = await snapshotRowsForUndo(supabase as never, 'company-1', 'customers', true)

    expect([...snapshot.keys()]).toEqual(['c1', 'c2'])
    expect(snapshot.get('c2')).toEqual({ id: 'c2', name: 'B' })
  })
})

describe('undoRegisterImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('is NOT_FOUND when the run is not visible in the company', async () => {
    enqueue({ data: null })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome).toEqual({ ok: false, code: 'REG_IMPORT_UNDO_NOT_FOUND' })
    expect(rpcMock).not.toHaveBeenCalled()
    expect(findCalls('register_import_runs', 'eq')).toEqual([
      ['id', 'run-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('is ALREADY_UNDONE without calling the RPC', async () => {
    enqueue({ data: { id: 'run-1', undone_at: '2026-10-03T12:00:00Z' } })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome).toEqual({ ok: false, code: 'REG_IMPORT_UNDO_ALREADY_UNDONE' })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('calls the RPC with the caller as actor and returns its report', async () => {
    enqueue({ data: { id: 'run-1', undone_at: null } })
    const report = { deleted: 3, restored: 1, kept: [] }
    rpcMock.mockResolvedValue({ data: report, error: null })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome).toEqual({ ok: true, result: report })
    expect(rpcMock).toHaveBeenCalledWith('undo_register_import', {
      p_company_id: 'company-1',
      p_run_id: 'run-1',
      p_user_id: 'user-1',
    })
  })

  it.each([
    ['42501', 'REG_IMPORT_UNDO_FORBIDDEN'],
    ['P0002', 'REG_IMPORT_UNDO_NOT_FOUND'],
    ['55000', 'REG_IMPORT_UNDO_ALREADY_UNDONE'],
    ['57014', 'REG_IMPORT_UNDO_FAILED'],
  ])('maps RPC errcode %s to %s', async (pgCode, code) => {
    enqueue({ data: { id: 'run-1', undone_at: null } })
    const error = { code: pgCode, message: 'x' }
    rpcMock.mockResolvedValue({ data: null, error })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome).toEqual({ ok: false, code, error })
  })

  it('is FAILED when the lookup itself errors', async () => {
    const error = { code: 'XX000', message: 'boom' }
    enqueue({ error })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome).toEqual({ ok: false, code: 'REG_IMPORT_UNDO_FAILED', error })
  })
})
