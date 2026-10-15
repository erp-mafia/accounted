import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PENDING_OPERATION_VIEW_COLUMNS, selectPendingOperationView } from '../view'

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
