/**
 * Kvittens confirmation email: the atomic claim-then-send dedup.
 *
 * The notification_log row is inserted FIRST as a claim (guarded by the
 * partial unique index from migration 20260712113000); the email is only
 * sent when this invocation won the insert. A 23505 unique violation means
 * another overlapping cron run already claimed the kvittens: no send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockIsConfigured = vi.fn()
const mockSendEmail = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: mockIsConfigured, sendEmail: mockSendEmail }),
}))

import { sendKvittensNotification } from '../lib/kvittens-notification'

interface RecordedOp {
  table: string
  op: 'select' | 'insert' | 'delete'
  payload?: Record<string, unknown>
  filters: Record<string, unknown>
}

/**
 * Hand-rolled mock (instead of createQueuedMockSupabase) because the
 * assertions need the recorded operation ORDER and payloads: claim insert
 * before send, delete filters on release.
 */
function makeSupabase(opts: {
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

const baseInput = {
  companyId: 'company-1',
  userId: 'user-1',
  kind: 'agi' as const,
  period: '202606',
  kvittensnummer: 'KV-123',
  referenceId: '3f9d3c9a-1c2b-4d5e-8f6a-7b8c9d0e1f2a',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsConfigured.mockReturnValue(true)
  mockSendEmail.mockResolvedValue({ success: true })
})

describe('sendKvittensNotification', () => {
  it('claims the notification_log row BEFORE sending the email', async () => {
    const { supabase, ops } = makeSupabase()
    let claimsAtSendTime = -1
    mockSendEmail.mockImplementation(async () => {
      claimsAtSendTime = ops.filter((o) => o.op === 'insert').length
      return { success: true }
    })

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: true })
    expect(claimsAtSendTime).toBe(1)
    const insert = ops.find((o) => o.op === 'insert')
    expect(insert?.table).toBe('notification_log')
    expect(insert?.payload).toMatchObject({
      user_id: 'user-1',
      company_id: 'company-1',
      notification_type: 'skv_kvittens',
      reference_id: baseInput.referenceId,
      delivery_status: 'sent',
    })
  })

  it('a 23505 unique violation on the claim means already claimed: no email', async () => {
    const { supabase } = makeSupabase({
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'duplicate' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('a non-23505 claim failure fails closed: no email, reason claim_failed', async () => {
    const { supabase } = makeSupabase({
      insertError: { code: '57014', message: 'canceling statement' },
    })

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'claim_failed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('the pre-check fast path short-circuits on an existing row', async () => {
    const { supabase, ops } = makeSupabase({ alreadyRow: { id: 'log-1' } })

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'duplicate' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(ops.some((o) => o.op === 'insert')).toBe(false)
  })

  it('releases the claim when the send fails, so a later run can retry', async () => {
    const { supabase, ops } = makeSupabase()
    mockSendEmail.mockResolvedValue({ success: false, error: 'smtp down' })

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'send_failed' })
    const release = ops.find((o) => o.op === 'delete')
    expect(release?.table).toBe('notification_log')
    expect(release?.filters).toMatchObject({
      user_id: 'user-1',
      notification_type: 'skv_kvittens',
      reference_id: baseInput.referenceId,
    })
  })

  it('releases the claim when the send throws', async () => {
    const { supabase, ops } = makeSupabase()
    mockSendEmail.mockRejectedValue(new Error('network'))

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'error' })
    expect(ops.some((o) => o.op === 'delete' && o.table === 'notification_log')).toBe(true)
  })

  it('maps a non-uuid reference id (VAT composite key) to a deterministic uuid', async () => {
    // notification_log.reference_id is a uuid column; the VAT cron passes a
    // composite string key. It must map to the SAME uuid on every run for
    // the claim to dedup.
    const input = { ...baseInput, kind: 'vat' as const, referenceId: 'vat_company-1_202606' }

    const run1 = makeSupabase()
    await sendKvittensNotification(run1.supabase, input)
    const run2 = makeSupabase()
    await sendKvittensNotification(run2.supabase, input)

    const ref1 = run1.ops.find((o) => o.op === 'insert')?.payload?.reference_id as string
    const ref2 = run2.ops.find((o) => o.op === 'insert')?.payload?.reference_id as string
    expect(ref1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(ref2).toBe(ref1)
  })

  it('does nothing when email is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)
    const { supabase, ops } = makeSupabase()

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'email_not_configured' })
    expect(ops).toHaveLength(0)
  })

  it('does not claim or send when the token owner is no longer a member', async () => {
    const { supabase, ops } = makeSupabase({ member: null })

    const result = await sendKvittensNotification(supabase, baseInput)

    expect(result).toEqual({ sent: false, reason: 'no_recipient' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(ops.some((o) => o.op === 'insert')).toBe(false)
  })
})
