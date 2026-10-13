import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/email/brand-sender', () => ({
  getBaseUrlForCompany: vi.fn().mockResolvedValue('https://byra.example.se/'),
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.supabase }))

const db = createTableMockSupabase()

import {
  BANK_CONNECT_INVITE_TTL_DAYS,
  CONSUMED_INVITE_GRACE_MS,
  createSignatoryLink,
  describeInvite,
  generateInviteToken,
  hashInviteToken,
  isValidInviteTokenFormat,
  resolveInviteToken,
  signatoryLinkUrl,
} from '../invites'

const COMPANY = '33333333-3333-4333-8333-333333333333'
const SENDER = '44444444-4444-4444-8444-444444444444'
const ID = '11111111-1111-4111-8111-111111111111'
const DAY = 24 * 60 * 60 * 1000
const service = db.supabase as unknown as SupabaseClient

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    company_id: COMPANY,
    created_by: SENDER,
    bic: null,
    replace_connection_id: null,
    offer_payments: false,
    recipient_email: null,
    mail_sent_at: null,
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    consumed_at: null,
    connection_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
})

describe('the signatory token', () => {
  it('is 32 random bytes as 43 base64url characters, stored as its sha256', () => {
    const { token, hash } = generateInviteToken()
    expect(isValidInviteTokenFormat(token)).toBe(true)
    expect(hash).toBe(hashInviteToken(token))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(generateInviteToken().token).not.toBe(token)
  })

  it('refuses anything but the 43-character shape', () => {
    expect(isValidInviteTokenFormat('')).toBe(false)
    expect(isValidInviteTokenFormat('a'.repeat(42))).toBe(false)
    expect(isValidInviteTokenFormat('a'.repeat(44))).toBe(false)
    expect(isValidInviteTokenFormat(`${'a'.repeat(42)}/`)).toBe(false)
  })

  it('builds the URL under /koppla on the company\'s base', () => {
    expect(signatoryLinkUrl('https://app.accounted.se', 'tok')).toBe('https://app.accounted.se/koppla/tok')
    expect(signatoryLinkUrl('https://byra.example.se/', 'tok')).toBe('https://byra.example.se/koppla/tok')
  })
})

