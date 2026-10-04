import { describe, it, expect } from 'vitest'
import { normalizeOrgNumber } from '../column-utils'
import {
  createRegisterMatcher,
  customerMatchRow,
  NAME_MATCH_POLICY,
  normalizeCustomerNumber,
  normalizeNameForMatch,
  type MatchableRecord,
  type MatchableRow,
} from '../register-match'

const orgKey = normalizeOrgNumber

function rec(id: string, overrides: Partial<MatchableRecord> = {}): MatchableRecord {
  return { id, name: `Kund ${id}`, org_number: null, email: null, customer_number: null, ...overrides }
}

function row(overrides: Partial<MatchableRow> = {}): MatchableRow {
  return { name: 'Ny kund', org_number: null, email: null, customer_number: null, ...overrides }
}

describe('normalizers', () => {
  it('compares customer numbers trimmed and case-insensitively', () => {
    expect(normalizeCustomerNumber(' K-001 ')).toBe('k-001')
    expect(normalizeCustomerNumber('   ')).toBeNull()
    expect(normalizeCustomerNumber(null)).toBeNull()
  })

  it('compares names trimmed, case-insensitively, with whitespace collapsed', () => {
    expect(normalizeNameForMatch('  Acme   AB ')).toBe('acme ab')
    expect(normalizeNameForMatch('')).toBeNull()
  })
})

describe('createRegisterMatcher', () => {
  it('defaults to asking about name matches', () => {
    expect(NAME_MATCH_POLICY).toBe('ask')
  })

  it('matches on customer number before org number and e-mail', () => {
    const matcher = createRegisterMatcher(
      [
        rec('by-org', { org_number: '5560217780' }),
        rec('by-email', { email: 'a@b.se' }),
        rec('by-number', { customer_number: '1001' }),
      ],
      { orgKey },
    )
    const found = matcher.find(row({ customer_number: '1001', email: 'A@B.se' }))
    expect(found?.record.id).toBe('by-number')
    expect(found?.matched_by).toBe('customer_number')
    expect(found?.possible).toBe(false)
  })

  it('falls back to org number, then e-mail', () => {
    const matcher = createRegisterMatcher(
      [rec('by-org', { org_number: '556021-7780' }), rec('by-email', { email: 'a@b.se' })],
      { orgKey },
    )
    expect(matcher.find(row({ customer_number: '9', org_number: '5560217780' }))?.matched_by).toBe('org_number')
    expect(matcher.find(row({ email: ' A@B.SE ' }))?.record.id).toBe('by-email')
  })

  it('never matches across two different org numbers', () => {
    const matcher = createRegisterMatcher(
      [rec('other', { customer_number: '1001', org_number: '5560217780', email: 'faktura@byra.se' })],
      { orgKey },
    )
    expect(matcher.find(row({ customer_number: '1001', org_number: '5562345678' }))).toBeNull()
    expect(matcher.find(row({ email: 'faktura@byra.se', org_number: '5562345678' }))).toBeNull()
    // No org number on one side is not a conflict.
    expect(matcher.find(row({ customer_number: '1001' }))?.record.id).toBe('other')
  })

  it('narrows a shared customer number with the later keys', () => {
    const matcher = createRegisterMatcher(
      [
        rec('acme', { name: 'Acme AB', customer_number: '5' }),
        rec('beta', { name: 'Beta AB', customer_number: '5' }),
      ],
      { orgKey },
    )
    const found = matcher.find(row({ name: 'beta ab', customer_number: '5' }))
    expect(found?.record.id).toBe('beta')
    expect(found?.matched_by).toBe('customer_number')
    expect(found?.possible).toBe(false)
  })

  it('takes the first record when nothing narrows a shared key', () => {
    const matcher = createRegisterMatcher(
      [rec('first', { org_number: '5560217780' }), rec('second', { org_number: '5560217780' })],
      { orgKey },
    )
    expect(matcher.find(row({ org_number: '5560217780' }))?.record.id).toBe('first')
  })

  it('reports a name-only match as possible and does not resolve it by itself', () => {
    const matcher = createRegisterMatcher([rec('anna', { name: 'Anna  Svensson' })], { orgKey })
    const r = row({ name: 'anna svensson' })

    const found = matcher.find(r)
    expect(found).toMatchObject({ matched_by: 'name', possible: true })
    expect(found?.record.id).toBe('anna')
    expect(matcher.resolve(r)).toBeNull()
    expect(matcher.resolve(r, 'anna')?.id).toBe('anna')
  })

  it('does not flag a same-name record with a different org number', () => {
    const matcher = createRegisterMatcher(
      [rec('x', { name: 'Acme AB', org_number: '5560217780' })],
      { orgKey },
    )
    expect(matcher.find(row({ name: 'Acme AB', org_number: '5562345678' }))).toBeNull()
  })

  it('resolves a name match by itself under the auto policy', () => {
    const matcher = createRegisterMatcher([rec('anna', { name: 'Anna Svensson' })], {
      orgKey,
      namePolicy: 'auto',
    })
    const found = matcher.find(row({ name: 'Anna Svensson' }))
    expect(found).toMatchObject({ matched_by: 'name', possible: false })
    expect(matcher.resolve(row({ name: 'Anna Svensson' }))?.id).toBe('anna')
  })

  it('lets a definite match win over the confirmed record', () => {
    const matcher = createRegisterMatcher(
      [rec('by-number', { customer_number: '7' }), rec('named', { name: 'Ny kund' })],
      { orgKey },
    )
    expect(matcher.resolve(row({ customer_number: '7' }), 'named')?.id).toBe('by-number')
  })

  it('ignores a confirmed id that is not an existing record', () => {
    const matcher = createRegisterMatcher([rec('a')], { orgKey })
    expect(matcher.resolve(row(), 'someone-elses-id')).toBeNull()
  })

  it('matches records added later in the batch, including by customer number', () => {
    const matcher = createRegisterMatcher<MatchableRecord>([], { orgKey })
    expect(matcher.find(row({ customer_number: '42' }))).toBeNull()

    matcher.add(rec('created', { customer_number: '42' }))

    expect(matcher.resolve(row({ customer_number: ' 42 ' }))?.id).toBe('created')
  })

  it('stops matching on a value an update in the batch replaced', () => {
    const matcher = createRegisterMatcher([rec('x', { email: 'old@b.se' })], { orgKey })
    matcher.add(rec('x', { email: 'new@b.se' }))

    expect(matcher.find(row({ email: 'old@b.se' }))).toBeNull()
    expect(matcher.find(row({ email: 'new@b.se' }))?.record.id).toBe('x')
  })
})

