import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { encryptCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import {
  adoptExistingCustomers,
  buildCustomerCards,
  customerNameKey,
  customerRegisterFacts,
  matchExistingCustomer,
  salesInvoicePartyFacts,
  type CustomerCard,
} from '../customer-match'
import { partyOrgKey } from '@/lib/invariants/org-number'

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

// Skatteverket's published test personnummer, never an invented one.
const PERSON = '195001182046'
const OTHER_PERSON = '201212121212'

const card = (id: string, overrides: Partial<CustomerCard> = {}): CustomerCard =>
  ({ id, identities: [], ...overrides })

beforeEach(() => {
  vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'customer-match-unit-test-only')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('keys', () => {
  it('reads an org number or personnummer the same in every written form', () => {
    expect(partyOrgKey('556677-8899')).toBe('5566778899')
    expect(partyOrgKey('16556677-8899')).toBe('5566778899')
    expect(partyOrgKey('19500118-2046')).toBe('5001182046')
    expect(partyOrgKey('500118-2046')).toBe('5001182046')
    expect(partyOrgKey('DE 123 456 789')).toBe('DE123456789')
    expect(partyOrgKey('  ')).toBeNull()
  })

  it('folds case and whitespace out of a name, nothing else', () => {
    expect(customerNameKey('  Anna   EXEMPEL ')).toBe('anna exempel')
    expect(customerNameKey('Åsa Ögren')).toBe('åsa ögren')
    expect(customerNameKey('Anna Exempel AB')).not.toBe(customerNameKey('Anna Exempel'))
  })
})

describe('matchExistingCustomer', () => {
  it('finds a hand-made privatperson card by the personnummer the invoice carries as its org number (crm#1294)', () => {
    const cards = [card('hand-made', { identities: ['5001182046'], number: '2329', name: 'anna exempel' }), card('other', { name: 'bo exempel' })]
    expect(matchExistingCustomer({ identity: '5001182046', number: '2329', name: 'anna exempel' }, cards)).toBe('hand-made')
  })

  it('finds a card by the source customer number typed into it, under a longer name', () => {
    const cards = [card('hand-made', { number: '2329', name: 'sam daniel exempel' })]
    expect(matchExistingCustomer({ number: '2329', name: 'sam exempel' }, cards)).toBe('hand-made')
  })

  it('does not take a customer number for identity when the names share no word', () => {
    // The user numbered the cards their own way: number 12 is someone else.
    const cards = [card('someone-else', { number: '12', name: 'bo exempel' })]
    expect(matchExistingCustomer({ number: '12', name: 'anna prov' }, cards)).toBeNull()
  })

  it('finds a card by a name that differs only in case and whitespace', () => {
    const cards = [card('hand-made', { name: customerNameKey('Anna Exempel') })]
    expect(matchExistingCustomer({ name: customerNameKey(' anna  EXEMPEL ') }, cards)).toBe('hand-made')
  })

  it('keeps two customers apart that share a name but not an org number', () => {
    const cards = [card('first', { identities: ['5566778899'], name: 'exempel ab' })]
    expect(matchExistingCustomer({ identity: '5599001122', name: 'exempel ab' }, cards)).toBeNull()
  })

  it('keeps two customers apart that share a name but not a personnummer', () => {
    const cards = [card('first', { identities: [partyOrgKey(PERSON)!], name: 'anna exempel' })]
    expect(matchExistingCustomer({ identity: partyOrgKey(OTHER_PERSON)!, name: 'anna exempel' }, cards)).toBeNull()
  })

  it('keeps two customers apart that share a name but not a customer number', () => {
    const cards = [card('first', { number: '101', name: 'anna exempel' })]
    expect(matchExistingCustomer({ number: '202', name: 'anna exempel' }, cards)).toBeNull()
  })

  it('does not guess between two cards with the same name', () => {
    const cards = [card('one', { name: 'anna exempel' }), card('two', { name: 'anna exempel' })]
    expect(matchExistingCustomer({ name: 'anna exempel' }, cards)).toBeNull()
  })

  it('tells two cards on the same identity apart by the weaker keys', () => {
    const cards = [
      card('one', { identities: ['5566778899'], number: '1', name: 'exempel ab' }),
      card('two', { identities: ['5566778899'], number: '2', name: 'exempel ab' }),
    ]
    expect(matchExistingCustomer({ identity: '5566778899', number: '2' }, cards)).toBe('two')
    expect(matchExistingCustomer({ identity: '5566778899' }, cards)).toBeNull()
  })

  it('matches on the VAT number before the customer number and the name', () => {
    const cards = [card('by-vat', { vat: 'SE556677889901', name: 'old name ab' }), card('by-name', { name: 'new name ab' })]
    expect(matchExistingCustomer({ vat: 'SE556677889901', name: 'new name ab' }, cards)).toBe('by-vat')
  })

  it('lets a strong key share a card another source customer maps to, a name never', () => {
    const claimed = new Set(['hand-made'])
    const cards = [card('hand-made', { identities: ['5001182046'], number: '2329', name: 'anna exempel' })]
    // The same person entered twice at the source: the personnummer says so.
    expect(matchExistingCustomer({ identity: '5001182046', number: '9001', name: 'anna exempel' }, cards, claimed)).toBe('hand-made')
    // The card's own customer number.
    expect(matchExistingCustomer({ number: '2329', name: 'anna exempel' }, cards, claimed)).toBe('hand-made')
    // Only the name: someone else with the same name.
    const nameOnly = [card('hand-made', { name: 'anna exempel' })]
    expect(matchExistingCustomer({ number: '9001', name: 'anna exempel' }, nameOnly, claimed)).toBeNull()
    expect(matchExistingCustomer({ number: '9001', name: 'anna exempel' }, nameOnly)).toBe('hand-made')
  })

  it('finds the hand-made cards among several customers that share one org number (crm#1398)', () => {
    // Departments of one public authority: one org number, a customer number
    // and a name each. Two were entered by hand before the import.
    const cards = [
      card('hand-120', { identities: ['2021000001'], number: '120', name: 'myndigheten avdelning a' }),
      card('hand-400', { identities: ['2021000001'], number: '400', name: 'myndigheten avdelning b' }),
    ]
    const department = (number: string, name: string) => ({ identity: '2021000001', number, name })
    expect(matchExistingCustomer(department('120', 'myndigheten, avd a'), cards)).toBe('hand-120')
    expect(matchExistingCustomer(department('400', 'myndigheten, avd b'), cards)).toBe('hand-400')
    for (const number of ['110', '112', '130', '132', '150', '301']) {
      expect(matchExistingCustomer(department(number, `myndigheten avdelning ${number}`), cards)).toBeNull()
    }
  })

  it('does not fold another department into the only card with its org number', () => {
    const cards = [card('hand-120', { identities: ['2021000001'], vat: 'SE202100000101', number: '120', name: 'myndigheten avdelning a' })]
    expect(matchExistingCustomer({ identity: '2021000001', number: '110', name: 'myndigheten avdelning c' }, cards)).toBeNull()
    expect(matchExistingCustomer({ vat: 'SE202100000101', number: '110', name: 'myndigheten avdelning c' }, cards)).toBeNull()
    // The department the card is for, and a source record with no number of its own.
    expect(matchExistingCustomer({ identity: '2021000001', number: '120', name: 'myndigheten avd a' }, cards)).toBe('hand-120')
    expect(matchExistingCustomer({ identity: '2021000001', name: 'myndigheten avdelning c' }, cards)).toBe('hand-120')
  })

  it('keeps an org-number match under the user\'s own numbering when the name is the same', () => {
    const cards = [card('hand-made', { identities: ['5566778899'], number: '1', name: 'exempel ab' })]
    expect(matchExistingCustomer({ identity: '5566778899', number: '2329', name: 'exempel ab' }, cards)).toBe('hand-made')
  })

  it('answers null when nothing matches', () => {
    expect(matchExistingCustomer({ name: 'anna exempel' }, [card('x', { name: 'bo exempel' })])).toBeNull()
    expect(matchExistingCustomer({}, [card('x', { name: 'bo exempel' })])).toBeNull()
  })
})

describe('facts', () => {
  it('reads the Fortnox customer number and the org-number field of a sales invoice', () => {
    const invoice = {
      customer: { name: ' Anna  Exempel', identifications: [{ id: '19500118-2046', schemeId: 'SE:ORGNR' }] },
      _raw: { CustomerNumber: '2329' },
    } as unknown as SalesInvoiceDto
    expect(salesInvoicePartyFacts('fortnox', invoice)).toEqual({
      identity: '5001182046', vat: undefined, number: '2329', name: 'anna exempel',
    })
  })

  it('takes no customer number from a provider whose field is an internal id', () => {
    const invoice = { customer: { name: 'Anna', identifications: [] }, _raw: { CustomerNumber: '7' } } as unknown as SalesInvoiceDto
    expect(salesInvoicePartyFacts('bokio', invoice).number).toBeUndefined()
  })

  it('reads the VAT number and customer number of a register customer', () => {
    expect(customerRegisterFacts('fortnox', {
      id: '17', customerNumber: '17', active: true, vatNumber: 'se 5566778899 01',
      party: { name: 'Exempel AB', identifications: [{ id: '556677-8899', schemeId: 'SE:ORGNR' }] },
    })).toEqual({ identity: '5566778899', vat: 'SE556677889901', number: '17', name: 'exempel ab' })
  })
})

describe('buildCustomerCards', () => {
  it('decrypts the personnummer into an identity key', () => {
    const [built] = buildCustomerCards([{ id: 'c', name: 'Anna Exempel', org_number: null,
      personal_number: encryptCustomerPersonalNumber('19500118-2046'), vat_number: null, customer_number: ' 2329 ' }])
    expect(built).toEqual({ id: 'c', identities: ['5001182046'], vat: undefined, number: '2329', name: 'anna exempel' })
  })

  it('leaves an undecryptable personnummer out and keeps the card', () => {
    const [built] = buildCustomerCards([{ id: 'c', name: 'Anna', org_number: null,
      personal_number: 'ab'.repeat(40), vat_number: null, customer_number: null }])
    expect(built).toEqual({ id: 'c', identities: [], vat: undefined, number: undefined, name: 'anna' })
  })
})

describe('adoptExistingCustomers', () => {
  const job = { id: 'job', company_id: 'company', provider: 'fortnox', account_key: '5560000000',
    created_at: '2026-10-18T08:32:56Z' } as ProviderMigrationJob

  function database(customers: Record<string, unknown>[], mappings: { source_id: string; target_id: string }[] = []) {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      mappings.push({ source_id: args.p_source_id as string, target_id: args.p_customer as string })
      return { data: args.p_customer, error: null }
    })
    const reads: string[] = []
    const supabase = {
      rpc,
      from: (table: string) => {
        let sources: unknown[] | null = null
        let before: string | null = null
        const chain = {
          select: () => chain, eq: () => chain, is: () => chain, order: () => chain, range: () => chain,
          in: (_key: string, values: unknown[]) => { sources = values; return chain },
          lt: (_key: string, value: string) => { before = value; return chain },
          then: (resolve: (value: unknown) => void) => {
            reads.push(table)
            const data = table === 'customers'
              ? customers.filter((c) => !before || String(c.created_at ?? '') < before)
              : mappings.filter((m) => !sources || sources.includes(m.source_id))
            return resolve({ data, error: null })
          },
        }
        return chain
      },
    } as unknown as SupabaseClient
    return { supabase, rpc, reads, mappings }
  }
  const within = <T>(promise: PromiseLike<T>) => Promise.resolve(promise)
  // Encrypted per test, under the key beforeEach stubs.
  const handMade = () => ({ id: 'hand-made', name: 'Anna Exempel', org_number: null, created_at: '2026-10-18T07:44:32Z',
    personal_number: encryptCustomerPersonalNumber(PERSON), vat_number: null, customer_number: '2329' })

  it('maps an unmapped source customer onto the hand-made card before the commit (crm#1294)', async () => {
    const db = database([handMade()])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: '2329', facts: { identity: partyOrgKey(PERSON)!, number: '2329', name: 'anna exempel' } }], within)
    expect(adopted).toBe(1)
    expect(db.rpc).toHaveBeenCalledWith('adopt_provider_migration_invoice_party',
      { p_job_id: 'job', p_source_id: '2329', p_customer: 'hand-made' })
  })

  it('leaves a source customer with a mapping alone, so a re-run creates and moves nothing', async () => {
    const db = database([handMade()], [{ source_id: '2329', target_id: 'stub-from-an-earlier-run' }])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: '2329', facts: { number: '2329', name: 'anna exempel' } }], within)
    expect(adopted).toBe(0)
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.reads).toEqual(['migration_source_records'])
  })

  it('does not hand one card to a second source customer of the same connection', async () => {
    const db = database([{ ...handMade(), personal_number: null, customer_number: null }],
      [{ source_id: '1001', target_id: 'hand-made' }])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: '1002', facts: { number: '1002', name: 'anna exempel' } }], within)
    expect(adopted).toBe(0)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('lets a derived party id (no source customer behind it) share a card', async () => {
    const db = database([{ ...handMade(), personal_number: null, customer_number: null }],
      [{ source_id: '1001', target_id: 'hand-made' }])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: 'invoice-party:abc', facts: { name: 'anna exempel' } }], within)
    expect(adopted).toBe(1)
  })

  it('maps two source customers of one batch onto two cards, never one card twice', async () => {
    const db = database([{ ...handMade(), personal_number: null, customer_number: null }])
    const adopted = await adoptExistingCustomers(db.supabase, job, [
      { sourceId: '1001', facts: { number: '1001', name: 'anna exempel' } },
      { sourceId: '1002', facts: { number: '1002', name: 'anna exempel' } },
    ], within)
    expect(adopted).toBe(1)
    expect(db.mappings).toEqual([{ source_id: '1001', target_id: 'hand-made' }])
  })

  it('never folds a source customer into a card the job itself created', async () => {
    // Two departments under one org number: the job made a card for the
    // first; the second keeps its own, as resolve_provider_migration_party rules.
    const db = database([{ id: 'made-by-the-job', name: 'Exempel AB', org_number: '556677-8899', created_at: '2026-10-18T08:33:04Z',
      personal_number: null, vat_number: null, customer_number: null }], [{ source_id: '1', target_id: 'made-by-the-job' }])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: '2', facts: { identity: '5566778899', number: '2', name: 'exempel ab' } }], within)
    expect(adopted).toBe(0)
  })

  it('puts a customer entered twice at the source on the one card its personnummer names', async () => {
    const db = database([handMade()], [{ source_id: '2329', target_id: 'hand-made' }])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: '9001', facts: { identity: partyOrgKey(PERSON)!, number: '9001', name: 'anna exempel' } }], within)
    expect(adopted).toBe(1)
    expect(db.mappings).toContainEqual({ source_id: '9001', target_id: 'hand-made' })
  })

  it('maps a Visma register onto the two hand-made cards of departments that share an org number (crm#1398)', async () => {
    const department = (id: string, number: string, name: string) => ({ id, name, org_number: '202100-0001',
      created_at: '2026-10-04T17:36:16Z', personal_number: null, vat_number: null, customer_number: number })
    const db = database([department('hand-120', '120', 'Myndigheten Avdelning A'), department('hand-400', '400', 'Myndigheten Avdelning B')])
    const facts = (number: string, name: string) => ({ identity: '2021000001', number, name: customerNameKey(name) })
    const adopted = await adoptExistingCustomers(db.supabase, { ...job, provider: 'visma' }, [
      { sourceId: 'visma-110', facts: facts('110', 'Myndigheten Avdelning C') },
      { sourceId: 'visma-120', facts: facts('120', 'Myndigheten, avd A') },
      { sourceId: 'visma-400', facts: facts('400', 'Myndigheten, avd B') },
    ], within)
    expect(adopted).toBe(2)
    expect(db.mappings).toEqual([
      { source_id: 'visma-120', target_id: 'hand-120' },
      { source_id: 'visma-400', target_id: 'hand-400' },
    ])
  })

  it('does nothing without the job start', async () => {
    const db = database([handMade()])
    const adopted = await adoptExistingCustomers(db.supabase, { ...job, created_at: undefined } as unknown as ProviderMigrationJob,
      [{ sourceId: '2329', facts: { number: '2329', name: 'anna exempel' } }], within)
    expect(adopted).toBe(0)
    expect(db.reads).toEqual([])
  })

  it('creates nothing and calls nothing when no card matches', async () => {
    const db = database([handMade()])
    const adopted = await adoptExistingCustomers(db.supabase, job,
      [{ sourceId: '9', facts: { identity: partyOrgKey(OTHER_PERSON)!, number: '9', name: 'bo prov' } }], within)
    expect(adopted).toBe(0)
    expect(db.rpc).not.toHaveBeenCalled()
  })
})
