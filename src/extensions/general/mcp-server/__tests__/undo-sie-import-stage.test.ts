/**
 * Stage-time pre-flight for gnubok_undo_sie_import.
 *
 * The tool mirrors undoSIEImport's gates so the approver sees an honest
 * preview: row must exist, must be in 'completed' status, and no date a
 * storno must carry may be locked. The lock question is the database's own
 * (sie_undo_lock_refusal, the answer request_sie_import_undo gives): a
 * closed or locked fiscal year, or a company lock date covering the
 * imported vouchers (crm#1022).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const undoTool = tools.find((t) => t.name === 'gnubok_undo_sie_import')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_undo_sie_import: stage-time validation', () => {
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
        status: 'completed', job_state: 'completed',
        fiscal_period_id: 'fp-1',
        imported_at: '2026-05-28T10:00:00Z',
      },
      error: null,
    }) // sie_imports lookup
    enqueue({ data: null, error: null }) // rpc sie_undo_lock_refusal: nothing locked
    enqueue({
      data: { name: 'Räkenskapsår 2019/2020' },
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

  it('directs a legacy import to outcome review', async () => {
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
    ).rejects.toMatchObject({ code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED' })
  })

  const lockedImport = {
    data: {
      id: 'imp-3',
      filename: 'locked.se',
      fiscal_year_start: '2024-01-01',
      fiscal_year_end: '2024-12-31',
      transactions_count: 1,
      opening_balance_entry_id: 'ob-1',
      status: 'completed', job_state: 'completed',
      fiscal_period_id: 'fp-locked',
      imported_at: '2026-05-01T00:00:00Z',
    },
    error: null,
  }

  it.each([
    ['the linked fiscal year is locked',
      'Räkenskapsåret 2024 (2024-01-01 till 2024-12-31) är låst. Lås upp det under Inställningar > Bokföring > Räkenskapsår först och försök igen.'],
    ['the company lock date covers the imported vouchers',
      'Bokföringen är låst t.o.m. 2025-12-31, och ångringen bokför storno med de importerade verifikationernas datum, 2024-03-04 till 2024-12-31. ' +
      'Lås upp till och med 2024-03-04 först: sätt Bokföring låst t.o.m. till 2024-03-03 eller tidigare, eller töm fältet, under Inställningar > Bokföring och försök igen. ' +
      'Lås bokföringen igen när ångringen är klar.'],
  ])('rejects with the database\'s sentence when %s, staging nothing', async (_case, sentence) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(lockedImport)
    enqueue({ data: sentence, error: null }) // rpc sie_undo_lock_refusal

    const thrown = await undoTool.execute(
      { import_id: 'imp-3' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    ).catch((err: unknown) => err)

    expect(thrown).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', message: sentence })
    expect(supabase.rpc).toHaveBeenCalledWith('sie_undo_lock_refusal', { p_company_id: 'company-1', p_import_id: 'imp-3' })
    // Refused before staging: no pending operation was written.
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
    const { getStructuredError } = await import('@/lib/errors/get-structured-error')
    expect(getStructuredError(thrown)).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', message_sv: sentence, retryable: false })
  })

  it('rejects missing import_id before any DB hit', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      undoTool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/import_id/i)
  })

  it('rejects reason longer than 500 characters as VALIDATION_ERROR with a Swedish message', async () => {
    const { supabase } = createQueuedMockSupabase()
    const { getStructuredError } = await import('@/lib/errors/get-structured-error')
    let thrown: unknown
    try {
      await undoTool.execute(
        { import_id: 'imp-1', reason: 'x'.repeat(501) },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const envelope = getStructuredError(thrown)
    expect(envelope.code).toBe('VALIDATION_ERROR')
    expect(envelope.message_sv).toBe('Motiveringen får vara högst 500 tecken.')
    expect(envelope.message_en).toMatch(/500 characters or fewer/)
  })
})
