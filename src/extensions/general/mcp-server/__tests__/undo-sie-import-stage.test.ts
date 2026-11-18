/**
 * Stage-time pre-flight for gnubok_undo_sie_import, generated from the
 * operation imports.sie.undo (lib/operations/imports.ts): the staging dry
 * run is the service's own (requestSIEImportAction in
 * lib/import/sie-job-action-service.ts), so the approver sees what the v1
 * endpoint would answer. The import must exist and be durable, the caller
 * must be owner or admin, no other SIE run may be active, and no date a
 * storno must carry may be locked. The lock question is the database's own
 * (sie_undo_lock_refusal, the answer request_sie_import_undo gives): a
 * closed or locked fiscal year, or a company lock date covering the
 * imported vouchers (crm#1022).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { getStructuredError } from '@/lib/errors/get-structured-error'

const undoTool = tools.find((t) => t.name === 'gnubok_undo_sie_import')!

const IMPORT_ID = '7ce91a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b'

const IMPORT_ROW = {
  id: IMPORT_ID,
  job_state: 'completed',
  job_kind: 'import',
  job_phase: null,
  user_id: 'user-1',
  execution_actor_id: null,
  fiscal_period_id: 'fp-1',
  filename: 'exempelab-201907-202006.se',
  fiscal_year_start: '2019-07-01',
  fiscal_year_end: '2020-06-30',
}

type Staged = { staged: boolean; operation_id?: string; preview: Record<string, unknown>; next?: Record<string, unknown> }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_undo_sie_import: registration', () => {
  it('stays in tools/list, is destructive, and keeps reason in its input', () => {
    expect(undoTool.catalogVisibility).toBe('default')
    expect(undoTool.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    const schema = undoTool.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['dry_run', 'idempotency_key', 'import_id', 'reason'])
    expect(schema.required).toEqual(['import_id'])
  })
})

describe('gnubok_undo_sie_import: stage-time validation', () => {
  it('stages an undo when the import is completed and nothing is locked', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: IMPORT_ROW }, // sie_imports lookup
      { data: { role: 'owner' } }, // company_members: owner/admin gate
      { data: [] }, // no other active SIE run
      { data: null }, // rpc sie_undo_lock_refusal: nothing locked
      { data: { import_hold: IMPORT_ID } }, // the period holds this import only
      { count: 109 }, // posted entries to reverse
      { data: { id: 'op-undo-1' } }, // pending_operations insert
    ])

    const result = (await undoTool.execute(
      { import_id: IMPORT_ID, reason: 'Importen skapade fel verifikat' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-undo-1')
    expect(result.preview).toMatchObject({
      import_id: IMPORT_ID,
      filename: 'exempelab-201907-202006.se',
      fiscal_year: '2019-07-01 till 2020-06-30',
      voucher_count: 109,
      reason: 'Importen skapade fel verifikat',
    })
    expect(result.next).toMatchObject({ tool: 'gnubok_sie_import_status' })
    expect(findCalls('pending_operations', 'insert')[0]?.[0]).toMatchObject({
      operation_type: 'undo_sie_import',
      title: 'Ångra SIE-import: exempelab-201907-202006.se',
    })
  })

  it('rejects when the import row is not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // sie_imports lookup misses

    await expect(
      undoTool.execute({ import_id: IMPORT_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('directs a legacy import to outcome review', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...IMPORT_ROW, job_state: null } })

    await expect(
      undoTool.execute({ import_id: IMPORT_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED' })
  })

  it('refuses a member who is not owner or admin, staging nothing (the hand-written tool let it through)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: IMPORT_ROW }, { data: { role: 'member' } }])

    await expect(
      undoTool.execute({ import_id: IMPORT_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('refuses while another SIE run is active (the hand-written tool let it through)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: IMPORT_ROW },
      { data: { role: 'admin' } },
      { data: [{ id: 'other-run', job_state: 'running', supersedes_import_id: null }] },
    ])

    await expect(
      undoTool.execute({ import_id: IMPORT_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code: 'SIE_IMPORT_ACTION_CONFLICT' })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it.each([
    ['the linked fiscal year is locked',
      'Räkenskapsåret 2024 (2024-01-01 till 2024-12-31) är låst. Lås upp det under Inställningar > Bokföring > Räkenskapsår först och försök igen.'],
    ['the company lock date covers the imported vouchers',
      'Bokföringen är låst t.o.m. 2025-12-31, och ångringen bokför storno med de importerade verifikationernas datum, 2024-03-04 till 2024-12-31. ' +
      'Lås upp till och med 2024-03-04 först: sätt Bokföring låst t.o.m. till 2024-03-03 eller tidigare, eller töm fältet, under Inställningar > Bokföring och försök igen. ' +
      'Lås bokföringen igen när ångringen är klar.'],
  ])('rejects with the database\'s sentence when %s, staging nothing', async (_case, sentence) => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: IMPORT_ROW },
      { data: { role: 'owner' } },
      { data: [] },
      { data: sentence }, // rpc sie_undo_lock_refusal
    ])

    const thrown = await undoTool
      .execute({ import_id: IMPORT_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .catch((err: unknown) => err)

    expect(thrown).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', message: sentence })
    expect(supabase.rpc).toHaveBeenCalledWith('sie_undo_lock_refusal', { p_company_id: 'company-1', p_import_id: IMPORT_ID })
    // Refused before staging: no pending operation was written.
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
    expect(getStructuredError(thrown)).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', message_sv: sentence, retryable: false })
  })

  it('rejects a missing import_id before any DB hit', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      undoTool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a reason longer than 500 characters as VALIDATION_ERROR naming the field', async () => {
    const { supabase } = createQueuedMockSupabase()
    const thrown = await undoTool
      .execute({ import_id: IMPORT_ID, reason: 'x'.repeat(501) }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .catch((err: unknown) => err)
    expect(getStructuredError(thrown).code).toBe('VALIDATION_ERROR')
    expect((thrown as Error).message).toMatch(/reason/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
