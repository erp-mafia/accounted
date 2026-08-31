import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildSenderAddress,
  senderFromRow,
  resolveInvoiceSender,
} from '@/lib/email/invoice-sender'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))

const VERIFIED_ROW = {
  domain: 'hansbolag.example',
  status: 'verified' as const,
  enabled: true,
  sender_local_part: 'faktura',
  sender_name: null,
}

describe('buildSenderAddress', () => {
  it('joins local part and domain', () => {
    expect(buildSenderAddress('faktura', 'hansbolag.example')).toBe('faktura@hansbolag.example')
  })
})

describe('senderFromRow', () => {
  it('uses the company name when no sender name is stored', () => {
    expect(senderFromRow(VERIFIED_ROW, 'Hans Bolag AB')).toEqual({
      name: 'Hans Bolag AB',
      address: 'faktura@hansbolag.example',
    })
  })

  it('prefers an explicit sender name', () => {
    expect(senderFromRow({ ...VERIFIED_ROW, sender_name: 'Hans Bolag Ekonomi' }, 'Hans Bolag AB')).toEqual({
      name: 'Hans Bolag Ekonomi',
      address: 'faktura@hansbolag.example',
    })
  })

  it('never sends as a reserved platform domain or a malformed domain, even from a verified row', () => {
    const previous = process.env.RESEND_FROM_EMAIL
    process.env.RESEND_FROM_EMAIL = 'noreply@platform.example'
    try {
      expect(senderFromRow({ ...VERIFIED_ROW, domain: 'platform.example' }, 'X')).toBeUndefined()
      expect(senderFromRow({ ...VERIFIED_ROW, domain: 'mail.platform.example' }, 'X')).toBeUndefined()
      expect(senderFromRow({ ...VERIFIED_ROW, domain: 'not a host' }, 'X')).toBeUndefined()
      expect(senderFromRow(VERIFIED_ROW, 'X')).toEqual({ name: 'X', address: 'faktura@hansbolag.example' })
    } finally {
      if (previous === undefined) delete process.env.RESEND_FROM_EMAIL
      else process.env.RESEND_FROM_EMAIL = previous
    }
  })

  it('returns undefined for missing, unverified, paused, or nameless rows', () => {
    expect(senderFromRow(null, 'X')).toBeUndefined()
    expect(senderFromRow({ ...VERIFIED_ROW, status: 'pending' }, 'X')).toBeUndefined()
    expect(senderFromRow({ ...VERIFIED_ROW, status: 'failed' }, 'X')).toBeUndefined()
    expect(senderFromRow({ ...VERIFIED_ROW, enabled: false }, 'X')).toBeUndefined()
    expect(senderFromRow(VERIFIED_ROW, '   ')).toBeUndefined()
    expect(senderFromRow(VERIFIED_ROW, null)).toBeUndefined()
  })
})

describe('resolveInvoiceSender', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined and skips the entitlement check when the company has no verified row', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = await resolveInvoiceSender(supabase as unknown as SupabaseClient, 'company-1', 'Hans Bolag AB')
    expect(result).toBeUndefined()
    expect(hasCapabilityMock).not.toHaveBeenCalled()
    // Only verified + enabled rows are ever read.
    const eqArgs = findCall('company_sending_domains', 'eq')
    expect(eqArgs).toEqual(['company_id', 'company-1'])
  })

  it('returns the sender when the row is verified and the company holds the grant', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: VERIFIED_ROW })
    hasCapabilityMock.mockResolvedValue(true)
    const result = await resolveInvoiceSender(supabase as unknown as SupabaseClient, 'company-1', 'Hans Bolag AB')
    expect(result).toEqual({ name: 'Hans Bolag AB', address: 'faktura@hansbolag.example' })
    expect(hasCapabilityMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'custom_sender_domain')
  })

  it('falls back to the platform sender when the grant has lapsed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: VERIFIED_ROW })
    hasCapabilityMock.mockResolvedValue(false)
    const result = await resolveInvoiceSender(supabase as unknown as SupabaseClient, 'company-1', 'Hans Bolag AB')
    expect(result).toBeUndefined()
  })

  it('never throws: a read error or a thrown entitlement check yields undefined', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(
      resolveInvoiceSender(supabase as unknown as SupabaseClient, 'company-1', 'X'),
    ).resolves.toBeUndefined()

    const second = createQueuedMockSupabase()
    second.enqueue({ data: VERIFIED_ROW })
    hasCapabilityMock.mockRejectedValue(new Error('network'))
    await expect(
      resolveInvoiceSender(second.supabase as unknown as SupabaseClient, 'company-1', 'X'),
    ).resolves.toBeUndefined()
  })
})
