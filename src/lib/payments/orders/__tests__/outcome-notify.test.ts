import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SendEmailOptions, SendEmailResult } from '@/lib/email/service'

const sendEmail = vi.fn<(options: SendEmailOptions) => Promise<SendEmailResult>>()
const isConfigured = vi.fn(() => true)
vi.mock('@/lib/email/service', () => ({ getEmailService: async () => ({ sendEmail, isConfigured }) }))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: async () => ({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
  getBaseUrlForBrand: () => 'https://app.accounted.se',
}))

import { notifyFailedPayments } from '../outcome-notify'

const COMPANY = 'company-1'
const NOW = new Date('2026-10-20T10:50:00Z')
const CREATOR = 'user-creator'
const APPROVER = 'user-approver'
const SIGNER = 'user-signer'

/** The production case (2026-10-20): a basket waiting for the second signer, rejected by the bank three days after the signing, found by the status sync. */
function ended(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    company_id: COMPANY,
    user_id: CREATOR,
    approved_by: CREATOR,
    submitted_by: CREATOR,
    batch_id: 'batch-1',
    status: 'rejected',
    purpose: 'supplier_invoice',
    supplier_invoice_id: `inv-${id}`,
    amount: 12500,
    currency: 'SEK',
    requested_execution_date: '2026-10-20',
    payee_name: 'Derome Bygg AB',
    provider_error_code: null,
    provider_status_at: '2026-10-20T10:45:38Z',
    ...overrides,
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

type Claim = { user_id: string; reference_id: string; delivery_status: string }

/** notification_log as the migration makes it: one claim per (user, payment), the second insert a 23505. */
function claimStore(initial: Claim[] = [], insertError: { code: string; message: string } | null = null) {
  const rows = [...initial]
  const resolver = (calls: Array<{ method: string; args: unknown[] }>) => {
    const insert = calls.find((c) => c.method === 'insert')
    if (insert) {
      if (insertError) return { error: insertError }
      const row = insert.args[0] as Claim
      if (rows.some((r) => r.user_id === row.user_id && r.reference_id === row.reference_id)) return { error: { code: '23505', message: 'duplicate key' } }
      rows.push({ ...row })
      return { data: null }
    }
    const userEq = calls.find((c) => c.method === 'eq' && c.args[0] === 'user_id')?.args[1]
    const refIn = (calls.find((c) => c.method === 'in' && c.args[0] === 'reference_id')?.args[1] ?? []) as string[]
    const scoped = (r: Claim) => (userEq === undefined || r.user_id === userEq) && refIn.includes(r.reference_id)
    if (calls.some((c) => c.method === 'delete')) {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (scoped(rows[i]!)) rows.splice(i, 1)
      return { data: null }
    }
    const update = calls.find((c) => c.method === 'update')
    if (update) {
      for (const r of rows) if (scoped(r)) Object.assign(r, update.args[0])
      return { data: null }
    }
    return { data: rows.filter(scoped).map(({ user_id, reference_id }) => ({ user_id, reference_id })) }
  }
  return { rows, resolver }
}

function database(options: {
  orders: Array<ReturnType<typeof ended>>
  actor?: Record<string, string | null>
  signer?: string | null
  members?: string[]
  settings?: Array<{ user_id: string; email_enabled: boolean | null }>
  claims?: ReturnType<typeof claimStore>
}) {
  const claims = options.claims ?? claimStore()
  const db = createTableMockSupabase({
    payment_orders: { data: options.orders },
    payment_order_events: {
      data: Object.entries(options.actor ?? {}).map(([payment_order_id, actor_user_id]) => ({ payment_order_id, actor_user_id })),
    },
    payment_order_batches: { data: [{ id: 'batch-1', signer_user_id: options.signer ?? SIGNER }] },
    notification_log: claims.resolver,
    company_members: { data: (options.members ?? [CREATOR, APPROVER, SIGNER]).map((user_id) => ({ user_id })) },
    // Answers the ids asked for, as PostgREST does.
    profiles: (calls) => {
      const ids = (calls.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
      return { data: ids.map((id) => ({ id, email: `${id}@example.se`, deleted_at: null })) }
    },
    notification_settings: { data: options.settings ?? [] },
    companies: { data: { name: 'Bygg & Co AB' } },
    supplier_invoices: { data: options.orders.map((o) => ({ id: o.supplier_invoice_id, supplier_invoice_number: `F-${o.id}`, arrival_number: 7 })) },
  })
  return { db, claims }
}

async function run(db: ReturnType<typeof createTableMockSupabase>) {
  return notifyFailedPayments(db.supabase as unknown as SupabaseClient, log, NOW)
}

function recipients(): string[] {
  return sendEmail.mock.calls.map(([options]) => options.to as string).sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  isConfigured.mockReturnValue(true)
  sendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' })
})

describe('notifyFailedPayments', () => {
  it('mails the creator and the signer once each when the status sync finds a signed payment rejected, and not again on the next run', async () => {
    const { db, claims } = database({ orders: [ended('o1')], actor: { o1: null } })

    const first = await run(db)

    expect(recipients()).toEqual([`${CREATOR}@example.se`, `${SIGNER}@example.se`])
    expect(first).toMatchObject({ considered: 1, mailed: 2, notified: 2, errors: 0 })
    const [options] = sendEmail.mock.calls[0]!
    expect(options.subject).toBe('Betalningen till Derome Bygg AB gick inte igenom')
    expect(options.text).toContain('Banken avvisade betalningen.')
    expect(options.text).toContain('faktura F-o1')
    expect(options.text).toContain('https://app.accounted.se/payments')
    // Claimed before the send, marked sent after it.
    expect(claims.rows.map((r) => [r.user_id, r.reference_id, r.delivery_status]).sort()).toEqual([
      [CREATOR, 'o1', 'sent'],
      [SIGNER, 'o1', 'sent'],
    ])

    sendEmail.mockClear()
    const second = await run(db)

    expect(sendEmail).not.toHaveBeenCalled()
    expect(second.mailed).toBe(0)
  })

  it('never mails twice when another run holds the claim, even past the fast-path read', async () => {
    const claims = claimStore()
    const { db } = database({ orders: [ended('o1')], claims })
    // Another run claimed between this run's read and its insert.
    db.setTable('notification_log', (calls) => {
      if (calls.some((c) => c.method === 'select')) return { data: [] }
      claims.rows.push({ user_id: CREATOR, reference_id: 'o1', delivery_status: 'pending' }, { user_id: SIGNER, reference_id: 'o1', delivery_status: 'pending' })
      return claims.resolver(calls)
    })

    const result = await run(db)

    expect(sendEmail).not.toHaveBeenCalled()
    expect(result.mailed).toBe(0)
  })

  it('leaves out the person who was on screen when the bank answered, and tells the others', async () => {
    const { db } = database({
      orders: [ended('o1', { status: 'failed', provider_error_code: 'FORMAT_ERROR', approved_by: APPROVER })],
      actor: { o1: SIGNER },
    })

    await run(db)

    expect(recipients()).toEqual([`${APPROVER}@example.se`, `${CREATOR}@example.se`])
  })

  it('sends nothing when the only person behind the payment saw it fail in the dialog', async () => {
    const { db, claims } = database({ orders: [ended('o1', { status: 'failed' })], actor: { o1: CREATOR }, signer: CREATOR })

    const result = await run(db)

    expect(sendEmail).not.toHaveBeenCalled()
    expect(claims.rows).toEqual([])
    expect(result.mailed).toBe(0)
  })

  it('sends one mail per person for a basket the bank refused as a whole', async () => {
    const { db } = database({ orders: [ended('o1'), ended('o2', { payee_name: 'Ahlsell AB', amount: 800 })], signer: CREATOR })

    await run(db)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const [options] = sendEmail.mock.calls[0]!
    expect(options.subject).toBe('2 betalningar från Bygg & Co AB gick inte igenom')
    expect(options.text).toContain('Ahlsell AB')
    expect(options.text).toContain('Derome Bygg AB')
  })

  it('tells only active members, with an address, who have not switched mail off', async () => {
    const { db } = database({
      orders: [ended('o1', { approved_by: APPROVER })],
      members: [CREATOR, APPROVER],
      settings: [{ user_id: APPROVER, email_enabled: false }],
    })

    await run(db)

    expect(recipients()).toEqual([`${CREATOR}@example.se`])
  })

  it('sends nothing while the database refuses the claim (before the migration), and counts it', async () => {
    const { db } = database({ orders: [ended('o1')], claims: claimStore([], { code: '23514', message: 'violates check constraint' }) })

    const result = await run(db)

    expect(sendEmail).not.toHaveBeenCalled()
    expect(result.claimRefused).toBe(2)
  })

  it('removes the claims of a mail the provider refused, so the next run tries again', async () => {
    const { db, claims } = database({ orders: [ended('o1')], signer: CREATOR })
    sendEmail.mockResolvedValueOnce({ success: false, error: 'invalid address', outcomeUnknown: false })

    await run(db)
    expect(claims.rows).toEqual([])

    await run(db)
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(claims.rows.map((r) => r.delivery_status)).toEqual(['sent'])
  })

  it('keeps the claims of a mail that may have gone out, so it is never sent twice', async () => {
    const { db, claims } = database({ orders: [ended('o1')], signer: CREATOR })
    sendEmail.mockResolvedValueOnce({ success: false, error: 'timeout' })

    await run(db)
    await run(db)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(claims.rows.map((r) => r.delivery_status)).toEqual(['failed'])
  })

  it('claims nothing without a mail service, so a later run with one sends', async () => {
    isConfigured.mockReturnValue(false)
    const { db, claims } = database({ orders: [ended('o1')] })

    await run(db)

    expect(claims.rows).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('reads only payments that ended within the window', async () => {
    const { db } = database({ orders: [] })

    const result = await run(db)

    expect(result.considered).toBe(0)
    expect(db.findCall('payment_orders', 'in')).toEqual(['status', ['rejected', 'failed']])
    expect(db.findCall('payment_orders', 'gte')).toEqual(['provider_status_at', '2026-10-19T10:50:00.000Z'])
    expect(db.tables()).toEqual(['payment_orders'])
  })
})
