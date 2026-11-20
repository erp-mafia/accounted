import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  readVerificationRecord,
  recordVerificationCheck,
  recordVerificationLink,
  VERIFICATION_RECORD_COLUMNS,
  VERIFICATION_REFRESH_AFTER_MS,
  verificationNeedsRefresh,
  type VerificationRecord,
} from '../verification-record'

const NOW = new Date('2026-10-13T10:00:00Z')
const COMPANY = 'c0000000-0000-4000-8000-000000000001'

function stored(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    company_id: COMPANY,
    status: 'valid',
    valid_until: '2027-10-03',
    checked_at: new Date(NOW.getTime() - 60_000).toISOString(),
    link_created_at: null,
    link_expires_at: null,
    handed_off_at: null,
    started_by: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  }
}

describe('verificationNeedsRefresh', () => {
  it('asks the provider with nothing on file, when forced, and once the answer is six hours old', () => {
    expect(verificationNeedsRefresh(null, NOW)).toBe(true)
    expect(verificationNeedsRefresh(stored({ checked_at: null }), NOW)).toBe(true)
    expect(verificationNeedsRefresh(stored(), NOW)).toBe(false)
    expect(verificationNeedsRefresh(stored(), NOW, true)).toBe(true)
    const sixHours = stored({ checked_at: new Date(NOW.getTime() - VERIFICATION_REFRESH_AFTER_MS).toISOString() })
    expect(verificationNeedsRefresh(sixHours, NOW)).toBe(true)
    const almost = stored({ checked_at: new Date(NOW.getTime() - VERIFICATION_REFRESH_AFTER_MS + 1000).toISOString() })
    expect(verificationNeedsRefresh(almost, NOW)).toBe(false)
  })

  it('asks while a form is out, since the person waits for the answer to change', () => {
    const created = new Date(NOW.getTime() - 60 * 60 * 1000)
    const formOut = stored({
      status: 'invalid',
      valid_until: null,
      link_created_at: created.toISOString(),
      link_expires_at: new Date(created.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    })
    expect(verificationNeedsRefresh(formOut, NOW)).toBe(true)
    expect(verificationNeedsRefresh({ ...formOut, handed_off_at: created.toISOString() }, NOW)).toBe(true)
    // An expired link is not a form out: the fresh answer stands.
    const linkDead = { ...formOut, link_created_at: '2026-10-01T09:00:00Z', link_expires_at: '2026-10-02T09:00:00Z' }
    expect(verificationNeedsRefresh(linkDead, NOW)).toBe(false)
  })
})

describe('the record writes', () => {
  it('never selects the form URL', () => {
    expect(VERIFICATION_RECORD_COLUMNS).not.toMatch(/link_url/)
  })

  it('reads one row per company and upserts the check without touching the link columns', async () => {
    const db = createTableMockSupabase({ company_payment_verifications: [{ data: stored() }, { data: null }] })
    const client = db.supabase as unknown as SupabaseClient
    expect(await readVerificationRecord(client, COMPANY)).toEqual(stored())
    expect(db.findCall('company_payment_verifications', 'select')).toEqual([VERIFICATION_RECORD_COLUMNS])
    expect(db.findCall('company_payment_verifications', 'eq')).toEqual(['company_id', COMPANY])

    await recordVerificationCheck(client, COMPANY, { status: 'valid', validUntil: '2027-10-03', checkedAt: NOW })
    const [row, options] = db.findCall('company_payment_verifications', 'upsert')!
    expect(row).toEqual({ company_id: COMPANY, status: 'valid', valid_until: '2027-10-03', checked_at: NOW.toISOString() })
    expect(options).toEqual({ onConflict: 'company_id' })
  })

  it('stores a new link with its 24-hour expiry and a hand-off mark that follows this link only', async () => {
    const db = createTableMockSupabase({ company_payment_verifications: { data: null } })
    const client = db.supabase as unknown as SupabaseClient
    const first = await recordVerificationLink(client, COMPANY, { url: 'https://kyc.example/?instanceId=1', createdAt: NOW, startedBy: 'u-1', handedOff: true })
    expect(first.expiresAt).toBe('2026-10-14T10:00:00.000Z')
    const second = await recordVerificationLink(client, COMPANY, { url: 'https://kyc.example/?instanceId=2', createdAt: NOW, startedBy: null, handedOff: false })
    expect(second.expiresAt).toBe('2026-10-14T10:00:00.000Z')
    const rows = db.payloads('company_payment_verifications', 'upsert') as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({
      company_id: COMPANY,
      link_url: 'https://kyc.example/?instanceId=1',
      link_created_at: NOW.toISOString(),
      link_expires_at: '2026-10-14T10:00:00.000Z',
      handed_off_at: NOW.toISOString(),
      started_by: 'u-1',
    })
    expect(rows[1]).toMatchObject({ link_url: 'https://kyc.example/?instanceId=2', handed_off_at: null, started_by: null })
  })
})
