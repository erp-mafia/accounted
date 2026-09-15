import { describe, it, expect } from 'vitest'
import type { ExtractedField, Payload } from '@/lib/documents/extract/fields'
import { agreementKindFor, deriveAgreement } from '../derive'

const TODAY = '2026-09-15'

function payload(fields: Record<string, string | number | null>, pages: Record<string, number> = {}): Payload {
  const out: Payload = {}
  for (const [name, value] of Object.entries(fields)) {
    out[name] = { value, normalized: value, page: pages[name] ?? 1, quote: null, bbox: null, confidence: 1, method: 'consensus', readings: [] } satisfies ExtractedField
  }
  return out
}

describe('agreementKindFor', () => {
  it('knows the four agreement schemas and nothing else', () => {
    expect(agreementKindFor('agreement.rental')).toBe('rental')
    expect(agreementKindFor('agreement.loan')).toBe('loan')
    expect(agreementKindFor('registration.bolagsverket')).toBeNull()
    expect(deriveAgreement({ schemaType: 'generic', payload: {}, reviewFields: [], today: TODAY })).toBeNull()
  })
})

describe('deriveAgreement: rental', () => {
  const rental = payload(
    { landlord_name: 'Fastighets AB Kvarnen', landlord_org_number: '5560167452', premises_address: 'Vasagatan 12', monthly_rent: 12500, rent_currency: 'SEK', starts_on: '2026-01-01', ends_on: '2028-12-31', notice_months: 9, renewal_terms: '3 år i taget', deposit_amount: 37500 },
    { monthly_rent: 2, ends_on: 3, notice_months: 3 },
  )

  it('produces the agreement, the rents inside the horizon, and the notice and end dates with their pages', () => {
    const out = deriveAgreement({ schemaType: 'agreement.rental', payload: rental, reviewFields: [], today: TODAY })!
    expect(out.agreement).toMatchObject({ kind: 'rental', title: 'Hyresavtal Vasagatan 12', counterparty: { name: 'Fastighets AB Kvarnen', orgNumber: '5560167452' }, amount: 12500, period: 'monthly', endsOn: '2028-12-31', noticeMonths: 9 })
    expect(out.agreement.sources.monthly_rent).toEqual({ page: 2, quote: null })
    const dueDates = out.obligations.filter((o) => o.kind === 'payment').map((o) => o.dueOn)
    expect(dueDates[0]).toBe('2026-08-01')
    expect(dueDates.at(-1)).toBe('2027-09-01')
    expect(dueDates).toHaveLength(14)
    expect(out.obligations.every((o) => o.amount === 12500 && !o.estimate)).toBe(true)
    // The deposit fell due before the horizon and is not listed.
    expect(out.obligations.some((o) => o.kind === 'deposit')).toBe(false)
    expect(out.deadlines).toEqual([
      { key: 'notice', title: 'Sista dag att säga upp hyresavtalet Vasagatan 12', dueOn: '2028-03-31', priority: 'important', fields: ['ends_on', 'notice_months'] },
      { key: 'end', title: 'Hyresavtal Vasagatan 12 löper ut, förlängs annars', dueOn: '2028-12-31', priority: 'normal', fields: ['ends_on'] },
    ])
    expect(out.waitingOn).toEqual([])
  })

  it('holds the schedule while the rent is under review, and says so', () => {
    const out = deriveAgreement({ schemaType: 'agreement.rental', payload: rental, reviewFields: ['monthly_rent'], today: TODAY })!
    expect(out.obligations).toEqual([])
    expect(out.agreement.amount).toBeNull()
    expect(out.waitingOn).toEqual(['monthly_rent'])
    expect(out.deadlines).toHaveLength(2)
  })

  it('lists a deposit that falls inside the horizon and skips dates that already passed', () => {
    const fresh = payload({ landlord_name: 'Kvarnen AB', monthly_rent: 10000, starts_on: '2026-10-01', ends_on: '2026-03-01', notice_months: 3, deposit_amount: 20000 })
    const out = deriveAgreement({ schemaType: 'agreement.rental', payload: fresh, reviewFields: [], today: TODAY })!
    expect(out.obligations.find((o) => o.kind === 'deposit')).toMatchObject({ dueOn: '2026-10-01', amount: 20000 })
    expect(out.deadlines).toEqual([])
  })
})

