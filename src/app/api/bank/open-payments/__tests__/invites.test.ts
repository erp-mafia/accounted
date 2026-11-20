import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const db = createTableMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(db.supabase),
  createServiceClient: () => db.supabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    ...actual,
    requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
  }
})
const door = vi.hoisted(() => ({ openBankFeedDoor: vi.fn() }))
vi.mock('@/lib/bank-feed/door', () => door)
vi.mock('@/lib/email/brand-sender', () => ({
  getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se'),
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
}))
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), isConfigured: vi.fn().mockReturnValue(true) }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))

import { POST } from '../invites/route'

const ID = '11111111-1111-4111-8111-111111111111'
const INVITE_ID = '22222222-2222-4222-8222-222222222222'
const none = { params: Promise.resolve({}) }
const post = (body?: unknown) => createMockRequest('/api/bank/open-payments/invites', { method: 'POST', ...(body === undefined ? {} : { body }) })

type ErrorBody = { error: { code: string; message: string } }
type Data = { data: { url: string; expires_at: string; email_sent: boolean; invite_id: string } }

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  db.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'byra@example.se' } } })
  isAdminMock.mockResolvedValue(true)
  door.openBankFeedDoor.mockResolvedValue({ ok: true, connect: {} })
  mail.isConfigured.mockReturnValue(true)
  mail.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  db.setTable('bank_connect_invites', { data: { id: INVITE_ID } })
  db.setTable('companies', { data: { name: 'Bolaget AB', team_id: null } })
  db.setTable('bank_connections', { data: { id: ID, status: 'active', bank_name: 'Swedbank', bic: 'SWEDSESS', aggregator: 'enable_banking' } })
})

describe('POST /api/bank/open-payments/invites', () => {
  it('answers 401 without a session', async () => {
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(post({ offer_payments: true }), none)).status).toBe(401)
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('answers 403 for a member who is neither owner nor admin', async () => {
    isAdminMock.mockResolvedValue(false)
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ offer_payments: true }), none))
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('answers 403 OPEN_BANKING_NOT_AVAILABLE when the company is not switched on, before anything is stored', async () => {
    door.openBankFeedDoor.mockResolvedValue({ ok: false, reason: 'not_in_pilot' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ offer_payments: true }), none))
    expect(status).toBe(403)
    expect(body.error.code).toBe('OPEN_BANKING_NOT_AVAILABLE')
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('answers 400 for a malformed body', async () => {
    expect((await POST(post({ offer_payments: 'yes' }), none)).status).toBe(400)
    expect((await POST(post({ bic: 'swedbank' }), none)).status).toBe(400)
    expect((await POST(post({ recipient_email: 'not-an-address' }), none)).status).toBe(400)
    expect((await POST(post({ replace_connection_id: 'nope' }), none)).status).toBe(400)
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('creates the link and answers its URL without mailing when no recipient is given', async () => {
    const { status, body } = await parseJsonResponse<Data>(await POST(post({ offer_payments: true, bic: 'SWEDSESS' }), none))
    expect(status).toBe(200)
    expect(body.data.url).toMatch(/^https:\/\/app\.accounted\.se\/koppla\/[A-Za-z0-9_-]{43}$/)
    expect(body.data.email_sent).toBe(false)
    expect(body.data.invite_id).toBe(INVITE_ID)
    expect(new Date(body.data.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
    const inserted = db.payloads('bank_connect_invites', 'insert')[0] as Record<string, unknown>
    expect(inserted).toMatchObject({ company_id: 'company-1', created_by: 'user-1', bic: 'SWEDSESS', offer_payments: true, recipient_email: null })
    expect(inserted.token_hash).toMatch(/^[0-9a-f]{64}$/)
    // The clear token is in the URL and nowhere in the row.
    expect(JSON.stringify(inserted)).not.toContain(body.data.url.split('/koppla/')[1])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('mails the link to the recipient, logs the send on the row and still answers the URL', async () => {
    const { status, body } = await parseJsonResponse<Data>(
      await POST(post({ offer_payments: true, recipient_email: 'Anna@Example.se', replace_connection_id: ID, bank_name: 'Swedbank' }), none),
    )
    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(true)
    expect(mail.sendEmail).toHaveBeenCalledTimes(1)
    const sent = mail.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string }
    expect(sent.to).toBe('Anna@Example.se')
    expect(sent.subject).toBe('Koppla banken för Bolaget AB med BankID')
    expect(sent.text).toContain(body.data.url)
    expect(sent.text).toContain('hos Swedbank')
    expect(sent.text).toContain('giltig i 7 dagar')
    expect(sent.html).toContain('Bolaget AB')
    const inserted = db.payloads('bank_connect_invites', 'insert')[0] as Record<string, unknown>
    expect(inserted.recipient_email).toBe('anna@example.se')
    expect(inserted.replace_connection_id).toBe(ID)
    const updates = db.payloads('bank_connect_invites', 'update') as Array<Record<string, unknown>>
    expect(updates.some((u) => typeof u.mail_sent_at === 'string')).toBe(true)
  })

  it('answers email_sent false, link intact, when the mail service refuses', async () => {
    mail.sendEmail.mockResolvedValue({ success: false, error: 'provider down' })
    const { status, body } = await parseJsonResponse<Data>(await POST(post({ offer_payments: false, recipient_email: 'anna@example.se' }), none))
    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(false)
    expect(body.data.url).toContain('/koppla/')
    expect(db.payloads('bank_connect_invites', 'update')).toEqual([])
  })

  it('answers 404 when the connection to replace is not the company\'s', async () => {
    db.setTable('bank_connections', { data: null })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ offer_payments: true, replace_connection_id: ID }), none))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })
})
