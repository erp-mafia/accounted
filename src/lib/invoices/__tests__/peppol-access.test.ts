import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  checkPeppolSendPermission,
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
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toEqual({ ok: true, remaining: 1 })

    enqueue({ data: row({ max_sends: 3 }), error: null })
    enqueue({ data: null, error: null, count: 3 })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toMatchObject({ ok: false, code: 'PEPPOL_SEND_LIMIT_REACHED' })
  })

  it('treats a null cap as unlimited', async () => {
    enqueue({ data: row({ max_sends: null }), error: null })
    enqueue({ data: null, error: null, count: 999 })
    expect(await checkPeppolSendPermission({ service, companyId: 'company-1' })).toEqual({ ok: true, remaining: null })
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
