/**
 * The profiles (lib/modules/profiles.ts): versioned data over the packages,
 * exactly the Profiles and Suggestions design's proposed table (2026-10-16),
 * naming only packages that exist and that a company can switch.
 */
import { describe, expect, it } from 'vitest'
import { PACKAGES, PACKAGE_IDS } from '../packages'
import {
  PROFILES,
  PROFILE_IDS,
  PROFILE_VERSIONS,
  STANDARD_PROFILE_ID,
  deriveSignupProfile,
  getProfile,
  isProfileId,
  latestProfile,
  packagesOffIn,
  resolveStoredProfile,
} from '../profiles'

const SWITCHABLE = PACKAGES.filter((p) => p.switchable).map((p) => p.id)

describe('profile definitions', () => {
  it('names only packages that exist, every switchable one, and never the always-on Bokföring', () => {
    const known = new Set<string>(PACKAGE_IDS)
    for (const def of PROFILE_VERSIONS) {
      const named = Object.keys(def.packages)
      expect(named.filter((id) => !known.has(id)), `${def.id} v${def.version} names an unknown package`).toEqual([])
      expect([...named].sort(), `${def.id} v${def.version}`).toEqual([...SWITCHABLE].sort())
      expect(named, def.id).not.toContain('bookkeeping')
      for (const state of Object.values(def.packages)) expect(['on', 'off']).toContain(state)
    }
  })

  it('numbers the versions of each profile 1, 2, 3 with no gap or repeat, and offers the latest of each in PROFILE_IDS order', () => {
    for (const id of PROFILE_IDS) {
      const versions = PROFILE_VERSIONS.filter((d) => d.id === id).map((d) => d.version)
      expect(versions, id).toEqual(versions.map((_, i) => i + 1))
      expect(latestProfile(id).version).toBe(Math.max(...versions))
    }
    expect(new Set(PROFILE_VERSIONS.map((d) => d.id))).toEqual(new Set(PROFILE_IDS))
    expect(PROFILES.map((p) => p.id)).toEqual([...PROFILE_IDS])
  })

  it('is the design table: which packages each profile starts with off', () => {
    const off = Object.fromEntries(PROFILES.map((p) => [p.nameSv, packagesOffIn(p)]))
    expect(off).toEqual({
      'Enskild firma': ['supplier-invoices-and-payments', 'expenses', 'payroll', 'assets', 'pos-and-webshop'],
      'Aktiebolag utan anställda': ['payroll', 'assets', 'pos-and-webshop'],
      'Aktiebolag med anställda': ['pos-and-webshop'],
      'Handel med kassa eller webbshop': ['expenses', 'payroll'],
      Förening: ['supplier-invoices-and-payments', 'payroll', 'assets', 'pos-and-webshop'],
      'Standard (allt på)': [],
    })
  })

  it('has an English and a Swedish name for every profile, and Standard keeps every package on', () => {
    for (const p of PROFILES) {
      expect(p.name.length, p.id).toBeGreaterThan(0)
      expect(p.nameSv.length, p.id).toBeGreaterThan(0)
    }
    expect(packagesOffIn(latestProfile(STANDARD_PROFILE_ID))).toEqual([])
    expect(latestProfile(STANDARD_PROFILE_ID).nameSv).toBe('Standard (allt på)')
  })

  it('freezes the data', () => {
    expect(Object.isFrozen(PROFILE_VERSIONS)).toBe(true)
    expect(Object.isFrozen(PROFILE_VERSIONS[0])).toBe(true)
    expect(Object.isFrozen(PROFILE_VERSIONS[0].packages)).toBe(true)
  })
})

describe('getProfile and isProfileId', () => {
  it('finds an exact version, the latest without one, and nothing it does not know', () => {
    expect(getProfile('retail', 1)?.nameSv).toBe('Handel med kassa eller webbshop')
    expect(getProfile('retail')?.version).toBe(latestProfile('retail').version)
    expect(getProfile('retail', 99)).toBeUndefined()
    expect(getProfile('freelancer')).toBeUndefined()
    expect(isProfileId('association')).toBe(true)
    expect(isProfileId('Association')).toBe(false)
    expect(isProfileId(null)).toBe(false)
  })
})

describe('resolveStoredProfile', () => {
  it('reads no stored profile as the implicit Standard, so a company from before profiles keeps every package', () => {
    for (const stored of [null, undefined, { id: null, version: null }]) {
      const resolved = resolveStoredProfile(stored)
      expect(resolved.source).toBe('implicit')
      expect(resolved.definition.id).toBe('standard')
    }
  })

  it('reads the stored id at its stored version', () => {
    const resolved = resolveStoredProfile({ id: 'sole-trader', version: 1 })
    expect(resolved).toEqual({ definition: getProfile('sole-trader', 1), source: 'stored' })
  })

  it('reads an id or version this code does not know as Standard rather than hiding on a guess', () => {
    expect(resolveStoredProfile({ id: 'sole-trader', version: 7 })).toMatchObject({
      source: 'implicit',
      definition: { id: 'standard' },
    })
    expect(resolveStoredProfile({ id: 'freelancer', version: 1 })).toMatchObject({ source: 'implicit' })
    expect(resolveStoredProfile({ id: 'sole-trader', version: null })).toMatchObject({ source: 'implicit' })
  })
})

describe('deriveSignupProfile', () => {
  it('derives the profile from the legal form the onboarding asked for', () => {
    expect(deriveSignupProfile('aktiebolag')).toBe('limited-company-no-employees')
    expect(deriveSignupProfile('enskild_firma')).toBe('sole-trader')
    expect(deriveSignupProfile('ideell_forening')).toBe('association')
    expect(deriveSignupProfile('ekonomisk_forening')).toBe('association')
  })

  it('derives nothing from a legal form it does not know', () => {
    expect(deriveSignupProfile('handelsbolag')).toBeNull()
    expect(deriveSignupProfile(undefined)).toBeNull()
  })
})
