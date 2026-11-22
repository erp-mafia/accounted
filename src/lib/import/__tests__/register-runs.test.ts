import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const rpcMock = vi.fn()
vi.mock('@/lib/supabase/bulk-delete-client', () => ({
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

  it('reads only the given ids, 200 to a read, when the import names them (crm#1383)', async () => {
    fetchAllRowsMock.mockImplementation(async () => [{ id: 'a1', name: 'A' }])
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`)

    const snapshot = await snapshotRowsForUndo(supabase as never, 'company-1', 'articles', true, ids)

    // 450 ids in slices of 200: three reads, not one read of the whole register.
    expect(fetchAllRowsMock).toHaveBeenCalledTimes(3)
    expect(snapshot.get('a1')).toEqual({ id: 'a1', name: 'A' })
  })

  it('reads nothing for an empty id list', async () => {
    const snapshot = await snapshotRowsForUndo(supabase as never, 'company-1', 'articles', true, [])
    expect(snapshot.size).toBe(0)
    expect(fetchAllRowsMock).not.toHaveBeenCalled()
  })
})

describe('undoRegisterImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    // An implementation another test set, or a queued one it left unused,
    // must not answer this test's drafts lookup.
    fetchAllRowsMock.mockReset()
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

  // The import moved the header of the customer's open drafts with it
  // (#3481); the undo moves it back for the rows it restored.
  it('re-derives the drafts of the customers it restored to another VAT status, and only those', async () => {
    enqueue({
      data: {
        id: 'run-1',
        undone_at: null,
        kind: 'customers',
        updated_rows: [
          { id: 'c1', before: { customer_type: 'eu_business', country: 'DE' }, after: { customer_type: 'swedish_business', country: 'SE' } },
          { id: 'c2', before: { phone: null }, after: { phone: '08-123456' } },
          { id: 'c3', before: { customer_type: 'eu_business' }, after: { customer_type: 'swedish_business' } },
        ],
      },
    })
    rpcMock.mockResolvedValue({
      data: { deleted: 0, restored: 2, kept: [{ id: 'c3', name: 'Kept AB', reason: 'used_since_import' }] },
      error: null,
    })
    // Which of them has an open draft: the lookup runs its query, and c1 has one.
    fetchAllRowsMock.mockImplementationOnce(async (query: (range: { from: number; to: number }) => PromiseLike<unknown>) => {
      await query({ from: 0, to: 999 })
      return [{ customer_id: 'c1' }]
    })
    enqueue({ data: [] })
    // syncDraftVatHeadersForCustomer for c1: the customer as restored, its draft, the seller, the write.
    enqueue({ data: { id: 'c1', customer_type: 'eu_business', vat_number: 'DE123456789', vat_number_validated: true, country: 'DE' } })
    enqueue({
      data: [{
        id: 'draft-1',
        vat_treatment: 'standard_25',
        moms_ruta: '05',
        reverse_charge_text: null,
        vat_treatment_override: null,
        delivery_country: null,
        items: [{ vat_rate: 0, line_type: 'service' }],
      }],
    })
    enqueue({ data: { vat_registered: true } })
    enqueue({ data: null })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome.ok).toBe(true)
    // c2 changed no VAT field, c3 was kept: only c1 is looked up and read.
    expect(findCalls('invoices', 'in')).toEqual([['customer_id', ['c1']]])
    expect(findCalls('customers', 'eq')).toEqual([
      ['id', 'c1'],
      ['company_id', 'company-1'],
    ])
    expect(findCall('invoices', 'update')![0]).toMatchObject({ vat_treatment: 'reverse_charge', moms_ruta: '39' })
  })

  it('reads no restored customer that has no open draft', async () => {
    enqueue({
      data: {
        id: 'run-1',
        undone_at: null,
        kind: 'customers',
        updated_rows: [{ id: 'c1', before: { customer_type: 'eu_business' }, after: { customer_type: 'swedish_business' } }],
      },
    })
    rpcMock.mockResolvedValue({ data: { deleted: 0, restored: 1, kept: [] }, error: null })
    fetchAllRowsMock.mockResolvedValueOnce([])

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome.ok).toBe(true)
    expect(fetchAllRowsMock).toHaveBeenCalledTimes(1)
    expect(findCall('customers', 'select')).toBeUndefined()
    expect(findCall('invoices', 'update')).toBeUndefined()
  })

  it('starts no draft sync past its deadline and names the restored customers it left', async () => {
    enqueue({
      data: {
        id: 'run-1',
        undone_at: null,
        kind: 'customers',
        updated_rows: [
          { id: 'c1', before: { customer_type: 'eu_business' }, after: { customer_type: 'swedish_business' } },
          { id: 'c2', before: { phone: null }, after: { phone: '08-123456' } },
        ],
      },
    })
    const result = { deleted: 0, restored: 2, kept: [] }
    rpcMock.mockResolvedValue({ data: result, error: null })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1', {
      draftSyncDeadline: Date.now() - 1,
    })

    // Undone either way; c2 changed no VAT field, so only c1 is left.
    expect(outcome).toEqual({ ok: true, result, draftsNotSynced: ['c1'] })
    expect(fetchAllRowsMock).not.toHaveBeenCalled()
    expect(findCall('customers', 'select')).toBeUndefined()
  })

  it('touches no drafts when it undoes a supplier import', async () => {
    enqueue({
      data: {
        id: 'run-1',
        undone_at: null,
        kind: 'suppliers',
        updated_rows: [{ id: 's1', before: { country: 'DE' }, after: { country: 'SE' } }],
      },
    })
    rpcMock.mockResolvedValue({ data: { deleted: 0, restored: 1, kept: [] }, error: null })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome.ok).toBe(true)
    expect(findCall('customers', 'select')).toBeUndefined()
    expect(findCall('invoices', 'select')).toBeUndefined()
  })

  it('is FAILED when the lookup itself errors', async () => {
    const error = { code: 'XX000', message: 'boom' }
    enqueue({ error })

    const outcome = await undoRegisterImport(supabase as never, 'company-1', 'run-1', 'user-1')

    expect(outcome).toEqual({ ok: false, code: 'REG_IMPORT_UNDO_FAILED', error })
  })
})