describe('deriveAgreement: lease', () => {
  it('derives the end from the term, the first and residual payments, and the monthly fees', () => {
    const lease = payload({ lessor_name: 'Wasa Kredit AB', object_description: 'Volvo XC40 ABC123', monthly_fee: 4990, term_months: 36, starts_on: '2026-09-01', first_payment: 50000, residual_value: 150000 })
    const out = deriveAgreement({ schemaType: 'agreement.lease', payload: lease, reviewFields: [], today: TODAY })!
    expect(out.agreement).toMatchObject({ kind: 'lease', title: 'Leasingavtal Volvo XC40 ABC123', endsOn: '2029-09-01', amount: 4990 })
    expect(out.obligations.find((o) => o.kind === 'first_payment')).toMatchObject({ dueOn: '2026-09-01', amount: 50000 })
    expect(out.obligations.some((o) => o.kind === 'residual')).toBe(false)
    expect(out.obligations.filter((o) => o.kind === 'payment')).toHaveLength(13)
    expect(out.deadlines).toEqual([{ key: 'end', title: 'Leasingavtal Volvo XC40 ABC123 löper ut', dueOn: '2029-09-01', priority: 'normal', fields: ['ends_on'] }])
  })
})

describe('deriveAgreement: loan', () => {
  const loan = payload({ lender_name: 'Almi Stockholm AB', principal: 500000, currency: 'SEK', interest_rate: 11.1, term_months: 60, disbursed_on: '2026-02-02', amortisation_free_months: 12, instalment_amount: 10417, instalment_frequency: 'månadsvis', loan_number: '500050956' })

  it('estimates interest on the remaining principal, schedules amortisation after the free months, and dates the maturity', () => {
    const out = deriveAgreement({ schemaType: 'agreement.loan', payload: loan, reviewFields: [], today: TODAY })!
    expect(out.agreement).toMatchObject({ kind: 'loan', title: 'Lån 500050956', principal: 500000, interestRate: 11.1, amount: 10417, period: 'monthly', endsOn: '2031-02-02' })
    const interest = out.obligations.filter((o) => o.kind === 'interest')
    expect(interest[0]).toMatchObject({ dueOn: '2026-08-02', amount: 4625, estimate: true })
    const amortisation = out.obligations.filter((o) => o.kind === 'amortisation')
    expect(amortisation[0]).toMatchObject({ dueOn: '2027-03-02', amount: 10417, estimate: false })
    // Interest after the first instalment is charged on what remains.
    expect(interest.find((o) => o.dueOn === '2027-04-02')?.amount).toBe(4528.64)
    expect(out.deadlines).toEqual([
      { key: 'maturity', title: 'Lån 500050956 förfaller till slutbetalning', dueOn: '2031-02-02', priority: 'important', fields: ['maturity_on'] },
      { key: 'amortisation_start', title: 'Amorteringen på lånet 500050956 börjar', dueOn: '2027-03-02', priority: 'normal', fields: ['disbursed_on', 'amortisation_free_months'] },
    ])
  })

  it('computes the instalment from the principal and term when none is printed, and reads a quarterly rhythm', () => {
    const quarterly = payload({ lender_name: 'Banken AB', principal: 120000, interest_rate: 6, term_months: 24, disbursed_on: '2026-01-15', instalment_frequency: 'kvartalsvis' })
    const out = deriveAgreement({ schemaType: 'agreement.loan', payload: quarterly, reviewFields: [], today: TODAY })!
    expect(out.agreement).toMatchObject({ amount: 15000, period: 'quarterly' })
    const amortisation = out.obligations.filter((o) => o.kind === 'amortisation')
    expect(amortisation[0]).toMatchObject({ dueOn: '2026-10-15', amount: 15000, estimate: true })
    expect(out.obligations.find((o) => o.kind === 'interest' && o.dueOn === '2026-10-15')?.amount).toBe(1350)
  })

  it('treats a convertible with compounding interest as a bullet loan: no monthly rows, the principal at maturity, no amortisation start', () => {
    const convertible = payload({ lender_name: 'Propel Capital VII AB', lender_org_number: '5595138057', principal: 400000, interest_rate: 10, interest_terms: '10% per year, compounded, added to the Loan; payable on Maturity Date or upon Conversion', term_months: 24, disbursed_on: '2025-10-13', maturity_on: '2027-10-13', amortisation_free_months: 24 })
    const out = deriveAgreement({ schemaType: 'agreement.loan', payload: convertible, reviewFields: [], today: TODAY })!
    expect(out.agreement).toMatchObject({ amount: 400000, period: 'one_time', principal: 400000, endsOn: '2027-10-13' })
    expect(out.obligations).toEqual([])
    expect(out.deadlines).toEqual([{ key: 'maturity', title: 'Lån Propel Capital VII AB förfaller till slutbetalning', dueOn: '2027-10-13', priority: 'important', fields: ['maturity_on'] }])
    const soon = deriveAgreement({ schemaType: 'agreement.loan', payload: convertible, reviewFields: [], today: '2027-06-01' })!
    expect(soon.obligations).toEqual([{ kind: 'amortisation', dueOn: '2027-10-13', amount: 400000, currency: 'SEK', estimate: true, fields: ['principal', 'maturity_on'] }])
  })

  it('waits for the principal before scheduling anything', () => {
    const out = deriveAgreement({ schemaType: 'agreement.loan', payload: loan, reviewFields: ['principal'], today: TODAY })!
    expect(out.obligations).toEqual([])
    expect(out.waitingOn).toEqual(['principal'])
  })
})

