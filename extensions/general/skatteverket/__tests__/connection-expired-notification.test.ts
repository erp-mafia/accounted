/**
 * Connection-expired email: the atomic claim-then-send dedup.
 *
 * One email per consent episode: the reference key is derived from
 * (userId, token.created_at), claimed through notification_log under type
 * 'skv_connection_expired' (partial unique index from migration
 * 20260720090000). A re-observed expiry of the same token never notifies
 * twice; a reconnect (new token row, new created_at) resets the episode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockIsConfigured = vi.fn()
const mockSendEmail = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: mockIsConfigured, sendEmail: mockSendEmail }),
}))

import { sendConnectionExpiredNotification } from '../lib/connection-expired-notification'

interface RecordedOp {
  table: string
  op: 'select' | 'insert' | 'delete'
  payload?: Record<string, unknown>
  filters: Record<string, unknown>
}

const TOKEN_CREATED_AT = '2026-06-30T13:09:50.729013+00:00'

function expectedReferenceUuid(userId: string, createdAt: string): string {
  const hex = createHash('sha256')
    .update(`skv-connection-expired|${userId}|${createdAt}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Hand-rolled mock (instead of createQueuedMockSupabase) because the
 * assertions need the recorded operation ORDER and payloads: claim insert
 * before send, delete filters on release.
 */
function makeSupabase(opts: {
  token?: { created_at: string } | null
  alreadyRow?: { id: string } | null
  member?: Record<string, unknown> | null
  insertError?: { code?: string; message: string } | null
} = {}) {
  const ops: RecordedOp[] = []
  const from = (table: string) => {
    const call: RecordedOp = { table, op: 'select', filters: {} }
    ops.push(call)
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      select: () => builder,
      insert: (payload: Record<string, unknown>) => {
        call.op = 'insert'
        call.payload = payload
        return Promise.resolve({ data: null, error: opts.insertError ?? null })
      },
      delete: () => {
        call.op = 'delete'
        return builder
      },
      eq: (key: string, value: unknown) => {
        call.filters[key] = value
        return builder
      },
      maybeSingle: async () => {
        if (table === 'skatteverket_tokens') {
          const token =
            opts.token === undefined ? { created_at: TOKEN_CREATED_AT } : opts.token
          return { data: token, error: null }
        }
        if (table === 'notification_log') return { data: opts.alreadyRow ?? null, error: null }
        if (table === 'company_members') {
          const member =
            opts.member === undefined
              ? { user_id: 'user-1', profiles: { email: 'user@example.com' } }
              : opts.member
          return { data: member, error: null }
        }
        return { data: null, error: null }
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    })
    return builder
  }
  return { supabase: { from } as unknown as SupabaseClient, ops }
}

const baseInput = { companyId: 'company-1', userId: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockIsConfigured.mockReturnValue(true)
  mockSendEmail.mockResolvedValue({ success: true })
})

describe('sendConnectionExpiredNotification', () => {
  it('claims the notification_log row BEFORE sending the email', async () => {
    const { supabase, ops } = makeSupabase()
    let claimsAtSendTime = -1
    mockSendEmail.mockImplementation(async () => {
      claimsAtSendTime = ops.filter((o) => o.op === 'insert').length
      return { success: true }
    })

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: true })
    expect(claimsAtSendTime).toBe(1)
    const insert = ops.find((o) => o.op === 'insert')
    expect(insert?.table).toBe('notification_log')
    expect(insert?.payload).toMatchObject({
      user_id: 'user-1',
      company_id: 'company-1',
      notification_type: 'skv_connection_expired',
      reference_id: expectedReferenceUuid('user-1', TOKEN_CREATED_AT),
      delivery_status: 'sent',
    })
  })

  it('sends the reconnect instructions to the token owner', async () => {
    const { supabase } = makeSupabase()

    await sendConnectionExpiredNotification(supabase, baseInput)

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    const mail = mockSendEmail.mock.calls[0][0] as {
      to: string
      subject: string
      text: string
    }
    expect(mail.to).toBe('user@example.com')
    expect(mail.subject).toContain('Skatteverket')
    expect(mail.text).toContain('BankID')
    expect(mail.text).toContain('alla behörigheter')
    expect(mail.text).toContain('/settings/tax')
  })

  it('skips via the fast path when the episode was already notified', async () => {
    const { supabase } = makeSupabase({ alreadyRow: { id: 'log-1' } })

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'duplicate' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('treats a 23505 unique violation on the claim as a duplicate', async () => {
    const { supabase } = makeSupabase({
      insertError: { code: '23505', message: 'duplicate key value' },
    })

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'duplicate' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('skips the send when the claim insert fails for another reason', async () => {
    const { supabase } = makeSupabase({
      insertError: { code: '57014', message: 'canceling statement' },
    })

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'claim_failed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does nothing when the email service is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)
    const { supabase, ops } = makeSupabase()

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'email_not_configured' })
    expect(ops).toHaveLength(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('keys the episode on the (user, company) token row, not the user alone', async () => {
    const { supabase, ops } = makeSupabase()

    await sendConnectionExpiredNotification(supabase, baseInput)

    // Rows are per (user, company): a multi-company operator holds several,
    // and a user-only maybeSingle() errored out and silently skipped the
    // email (#1673 follow-through).
    const tokenRead = ops.find((o) => o.table === 'skatteverket_tokens')
    expect(tokenRead?.filters).toMatchObject({ user_id: 'user-1', company_id: 'company-1' })
  })

  it('skips when no token row exists (already disconnected)', async () => {
    const { supabase } = makeSupabase({ token: null })

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'no_token' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('skips without claiming when the token owner is no longer a member', async () => {
    const { supabase, ops } = makeSupabase({ member: null })

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'no_recipient' })
    expect(ops.find((o) => o.op === 'insert')).toBeUndefined()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('releases the claim when the email send reports failure', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'smtp down' })
    const { supabase, ops } = makeSupabase()

    const result = await sendConnectionExpiredNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'send_failed' })
    const del = ops.find((o) => o.op === 'delete')
    expect(del?.table).toBe('notification_log')
    expect(del?.filters).toMatchObject({
      user_id: 'user-1',
      notification_type: 'skv_connection_expired',
      reference_id: expectedReferenceUuid('user-1', TOKEN_CREATED_AT),
    })
  })
})
