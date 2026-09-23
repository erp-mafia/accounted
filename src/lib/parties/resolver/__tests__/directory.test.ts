import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { preclean } from '../preclean'
import { directoryKeysFor, lookupDirectory, matchSeed, matchSeedText, promoteIfShared } from '../directory'

describe('matchSeedText', () => {
  it('matches whole tokens, longest pattern first', () => {
    expect(matchSeedText('APPLE.COM/BILL 866-712-7753')?.name).toBe('Apple')
    expect(matchSeedText('GOOGLE WORKSPACE DILEN')?.name).toBe('Google Workspace')
    expect(matchSeedText('GOOGLE*CLOUD X6VXKX')?.name).toBe('Google Cloud')
    expect(matchSeedText('Slack Technologies')?.name).toBe('Slack')
    expect(matchSeedText('Kortköp 260810 SL')?.name).toBe('SL')
  })

  it('does not fire on a fragment inside another word', () => {
    expect(matchSeedText('SLACK')?.name).not.toBe('SL')
    expect(matchSeedText('ICAROS AB')).toBeNull()
  })
})

describe('matchSeed', () => {
  it('settles a giro number outright', () => {
    const hit = matchSeed(preclean('1655958320228 DBT.5050-1055 SKATTEVERK 144 240 1655958320228 350 Polytop AB'))
    expect(hit).toMatchObject({ name: 'Skatteverket', kind: 'authority', confidence: 0.98, key: 'bg:5050-1055' })
  })

  it('tries the sub-merchant of a facilitator string first', () => {
    expect(matchSeed(preclean('PAYPAL *LINKEDIN,35314369001,GB Kortköp'))?.name).toBe('LinkedIn')
    expect(matchSeed(preclean('K*SODASTREAM'))).toBeNull()
  })

  it('reads the payment-file payee fragment', () => {
    expect(matchSeed(preclean('642270007400255 DBT.1202407 LÄNSFÖRSÄKRI 144 240 642270007400255'))?.name).toBe('Länsförsäkringar')
  })

  it('names the rail-as-counterpart cases', () => {
    expect(matchSeed(preclean('FACEBK *EG3BLLVQF2'))?.name).toBe('Meta')
    expect(matchSeed(preclean('BKG*BOOKING.COM HOTEL K3667 Kortköp/uttag'))?.name).toBe('Booking.com')
    expect(matchSeed(preclean('Hotel at Booking.com K3667 Kortköp/uttag'))?.name).toBe('Booking.com')
  })
})

describe('lookupDirectory', () => {
  it('falls through to the promoted table with the most specific key first', async () => {
    const pre = preclean('Kortköp 260202 SOMEBRAND.COM')
    expect(directoryKeysFor(pre)).toContain('domain:somebrand.com')
    const rows = [
      { directory_key: pre.aliasKey, display_name: 'Somebrand (alias)', kind: 'merchant', rail: null, country: null, what: null, logo_domain: null, source: 'promoted', confidence: 0.9 },
      { directory_key: 'domain:somebrand.com', display_name: 'Somebrand', kind: 'merchant', rail: null, country: 'SE', what: null, logo_domain: 'somebrand.com', source: 'promoted', confidence: 0.9 },
    ]
    const limit = vi.fn(async () => ({ data: rows, error: null }))
    const service = { from: () => ({ select: () => ({ in: () => ({ limit }) }) }) } as unknown as SupabaseClient
    const hit = await lookupDirectory(service, pre)
    expect(hit).toMatchObject({ name: 'Somebrand', key: 'domain:somebrand.com', source: 'promoted' })
  })
})

describe('promoteIfShared', () => {
  it('promotes only when two companies produced the same reading, never a person', async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    const limit = vi.fn(async () => ({ data: [{ company_id: 'a' }, { company_id: 'b' }], error: null }))
    const service = {
      from: (table: string) =>
        table === 'counterparty_directory'
          ? { upsert }
          : { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ is: () => ({ limit }) }) }) }) }) },
    } as unknown as SupabaseClient
    expect(await promoteIfShared(service, { aliasKey: 'railway', displayName: 'Railway', kind: 'merchant', rail: null, country: 'US', what: null })).toBe(true)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ directory_key: 'railway', company_count: 2, source: 'promoted' }), { onConflict: 'directory_key' })
    expect(await promoteIfShared(service, { aliasKey: 'anna', displayName: 'Anna', kind: 'person', rail: null, country: null, what: null })).toBe(false)

    limit.mockResolvedValueOnce({ data: [{ company_id: 'a' }], error: null })
    expect(await promoteIfShared(service, { aliasKey: 'x', displayName: 'X', kind: 'merchant', rail: null, country: null, what: null })).toBe(false)
  })
})
