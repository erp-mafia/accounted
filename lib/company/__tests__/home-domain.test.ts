import { describe, it, expect } from 'vitest'
import {
  partitionCompaniesByHomeDomain,
  isCompanyHomedOnHost,
  isCockpitLandingRole,
  resolveLandingPath,
  resolveCockpitHref,
  type TeamBrandRef,
} from '../home-domain'

interface Entry {
  id: string
  teamId: string | null
}

const CANONICAL = {
  canonicalDomain: 'app.gnubok.se',
  canonicalAppName: 'Accounted',
}

const siffraBrand: TeamBrandRef = { domain: 'app.siffra.se', appName: 'Siffra' }

function partition(opts: {
  companies: Entry[]
  brandByTeam?: Map<string, TeamBrandRef>
  hostBrandTeamId?: string | null
}) {
  return partitionCompaniesByHomeDomain<Entry>({
    companies: opts.companies,
    getTeamId: (c) => c.teamId,
    brandByTeam: opts.brandByTeam ?? new Map(),
    hostBrandTeamId: opts.hostBrandTeamId ?? null,
    ...CANONICAL,
  })
}

describe('partitionCompaniesByHomeDomain', () => {
  it('canonical host with no brands anywhere: everything visible (additive guarantee)', () => {
    const result = partition({
      companies: [
        { id: 'own', teamId: 'personal-1' },
        { id: 'other', teamId: null },
      ],
    })
    expect(result.visible.map((c) => c.id)).toEqual(['own', 'other'])
    expect(result.foreign).toHaveLength(0)
  })

  it('canonical host: branded companies become foreign under their brand domain', () => {
    const result = partition({
      companies: [
        { id: 'own-firma', teamId: 'personal-1' },
        { id: 'client', teamId: 'byra-1' },
      ],
      brandByTeam: new Map([['byra-1', siffraBrand]]),
    })
    expect(result.visible.map((c) => c.id)).toEqual(['own-firma'])
    expect(result.foreign).toEqual([
      { item: { id: 'client', teamId: 'byra-1' }, domain: 'app.siffra.se', appName: 'Siffra' },
    ])
  })

  it("brand host: only the brand team's companies are visible", () => {
    const result = partition({
      companies: [
        { id: 'own-firma', teamId: 'personal-1' },
        { id: 'client-a', teamId: 'byra-1' },
        { id: 'client-b', teamId: 'byra-1' },
      ],
      brandByTeam: new Map([['byra-1', siffraBrand]]),
      hostBrandTeamId: 'byra-1',
    })
    expect(result.visible.map((c) => c.id)).toEqual(['client-a', 'client-b'])
    // The consultant's own firma points home to the canonical domain.
    expect(result.foreign).toEqual([
      {
        item: { id: 'own-firma', teamId: 'personal-1' },
        domain: 'app.gnubok.se',
        appName: 'Accounted',
      },
    ])
  })

  it('brand host: a company under ANOTHER brand points at that brand domain', () => {
    const otherBrand: TeamBrandRef = { domain: 'app.other.se', appName: 'Other' }
    const result = partition({
      companies: [{ id: 'other-client', teamId: 'byra-2' }],
      brandByTeam: new Map([
        ['byra-1', siffraBrand],
        ['byra-2', otherBrand],
      ]),
      hostBrandTeamId: 'byra-1',
    })
    expect(result.visible).toHaveLength(0)
    expect(result.foreign[0]!.domain).toBe('app.other.se')
  })
})

describe('isCompanyHomedOnHost', () => {
  const brandByTeam = new Map([['byra-1', siffraBrand]])

  it('brandless company is homed on the canonical host', () => {
    expect(
      isCompanyHomedOnHost({
        companyTeamId: 'personal-1',
        brandByTeam,
        hostBrandTeamId: null,
      }),
    ).toBe(true)
  })

  it('branded company is NOT homed on the canonical host', () => {
    expect(
      isCompanyHomedOnHost({
        companyTeamId: 'byra-1',
        brandByTeam,
        hostBrandTeamId: null,
      }),
    ).toBe(false)
  })

  it('branded company is homed on its own brand host', () => {
    expect(
      isCompanyHomedOnHost({
        companyTeamId: 'byra-1',
        brandByTeam,
        hostBrandTeamId: 'byra-1',
      }),
    ).toBe(true)
  })

  it('brandless company is NOT homed on a brand host', () => {
    expect(
      isCompanyHomedOnHost({
        companyTeamId: 'personal-1',
        brandByTeam,
        hostBrandTeamId: 'byra-1',
      }),
    ).toBe(false)
  })
})