describe('deriveAgreement: subscription', () => {
  it('bills per period from the start, reads the notice period out of prose and marks automatic renewal', () => {
    const sub = payload({ provider_name: 'Fortnox AB', service_description: 'Fortnox Bokföring', fee_amount: 299, fee_period: 'monthly', starts_on: '2026-03-10', ends_on: '2027-03-09', notice_period: '3 månader före bindningstidens slut', auto_renewal: 'yes' })
    const out = deriveAgreement({ schemaType: 'agreement.subscription', payload: sub, reviewFields: [], today: TODAY })!
    expect(out.agreement).toMatchObject({ kind: 'subscription', title: 'Abonnemang Fortnox Bokföring', amount: 299, period: 'monthly', noticeMonths: 3, renewalTerms: 'Förlängs automatiskt' })
    expect(out.obligations.map((o) => o.dueOn)).toEqual(['2026-08-10', '2026-09-10', '2026-10-10', '2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10'])
    expect(out.deadlines).toEqual([
      { key: 'notice', title: 'Sista dag att säga upp abonnemanget Fortnox Bokföring', dueOn: '2026-12-09', priority: 'important', fields: ['ends_on', 'notice_period'] },
      { key: 'end', title: 'Bindningstiden för abonnemanget Fortnox Bokföring går ut, förlängs annars automatiskt', dueOn: '2027-03-09', priority: 'normal', fields: ['ends_on'] },
    ])
  })

  it('anchors on today when no start date is printed, and bills a one-time fee once', () => {
    const yearly = payload({ provider_name: 'Domänbolaget', service_description: 'domän', fee_amount: 1200, fee_period: 'yearly' })
    const out = deriveAgreement({ schemaType: 'agreement.subscription', payload: yearly, reviewFields: [], today: TODAY })!
    expect(out.obligations.map((o) => o.dueOn)).toEqual([TODAY, '2027-09-15'])
    const once = payload({ provider_name: 'X', service_description: 'licens', fee_amount: 5000, fee_period: 'one_time', starts_on: '2026-10-01' })
    expect(deriveAgreement({ schemaType: 'agreement.subscription', payload: once, reviewFields: [], today: TODAY })!.obligations).toEqual([{ kind: 'payment', dueOn: '2026-10-01', amount: 5000, currency: 'SEK', estimate: false, fields: ['fee_amount', 'fee_period', 'starts_on'] }])
  })
})

