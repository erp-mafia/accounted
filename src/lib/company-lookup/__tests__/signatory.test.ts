import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { bankIdSignatoryProof, holdsSignatoryPosition } from '../signatory'

// Synthetic identifiers only: the org number used across the test suite and a
// made-up 55699999xx number for another company.
const ORG = '5560125790'
const ELSEWHERE = '5569999990'

function role(positionTypes: string[], overrides: Record<string, unknown> = {}) {
  return { companyRegistrationNumber: ORG, positionTypes, positionDescriptions: [], positionEnd: null, ...overrides }
}

describe('holdsSignatoryPosition', () => {
  it.each(['LE', 'OF', 'VD', 'EVD', 'VVD', 'EVVD', 'EFT', 'LI', 'BO', 'KP'])('counts %s', (code) => {
    expect(holdsSignatoryPosition([role([code])], ORG)).toBe(true)
  })

  it.each(['SU', 'REV', 'REVH', 'REVS', 'KD', 'DELG', 'PO', 'LS', 'IN'])('does not count %s', (code) => {
    expect(holdsSignatoryPosition([role([code])], ORG)).toBe(false)
  })

  it('reads the org number in any written form on either side', () => {
    expect(holdsSignatoryPosition([role(['LE'], { companyRegistrationNumber: '165560125790' })], '556012-5790')).toBe(true)
  })

  it('counts only a position in that company, still held, in a company that still exists', () => {
    expect(holdsSignatoryPosition([role(['LE'], { companyRegistrationNumber: ELSEWHERE })], ORG)).toBe(false)
    expect(holdsSignatoryPosition([role(['LE'], { positionEnd: '2025-06-30' })], ORG)).toBe(false)
    expect(holdsSignatoryPosition([role(['LE'], { companyStatus: 'CompanyStruckOff' })], ORG)).toBe(false)
    expect(holdsSignatoryPosition([role(['LI'], { companyStatus: 'LiquidationDecided' })], ORG)).toBe(true)
  })

  it('reads anything that is not a list of roles as no position', () => {
    expect(holdsSignatoryPosition(null, ORG)).toBe(false)
    expect(holdsSignatoryPosition({ positionTypes: ['LE'] }, ORG)).toBe(false)
    expect(holdsSignatoryPosition([null, role(['LE'], { companyRegistrationNumber: 42 })], ORG)).toBe(false)
    expect(holdsSignatoryPosition([role(['LE'])], 'not a number')).toBe(false)
  })
})

describe('bankIdSignatoryProof', () => {
  const identity = (userId: string, extra: Record<string, unknown> = {}) => ({
    user_id: userId,
    email_verified_at: '2026-09-01T10:00:00Z',
    linked_at: '2026-09-01T10:00:00Z',
    ...extra,
  })
  const enrichment = (userId: string, positionTypes: string[], updatedAt = '2026-11-01T10:00:00Z') => ({
    user_id: userId,
    updated_at: updatedAt,
    company_roles: [role(positionTypes)],
  })
  const service = (identities: Record<string, unknown>[], enrichments: Record<string, unknown>[]) =>
    createRowsMockSupabase({ bankid_identities: identities, bankid_enrichment: enrichments }).supabase as unknown as SupabaseClient

  it('is proven when one of the people is a firmatecknare', async () => {
    const svc = service([identity('a'), identity('b')], [enrichment('a', ['SU']), enrichment('b', ['VD'])])
    await expect(bankIdSignatoryProof(svc, ['a', 'b'], ORG)).resolves.toBe('proven')
  })

  it('is not_signatory when the register was read and lists none of them', async () => {
    const svc = service([identity('a')], [enrichment('a', ['SU'])])
    await expect(bankIdSignatoryProof(svc, ['a'], ORG)).resolves.toBe('not_signatory')
  })

  it('is no_bankid without a proven link, or with roles older than the link', async () => {
    await expect(bankIdSignatoryProof(service([], [enrichment('a', ['LE'])]), ['a'], ORG)).resolves.toBe('no_bankid')
    await expect(
      bankIdSignatoryProof(service([identity('a', { email_verified_at: null })], [enrichment('a', ['LE'])]), ['a'], ORG),
    ).resolves.toBe('no_bankid')
    await expect(
      bankIdSignatoryProof(service([identity('a')], [enrichment('a', ['LE'], '2026-08-31T10:00:00Z')]), ['a'], ORG),
    ).resolves.toBe('no_bankid')
    await expect(bankIdSignatoryProof(service([], []), [], ORG)).resolves.toBe('no_bankid')
  })

  it('throws when a read fails: not knowing is no proof', async () => {
    const { supabase } = createTableMockSupabase({
      bankid_identities: { data: null, error: { message: 'boom' } },
      bankid_enrichment: { data: [] },
    })
    await expect(bankIdSignatoryProof(supabase as unknown as SupabaseClient, ['a'], ORG)).rejects.toThrow('bankid identity read failed')
  })
})