describe('isCockpitLandingRole', () => {
  it('owner gets the automatic cockpit landing', () => {
    expect(isCockpitLandingRole('owner')).toBe(true)
  })

  it('admin gets the automatic cockpit landing', () => {
    expect(isCockpitLandingRole('admin')).toBe(true)
  })

  it('plain member lands like a regular user', () => {
    expect(isCockpitLandingRole('member')).toBe(false)
  })

  it('unknown roles default to the regular landing (allowlist)', () => {
    expect(isCockpitLandingRole('viewer')).toBe(false)
    expect(isCockpitLandingRole('')).toBe(false)
  })
})

describe('resolveLandingPath', () => {
  it("byrå staff on their brand host land in the cockpit", () => {
    expect(
      resolveLandingPath({
        hostBrandTeamId: 'byra-1',
        byraTeams: [{ teamId: 'byra-1', hasBrand: true }],
      }),
    ).toBe('/clients')
  })

  it("someone else's brand host never lands in the cockpit", () => {
    expect(
      resolveLandingPath({
        hostBrandTeamId: 'byra-2',
        byraTeams: [{ teamId: 'byra-1', hasBrand: true }],
      }),
    ).toBe('/')
  })

  it('brandless byrå homes its cockpit on the canonical host (WL-01)', () => {
    expect(
      resolveLandingPath({
        hostBrandTeamId: null,
        byraTeams: [{ teamId: 'byra-1', hasBrand: false }],
      }),
    ).toBe('/clients')
  })

  it('a BRANDED byrå does not land in the cockpit on the canonical host', () => {
    expect(
      resolveLandingPath({
        hostBrandTeamId: null,
        byraTeams: [{ teamId: 'byra-1', hasBrand: true }],
      }),
    ).toBe('/')
  })

  it('non-byrå users always land on / (byte-identical flow)', () => {
    expect(resolveLandingPath({ hostBrandTeamId: null, byraTeams: [] })).toBe('/')
    expect(resolveLandingPath({ hostBrandTeamId: 'byra-1', byraTeams: [] })).toBe('/')
  })
})

describe('resolveCockpitHref', () => {
  const brandByTeam = new Map([['byra-1', siffraBrand]])
  const canonicalDomain = CANONICAL.canonicalDomain

  it('brandless byrå on the canonical host stays relative', () => {
    expect(
      resolveCockpitHref({
        byraTeamId: 'byra-1',
        brandByTeam: new Map(),
        hostBrandTeamId: null,
        canonicalDomain,
      }),
    ).toBe('/clients')
  })

  it('branded byrå on its own brand host stays relative', () => {
    expect(
      resolveCockpitHref({
        byraTeamId: 'byra-1',
        brandByTeam,
        hostBrandTeamId: 'byra-1',
        canonicalDomain,
      }),
    ).toBe('/clients')
  })

  it('branded byrå on the canonical host points at the brand domain (problem 4)', () => {
    expect(
      resolveCockpitHref({
        byraTeamId: 'byra-1',
        brandByTeam,
        hostBrandTeamId: null,
        canonicalDomain,
      }),
    ).toBe('https://app.siffra.se/clients')
  })

  it("branded byrå on someone ELSE's brand host points at its own brand domain", () => {
    expect(
      resolveCockpitHref({
        byraTeamId: 'byra-1',
        brandByTeam,
        hostBrandTeamId: 'byra-2',
        canonicalDomain,
      }),
    ).toBe('https://app.siffra.se/clients')
  })

  it('brandless byrå on a foreign brand host points home to canonical (WL-14 symmetry)', () => {
    expect(
      resolveCockpitHref({
        byraTeamId: 'byra-1',
        brandByTeam: new Map(),
        hostBrandTeamId: 'byra-2',
        canonicalDomain,
      }),
    ).toBe('https://app.gnubok.se/clients')
  })

  it('byrå with zero client companies still resolves via its own brand entry', () => {
    // The layout adds the byrå team id to the resolveBrandsForTeams id list
    // precisely so this map entry exists even when no membership company
    // belongs to the byrå (pre-byrå companies have team_id null).
    expect(
      resolveCockpitHref({
        byraTeamId: 'byra-1',
        brandByTeam: new Map([['byra-1', siffraBrand]]),
        hostBrandTeamId: null,
        canonicalDomain,
      }),
    ).toBe('https://app.siffra.se/clients')
  })
})
