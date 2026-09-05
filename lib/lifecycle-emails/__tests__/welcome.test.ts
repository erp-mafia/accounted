import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const sendEmail = vi.fn()
const isConfigured = vi.fn(() => true)

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail, isConfigured }),
}))

import {
  firstNameFromFullName,
  runWelcomeEmailSweep,
  WELCOME_EMAIL_KEY,
  WELCOME_LOOKBACK_MS,
  type WelcomeCandidate,
} from '@/lib/lifecycle-emails/welcome'
import { getBranding } from '@/lib/branding/service'

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}
log.child.mockReturnValue(log)

function candidate(overrides: Partial<WelcomeCandidate> = {}): WelcomeCandidate {
  return {
    user_id: '11111111-1111-4111-8111-111111111111',
    email: 'ny@example.test',
    full_name: 'Jakob Wennberg',
    locale: 'sv',
    confirmed_at: '2026-09-05T12:00:00.000Z',
    ...overrides,
  }
}

interface Filter {
  column: string
  value: unknown
}

/**
 * Minimal fake of the two Supabase surfaces the sweep touches: the candidate
 * RPC and the user_lifecycle_emails table (insert / update / delete with eq
 * filters). Every write is captured so the tests can assert the claim
 * protocol exactly.
 */
function makeSupabase(opts: {
  candidates?: WelcomeCandidate[]
  rpcError?: { message: string } | null
  claimErrors?: Array<{ code?: string; message: string } | null>
}) {
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<{ payload: Record<string, unknown>; filters: Filter[] }> = []
  const deletes: Array<{ filters: Filter[] }> = []
  const claimErrors = [...(opts.claimErrors ?? [])]

  function filterChain(filters: Filter[]) {
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn((column: string, value: unknown) => {
      filters.push({ column, value })
      return chain
    })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve)
    return chain
  }

  const from = vi.fn((table: string) => {
    expect(table).toBe('user_lifecycle_emails')
    return {
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserts.push(row)
        return { data: null, error: claimErrors.shift() ?? null }
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        const rec = { payload, filters: [] as Filter[] }
        updates.push(rec)
        return filterChain(rec.filters)
      }),
      delete: vi.fn(() => {
        const rec = { filters: [] as Filter[] }
        deletes.push(rec)
        return filterChain(rec.filters)
      }),
    }
  })

  const rpc = vi.fn(async () => ({
    data: opts.rpcError ? null : (opts.candidates ?? []),
    error: opts.rpcError ?? null,
  }))

  return {
    supabase: { rpc, from } as unknown as SupabaseClient,
    rpc,
    from,
    inserts,
    updates,
    deletes,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  isConfigured.mockReturnValue(true)
  sendEmail.mockResolvedValue({ success: true, provider: 'resend', messageId: 'msg_1' })
  log.child.mockReturnValue(log)
})

describe('firstNameFromFullName', () => {
  it('takes the first token', () => {
    expect(firstNameFromFullName('Jakob Wennberg')).toBe('Jakob')
    expect(firstNameFromFullName('  Anna-Karin   Berg ')).toBe('Anna-Karin')
  })

  it('returns null for empty, address-like or absurdly long values', () => {
    expect(firstNameFromFullName(null)).toBeNull()
    expect(firstNameFromFullName('')).toBeNull()
    expect(firstNameFromFullName('   ')).toBeNull()
    expect(firstNameFromFullName('jakob@example.test')).toBeNull()
    expect(firstNameFromFullName('x'.repeat(41))).toBeNull()
  })
})