describe('customerMatchRow', () => {
  // Synthetic personnummer, never a real one.
  const PERSONAL_NUMBER = '19900101-1234'

  it('never lets an individual\'s personnummer match as an org number', () => {
    const matcher = createRegisterMatcher(
      [rec('legacy', { org_number: PERSONAL_NUMBER }), rec('by-email', { email: 'a@b.se' })],
      { orgKey },
    )
    const individual = { ...row({ org_number: PERSONAL_NUMBER }), customer_type: 'individual' }

    expect(matcher.find(customerMatchRow(individual))).toBeNull()
    // It still matches on the other keys.
    expect(matcher.find(customerMatchRow({ ...individual, email: 'a@b.se' }))?.matched_by).toBe('email')
  })

  it('keeps a business org number as its match key', () => {
    const business = { ...row({ org_number: '5560217780' }), customer_type: 'swedish_business' }
    expect(customerMatchRow(business)).toBe(business)
  })
})

describe('individuals and businesses with an org number', () => {
  const firm = rec('firm', {
    name: 'Bengtsson Bygg AB',
    customer_type: 'swedish_business',
    org_number: '5560217780',
    email: 'shared@b.se',
    customer_number: '1001',
  })
  const person = rec('person', {
    name: 'Bertil Bengtsson',
    customer_type: 'individual',
    email: 'shared@b.se',
    customer_number: '2001',
  })

  it('never matches an individual row to a business with an org number, on any key', () => {
    const matcher = createRegisterMatcher([firm], { orgKey })
    const individual = (overrides: Partial<MatchableRow>) =>
      customerMatchRow({ ...row(overrides), customer_type: 'individual' })

    expect(matcher.find(individual({ email: 'shared@b.se' }))).toBeNull()
    expect(matcher.find(individual({ customer_number: '1001' }))).toBeNull()
    // Not even offered as a possible duplicate on the name.
    expect(matcher.find(individual({ name: 'Bengtsson Bygg AB' }))).toBeNull()
    // A hand-built confirmation cannot merge it either.
    expect(matcher.resolve(individual({}), 'firm')).toBeNull()
  })

  it('never matches a business row with an org number to an individual', () => {
    const matcher = createRegisterMatcher([person], { orgKey })
    const business = (overrides: Partial<MatchableRow>) =>
      customerMatchRow({ ...row({ org_number: '5566778899', ...overrides }), customer_type: 'swedish_business' })

    expect(matcher.find(business({ email: 'shared@b.se' }))).toBeNull()
    expect(matcher.find(business({ customer_number: '2001' }))).toBeNull()
    expect(matcher.find(business({ name: 'Bertil Bengtsson' }))).toBeNull()
    expect(matcher.resolve(business({}), 'person')).toBeNull()
  })

  it('still matches an individual to an individual, and a business without an org number', () => {
    const noOrgFirm = rec('no-org', { customer_type: 'swedish_business', email: 'firm@b.se' })
    const matcher = createRegisterMatcher([firm, person, noOrgFirm], { orgKey })
    const individual = (overrides: Partial<MatchableRow>) =>
      customerMatchRow({ ...row(overrides), customer_type: 'individual' })

    // The shared e-mail finds the individual, not the business.
    expect(matcher.find(individual({ email: 'shared@b.se' }))?.record.id).toBe('person')
    expect(matcher.find(individual({ email: 'firm@b.se' }))?.record.id).toBe('no-org')
  })

  it('leaves rows and records without a customer type alone (the supplier register)', () => {
    const supplier = rec('s1', { org_number: '5560217780', email: 'shared@b.se' })
    const matcher = createRegisterMatcher([supplier], { orgKey })
    expect(matcher.find(row({ email: 'shared@b.se' }))?.record.id).toBe('s1')
  })
})
