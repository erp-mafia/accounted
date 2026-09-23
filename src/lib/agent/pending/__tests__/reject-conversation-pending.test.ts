import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { rejectPendingForConversation } from '../reject-conversation-pending'

function makeSupabase(rows: unknown[]) {
  const calls: { table?: string; update?: Record<string, unknown>; filters: [string, unknown][] } = {
    filters: [],
  }
  const chain = {
    from(table: string) {
      calls.table = table
      return chain
    },
    update(payload: Record<string, unknown>) {
      calls.update = payload
      return chain
    },
    eq(col: string, val: unknown) {
      calls.filters.push([col, val])
      return chain
    },
    select: async () => ({ data: rows }),
  }
  return { supabase: chain as unknown as SupabaseClient, calls }
}

describe('rejectPendingForConversation', () => {
  it('rejects only pending rows of the conversation and returns the count', async () => {
    const { supabase, calls } = makeSupabase([{ id: 'a' }, { id: 'b' }])
    const n = await rejectPendingForConversation(supabase, 'company-1', 'conv-1')
    expect(n).toBe(2)
    expect(calls.table).toBe('pending_operations')
    expect(calls.update).toMatchObject({ status: 'rejected', rejection_reason: 'Ej godkänd i assistenten' })
    expect(calls.update?.resolved_at).toEqual(expect.any(String))
    // Guarded to this company, only pending rows, only this conversation.
    expect(calls.filters).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['status', 'pending'],
        ['agent_metadata->>conversation_id', 'conv-1'],
      ]),
    )
  })

  it('returns 0 when nothing was pending', async () => {
    const { supabase } = makeSupabase([])
    expect(await rejectPendingForConversation(supabase, 'c1', 'conv-1')).toBe(0)
  })
})
