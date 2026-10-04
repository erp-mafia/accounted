import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const rpcMock = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  rpcClientForBulkDelete: vi.fn(async () => ({ rpc: (...a: unknown[]) => rpcMock(...a) })),
}))

import { recordRegisterImportRun, undoRegisterImport } from '../register-runs'

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
      { companyId: 'company-1', userId: 'user-1', kind: 'customers', created: [{ id: 'c1' }, { id: 'c2' }] },
      testLog(),
    )

    expect(id).toBe('run-1')
    expect(findCall('register_import_runs', 'insert')).toEqual([
      { company_id: 'company-1', user_id: 'user-1', kind: 'customers', created_ids: ['c1', 'c2'] },
    ])
  })

  it('records nothing when the import created nothing', async () => {
    const id = await recordRegisterImportRun(
      supabase as never,
      { companyId: 'company-1', userId: 'user-1', kind: 'articles', created: [] },
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
      { companyId: 'company-1', userId: 'user-1', kind: 'suppliers', created: [{ id: 's1' }] },
      log,
    )

    expect(id).toBeNull()
    expect(log.error).toHaveBeenCalledTimes(1)
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
    const report = { deleted: 3, kept: [] }
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