describe('phase 6 kinds', () => {
  const today = '2026-09-15'
  const f = (value: string | number, page = 1) => ({ value, normalized: value, page, quote: 'q', bbox: null, confidence: 1, method: 'consensus' as const, readings: [] })

  it('schedules insurance premiums per period with renewal and notice dates', () => {
    const out = deriveAgreement({
      schemaType: 'agreement.insurance',
      payload: { insurer_name: f('Trygg AB'), policy_number: f('P-1'), premium_amount: f(3720), premium_period: f('quarterly'), starts_on: f('2026-01-01'), ends_on: f('2026-12-31'), notice_months: f(1), auto_renewal: f('yes') },
      reviewFields: [],
      today,
    })!
    expect(out.agreement).toMatchObject({ kind: 'insurance', title: 'Försäkring P-1', amount: 3720, period: 'quarterly', renewalTerms: 'Förnyas automatiskt', noticeMonths: 1 })
    expect(out.obligations.map((o) => o.dueOn)).toEqual(['2026-10-01'])
    expect(out.obligations[0]).toMatchObject({ kind: 'payment', amount: 3720, estimate: false })
    expect(out.deadlines.map((d) => [d.key, d.dueOn, d.title])).toEqual([
      ['notice', '2026-11-30', 'Sista dag att säga upp försäkringen P-1'],
      ['end', '2026-12-31', 'Försäkring P-1 förnyas'],
    ])
  })

  it('keeps salary out of expected payments and watches a probation end', () => {
    const out = deriveAgreement({
      schemaType: 'agreement.employment',
      payload: { employee_name: f('Alice Jönsson'), monthly_salary: f(42000), starts_on: f('2026-09-01'), ends_on: f('2027-02-28'), employment_form: f('probation'), notice_months: f(1) },
      reviewFields: [],
      today,
    })!
    expect(out.agreement).toMatchObject({ kind: 'employment', title: 'Anställningsavtal Alice Jönsson', counterparty: { name: 'Alice Jönsson', orgNumber: null }, amount: 42000, period: 'monthly' })
    expect(out.obligations).toEqual([])
    expect(out.deadlines).toEqual([{ key: 'end', title: 'Provanställningen för Alice Jönsson går ut', dueOn: '2027-02-28', priority: 'important', fields: ['ends_on'] }])
  })

  it('expects an investment to arrive at closing and a customer fee to arrive each period', () => {
    const investment = deriveAgreement({
      schemaType: 'agreement.investment',
      payload: { investor_name: f('Propel VII AB'), investor_org_number: f('5595138057'), investment_amount: f(400000), closing_on: f('2026-10-13'), signed_on: f('2026-09-10') },
      reviewFields: [],
      today,
    })!
    expect(investment.obligations).toEqual([{ kind: 'payment', dueOn: '2026-10-13', amount: 400000, currency: 'SEK', estimate: false, fields: ['investment_amount', 'closing_on'], direction: 'in' }])
    expect(investment.deadlines[0]).toMatchObject({ key: 'closing', title: 'Tillträde för investeringen Propel VII AB' })

    const customer = deriveAgreement({
      schemaType: 'agreement.customer',
      payload: { customer_name: f('Kund AB'), service_description: f('Bokföring'), fee_amount: f(2500), fee_period: f('monthly'), starts_on: f('2026-08-01') },
      reviewFields: [],
      today,
    })!
    expect(customer.agreement).toMatchObject({ kind: 'customer', title: 'Kundavtal Kund AB', period: 'monthly' })
    expect(customer.obligations.every((o) => o.direction === 'in')).toBe(true)
    expect(customer.obligations.map((o) => o.dueOn).slice(0, 3)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])
  })

  it('records a shareholders agreement and any other agreement without inventing payments', () => {
    const sha = deriveAgreement({ schemaType: 'agreement.shareholder', payload: { parties_summary: f('A och B'), company_name: f('Arcim Technology AB'), effective_on: f('2026-01-01') }, reviewFields: [], today })!
    expect(sha.agreement).toMatchObject({ kind: 'shareholder', title: 'Aktieägaravtal Arcim Technology AB', startsOn: '2026-01-01', amount: null })
    expect(sha.obligations).toEqual([])
    const other = deriveAgreement({ schemaType: 'agreement.other', payload: { counterparty_name: f('Sting'), subject: f('Core-programmet'), amount: f(0), ends_on: f('2026-12-31'), notice_months: f(2) }, reviewFields: [], today })!
    expect(other.agreement).toMatchObject({ kind: 'other', title: 'Avtal Sting', period: 'one_time' })
    expect(other.obligations).toEqual([])
    expect(other.deadlines.map((d) => d.key)).toEqual(['notice', 'end'])
    expect(other.waitingOn).toEqual([])
  })
})
