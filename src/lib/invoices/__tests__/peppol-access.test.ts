import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  checkPeppolSendPermission,
  countPeppolSends,
  peppolConnectionState,
  peppolReceivingOn,
  peppolSendPeriodStart,
  requestPeppolAccess,
  setPeppolAccess,
  summarizePeppolAccess,
  type PeppolAccessRow,
} from '@/lib/invoices/peppol-access'

const { supabase: mockService, enqueue, reset, calls } = createQueuedMockSupabase()
const service = mockService as unknown as SupabaseClient

function row(overrides: Partial<PeppolAccessRow> = {}): PeppolAccessRow {
  return {
    company_id: 'company-1',
    status: 'enabled',
    max_sends: 50,
    receive_enabled: false,
    requested_at: '2026-08-21T15:00:00.000Z',
    requested_by: 'user-1',
    request_note: null,
    enabled_at: '2026-08-21T16:00:00.000Z',
    enabled_by: 'jakob',
    disabled_at: null,
    note: null,
    created_at: '2026-08-21T15:00:00.000Z',
    updated_at: '2026-08-21T16:00:00.000Z',
    ...overrides,
  }
}

describe('summarizePeppolAccess', () => {
  it('is locked without a row and reports sends only when enabled', () => {
    expect(summarizePeppolAccess(null, 0)).toMatchObject({ status: 'none', send_enabled: false, receive_enabled: false, remaining_sends: null })
    expect(summarizePeppolAccess(row({ status: 'requested' }), 0)).toMatchObject({ status: 'requested', send_enabled: false })
    expect(summarizePeppolAccess(row(), 12)).toMatchObject({ send_enabled: true, max_sends: 50, sent_count: 12, remaining_sends: 38 })
    expect(summarizePeppolAccess(row({ max_sends: null }), 12)).toMatchObject({ max_sends: null, remaining_sends: null })
    expect(summarizePeppolAccess(row({ receive_enabled: true }), 0).receive_enabled).toBe(true)
    expect(summarizePeppolAccess(row({ status: 'disabled', receive_enabled: true, disabled_at: 'x' }), 0).receive_enabled).toBe(false)
  })
})

describe('checkPeppolSendPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('refuses a company without a grant before counting anything', async () => {
    enqueue({ data: null, error: null })
    const result = await checkPeppolSendPermission({ service, companyId: 'company-1' })
    expect(result).toMatchObject({ ok: false, code: 'PEPPOL_ACCESS_REQUIRED' })
    expect(calls.filter((c) => c.table === 'peppol_deliveries')).toHaveLength(0)
  })

  it('refuses a requested or disabled company', async () => {
    enqueue({ data: row({ status: 'requested', enabled_at: null }), error: null })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toMatchObject({ ok: false, code: 'PEPPOL_ACCESS_REQUIRED' })
    enqueue({ data: row({ status: 'disabled', disabled_at: 'x' }), error: null })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toMatchObject({ ok: false, code: 'PEPPOL_ACCESS_REQUIRED' })
  })

  it('allows an enabled company under its cap and refuses at the cap', async () => {
    enqueue({ data: row({ max_sends: 3 }), error: null })
    enqueue({ data: null, error: null, count: 2 })
    enqueue({ data: null, error: null, count: 0 })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toEqual({ ok: true, remaining: 1 })

    enqueue({ data: row({ max_sends: 3 }), error: null })
    enqueue({ data: null, error: null, count: 2 })
    enqueue({ data: null, error: null, count: 1 })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toMatchObject({ ok: false, code: 'PEPPOL_SEND_LIMIT_REACHED' })
  })

  it('treats a null cap as unlimited', async () => {
    enqueue({ data: row({ max_sends: null }), error: null })
    enqueue({ data: null, error: null, count: 999 })
    enqueue({ data: null, error: null, count: 0 })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toEqual({ ok: true, remaining: null })
  })
})