describe('runWelcomeEmailSweep', () => {
  it('does nothing when no email provider is configured', async () => {
    isConfigured.mockReturnValue(false)
    const { supabase, rpc, inserts } = makeSupabase({ candidates: [candidate()] })

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary).toEqual({ configured: false, candidates: 0, sent: 0, skipped: 0, failed: 0 })
    expect(rpc).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('asks for candidates confirmed inside the lookback window', async () => {
    const now = Date.parse('2026-09-05T12:00:00.000Z')
    const { supabase, rpc } = makeSupabase({ candidates: [] })

    await runWelcomeEmailSweep(supabase, { log, now })

    expect(rpc).toHaveBeenCalledWith('list_users_awaiting_lifecycle_email', {
      p_email_key: WELCOME_EMAIL_KEY,
      p_confirmed_since: new Date(now - WELCOME_LOOKBACK_MS).toISOString(),
      p_limit: expect.any(Number),
    })
  })

  it('claims first, sends as the configured person with reply-to support, then records the send', async () => {
    const { supabase, inserts, updates, deletes } = makeSupabase({ candidates: [candidate()] })
    const { supportEmail, welcomeSenderName } = getBranding()

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary).toEqual({ configured: true, candidates: 1, sent: 1, skipped: 0, failed: 0 })
    expect(inserts).toEqual([
      { user_id: '11111111-1111-4111-8111-111111111111', email_key: WELCOME_EMAIL_KEY },
    ])

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const options = sendEmail.mock.calls[0]![0]
    expect(options.to).toBe('ny@example.test')
    expect(options.fromName).toBe(welcomeSenderName)
    expect(options.replyTo).toBe(supportEmail)
    expect(options.subject).toContain('Välkommen')
    expect(options.subject).toContain('Jakob')
    expect(options.html).toContain('Hej Jakob,')
    expect(options.text).toContain('Hej Jakob,')

    expect(updates).toHaveLength(1)
    expect(updates[0]!.payload).toMatchObject({ provider: 'resend', provider_message_id: 'msg_1' })
    expect(updates[0]!.payload.sent_at).toEqual(expect.any(String))
    expect(updates[0]!.filters).toEqual([
      { column: 'user_id', value: '11111111-1111-4111-8111-111111111111' },
      { column: 'email_key', value: WELCOME_EMAIL_KEY },
    ])
    expect(deletes).toHaveLength(0)
  })

  it('renders the English letter for an en locale and the bare greeting without a name', async () => {
    const { supabase } = makeSupabase({
      candidates: [candidate({ locale: 'en', full_name: null })],
    })

    await runWelcomeEmailSweep(supabase, { log })

    const options = sendEmail.mock.calls[0]![0]
    expect(options.subject).toMatch(/^Welcome to /)
    expect(options.text).toMatch(/^Hi,\n/)
  })

  it('skips a candidate whose claim was won by another tick (23505) without sending', async () => {
    const { supabase, updates } = makeSupabase({
      candidates: [candidate()],
      claimErrors: [{ code: '23505', message: 'duplicate key' }],
    })

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary).toEqual({ configured: true, candidates: 1, sent: 0, skipped: 1, failed: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('counts any other claim error as failed and does not send', async () => {
    const { supabase } = makeSupabase({
      candidates: [candidate()],
      claimErrors: [{ code: '42501', message: 'permission denied' }],
    })

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary.failed).toBe(1)
    expect(summary.sent).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('releases the claim when the provider rejects the mail so the next tick retries', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'rate limited' })
    const { supabase, updates, deletes } = makeSupabase({ candidates: [candidate()] })

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary).toEqual({ configured: true, candidates: 1, sent: 0, skipped: 0, failed: 1 })
    expect(updates).toHaveLength(0)
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.filters).toEqual([
      { column: 'user_id', value: '11111111-1111-4111-8111-111111111111' },
      { column: 'email_key', value: WELCOME_EMAIL_KEY },
    ])
  })

  it('releases the claim when the provider throws', async () => {
    sendEmail.mockRejectedValue(new Error('network down'))
    const { supabase, deletes } = makeSupabase({ candidates: [candidate()] })

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary.failed).toBe(1)
    expect(deletes).toHaveLength(1)
  })

  it('keeps going after one failure and never logs the address', async () => {
    sendEmail
      .mockResolvedValueOnce({ success: false, error: 'boom' })
      .mockResolvedValueOnce({ success: true, provider: 'resend', messageId: 'msg_2' })
    const { supabase } = makeSupabase({
      candidates: [
        candidate({ user_id: '11111111-1111-4111-8111-111111111111', email: 'a@example.test' }),
        candidate({ user_id: '22222222-2222-4222-8222-222222222222', email: 'b@example.test' }),
      ],
    })

    const summary = await runWelcomeEmailSweep(supabase, { log })

    expect(summary).toEqual({ configured: true, candidates: 2, sent: 1, skipped: 0, failed: 1 })
    const logged = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
      ...log.child.mock.calls,
    ])
    expect(logged).not.toContain('@example.test')
  })

  it('throws when the candidate lookup fails', async () => {
    const { supabase } = makeSupabase({ rpcError: { message: 'relation missing' } })

    await expect(runWelcomeEmailSweep(supabase, { log })).rejects.toThrow(/relation missing/)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
