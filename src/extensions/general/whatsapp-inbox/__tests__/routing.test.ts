import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import type { WhatsAppConversation } from '@/types'
import { resolveRoutedCompany } from '@/extensions/general/whatsapp-inbox/lib/routing'

const USER = 'a0000000-0000-4000-8000-000000000001'
const COMPANY_A = 'c0000000-0000-4000-8000-00000000000a'
const COMPANY_B = 'c0000000-0000-4000-8000-00000000000b'
const NOW = new Date('2026-11-20T10:00:00.000Z')
const HOUR = 60 * 60 * 1000

interface Membership {
  company_id: string
  role?: string
  archived?: boolean
}

/** A database with the person's memberships. */
function db(memberships: Membership[]): SupabaseClient {
  const mock = createRowsMockSupabase({
    company_members: memberships.map((membership) => ({
      user_id: USER,
      company_id: membership.company_id,
      role: membership.role ?? 'owner',
      ...(membership.archived ? { 'companies.archived_at': '2026-01-01T00:00:00.000Z' } : {}),
    })),
  })
  return mock.supabase as unknown as SupabaseClient
}

function makeConversation(overrides: Partial<WhatsAppConversation> = {}): WhatsAppConversation {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: null,
    service_window_expires_at: null,
    debounce_until: null,
    pending_ack: false,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  }
}

const pinnedTo = (companyId: string, expiresInMs: number) =>
  makeConversation({ company_id: companyId, context: { pin_expires_at: new Date(NOW.getTime() + expiresInMs).toISOString() } })

const link = (defaultCompanyId: string | null = null) => ({ user_id: USER, default_company_id: defaultCompanyId })

describe('resolveRoutedCompany', () => {
  const both = [{ company_id: COMPANY_A }, { company_id: COMPANY_B }]

  it('routes a person in two companies nowhere without a pin or a default', async () => {
    expect(await resolveRoutedCompany(db(both), link(), makeConversation(), NOW)).toBeNull()
  })

  it('routes a person in two companies to the default company', async () => {
    expect(await resolveRoutedCompany(db(both), link(COMPANY_B), makeConversation(), NOW)).toEqual({ companyId: COMPANY_B, via: 'default' })
  })

  it('lets a live pin win over the default company', async () => {
    expect(await resolveRoutedCompany(db(both), link(COMPANY_B), pinnedTo(COMPANY_A, HOUR), NOW)).toEqual({ companyId: COMPANY_A, via: 'pin' })
  })

  it('passes an expired pin by', async () => {
    expect(await resolveRoutedCompany(db(both), link(COMPANY_B), pinnedTo(COMPANY_A, -HOUR), NOW)).toEqual({ companyId: COMPANY_B, via: 'default' })
  })

  it('passes by a pin and a default the person is no longer a member of', async () => {
    const onlyB = [{ company_id: COMPANY_B }]
    expect(await resolveRoutedCompany(db(onlyB), link(COMPANY_A), pinnedTo(COMPANY_A, HOUR), NOW)).toEqual({ companyId: COMPANY_B, via: 'single' })
  })

  it('routes a person with one company there', async () => {
    expect(await resolveRoutedCompany(db([{ company_id: COMPANY_A }]), link(), null, NOW)).toEqual({ companyId: COMPANY_A, via: 'single' })
  })

  it('counts neither an archived company nor an invoicing-only membership', async () => {
    const memberships = [{ company_id: COMPANY_A }, { company_id: COMPANY_B, archived: true }]
    expect(await resolveRoutedCompany(db(memberships), link(COMPANY_B), makeConversation(), NOW)).toEqual({ companyId: COMPANY_A, via: 'single' })

    const invoicer = [{ company_id: COMPANY_A, role: 'invoicer' }]
    expect(await resolveRoutedCompany(db(invoicer), link(COMPANY_A), makeConversation(), NOW)).toBeNull()
  })

  it('answers transient_error when the memberships cannot be read', async () => {
    const mock = createTableMockSupabase({ company_members: { error: { message: 'statement timeout' } } })
    expect(await resolveRoutedCompany(mock.supabase as unknown as SupabaseClient, link(), makeConversation(), NOW)).toBe('transient_error')
  })

  it('writes nothing', async () => {
    const writes: { table: string; method: string; row: unknown }[] = []
    const mock = createRowsMockSupabase({ company_members: [{ user_id: USER, company_id: COMPANY_A, role: 'owner' }] }, writes)
    await resolveRoutedCompany(mock.supabase as unknown as SupabaseClient, link(), pinnedTo(COMPANY_A, HOUR), NOW)
    expect(writes).toEqual([])
  })
})
