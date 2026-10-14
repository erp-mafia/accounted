/**
 * The payment signing link's rules (../signing-links.ts): who may send one,
 * which orders it may cover, how its token resolves, where its basket stands
 * and what the page shows. The database is a table mock; the mail, the brand
 * base URL and the payments door are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import { hashInviteToken } from '@/lib/bank-feed/invites'
import { COMPANY, order, USER } from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))
const mail = vi.hoisted(() => ({ sendPaymentSigningRequestMail: vi.fn() }))
vi.mock('@/lib/email/send-payment-signing-request', () => mail)
const door = vi.hoisted(() => ({ openPaymentsDoor: vi.fn() }))
vi.mock('../switched-on', () => door)

import {
  cancelPaymentSigningLink,
  consumePaymentSigningLink,
  describePaymentSigningLink,
  issuePaymentSigningLink,
  linkState,
  listOpenPaymentSigningLinks,
  previewPaymentSigningLink,
  resolvePaymentSigningLink,
  signingBelongsToLink,
  type PaymentSigningLinkRow,
} from '../signing-links'

const LINK_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_USER = 'user-2'
const HOUR = 60 * 60 * 1000

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

function linkRow(overrides: Partial<PaymentSigningLinkRow> = {}): PaymentSigningLinkRow {
  return {
    id: LINK_ID,
    company_id: COMPANY,
    created_by: USER,
    recipient_email: 'anna@example.se',
    note: 'Oktober',
    order_ids: ['o1', 'o2'],
    total_amount: 1475,
    currency: 'SEK',
    expires_at: new Date(Date.now() + 72 * HOUR).toISOString(),
    mail_sent_at: null,
    batch_id: null,
    consumed_at: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

const inserted = () => db.payloads('payment_signing_links', 'insert') as Array<Record<string, unknown>>

beforeEach(() => {
  vi.clearAllMocks()
  db = createTableMockSupabase({
    company_members: { data: { role: 'owner' } },
    payment_orders: { data: [order('o1'), order('o2', { amount: 737.5 })] },
    payment_signing_links: { data: [] },
    companies: { data: { name: 'Bolaget AB', team_id: null } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: USER, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never }
  door.openPaymentsDoor.mockResolvedValue({ ok: true, provider: { id: 'open_payments' } })
  mail.sendPaymentSigningRequestMail.mockResolvedValue({ emailSent: true })
})

describe('issuePaymentSigningLink', () => {
  it('stores only the hash, covers exactly the orders, mails the link and answers the url once', async () => {
    db.setTable('payment_signing_links', [{ data: [] }, { data: { id: LINK_ID } }, { data: null }])
    const result = await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2', 'o1'], recipientEmail: ' Anna@Example.se ', note: '  Oktober  ' })
    expect(result.ok).toBe(true)
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data).toMatchObject({ signing_link_id: LINK_ID, email_sent: true, order_count: 2, total_amount: 1475, currency: 'SEK' })
    const token = result.data.url.split('/betala/')[1]!
    expect(result.data.url).toBe(`https://app.accounted.se/betala/${token}`)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [row] = inserted()
    expect(row).toMatchObject({
      company_id: COMPANY,
      created_by: USER,
      token_hash: hashInviteToken(token),
      recipient_email: 'anna@example.se',
      note: 'Oktober',
      order_ids: ['o1', 'o2'],
      total_amount: 1475,
      currency: 'SEK',
    })
    expect(JSON.stringify(row)).not.toContain(token)
    const hours = (new Date(String(row!.expires_at)).getTime() - Date.now()) / HOUR
    expect(Math.round(hours)).toBe(72)
    expect(mail.sendPaymentSigningRequestMail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'anna@example.se', url: result.data.url, orderCount: 2, totalAmount: 1475, companyName: 'Bolaget AB', requester: 'Karin Byråsson', note: 'Oktober' }),
    )
    expect(db.payloads('payment_signing_links', 'update')).toEqual([expect.objectContaining({ mail_sent_at: expect.any(String) })])
  })

  it('answers the url with email_sent false when nobody is named or the mail fails', async () => {
    db.setTable('payment_signing_links', [{ data: [] }, { data: { id: LINK_ID } }])
    const plain = await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })
    expect(plain.ok && !plain.dryRun && plain.data.email_sent).toBe(false)
    expect(mail.sendPaymentSigningRequestMail).not.toHaveBeenCalled()

    db.setTable('payment_signing_links', [{ data: [] }, { data: { id: LINK_ID } }])
    mail.sendPaymentSigningRequestMail.mockResolvedValue({ emailSent: false })
    const failed = await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'], recipientEmail: 'anna@example.se' })
    expect(failed.ok && !failed.dryRun && failed.data.email_sent).toBe(false)
    expect(failed.ok && !failed.dryRun && failed.data.url).toContain('/betala/')
  })

  it('covers approved orders only', async () => {
    db.setTable('payment_orders', { data: [order('o1'), order('o2', { status: 'submitted' })] })
    const result = await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })
    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { orders: [{ id: 'o2', status: 'submitted' }] } })
    db.setTable('payment_orders', { data: [order('o1'), order('o2', { status: 'draft' })] })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
    expect(inserted()).toEqual([])
  })

  it('covers one account in one currency', async () => {
    db.setTable('payment_orders', { data: [order('o1'), order('o2', { cash_account_id: 'acct-2' })] })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_MIXED_ACCOUNTS' })
    db.setTable('payment_orders', { data: [order('o1'), order('o2', { currency: 'EUR' })] })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_MIXED_CURRENCY' })
    expect(inserted()).toEqual([])
  })

  it('answers PAYMENT_ORDER_NOT_FOUND for an order that is not the company\'s', async () => {
    db.setTable('payment_orders', { data: [order('o1')] })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' })
  })

  it('lets owners, admins and the person who prepared every order send it; nobody else', async () => {
    db.setTable('payment_signing_links', [{ data: [] }, { data: { id: LINK_ID } }])
    db.setTable('company_members', { data: { role: 'admin' } })
    expect((await issuePaymentSigningLink({ ...ctx, userId: OTHER_USER }, { orderIds: ['o1', 'o2'] })).ok).toBe(true)

    db.setTable('company_members', { data: { role: 'member' } })
    const member = await issuePaymentSigningLink({ ...ctx, userId: OTHER_USER }, { orderIds: ['o1', 'o2'] })
    expect(member).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    db.setTable('payment_signing_links', [{ data: [] }, { data: { id: LINK_ID } }])
    expect((await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).ok).toBe(true) // the member prepared both

    db.setTable('payment_orders', { data: [order('o1'), order('o2', { user_id: OTHER_USER })] })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    db.setTable('payment_orders', { data: [order('o1'), order('o2')] })
    db.setTable('company_members', { data: { role: 'viewer' } })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    db.setTable('company_members', { data: null })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('refuses orders another open link already covers', async () => {
    db.setTable('payment_signing_links', { data: [{ id: LINK_ID }] })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_LINK_ALREADY_OPEN', details: { signing_link_ids: [LINK_ID] } })
    expect(db.findCall('payment_signing_links', 'overlaps')).toEqual(['order_ids', ['o1', 'o2']])
    expect(inserted()).toEqual([])
  })

  it('refuses when the company cannot pay through the bank, an empty selection and a long note', async () => {
    door.openPaymentsDoor.mockResolvedValue({ ok: false, reason: 'subscription' })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1'] })).toMatchObject({ ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'subscription' } })
    door.openPaymentsDoor.mockResolvedValue({ ok: true, provider: {} })
    expect(await issuePaymentSigningLink(ctx, { orderIds: [] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' })
    expect(await issuePaymentSigningLink(ctx, { orderIds: ['o1'], note: 'x'.repeat(501) })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(inserted()).toEqual([])
  })
})

describe('previewPaymentSigningLink', () => {
  it('runs every rule and mints nothing: no row, no mail, no url', async () => {
    const preview = await previewPaymentSigningLink(ctx, { orderIds: ['o1', 'o2'], recipientEmail: 'anna@example.se' })
    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { payment_order_ids: ['o1', 'o2'], order_count: 2, total_amount: 1475, currency: 'SEK', recipient_email: 'anna@example.se', email_will_be_sent: true, valid_hours: 72, url: null },
    })
    expect(inserted()).toEqual([])
    expect(mail.sendPaymentSigningRequestMail).not.toHaveBeenCalled()
    db.setTable('payment_orders', { data: [order('o1', { status: 'cancelled' }), order('o2')] })
    expect(await previewPaymentSigningLink(ctx, { orderIds: ['o1', 'o2'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
  })
})

describe('resolvePaymentSigningLink', () => {
  const token = 'A'.repeat(43)

  it('refuses a malformed token without reading, and looks a token up by its hash', async () => {
    expect(await resolvePaymentSigningLink(db.supabase as never, 'short')).toEqual({ ok: false, reason: 'invalid_format' })
    expect(db.supabase.from).not.toHaveBeenCalled()
    db.setTable('payment_signing_links', { data: null })
    expect(await resolvePaymentSigningLink(db.supabase as never, token)).toEqual({ ok: false, reason: 'not_found' })
    expect(db.findCall('payment_signing_links', 'eq')).toEqual(['token_hash', hashInviteToken(token)])
    expect(db.findCall('payment_signing_links', 'select')?.[0]).not.toContain('token_hash')
  })

  it('refuses an expired and a cancelled link', async () => {
    db.setTable('payment_signing_links', { data: linkRow({ expires_at: new Date(Date.now() - 1000).toISOString() }) })
    expect(await resolvePaymentSigningLink(db.supabase as never, token)).toEqual({ ok: false, reason: 'expired' })
    db.setTable('payment_signing_links', { data: linkRow({ cancelled_at: new Date().toISOString() }) })
    expect(await resolvePaymentSigningLink(db.supabase as never, token, { allowConsumedWithinMs: HOUR })).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('answers a consumed link only within the grace window asked for', async () => {
    db.setTable('payment_signing_links', { data: linkRow({ consumed_at: new Date(Date.now() - 60_000).toISOString() }) })
    expect(await resolvePaymentSigningLink(db.supabase as never, token)).toEqual({ ok: false, reason: 'consumed' })
    expect((await resolvePaymentSigningLink(db.supabase as never, token, { allowConsumedWithinMs: HOUR })).ok).toBe(true)
    db.setTable('payment_signing_links', { data: linkRow({ consumed_at: new Date(Date.now() - 2 * HOUR).toISOString() }) })
    expect(await resolvePaymentSigningLink(db.supabase as never, token, { allowConsumedWithinMs: HOUR })).toEqual({ ok: false, reason: 'consumed' })
  })
})

describe('linkState', () => {
  const link = { order_ids: ['o1', 'o2'], batch_id: null, consumed_at: null }

  it('is ready while every order is approved', () => {
    expect(linkState(link, [order('o1'), order('o2')], null)).toBe('ready')
  })

  it('is changed when an order was cancelled, un-approved, signed elsewhere or is gone', () => {
    expect(linkState(link, [order('o1'), order('o2', { status: 'cancelled' })], null)).toBe('changed')
    expect(linkState(link, [order('o1'), order('o2', { status: 'draft' })], null)).toBe('changed')
    expect(linkState(link, [order('o1', { status: 'awaiting_signature', batch_id: 'b-dashboard' }), order('o2', { status: 'awaiting_signature', batch_id: 'b-dashboard' })], null)).toBe('changed')
    expect(linkState({ ...link, batch_id: 'b-link' }, [order('o1', { status: 'accepted', batch_id: 'b-dashboard' }), order('o2', { status: 'accepted', batch_id: 'b-dashboard' })], null)).toBe('changed')
    expect(linkState(link, [order('o1')], null)).toBe('changed')
  })

  it('is in_signing while the link\'s own signing holds every order unsigned, and done once it is past', () => {
    const own = { ...link, batch_id: 'b-link' }
    const waiting = [order('o1', { status: 'submitted', batch_id: 'b-link' }), order('o2', { status: 'submitted', batch_id: 'b-link' })]
    expect(linkState(own, waiting, { id: 'b-link', status: 'created' })).toBe('in_signing')
    expect(linkState(own, waiting, { id: 'b-link', status: 'awaiting_signature' })).toBe('in_signing')
    expect(linkState(own, waiting, { id: 'b-link', status: 'failed' })).toBe('changed')
    expect(linkState(own, [order('o1', { status: 'accepted', batch_id: 'b-link' }), order('o2', { status: 'executed', batch_id: 'b-link' })], null)).toBe('done')
    expect(linkState({ ...own, consumed_at: new Date().toISOString() }, waiting, null)).toBe('done')
  })
})

describe('signingBelongsToLink', () => {
  it('admits the link\'s own signing, or one holding only the link\'s orders; never another', async () => {
    expect(await signingBelongsToLink(db.supabase as never, linkRow({ batch_id: 'b-link' }), 'b-link')).toBe(true)
    db.setTable('payment_orders', { data: [{ id: 'o1' }, { id: 'o2' }] })
    expect(await signingBelongsToLink(db.supabase as never, linkRow({ batch_id: 'b-link' }), 'b-new')).toBe(true)
    db.setTable('payment_orders', { data: [{ id: 'o1' }, { id: 'o9' }] })
    expect(await signingBelongsToLink(db.supabase as never, linkRow(), 'b-other')).toBe(false)
    db.setTable('payment_orders', { data: [] })
    expect(await signingBelongsToLink(db.supabase as never, linkRow(), 'b-unknown')).toBe(false)
  })
})

describe('cancelPaymentSigningLink', () => {
  it('lets the sender cancel an open link, and answers the same twice', async () => {
    db.setTable('payment_signing_links', [{ data: linkRow() }, { data: [{ id: LINK_ID }] }])
    expect(await cancelPaymentSigningLink(ctx, { signingLinkId: LINK_ID })).toEqual({ ok: true, data: { signing_link_id: LINK_ID, cancelled: true } })
    expect(db.payloads('payment_signing_links', 'update')).toEqual([expect.objectContaining({ cancelled_at: expect.any(String) })])
    db.setTable('payment_signing_links', { data: linkRow({ cancelled_at: new Date().toISOString() }) })
    expect((await cancelPaymentSigningLink(ctx, { signingLinkId: LINK_ID })).ok).toBe(true)
  })

  it('refuses a member who did not send it, an unknown link and a consumed one', async () => {
    db.setTable('company_members', { data: { role: 'member' } })
    db.setTable('payment_signing_links', { data: linkRow() })
    expect(await cancelPaymentSigningLink({ ...ctx, userId: OTHER_USER }, { signingLinkId: LINK_ID })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    db.setTable('payment_signing_links', { data: null })
    expect(await cancelPaymentSigningLink(ctx, { signingLinkId: LINK_ID })).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_FOUND' })
    db.setTable('payment_signing_links', { data: linkRow({ consumed_at: new Date().toISOString() }) })
    expect(await cancelPaymentSigningLink(ctx, { signingLinkId: LINK_ID })).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_OPEN' })
  })
})

describe('listOpenPaymentSigningLinks and consumePaymentSigningLink', () => {
  it('lists the open links without their token, and consumes a link once', async () => {
    db.setTable('payment_signing_links', { data: [{ ...linkRow(), mail_sent_at: '2026-10-14T09:00:00Z' }] })
    const open = await listOpenPaymentSigningLinks(ctx)
    expect(open).toEqual([expect.objectContaining({ signing_link_id: LINK_ID, recipient_email: 'anna@example.se', payment_order_ids: ['o1', 'o2'], email_sent: true })])
    expect(db.findCall('payment_signing_links', 'select')?.[0]).not.toContain('token_hash')
    db.setTable('payment_signing_links', { data: null })
    await consumePaymentSigningLink(db.supabase as never, LINK_ID)
    expect(db.findCalls('payment_signing_links', 'is')).toEqual(expect.arrayContaining([['consumed_at', null], ['cancelled_at', null]]))
  })
})

describe('describePaymentSigningLink', () => {
  it('answers the basket the page shows: who asked, each payment, the account paying (masked), the total and the state', async () => {
    db.setTable('payment_orders', {
      data: [
        order('o1', { debtor_snapshot: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Företagskonto', currency: 'SEK', bank_name: 'SEB' } }),
        order('o2', { payee_type: 'bank_account', payee_bankgiro: null, payee_clearing: '3300', payee_account: '1234567', reference_type: 'message', reference: 'F-1001' }),
      ],
    })
    db.setTable('companies', { data: { name: 'Bolaget AB', team_id: 'team-1' } })
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: 'Byrån AB' } } })
    const page = await describePaymentSigningLink(db.supabase as never, linkRow())
    expect(page).toMatchObject({
      state: 'ready',
      company_name: 'Bolaget AB',
      requester: 'Byrån AB',
      note: 'Oktober',
      bank_name: 'SEB',
      account: { name: 'Företagskonto', iban: 'SE35 **** 0003' },
      order_count: 2,
      total_amount: 1475,
      currency: 'SEK',
      signing: null,
    })
    expect(page.orders).toEqual([
      expect.objectContaining({ payment_order_id: 'o1', payee_name: 'Derome Bygg AB', payee_label: 'BG 5050-1055', amount: 737.5, reference_type: 'ocr', reference: '4400112233', status: 'approved' }),
      expect.objectContaining({ payment_order_id: 'o2', payee_label: '3300 1234567', reference_type: 'message', reference: 'F-1001' }),
    ])
    expect(JSON.stringify(page)).not.toContain('SE3550000000054910000003')
  })

  it('names the sender by name without a byrå, and reads the link\'s signing', async () => {
    db.setTable('payment_orders', { data: [order('o1', { status: 'submitted', batch_id: 'b-link' }), order('o2', { status: 'submitted', batch_id: 'b-link' })] })
    db.setTable('payment_order_batches', { data: { id: 'b-link', status: 'created' } })
    const page = await describePaymentSigningLink(db.supabase as never, linkRow({ batch_id: 'b-link' }))
    expect(page).toMatchObject({ requester: 'Karin Byråsson', state: 'in_signing', signing: { batch_id: 'b-link', status: 'created' } })
  })
})
