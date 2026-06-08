/**
 * Stage-time pre-flight for gnubok_undo_sie_import.
 *
 * The tool mirrors undoSIEImport's gates so the approver sees an honest
 * preview: row must exist, must be in 'completed' status, and if linked
 * to a fiscal period that period must be open + unlocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const undoTool = tools.find((t) => t.name === 'gnubok_undo_sie_import')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_undo_sie_import — stage-time validation', () => {
  it('stages an undo when the import is completed and the period is open', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'imp-1',
        filename: 'lookmaab-201907-202006.se',
        fiscal_year_start: '2019-07-01',
        fiscal_year_end: '2020-06-30',
        transactions_count: 109,
        opening_balance_entry_id: null,
        status: 'completed',
        fiscal_period_id: 'fp-1',
        imported_at: '2026-05-28T10:00:00Z',
      },
      error: null,
    }) // sie_imports lookup
    enqueue({
      data: { name: 'Räkenskapsår 2019/2020', is_closed: false, locked_at: null },
      error: null,
    }) // fiscal_periods lookup
    enqueue({ data: { id: 'op-undo-1' }, error: null }) // pending_operations insert

    const result = (await undoTool.execute(
      { import_id: 'imp-1', reason: 'Importen skapade 0 verifikat' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-undo-1')
    expect(result.preview.import).toMatchObject({
      id: 'imp-1',
      filename: 'lookmaab-201907-202006.se',
      transactions_count: 109,
      has_opening_balance_entry: false,
      fiscal_period_name: 'Räkenskapsår 2019/2020',
    })
  })

  it('rejects when the import row is not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // sie_imports lookup misses

    await expect(
      undoTool.execute(
        { import_id: 'imp-missing' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/hittades inte/i)
  })

  it('rejects when the import is not in completed status', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'imp-2',
        filename: 'half.se',
        fiscal_year_start: '2024-01-01',
        fiscal_year_end: '2024-12-31',
        transactions_count: 0,
        opening_balance_entry_id: null,
        status: 'pending',
        fiscal_period_id: null,
        imported_at: null,
      },
      error: null,
    })

    await expect(
      undoTool.execute(
        { import_id: 'imp-2' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/slutförda importer kan ångras/i)
  })

  it('rejects when the linked fiscal period is locked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'imp-3',
        filename: 'locked.se',
        fiscal_year_start: '2024-01-01',
        fiscal_year_end: '2024-12-31',
        transactions_count: 1,
        opening_balance_entry_id: 'ob-1',
        status: 'completed',
        fiscal_period_id: 'fp-locked',
        imported_at: '2026-05-01T00:00:00Z',
      },
      error: null,
    })
    enqueue({
      data: { name: 'Räkenskapsår 2024', is_closed: false, locked_at: '2026-04-30T00:00:00Z' },
      error: null,
    })

    await expect(
      undoTool.execute(
        { import_id: 'imp-3' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/låst eller stängt/i)
  })

  it('rejects missing import_id before any DB hit', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      undoTool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/import_id/i)
  })

  it('rejects reason longer than 500 characters', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      undoTool.execute(
        { import_id: 'imp-1', reason: 'x'.repeat(501) },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/500/)
  })
})
