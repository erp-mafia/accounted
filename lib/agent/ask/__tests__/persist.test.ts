import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveChatConversation,
  persistUserTurn,
  persistAssistantTurn,
  CHAT_INTENT_ID,
} from '../persist'

interface Recorded {
  inserts: { table: string; payload: Record<string, unknown> }[]
  updates: { table: string; payload: Record<string, unknown>; id?: string }[]
}

/**
 * Hand-rolled supabase double. agent_messages.insert() is awaited directly
 * ({ error }); agent_conversations.insert() chains .select('id').single().
 * agent_conversations.update() chains .eq('id', ...). The mock branches on the
 * table so both shapes resolve.
 */
function makeSupabase(opts: {
  conv?: { id: string; user_id: string; company_id: string; intent_id: string } | null
  newId?: string
  msgInsertError?: unknown
} = {}) {
  const rec: Recorded = { inserts: [], updates: [] }
  const api = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: (_col: string, _val: string) => chain,
        maybeSingle: async () => ({ data: opts.conv ?? null, error: null }),
        insert(payload: Record<string, unknown>) {
          rec.inserts.push({ table, payload })
          if (table === 'agent_messages') {
            return Promise.resolve({ error: opts.msgInsertError ?? null })
          }
          return {
            select: () => ({
              single: async () => ({ data: { id: opts.newId ?? 'new-conv' }, error: null }),
            }),
          }
        },
        update(payload: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: string) => {
              rec.updates.push({ table, payload, id })
              return { error: null }
            },
          }
        },
      }
      return chain
    },
  }
  return { supabase: api as unknown as SupabaseClient, rec }
}

beforeEach(() => vi.clearAllMocks())

describe('resolveChatConversation', () => {
  it('creates a general.help conversation titled from the first question', async () => {
    const { supabase, rec } = makeSupabase({ newId: 'conv-new' })
    const res = await resolveChatConversation(
      supabase,
      'user-1',
      'company-1',
      null,
      '  Hur bokför jag en lunch med en kund?  ',
      'report:vat:2026-07',
    )
    expect(res).toEqual({ ok: true, conversationId: 'conv-new', created: true })
    const insert = rec.inserts.find((i) => i.table === 'agent_conversations')!
    expect(insert.payload).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      intent_id: CHAT_INTENT_ID,
      context_ref: 'report:vat:2026-07',
    })
    expect(insert.payload.title).toBe('Hur bokför jag en lunch med en kund?')
  })

  it('resumes an owned general.help thread', async () => {
    const { supabase } = makeSupabase({
      conv: {
        id: 'conv-9',
        user_id: 'user-1',
        company_id: 'company-1',
        intent_id: CHAT_INTENT_ID,
      },
    })
    const res = await resolveChatConversation(supabase, 'user-1', 'company-1', 'conv-9', 'q')
    expect(res).toEqual({ ok: true, conversationId: 'conv-9', created: false })
  })

  it("refuses a colleague's thread (not_found, not 403)", async () => {
    const { supabase } = makeSupabase({
      conv: {
        id: 'conv-9',
        user_id: 'other-user',
        company_id: 'company-1',
        intent_id: CHAT_INTENT_ID,
      },
    })
    const res = await resolveChatConversation(supabase, 'user-1', 'company-1', 'conv-9', 'q')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses a thread from another company', async () => {
    const { supabase } = makeSupabase({
      conv: { id: 'conv-9', user_id: 'user-1', company_id: 'company-2', intent_id: CHAT_INTENT_ID },
    })
    const res = await resolveChatConversation(supabase, 'user-1', 'company-1', 'conv-9', 'q')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses a tool-loop thread (wrong intent)', async () => {
    const { supabase } = makeSupabase({
      conv: {
        id: 'conv-9',
        user_id: 'user-1',
        company_id: 'company-1',
        intent_id: 'transaction.categorization',
      },
    })
    const res = await resolveChatConversation(supabase, 'user-1', 'company-1', 'conv-9', 'q')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  it('falls back to a default title when the first question is blank', async () => {
    const { supabase, rec } = makeSupabase({ newId: 'conv-new' })
    await resolveChatConversation(supabase, 'user-1', 'company-1', null, '   ')
    const insert = rec.inserts.find((i) => i.table === 'agent_conversations')!
    expect(insert.payload.title).toBe('Fråga din assistent')
    expect(insert.payload.context_ref).toBeNull()
  })
})

describe('persistUserTurn', () => {
  it('appends the question as a text-block user message', async () => {
    const { supabase, rec } = makeSupabase()
    await persistUserTurn(supabase, 'conv-9', 'Stämmer momsen?')
    const insert = rec.inserts.find((i) => i.table === 'agent_messages')!
    expect(insert.payload).toEqual({
      conversation_id: 'conv-9',
      role: 'user',
      content: [{ type: 'text', text: 'Stämmer momsen?' }],
    })
  })

  it('throws if the insert fails (append-only audit must not silently drop turns)', async () => {
    const { supabase } = makeSupabase({ msgInsertError: new Error('rls') })
    await expect(persistUserTurn(supabase, 'conv-9', 'q')).rejects.toThrow('rls')
  })
})

describe('persistAssistantTurn', () => {
  it('appends the answer and rolls the conversation row forward with a preview', async () => {
    const { supabase, rec } = makeSupabase()
    await persistAssistantTurn(supabase, 'conv-9', 'Ja, momsen stämmer.')
    const insert = rec.inserts.find((i) => i.table === 'agent_messages')!
    expect(insert.payload).toEqual({
      conversation_id: 'conv-9',
      role: 'assistant',
      content: [{ type: 'text', text: 'Ja, momsen stämmer.' }],
    })
    const update = rec.updates.find((u) => u.table === 'agent_conversations')!
    expect(update.id).toBe('conv-9')
    expect(update.payload.last_message_preview).toBe('Ja, momsen stämmer.')
    expect(update.payload.last_message_at).toEqual(expect.any(String))
  })

  it('truncates a long preview to 200 chars with an ellipsis', async () => {
    const { supabase, rec } = makeSupabase()
    await persistAssistantTurn(supabase, 'conv-9', 'x'.repeat(500))
    const preview = rec.updates.find((u) => u.table === 'agent_conversations')!.payload
      .last_message_preview as string
    expect(preview.length).toBe(200)
    expect(preview.endsWith('…')).toBe(true)
  })
})
