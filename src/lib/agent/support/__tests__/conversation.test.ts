import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveSupportConversation, SUPPORT_INTENT_ID } from '../conversation'
import { checkSupportRateLimit } from '../rate-limit'

const mock = createQueuedMockSupabase()
const supabase = mock.supabase as unknown as SupabaseClient

const USER = 'user-1'
const COMPANY = 'company-1'
const CONVERSATION = '11111111-2222-4333-8444-555555555555'

beforeEach(() => mock.reset())

describe('resolveSupportConversation', () => {
  it('creates a support conversation, archived, titled by the question and bound to the page', async () => {
    mock.enqueue({ data: { id: CONVERSATION } })
    const result = await resolveSupportConversation(supabase, USER, COMPANY, null, '  Var  skapar jag\nen faktura? ', '/invoices')
    expect(result).toEqual({ ok: true, conversationId: CONVERSATION, created: true })
    expect(mock.findCall('agent_conversations', 'insert')).toEqual([
      {
        company_id: COMPANY,
        user_id: USER,
        intent_id: SUPPORT_INTENT_ID,
        context_ref: 'page:/invoices',
        title: 'Var skapar jag en faktura?',
        // Kept out of the chat's own list, which shows every unarchived conversation.
        archived: true,
      },
    ])
  })

  it('cuts a long first question to a title', async () => {
    mock.enqueue({ data: { id: CONVERSATION } })
    await resolveSupportConversation(supabase, USER, COMPANY, undefined, 'a'.repeat(300))
    const [row] = mock.findCall('agent_conversations', 'insert') as [{ title: string; context_ref: string | null }]
    expect(row.title).toHaveLength(80)
    expect(row.context_ref).toBeNull()
  })

  it('resumes the user\'s own support conversation in this company', async () => {
    mock.enqueue({ data: { id: CONVERSATION, user_id: USER, company_id: COMPANY, intent_id: SUPPORT_INTENT_ID } })
    expect(await resolveSupportConversation(supabase, USER, COMPANY, CONVERSATION, 'Och sen?')).toEqual({
      ok: true,
      conversationId: CONVERSATION,
      created: false,
    })
    expect(mock.findCall('agent_conversations', 'insert')).toBeUndefined()
  })

  it.each([
    ['a missing conversation', null],
    ['a colleague\'s conversation', { id: CONVERSATION, user_id: 'user-2', company_id: COMPANY, intent_id: SUPPORT_INTENT_ID }],
    ['another company\'s conversation', { id: CONVERSATION, user_id: USER, company_id: 'company-2', intent_id: SUPPORT_INTENT_ID }],
    ['a chat conversation', { id: CONVERSATION, user_id: USER, company_id: COMPANY, intent_id: 'general.help' }],
  ])('answers not found for %s', async (_name, row) => {
    mock.enqueue({ data: row })
    expect(await resolveSupportConversation(supabase, USER, COMPANY, CONVERSATION, 'Hej')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('throws when the conversation cannot be created', async () => {
    mock.enqueue({ data: null, error: { message: 'insert refused' } })
    await expect(resolveSupportConversation(supabase, USER, COMPANY, null, 'Hej')).rejects.toBeTruthy()
  })
})

describe('checkSupportRateLimit', () => {
  const counter = (result: { data: unknown; error: unknown }) => {
    const rpc = vi.fn().mockResolvedValue(result)
    return { rpc, client: { rpc } as unknown as SupabaseClient }
  }

  it('asks the shared counter with the support limits', async () => {
    const { rpc, client } = counter({ data: { ok: true }, error: null })
    expect(await checkSupportRateLimit(client, USER)).toEqual({ ok: true, scope: undefined })
    // Far below the chat's 30 a minute and 1000 a day: every company has the
    // assistant, a company on trial included.
    expect(rpc).toHaveBeenCalledWith('check_and_increment_agent_quota', {
      p_user_id: USER,
      p_minute_max: 10,
      p_day_max: 60,
    })
  })

  it('reports which limit was hit', async () => {
    const { client } = counter({ data: { ok: false, scope: 'day', retry_after_sec: 3600 }, error: null })
    expect(await checkSupportRateLimit(client, USER)).toEqual({ ok: false, scope: 'day' })
  })

  it('stays open when the counter cannot be read', async () => {
    const { client } = counter({ data: null, error: { message: 'rpc down' } })
    expect(await checkSupportRateLimit(client, USER)).toEqual({ ok: true })
  })
})
