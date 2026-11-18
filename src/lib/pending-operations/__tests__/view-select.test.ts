import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PENDING_OPERATION_VIEW_COLUMNS,
  PENDING_OPERATION_VIEW_COLUMNS_WITHOUT_OPERATION_NUMBER,
  readPendingOperationView,
  selectPendingOperationView,
  toPendingOperationView,
} from '../view'

describe('selectPendingOperationView', () => {
  it('reads pending_operations with exactly the view columns, never params', () => {
    const calls: { table?: string; columns?: string } = {}
    const fake = {
      from(table: string) {
        calls.table = table
        return { select: (columns: string) => { calls.columns = columns; return {} } }
      },
    } as unknown as SupabaseClient
    selectPendingOperationView(fake)
    expect(calls.table).toBe('pending_operations')
    expect(calls.columns).toBe(PENDING_OPERATION_VIEW_COLUMNS)
    expect(calls.columns?.split(',').map((c) => c.trim())).not.toContain('params')
  })
})

describe('the columns a deploy can be ahead of', () => {
  const columnsOf = (options?: { withOperationNumber?: boolean }) => {
    let columns = ''
    const fake = {
      from: () => ({ select: (c: string) => { columns = c; return {} } }),
    } as unknown as SupabaseClient
    selectPendingOperationView(fake, options)
    return columns.split(',').map((c) => c.trim())
  }

  it('reads operation_number by default, and the same columns without it on request', () => {
    expect(columnsOf()).toContain('operation_number')
    const without = columnsOf({ withOperationNumber: false })
    expect(without.join(', ')).toBe(PENDING_OPERATION_VIEW_COLUMNS_WITHOUT_OPERATION_NUMBER)
    expect(without).toEqual(columnsOf().filter((c) => c !== 'operation_number'))
    // The retry keeps agent_reason: its own migration is long applied.
    expect(without).toContain('agent_reason')
    expect(without).not.toContain('params')
  })

  it('retries without operation_number only when PostgREST does not know the column', async () => {
    const asked: boolean[] = []
    const answers = [{ data: null, error: { code: '42703' } }, { data: { id: 'op-1' }, error: null }]
    const result = await readPendingOperationView(async ({ withOperationNumber }) => {
      asked.push(withOperationNumber)
      return answers[asked.length - 1]!
    })
    expect(asked).toEqual([true, false])
    expect(result).toEqual({ data: { id: 'op-1' }, error: null })

    const other: boolean[] = []
    await readPendingOperationView(async ({ withOperationNumber }) => {
      other.push(withOperationNumber)
      return { data: null, error: { code: '57014' } }
    })
    expect(other).toEqual([true])
  })

  const base = {
    id: '9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f',
    company_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operation_type: 'create_supplier',
    title: 'Skapa leverantör',
    preview_data: {},
    status: 'pending',
    risk_level: 'low',
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    rejection_category: null,
    rejection_reason: null,
    result_data: null,
    created_at: '2026-10-28T10:00:00Z',
    resolved_at: null,
  }

  it('answers agent_reason, null for a row without one', () => {
    expect(toPendingOperationView({ ...base, agent_reason: 'Why.' }).agent_reason).toBe('Why.')
    expect(toPendingOperationView(base).agent_reason).toBeNull()
  })

  it('answers operation_number: the number, null before the column exists and on a proposal decided before it', () => {
    expect(toPendingOperationView({ ...base, operation_number: 128 }).operation_number).toBe(128)
    expect(toPendingOperationView(base).operation_number).toBeNull()
    expect(toPendingOperationView({ ...base, operation_number: null }).operation_number).toBeNull()
  })
})
