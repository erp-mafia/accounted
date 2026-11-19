import { describe, it, expect } from 'vitest'
import {
  OWNER_FALLBACK_NAME,
  PAYER_ORDER,
  isPersonPayer,
  lastOwnerClaimantName,
  ownerFallbackName,
  resolveExpenseLiabilityAccount,
} from '../payer'

describe('ownerFallbackName', () => {
  it('is the form glossary noun: Ägare for an AB and an EF, Medlem for an ideell förening', () => {
    expect(ownerFallbackName('aktiebolag')).toBe('Ägare')
    expect(ownerFallbackName('enskild_firma')).toBe('Ägare')
    expect(ownerFallbackName('ideell_forening')).toBe('Medlem')
  })

  it('keeps the shared constant while the form is not known', () => {
    expect(ownerFallbackName(null)).toBe(OWNER_FALLBACK_NAME)
    expect(ownerFallbackName(undefined)).toBe(OWNER_FALLBACK_NAME)
    expect(ownerFallbackName('handelsbolag')).toBe(OWNER_FALLBACK_NAME)
  })
})

describe('resolveExpenseLiabilityAccount', () => {
  it('an employee is always 2820, whatever the entity type', () => {
    expect(resolveExpenseLiabilityAccount('aktiebolag', 'employee')).toBe('2820')
    expect(resolveExpenseLiabilityAccount('enskild_firma', 'employee')).toBe('2820')
    expect(resolveExpenseLiabilityAccount(null, 'employee')).toBe('2820')
  })

  it('the owner is a creditor in an AB (2893) and makes an egen insättning in an EF (2018)', () => {
    expect(resolveExpenseLiabilityAccount('aktiebolag', 'owner')).toBe('2893')
    expect(resolveExpenseLiabilityAccount('enskild_firma', 'owner')).toBe('2018')
  })

  it('a member of an ideell förening is a plain short-term creditor (2890)', () => {
    expect(resolveExpenseLiabilityAccount('ideell_forening', 'owner')).toBe('2890')
    expect(resolveExpenseLiabilityAccount('ideell_forening', 'employee')).toBe('2820')
  })

  it('an unknown entity type falls back to the AB rule, never to 2018', () => {
    expect(resolveExpenseLiabilityAccount(undefined, 'owner')).toBe('2893')
    expect(resolveExpenseLiabilityAccount('handelsbolag', 'owner')).toBe('2893')
  })
})

describe('isPersonPayer', () => {
  it('only owner and employee are people', () => {
    expect(isPersonPayer('owner')).toBe(true)
    expect(isPersonPayer('employee')).toBe(true)
    expect(isPersonPayer('company')).toBe(false)
    expect(isPersonPayer('unpaid')).toBe(false)
    expect(isPersonPayer(null)).toBe(false)
  })

  it('the select lists every answer exactly once', () => {
    expect([...PAYER_ORDER].sort()).toEqual(['company', 'employee', 'owner', 'unpaid'])
  })

  it('the owner fallback label is the one Hem groups on', () => {
    expect(OWNER_FALLBACK_NAME).toBe('Ägare')
  })
})

describe('lastOwnerClaimantName (PH 101: "Jag, privat" remembers the name)', () => {
  const owner = (claimant_name: string | null, created_at: string | null) => ({ employee_id: null, claimant_name, created_at })

  it('is the name the most recently registered owner claim was typed under, trimmed', () => {
    expect(
      lastOwnerClaimantName([
        owner('Anna', '2026-10-01T10:00:00+00:00'),
        owner('  Kim  ', '2026-10-21T21:56:14.096565+00:00'),
        owner('Anna', '2026-10-20T08:00:00+00:00'),
      ]),
    ).toBe('Kim')
  })

  it("skips an employee's claim: the name belongs to the employee row", () => {
    expect(
      lastOwnerClaimantName([
        owner('Kim', '2026-10-01T10:00:00+00:00'),
        { employee_id: 'emp-1', claimant_name: 'Sam Anställd', created_at: '2026-10-22T10:00:00+00:00' },
      ]),
    ).toBe('Kim')
  })

  it('skips a claim left on the fallback label, so the typed name wins over "Ägare"', () => {
    expect(
      lastOwnerClaimantName([
        owner('Kim', '2026-10-21T21:47:06+00:00'),
        owner('Ägare', '2026-10-21T21:53:53+00:00'),
        owner('medlem', '2026-10-21T21:54:00+00:00'),
        owner('Owner', '2026-10-21T21:55:00+00:00'),
      ]),
    ).toBe('Kim')
  })

  it('is null without a typed owner name, so the field stays empty with the fallback as placeholder', () => {
    expect(lastOwnerClaimantName([])).toBeNull()
    expect(lastOwnerClaimantName([owner('Ägare', '2026-10-21T21:53:53+00:00'), owner('   ', null), owner(null, null)])).toBeNull()
  })

  it('still answers when a row has no readable date', () => {
    expect(lastOwnerClaimantName([owner('Kim', null)])).toBe('Kim')
    expect(lastOwnerClaimantName([owner('Kim', 'not a date'), owner('Anna', '2026-10-01T10:00:00+00:00')])).toBe('Anna')
  })
})
