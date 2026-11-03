import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const mail = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))
const countMock = vi.hoisted(() => vi.fn())
vi.mock('../counters', () => ({ countCompanyUsage: (...args: unknown[]) => countMock(...args) }))

import { requestMoreUsage } from '../requests'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-11-14T10:00:00.000Z')
const PAYING = {
  company_subscriptions: { data: { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' } },
  company_settings: { data: { is_sandbox: false } },
}

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
}

function actor() {
  return { companyId: COMPANY, userId: USER, email: 'anna@bygg.se', log: log() }
}

beforeEach(() => {
  vi.clearAllMocks()
  mail.isConfigured.mockReturnValue(true)
  mail.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  countMock.mockResolvedValue(3)
})

describe('requestMoreUsage', () => {
  it('stores the request and mails support with the company, the month, the price, who pays and how to open it', async () => {
    const db = createTableMockSupabase({
      usage_requests: [{ data: [] }, { data: { id: 'r-1', created_at: NOW.toISOString() } }],
      companies: { data: { name: 'Bygg AB', org_number: '556677-8899' } },
      ...PAYING,
    })
    const result = await requestMoreUsage(db.supabase as unknown as SupabaseClient, actor(), { kind: 'signing', message: 'Vi signerar <många> avtal' }, NOW)
    expect(result).toEqual({ ok: true, created: true, data: { request_id: 'r-1', created_at: NOW.toISOString() } })
    expect(db.payloads('usage_requests', 'insert')).toEqual([{ company_id: COMPANY, kind: 'signing', requested_by: USER, message: 'Vi signerar <många> avtal' }])
    // Only an open request for the same kind younger than a day stops a new one.
    expect(db.findCall('usage_requests', 'is')).toEqual(['handled_at', null])
    expect(db.findCall('usage_requests', 'gte')).toEqual(['created_at', '2026-11-13T10:00:00.000Z'])
    const sent = mail.sendEmail.mock.calls[0]![0] as { subject: string; text: string; html: string; replyTo?: string }
    expect(sent.replyTo).toBe('anna@bygg.se')
    expect(sent.subject).toContain('Bygg AB')
    for (const part of ['Bygg AB', '556677-8899', 'anna@bygg.se', 'Signerade dokument med BankID', '3 av 3 som ingår', '10,00 kr', 'eget abonnemang']) {
      expect(sent.text).toContain(part)
    }
    expect(sent.text).toContain(`('${COMPANY}', 'signing', 1000, 3,`)
    expect(sent.html).toContain('&lt;många&gt;')
    expect(sent.html).not.toContain('<många>')
  })

  it('names the byrå that pays for a byrå client', async () => {
    const db = createTableMockSupabase({
      usage_requests: [{ data: [] }, { data: { id: 'r-2', created_at: NOW.toISOString() } }],
      companies: { data: { name: 'Klient AB', org_number: '556600-0000', team_id: 'team-1' } },
      company_subscriptions: { data: null },
      company_settings: { data: { is_sandbox: false } },
      teams: { data: { name: 'Byrån AB', kind: 'byra' } },
      capability_grants: { data: [{ expires_at: null }] },
    })
    await requestMoreUsage(db.supabase as unknown as SupabaseClient, actor(), { kind: 'bank_account', message: null }, NOW)
    expect((mail.sendEmail.mock.calls[0]![0] as { text: string }).text).toContain('byrån Byrån AB, faktureras för hand')
  })

  it('refuses a second request for the kind while one is unanswered, and sends nothing', async () => {
    const db = createTableMockSupabase({ usage_requests: { data: [{ id: 'r-0', created_at: '2026-11-14T08:00:00.000Z' }] } })
    const result = await requestMoreUsage(db.supabase as unknown as SupabaseClient, actor(), { kind: 'peppol_send', message: null }, NOW)
    expect(result).toEqual({ ok: false, code: 'USAGE_REQUEST_OPEN', details: { requested_at: '2026-11-14T08:00:00.000Z' } })
    expect(db.findCalls('usage_requests', 'eq')).toContainEqual(['kind', 'peppol_send'])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('removes the row again when the mail cannot be sent, so the person can ask later', async () => {
    mail.sendEmail.mockResolvedValue({ success: false, error: 'smtp down' })
    const db = createTableMockSupabase({
      usage_requests: [{ data: [] }, { data: { id: 'r-3', created_at: NOW.toISOString() } }, { data: null }],
      companies: { data: { name: 'Bygg AB', org_number: null } },
      ...PAYING,
    })
    const result = await requestMoreUsage(db.supabase as unknown as SupabaseClient, actor(), { kind: 'kivra_send', message: null }, NOW)
    expect(result).toEqual({ ok: false, code: 'USAGE_REQUEST_NOT_SENT' })
    expect(db.findCall('usage_requests', 'delete')).toBeDefined()
  })

  it('stores nothing without a mail service', async () => {
    mail.isConfigured.mockReturnValue(false)
    const db = createTableMockSupabase({ usage_requests: { data: [] } })
    const result = await requestMoreUsage(db.supabase as unknown as SupabaseClient, actor(), { kind: 'signing', message: null }, NOW)
    expect(result).toEqual({ ok: false, code: 'USAGE_REQUEST_NOT_SENT' })
    expect(db.payloads('usage_requests', 'insert')).toEqual([])
  })
})
