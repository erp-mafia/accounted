import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveChatConversation,
  loadChatHistory,
  persistUserTurn,
  persistAssistantTurn,
  CHAT_INTENT_ID,
  HISTORY_MAX_CHARS,
  HISTORY_MAX_MESSAGES,
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

describe('loadChatHistory', () => {
  type Row = { role: string; content: unknown; hidden?: boolean | null }
  // agent_messages read: select → eq → order → order → limit resolves rows.
  // Rows are handed over newest-first, exactly as the query returns them.
  function supabaseWithRows(newestFirst: Row[], opts: { error?: unknown; limitSeen?: number[] } = {}) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async (n: number) => {
        opts.limitSeen?.push(n)
        return { data: opts.error ? null : newestFirst, error: opts.error ?? null }
      },
    }
    return { from: () => chain } as unknown as SupabaseClient
  }
  const text = (t: string) => [{ type: 'text', text: t }]

  it('returns the thread oldest-first as user/assistant text turns', async () => {
    const supabase = supabaseWithRows([
      { role: 'assistant', content: text('12 345 kr på 5010.') },
      { role: 'user', content: text('Vad är min största utgift?') },
    ])
    expect(await loadChatHistory(supabase, 'conv-1')).toEqual([
      { role: 'user', text: 'Vad är min största utgift?' },
      { role: 'assistant', text: '12 345 kr på 5010.' },
    ])
  })

  it('drops hidden scaffolding, tool rows and empty tool-only turns from the old streaming runtime', async () => {
    const supabase = supabaseWithRows([
      { role: 'assistant', content: text('Klart.') },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'x', input: {} }] },
      { role: 'user', content: text('Kolla momsen.') },
      { role: 'user', content: text('[prompt template]'), hidden: true },
    ])
    expect(await loadChatHistory(supabase, 'conv-1')).toEqual([
      { role: 'user', text: 'Kolla momsen.' },
      { role: 'assistant', text: 'Klart.' },
    ])
  })

  it('merges consecutive same-role turns (a question whose answer failed, then its retry)', async () => {
    const supabase = supabaseWithRows([
      { role: 'assistant', content: text('Svar.') },
      { role: 'user', content: text('Igen?') },
      { role: 'user', content: text('Hur gick juli?') },
    ])
    expect(await loadChatHistory(supabase, 'conv-1')).toEqual([
      { role: 'user', text: 'Hur gick juli?\n\nIgen?' },
      { role: 'assistant', text: 'Svar.' },
    ])
  })

  it('never opens with an assistant turn whose question fell off the window', async () => {
    const supabase = supabaseWithRows([
      { role: 'assistant', content: text('B') },
      { role: 'user', content: text('b?') },
      { role: 'assistant', content: text('A (its question is outside the window)') },
    ])
    expect(await loadChatHistory(supabase, 'conv-1')).toEqual([
      { role: 'user', text: 'b?' },
      { role: 'assistant', text: 'B' },
    ])
  })

  it('reads only the newest HISTORY_MAX_MESSAGES rows and trims the oldest until the text fits', async () => {
    const limitSeen: number[] = []
    const big = 'x'.repeat(2_500)
    // 6 turns of 2 500 chars = 15 000 > HISTORY_MAX_CHARS: the oldest go.
    const rows: Row[] = []
    for (let i = 0; i < 6; i++) rows.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: text(`${i}${big}`) })
    const supabase = supabaseWithRows(rows, { limitSeen })
    const turns = await loadChatHistory(supabase, 'conv-1')
    expect(limitSeen).toEqual([HISTORY_MAX_MESSAGES])
    const total = turns.reduce((n, t) => n + t.text.length, 0)
    expect(total).toBeLessThanOrEqual(HISTORY_MAX_CHARS)
    expect(turns[0].role).toBe('user')
    // Newest turn (index 0 in the newest-first rows) is the last one kept.
    expect(turns[turns.length - 1].text.startsWith('0')).toBe(true)
  })

  it('clamps a single oversized turn instead of letting it eat the whole budget', async () => {
    const supabase = supabaseWithRows([
      { role: 'assistant', content: text('Svar.') },
      { role: 'user', content: text('y'.repeat(9_000)) },
    ])
    const turns = await loadChatHistory(supabase, 'conv-1')
    expect(turns).toHaveLength(2)
    expect(turns[0].text.length).toBeLessThan(3_100)
    expect(turns[0].text.endsWith('…')).toBe(true)
  })

  it('throws on a read error rather than silently answering without context', async () => {
    const supabase = supabaseWithRows([], { error: new Error('rls') })
    await expect(loadChatHistory(supabase, 'conv-1')).rejects.toThrow('rls')
  })

  it('is empty for a thread with nothing readable', async () => {
    expect(await loadChatHistory(supabaseWithRows([]), 'conv-1')).toEqual([])
  })
})
