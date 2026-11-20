/**
 * Which verifikat delete_last_voucher can never delete (PH 212, crm#1438):
 * the guard mirrors retain_sie_batch_entry (55000) and
 * retain_sie_undo_reversal (P0001), so the voucher page stops offering a
 * delete the database refuses and the route answers it up front.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  SIE_DELETE_BLOCK_CODE,
  isUndoneSieImport,
  readSieDeleteBlock,
  sieDeleteBlockFromDbError,
} from '../voucher-delete-guard'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const { supabase, enqueue, reset, findCall, calls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

describe('readSieDeleteBlock', () => {
  beforeEach(() => reset())

  it('blocks an SIE-imported verifikat without reading anything', async () => {
    await expect(
      readSieDeleteBlock(client, 'company-1', { import_batch_id: 'imp-1', reverses_id: null }),
    ).resolves.toBe('sie_batch_entry')
    expect(calls).toHaveLength(0)
  })

  it('leaves an ordinary verifikat alone without reading anything', async () => {
    await expect(
      readSieDeleteBlock(client, 'company-1', { import_batch_id: null, reverses_id: null }),
    ).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['undone', { job_state: 'undone', status: 'undone' }],
    ['undoing', { job_state: 'undoing', status: 'completed' }],
    ['replaced', { job_state: 'completed', status: 'replaced' }],
  ])('blocks the storno of a verifikat whose SIE import is %s', async (_label, importState) => {
    enqueue({ data: { import_batch_id: 'imp-1', status: 'reversed' } })
    enqueue({ data: importState })

    await expect(
      readSieDeleteBlock(client, 'company-1', { import_batch_id: null, reverses_id: 'orig-1' }),
    ).resolves.toBe('sie_undo_storno')
    expect(findCall('journal_entries', 'eq')).toEqual(['id', 'orig-1'])
    expect(findCall('sie_imports', 'eq')).toEqual(['id', 'imp-1'])
  })

  it('leaves the storno of one verifikat of a completed import deletable', async () => {
    enqueue({ data: { import_batch_id: 'imp-1', status: 'reversed' } })
    enqueue({ data: { job_state: 'completed', status: 'completed' } })

    await expect(
      readSieDeleteBlock(client, 'company-1', { import_batch_id: null, reverses_id: 'orig-1' }),
    ).resolves.toBeNull()
  })

  it('leaves a storno of an ordinary verifikat deletable after one read', async () => {
    enqueue({ data: { import_batch_id: null, status: 'reversed' } })

    await expect(
      readSieDeleteBlock(client, 'company-1', { import_batch_id: null, reverses_id: 'orig-1' }),
    ).resolves.toBeNull()
    expect(calls.some((c) => c.table === 'sie_imports')).toBe(false)
  })

  it('uses the original the caller already holds instead of reading it', async () => {
    enqueue({ data: { job_state: 'undone', status: 'undone' } })

    await expect(
      readSieDeleteBlock(
        client,
        'company-1',
        { import_batch_id: null, reverses_id: 'orig-1' },
        { import_batch_id: 'imp-1', status: 'reversed' },
      ),
    ).resolves.toBe('sie_undo_storno')
    expect(calls.some((c) => c.table === 'journal_entries')).toBe(false)
  })

  it('does not block when the original is not reversed (the trigger only guards that flip)', async () => {
    await expect(
      readSieDeleteBlock(
        client,
        'company-1',
        { import_batch_id: null, reverses_id: 'orig-1' },
        { import_batch_id: 'imp-1', status: 'posted' },
      ),
    ).resolves.toBeNull()
  })

  it('lets the RPC decide when the reads come back empty', async () => {
    enqueue({ data: null, error: { message: 'timeout' } })

    await expect(
      readSieDeleteBlock(client, 'company-1', { import_batch_id: null, reverses_id: 'orig-1' }),
    ).resolves.toBeNull()
  })
})

describe('isUndoneSieImport', () => {
  it('matches retain_sie_undo_reversal', () => {
    expect(isUndoneSieImport({ job_state: 'completed', status: 'completed' })).toBe(false)
    expect(isUndoneSieImport({ job_state: 'paused', status: 'pending' })).toBe(false)
    expect(isUndoneSieImport({ job_state: 'undone', status: 'replaced' })).toBe(true)
    expect(isUndoneSieImport({ job_state: null, status: 'undone' })).toBe(true)
  })
})

describe('sieDeleteBlockFromDbError', () => {
  it('recognises both trigger refusals and nothing else', () => {
    expect(
      sieDeleteBlockFromDbError({ code: '55000', message: 'SIE batch entries cannot be deleted; use batch storno' }),
    ).toBe('sie_batch_entry')
    expect(
      sieDeleteBlockFromDbError({
        code: 'P0001',
        message: 'Voucher of an undone SIE import cannot be restored; its storno must stay',
      }),
    ).toBe('sie_undo_storno')
    expect(sieDeleteBlockFromDbError({ code: 'P0001', message: 'Cannot delete voucher in a locked fiscal period' }))
      .toBeNull()
    expect(sieDeleteBlockFromDbError(null)).toBeNull()
  })
})

describe('the registered refusals', () => {
  it('are 409s that say the same as the translated trigger refusals', () => {
    const batch = getErrorEntry(SIE_DELETE_BLOCK_CODE.sie_batch_entry)
    const undo = getErrorEntry(SIE_DELETE_BLOCK_CODE.sie_undo_storno)
    expect(batch?.httpStatus).toBe(409)
    expect(undo?.httpStatus).toBe(409)
    expect(batch?.message_sv).toBe(
      getErrorMessage({ code: '55000', message: 'SIE batch entries cannot be deleted; use batch storno' }),
    )
    expect(undo?.message_sv).toBe(
      getErrorMessage({
        code: 'P0001',
        message: 'Voucher of an undone SIE import cannot be restored; its storno must stay',
      }),
    )
  })
})
