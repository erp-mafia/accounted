import { describe, it, expect, vi } from 'vitest'
import { hashPersonalNumber } from '@/lib/auth/bankid'
import {
  isOwnPersonalNumber,
  offerableSearchHits,
  ownCompanyRoles,
  ownPersonalNumberHash,
} from '../own-firm'

// Three sole traders who share one name (crm#1456): only the first is the
// signed-in person's own firm. Synthetic personnummer.
const OWN = '198201022343'
const OWN_HASH = hashPersonalNumber(OWN)
const OTHER_A = '8201011239'
const OTHER_B = '0201011236'

function role(registrationNumber: string, legalEntityType: string, legalName = 'Andersson, Anna') {
  return {
    companyId: Number(registrationNumber.slice(-6)),
    companyRegistrationNumber: registrationNumber,
    legalName,
    legalEntityType,
    positionTypes: ['IN'],
    positionDescriptions: ['Innehavare'],
    positionStart: '2024-01-01',
    positionEnd: null,
    companyStatus: '',
  }
}

describe('ownCompanyRoles', () => {
  it('keeps only the sole trader firm whose registration number is the BankID personnummer', () => {
    const roles = [
      role('1982010112390001', 'Enskild näringsidkare'),
      role('1982010223430001', 'Enskild näringsidkare'),
      role('2002010112360001', 'Enskild näringsidkare'),
    ]
    const kept = ownCompanyRoles(roles, OWN)
    expect(kept.map((r) => r.companyRegistrationNumber)).toEqual(['1982010223430001'])
  })

  it('keeps every role in a juridisk person, whatever the name', () => {
    const roles = [
      role('5560360793', 'Aktiebolag', 'Exempel AB'),
      role('9166723958', 'Kommanditbolag', 'Exempel KB'),
      // TIC's 14-digit form for an ideell förening that runs a business.
      role('80240012340001', 'Ideell förening som bedriver näring', 'Exempelföreningen'),
    ]
    expect(ownCompanyRoles(roles, OWN)).toEqual(roles)
  })

  it("drops another person's sole trader firm even when the role is a prokura", () => {
    const roles = [{ ...role('1982010112390001', 'Enskild näringsidkare'), positionTypes: ['PO'] }]
    expect(ownCompanyRoles(roles, OWN)).toEqual([])
  })

  it('drops a role whose form says sole trader but whose number proves nothing', () => {
    expect(ownCompanyRoles([role('', 'Enskild näringsidkare')], OWN)).toEqual([])
  })

  it('accepts the BankID personnummer in its 10-digit form too', () => {
    const kept = ownCompanyRoles([role('1982010223430001', 'Enskild näringsidkare')], OWN.slice(2))
    expect(kept).toHaveLength(1)
  })
})

describe('isOwnPersonalNumber', () => {
  it('matches the 10-, 12- and 16-digit forms of the own personnummer', () => {
    expect(isOwnPersonalNumber('8201022343', OWN_HASH)).toBe(true)
    expect(isOwnPersonalNumber('820102-2343', OWN_HASH)).toBe(true)
    expect(isOwnPersonalNumber('198201022343', OWN_HASH)).toBe(true)
    expect(isOwnPersonalNumber('1982010223430001', OWN_HASH)).toBe(true)
  })

  it('is false for another number, a missing hash or a non-number', () => {
    expect(isOwnPersonalNumber(OTHER_A, OWN_HASH)).toBe(false)
    expect(isOwnPersonalNumber('8201022343', null)).toBe(false)
    expect(isOwnPersonalNumber('', OWN_HASH)).toBe(false)
    expect(isOwnPersonalNumber(null, OWN_HASH)).toBe(false)
  })
})

describe('offerableSearchHits', () => {
  const hit = (orgNumber: string, legalEntityType: string | null) => ({ orgNumber, legalEntityType })
  const describeHit = (h: { orgNumber: string; legalEntityType: string | null }) => ({
    orgNumber: h.orgNumber,
    legalForm: h.legalEntityType,
  })

  const sameNameHits = [
    hit(OTHER_A, 'EF'),
    hit('8201022343', 'EF'),
    hit(OTHER_B, 'EF'),
    hit('5560360793', 'AB'),
  ]

  it('offers only the own sole trader firm among three with the same name, plus juridiska personer', () => {
    const offered = offerableSearchHits(sameNameHits, describeHit, OWN_HASH)
    expect(offered.map((h) => h.orgNumber)).toEqual(['8201022343', '5560360793'])
  })

  it('offers no sole trader firm by name without a BankID-verified personnummer', () => {
    const offered = offerableSearchHits(sameNameHits, describeHit, null)
    expect(offered.map((h) => h.orgNumber)).toEqual(['5560360793'])
  })

  it('treats a person-shaped number as a sole trader whatever form the register gives', () => {
    expect(offerableSearchHits([hit(OTHER_A, null)], describeHit, OWN_HASH)).toEqual([])
    expect(offerableSearchHits([hit(OTHER_A, 'AB')], describeHit, OWN_HASH)).toEqual([])
  })

  it('leaves the order of the remaining hits alone', () => {
    const hits = [hit('5566778899', 'AB'), hit('8201022343', 'EF'), hit('5560360793', 'AB')]
    expect(offerableSearchHits(hits, describeHit, OWN_HASH)).toEqual(hits)
  })
})

describe('ownPersonalNumberHash', () => {
  function client(result: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue(result)
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    return { client: { from } as never, from, eq }
  }

  it("returns the hash of the user's proven BankID link", async () => {
    const { client: supabase, from, eq } = client({
      data: { personal_number_hash: OWN_HASH, email_verified_at: '2026-10-01T00:00:00Z' },
      error: null,
    })
    await expect(ownPersonalNumberHash(supabase, 'user-1')).resolves.toBe(OWN_HASH)
    expect(from).toHaveBeenCalledWith('bankid_identities')
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1')
  })

  it('returns null for a pending (unconfirmed) link, no link, or a read error', async () => {
    const pending = client({ data: { personal_number_hash: OWN_HASH, email_verified_at: null }, error: null })
    await expect(ownPersonalNumberHash(pending.client, 'user-1')).resolves.toBeNull()
    const none = client({ data: null, error: null })
    await expect(ownPersonalNumberHash(none.client, 'user-1')).resolves.toBeNull()
    const failed = client({ data: null, error: { message: 'boom' } })
    await expect(ownPersonalNumberHash(failed.client, 'user-1')).resolves.toBeNull()
  })
})
