import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { inboxAddressCarriesName, inboxSlugForName, resolveInboxAddress, tagInboxAddress } from '../inbox-address'

describe('resolveInboxAddress', () => {
  beforeEach(() => {
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
  })
  afterEach(() => {
    delete process.env.RESEND_INBOUND_DOMAIN
  })

  it('composes the active inbox local part with the inbound domain', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { local_part: 'acme-7f3k' } })

    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBe('acme-7f3k@in.example.test')
    // Scoped to the company and to its live address, never a retired one.
    expect(findCalls('company_inboxes', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'active'],
    ])
  })

  it('is null without reading when the install has no inbound mail domain', async () => {
    delete process.env.RESEND_INBOUND_DOMAIN
    const supabase = { from: vi.fn() }

    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is null when the company has no active inbox', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBeNull()
  })

  it('is null when the read fails, so the read it rides along with never fails on it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBeNull()

    const throwing = { from: vi.fn(() => { throw new Error('network') }) }
    expect(await resolveInboxAddress(throwing as never, 'company-1')).toBeNull()
  })
})

describe('inboxSlugForName', () => {
  // Same results as public.generate_inbox_local_part() (20260420000000_arcim_inbox.sql)
  // gives for these names, checked against the SQL function on 2026-10-21.
  it('folds Swedish vowels and accents and hyphenates everything else', () => {
    expect(inboxSlugForName('Test AB')).toBe('test-ab')
    expect(inboxSlugForName('Nordlig Öst AB')).toBe('nordlig-ost-ab')
    expect(inboxSlugForName('Åkeriet & Söner Handelsbolag')).toBe('akeriet-soner-handelsbol')
    // ú is outside the SQL fold list, so it becomes a separator there too.
    expect(inboxSlugForName('  --Café Ñandú!-- ')).toBe('cafe-nand')
  })

  it('cuts at 24 characters without a trailing hyphen', () => {
    expect(inboxSlugForName('Exempelbolaget Online Utbildning AB')).toBe('exempelbolaget-online-ut')
    expect(inboxSlugForName('abcdefghijklmnopqrstuvw xyz')).toBe('abcdefghijklmnopqrstuvw')
  })

  it('is company when nothing is left of the name', () => {
    expect(inboxSlugForName('')).toBe('company')
    expect(inboxSlugForName(null)).toBe('company')
    expect(inboxSlugForName('!!!')).toBe('company')
  })
})

describe('inboxAddressCarriesName', () => {
  it('is true while the address slugs the current name', () => {
    expect(inboxAddressCarriesName('test-ab-7f3k@in.example.test', 'Test AB')).toBe(true)
    expect(inboxAddressCarriesName('test-ab-7f3k+lev@in.example.test', 'Test AB')).toBe(true)
    expect(inboxAddressCarriesName('test-ab-7f3k', 'Test AB')).toBe(true)
  })

  it('is false after a rename', () => {
    expect(inboxAddressCarriesName('exempelbolaget-online-ut-m4tz@in.example.test', 'Nytt Namn AB')).toBe(false)
    // A name that only grew a suffix is a rename too.
    expect(inboxAddressCarriesName('test-7f3k@in.example.test', 'Test AB')).toBe(false)
  })
})

describe('tagInboxAddress', () => {
  it('puts the tag between the local part and the domain', () => {
    expect(tagInboxAddress('acme-7f3k@in.example.test', 'lev')).toBe('acme-7f3k+lev@in.example.test')
    expect(tagInboxAddress('acme-7f3k@in.example.test', 'ver')).toBe('acme-7f3k+ver@in.example.test')
  })

  it('returns an address without a local part unchanged', () => {
    expect(tagInboxAddress('not-an-address', 'lev')).toBe('not-an-address')
    expect(tagInboxAddress('@in.example.test', 'lev')).toBe('@in.example.test')
  })
})