describe('peppolSendPeriodStart', () => {
  it('starts the period at midnight on the 1st in Stockholm, summer and winter time', () => {
    expect(peppolSendPeriodStart(new Date('2026-10-18T10:00:00Z'))).toBe('2026-09-30T22:00:00.000Z')
    expect(peppolSendPeriodStart(new Date('2026-11-18T10:00:00Z'))).toBe('2026-10-31T23:00:00.000Z')
  })

  it('follows the Stockholm calendar near midnight on the 1st', () => {
    // 23:30Z on 31 October is already 00:30 on 1 November in Stockholm.
    expect(peppolSendPeriodStart(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10-31T23:00:00.000Z')
    // 22:30Z on 31 October is still October in Stockholm.
    expect(peppolSendPeriodStart(new Date('2026-10-31T22:30:00Z'))).toBe('2026-09-30T22:00:00.000Z')
  })
})

describe('countPeppolSends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('counts transmissions submitted this calendar month, plus unstamped ones created this month', async () => {
    enqueue({ data: null, error: null, count: 4 })
    enqueue({ data: null, error: null, count: 1 })
    const count = await countPeppolSends(service, 'company-1', new Date('2026-10-18T10:00:00Z'))
    expect(count).toBe(5)
    const query = calls.filter((c) => c.table === 'peppol_deliveries')
    expect(query.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([['company_id', 'company-1'], ['company_id', 'company-1']])
    expect(query.filter((c) => c.method === 'not').map((c) => c.args)).toEqual([['provider_submission_id', 'is', null], ['provider_submission_id', 'is', null]])
    expect(query.filter((c) => c.method === 'gte').map((c) => c.args)).toEqual([
      ['submitted_at', '2026-09-30T22:00:00.000Z'],
      ['created_at', '2026-09-30T22:00:00.000Z'],
    ])
    expect(query.find((c) => c.method === 'is')?.args).toEqual(['submitted_at', null])
  })

  it('throws when either count fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(countPeppolSends(service, 'company-1')).rejects.toThrow('boom')
  })

  it('names the code or HTTP status when a refused count carries no message (crm#1641)', async () => {
    // A count is a HEAD request: a refusal has no body, so PostgREST's message is empty.
    enqueue({ data: null, error: { message: '', code: '42501' } })
    await expect(countPeppolSends(service, 'company-1')).rejects.toThrow('Failed to count Peppol sends: 42501')
    reset()
    enqueue({ data: null, error: { message: '', code: '' } })
    await expect(countPeppolSends(service, 'company-1')).rejects.toThrow(/^Failed to count Peppol sends: HTTP \S+$/)
  })
})

describe('requestPeppolAccess / setPeppolAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('creates a request, is idempotent on a second ask, and refuses when already enabled', async () => {
    enqueue({ data: null, error: null })
    enqueue({ data: row({ status: 'requested', enabled_at: null }), error: null })
    const first = await requestPeppolAccess({ service, companyId: 'company-1', userId: 'user-1', note: 'offentlig sektor' })
    expect(first).toMatchObject({ ok: true, created: true })
    const upsert = calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(upsert).toMatchObject({ company_id: 'company-1', status: 'requested', requested_by: 'user-1', request_note: 'offentlig sektor' })

    enqueue({ data: row({ status: 'requested', enabled_at: null }), error: null })
    expect(await requestPeppolAccess({ service, companyId: 'company-1', userId: 'user-1', note: null })).toMatchObject({ ok: true, created: false })

    enqueue({ data: row(), error: null })
    expect(await requestPeppolAccess({ service, companyId: 'company-1', userId: 'user-1', note: null })).toEqual({ ok: false, code: 'PEPPOL_ACCESS_ALREADY_ENABLED' })
  })

  it('grants with a cap and receiving flag, and disables without touching the cap', async () => {
    enqueue({ data: row({ max_sends: 25, receive_enabled: true }), error: null })
    await setPeppolAccess({ service, companyId: 'company-1', status: 'enabled', maxSends: 25, receiveEnabled: true, by: 'jakob' })
    const granted = calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(granted).toMatchObject({ status: 'enabled', max_sends: 25, receive_enabled: true, enabled_by: 'jakob', disabled_at: null })
    expect(typeof granted.enabled_at).toBe('string')

    reset()
    enqueue({ data: row({ status: 'disabled', disabled_at: 'x' }), error: null })
    await setPeppolAccess({ service, companyId: 'company-1', status: 'disabled', by: 'jakob' })
    const disabled = calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(disabled.status).toBe('disabled')
    expect(disabled.max_sends).toBeUndefined()
    expect(typeof disabled.disabled_at).toBe('string')
  })
})

describe('peppolConnectionState', () => {
  it('reads send-only access without a registration as sending, not off (the Kopplingar row)', () => {
    const access = summarizePeppolAccess(row({ status: 'enabled', receive_enabled: false, max_sends: 10 }), 0)
    expect(peppolConnectionState(access, null)).toBe('sending')
  })

  it('reads a published or publishing registration as receiving', () => {
    const access = summarizePeppolAccess(row({ receive_enabled: true }), 0)
    expect(peppolConnectionState(access, 'registered')).toBe('receiving')
    expect(peppolConnectionState(access, 'pending')).toBe('receiving')
  })

  it('reads send and receive access before the registration as sending', () => {
    const access = summarizePeppolAccess(row({ receive_enabled: true }), 0)
    expect(peppolConnectionState(access, null)).toBe('sending')
    expect(peppolConnectionState(access, 'deregistered')).toBe('sending')
  })

  it('reads no, requested or disabled access as off', () => {
    expect(peppolConnectionState(null, null)).toBe('off')
    expect(peppolConnectionState(summarizePeppolAccess(null, 0), null)).toBe('off')
    expect(peppolConnectionState(summarizePeppolAccess(row({ status: 'requested' }), 0), null)).toBe('off')
    expect(peppolConnectionState(summarizePeppolAccess(row({ status: 'disabled' }), 0), 'failed')).toBe('off')
  })

  it('peppolReceivingOn is true only for registered and pending', () => {
    expect(peppolReceivingOn('registered')).toBe(true)
    expect(peppolReceivingOn('pending')).toBe(true)
    expect(peppolReceivingOn('failed')).toBe(false)
    expect(peppolReceivingOn(null)).toBe(false)
  })
})