describe('createSignatoryLink', () => {
  it('stores the hash, never the token, with a 7-day expiry, and answers the brand URL', async () => {
    db.setTable('bank_connect_invites', { data: { id: 'inv-1' } })
    const now = Date.UTC(2026, 9, 12, 9, 0, 0)
    const outcome = await createSignatoryLink({ companyId: COMPANY, createdBy: SENDER, bic: 'swedsess', offerPayments: true, recipientEmail: ' Anna@Example.se ', supabase: service, now })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a link')
    expect(outcome.data.url).toBe(`https://byra.example.se/koppla/${outcome.data.token}`)
    expect(outcome.data.expires_at).toBe(new Date(now + BANK_CONNECT_INVITE_TTL_DAYS * DAY).toISOString())
    const inserted = db.payloads('bank_connect_invites', 'insert')[0] as Record<string, unknown>
    expect(inserted).toMatchObject({ company_id: COMPANY, created_by: SENDER, bic: 'SWEDSESS', offer_payments: true, recipient_email: 'anna@example.se', replace_connection_id: null })
    expect(inserted.token_hash).toBe(hashInviteToken(outcome.data.token))
    expect(JSON.stringify(inserted)).not.toContain(outcome.data.token)
  })

  it('refuses a connection to replace that is not the company\'s, or is revoked', async () => {
    db.setTable('bank_connections', { data: null })
    const missing = await createSignatoryLink({ companyId: COMPANY, createdBy: SENDER, replaceConnectionId: ID, offerPayments: false, supabase: service })
    expect(missing).toEqual({ ok: false, code: 'NOT_FOUND', details: { field: 'replace_connection_id' } })
    db.setTable('bank_connections', { data: { id: ID, status: 'revoked' } })
    const revoked = await createSignatoryLink({ companyId: COMPANY, createdBy: SENDER, replaceConnectionId: ID, offerPayments: false, supabase: service })
    expect(revoked.ok).toBe(false)
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('answers INTERNAL_ERROR when the row is not stored', async () => {
    db.setTable('bank_connect_invites', { data: null, error: { message: 'boom' } })
    const outcome = await createSignatoryLink({ companyId: COMPANY, createdBy: SENDER, offerPayments: false, supabase: service })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.code).toBe('INTERNAL_ERROR')
  })
})

describe('resolveInviteToken', () => {
  const token = 'b'.repeat(43)

  it('refuses a malformed token without a read', async () => {
    expect(await resolveInviteToken(service, 'short')).toEqual({ ok: false, reason: 'invalid_format' })
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('looks the row up by hash and answers it while it is live', async () => {
    db.setTable('bank_connect_invites', { data: row() })
    const resolved = await resolveInviteToken(service, token)
    expect(resolved.ok).toBe(true)
    expect(db.findCall('bank_connect_invites', 'eq')).toEqual(['token_hash', hashInviteToken(token)])
  })

  it('answers not_found, expired and consumed', async () => {
    db.setTable('bank_connect_invites', { data: null })
    expect(await resolveInviteToken(service, token)).toEqual({ ok: false, reason: 'not_found' })
    db.setTable('bank_connect_invites', { data: row({ expires_at: new Date(Date.now() - 1).toISOString() }) })
    expect(await resolveInviteToken(service, token)).toEqual({ ok: false, reason: 'expired' })
    db.setTable('bank_connect_invites', { data: row({ consumed_at: new Date().toISOString() }) })
    expect(await resolveInviteToken(service, token)).toEqual({ ok: false, reason: 'consumed' })
  })

  it('keeps a consumed link open for the follow-up calls inside the grace window only', async () => {
    const now = Date.now()
    db.setTable('bank_connect_invites', { data: row({ consumed_at: new Date(now - CONSUMED_INVITE_GRACE_MS + 60_000).toISOString() }) })
    expect((await resolveInviteToken(service, token, { allowConsumedWithinMs: CONSUMED_INVITE_GRACE_MS, now })).ok).toBe(true)
    db.setTable('bank_connect_invites', { data: row({ consumed_at: new Date(now - CONSUMED_INVITE_GRACE_MS - 1).toISOString() }) })
    expect(await resolveInviteToken(service, token, { allowConsumedWithinMs: CONSUMED_INVITE_GRACE_MS, now })).toEqual({ ok: false, reason: 'consumed' })
  })
})

describe('describeInvite', () => {
  it('names the company, the byrå when the sender acts through its team, and the connection being replaced', async () => {
    db.setTable('companies', { data: { name: 'Bolaget AB', team_id: 'team-1' } })
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: 'Byrån AB' } } })
    db.setTable('bank_connections', { data: { id: ID, bank_name: 'Swedbank', bic: 'SWEDSESS', aggregator: 'enable_banking', status: 'active' } })
    const described = await describeInvite(service, { company_id: COMPANY, created_by: SENDER, replace_connection_id: ID })
    expect(described).toEqual({
      companyName: 'Bolaget AB',
      requester: 'Byrån AB',
      replaced: { connection_id: ID, bank_name: 'Swedbank', bic: 'SWEDSESS', kind: 'switch' },
    })
  })

  it('falls back to the company\'s own name, and calls an Open Payments replacement a renewal', async () => {
    db.setTable('companies', { data: { name: 'Bolaget AB', team_id: null } })
    db.setTable('bank_connections', { data: { id: ID, bank_name: 'Nordea', bic: 'NDEASESS', aggregator: 'open_payments', status: 'active' } })
    const described = await describeInvite(service, { company_id: COMPANY, created_by: SENDER, replace_connection_id: ID })
    expect(described.requester).toBe('Bolaget AB')
    expect(described.replaced?.kind).toBe('renew')
    expect(db.supabase.from).not.toHaveBeenCalledWith('team_members')
  })
})
