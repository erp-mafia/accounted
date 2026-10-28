import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PENDING_OPERATION_VIEW_COLUMNS,
  PENDING_OPERATION_VIEW_COLUMNS_WITHOUT_AGENT_REASON,
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

describe('agent_reason in the view', () => {
  const columnsOf = (options?: { withAgentReason?: boolean }) => {
    let columns = ''
    const fake = {
      from: () => ({ select: (c: string) => { columns = c; return {} } }),
    } as unknown as SupabaseClient
    selectPendingOperationView(fake, options)
    return columns.split(',').map((c) => c.trim())
  }

  it('reads agent_reason by default, and the same columns without it on request', () => {
    expect(columnsOf()).toContain('agent_reason')
    const without = columnsOf({ withAgentReason: false })
    expect(without.join(', ')).toBe(PENDING_OPERATION_VIEW_COLUMNS_WITHOUT_AGENT_REASON)
    expect(without).toEqual(columnsOf().filter((c) => c !== 'agent_reason'))
    expect(without).not.toContain('params')
  })

  it('retries without agent_reason only when PostgREST does not know the column', async () => {
    const asked: boolean[] = []
    const answers = [{ data: null, error: { code: '42703' } }, { data: { id: 'op-1' }, error: null }]
    const result = await readPendingOperationView(async ({ withAgentReason }) => {
      asked.push(withAgentReason)
      return answers[asked.length - 1]!
    })
    expect(asked).toEqual([true, false])
    expect(result).toEqual({ data: { id: 'op-1' }, error: null })

    const other: boolean[] = []
    await readPendingOperationView(async ({ withAgentReason }) => {
      other.push(withAgentReason)
      return { data: null, error: { code: '57014' } }
    })
    expect(other).toEqual([true])
  })

  it('answers agent_reason, null for a row read before the column existed', () => {
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
    expect(toPendingOperationView({ ...base, agent_reason: 'Why.' }).agent_reason).toBe('Why.')
    expect(toPendingOperationView(base).agent_reason).toBeNull()
  })
})
