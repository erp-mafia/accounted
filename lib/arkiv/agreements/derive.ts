import type { Payload } from '@/lib/documents/extract/fields'
import { addMonths, monthlySeries } from './dates'

/**
 * Arkiv phase 4: what an extracted agreement implies, computed from the
 * settled fields only. A field the two readings disagreed on, or that a check
 * rejected, stays out: the schedule that needs it waits for a person instead
 * of guessing. Nothing here touches the database.
 */
export type AgreementKind = 'rental' | 'lease' | 'loan' | 'subscription'
export type Period = 'monthly' | 'quarterly' | 'yearly' | 'one_time'
export type ObligationKind = 'payment' | 'deposit' | 'first_payment' | 'residual' | 'amortisation' | 'interest'

const KIND_BY_SCHEMA: Record<string, AgreementKind> = {
  'agreement.rental': 'rental',
  'agreement.lease': 'lease',
  'agreement.loan': 'loan',
  'agreement.subscription': 'subscription',
}

export function agreementKindFor(schemaType: string | null | undefined): AgreementKind | null {
  return (schemaType && KIND_BY_SCHEMA[schemaType]) || null
}

export interface Citation {
  page: number | null
  quote: string | null
}

export interface AgreementDraft {
  kind: AgreementKind
  title: string
  counterparty: { name: string | null; orgNumber: string | null }
  startsOn: string | null
  endsOn: string | null
  noticeMonths: number | null
  renewalTerms: string | null
  amount: number | null
  currency: string
  period: Period | null
  principal: number | null
  interestRate: number | null
  /** Where each value used stands in the document. */
  sources: Record<string, Citation>
}

export interface ObligationDraft {
  kind: ObligationKind
  dueOn: string
  amount: number
  currency: string
  /** Computed from other values rather than printed. */
  estimate: boolean
  fields: string[]
}

export interface DeadlineDraft {
  key: 'notice' | 'end' | 'maturity' | 'amortisation_start'
  title: string
  dueOn: string
  priority: 'important' | 'normal'
  fields: string[]
}

export interface Derivation {
  agreement: AgreementDraft
  obligations: ObligationDraft[]
  deadlines: DeadlineDraft[]
  /** Fields a schedule needed that are missing or under review. */
  waitingOn: string[]
}

/** How far the schedule reaches: two months back so a payment that just arrived can be matched, a year ahead. */
export const HORIZON = { pastDays: 60, futureMonths: 12 } as const

const PERIOD_MONTHS: Record<Exclude<Period, 'one_time'>, number> = { monthly: 1, quarterly: 3, yearly: 12 }

const roundOre = (n: number) => Math.round(n * 100) / 100

export function deriveAgreement(input: { schemaType: string; payload: Payload; reviewFields: string[]; today: string }): Derivation | null {
  const kind = agreementKindFor(input.schemaType)
  if (!kind) return null
  const record = new SettledRecord(input.payload, input.reviewFields)
  const window = { from: addDaysIso(input.today, -HORIZON.pastDays), to: addMonths(input.today, HORIZON.futureMonths) }
  const derivation = DERIVERS[kind](record, window, input.today)
  derivation.agreement.sources = record.sources
  return derivation
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Reads settled values out of a payload and remembers which fields were used. */
class SettledRecord {
  readonly sources: Record<string, Citation> = {}
  readonly waitingOn = new Set<string>()

  constructor(
    private readonly payload: Payload,
    private readonly reviewFields: string[],
  ) {}

  private settled(name: string): string | number | null {
    const field = this.payload[name]
    if (!field || field.normalized == null || this.reviewFields.includes(name)) {
      if (field?.value != null) this.waitingOn.add(name)
      return null
    }
    this.sources[name] = { page: field.page, quote: field.quote }
    return field.normalized
  }

  text(name: string): string | null {
    const v = this.settled(name)
    return typeof v === 'string' ? v : null
  }

  number(name: string): number | null {
    const v = this.settled(name)
    return typeof v === 'number' ? v : null
  }

  date(name: string): string | null {
    const v = this.settled(name)
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
  }

  /** The fields a schedule needed but could not use, in field order. */
  missing(...names: string[]): string[] {
    return names.filter((n) => this.waitingOn.has(n) || this.payload[n]?.normalized == null)
  }
}

type Window = { from: string; to: string }
type Deriver = (record: SettledRecord, window: Window, today: string) => Derivation

const DERIVERS: Record<AgreementKind, Deriver> = {
  rental(record, window, today) {
    const counterparty = party(record, 'landlord')
    const amount = record.number('monthly_rent')
    const currency = record.text('rent_currency') ?? 'SEK'
    const startsOn = record.date('starts_on')
    const endsOn = record.date('ends_on')
    const noticeMonths = record.number('notice_months')
    const renewalTerms = record.text('renewal_terms')
    const title = `Hyresavtal ${record.text('premises_address') ?? counterparty.name ?? ''}`.trim()

    const obligations: ObligationDraft[] = []
    if (amount != null && startsOn) {
      for (const dueOn of monthlySeries(startsOn, 1, { ...window, end: endsOn })) {
        obligations.push({ kind: 'payment', dueOn, amount, currency, estimate: false, fields: ['monthly_rent', 'starts_on'] })
      }
      const deposit = record.number('deposit_amount')
      if (deposit != null && startsOn >= window.from && startsOn <= window.to) {
        obligations.push({ kind: 'deposit', dueOn: startsOn, amount: deposit, currency, estimate: false, fields: ['deposit_amount', 'starts_on'] })
      }
    }
    const deadlines: DeadlineDraft[] = []
    if (endsOn && noticeMonths != null) {
      deadlines.push({ key: 'notice', title: `Sista dag att säga upp ${lower(title)}`, dueOn: addMonths(endsOn, -noticeMonths), priority: 'important', fields: ['ends_on', 'notice_months'] })
    }
    if (endsOn) {
      deadlines.push({ key: 'end', title: `${title} löper ut${renewalTerms ? ', förlängs annars' : ''}`, dueOn: endsOn, priority: 'normal', fields: ['ends_on'] })
    }
    return {
      agreement: { kind: 'rental', title, counterparty, startsOn, endsOn, noticeMonths, renewalTerms, amount, currency, period: 'monthly', principal: null, interestRate: null, sources: {} },
      obligations,
      deadlines: futureOnly(deadlines, today),
      waitingOn: record.missing('monthly_rent', 'starts_on'),
    }
  },

  lease(record, window, today) {
    const counterparty = party(record, 'lessor')
    const amount = record.number('monthly_fee')
    const currency = record.text('currency') ?? 'SEK'
    const startsOn = record.date('starts_on')
    const termMonths = record.number('term_months')
    const endsOn = record.date('ends_on') ?? (startsOn && termMonths != null ? addMonths(startsOn, termMonths) : null)
    const title = `Leasingavtal ${record.text('object_description') ?? counterparty.name ?? ''}`.trim()

    const obligations: ObligationDraft[] = []
    if (amount != null && startsOn) {
      for (const dueOn of monthlySeries(startsOn, 1, { ...window, end: endsOn })) {
        obligations.push({ kind: 'payment', dueOn, amount, currency, estimate: false, fields: ['monthly_fee', 'starts_on'] })
      }
      const first = record.number('first_payment')
      if (first != null && inWindow(startsOn, window)) obligations.push({ kind: 'first_payment', dueOn: startsOn, amount: first, currency, estimate: false, fields: ['first_payment', 'starts_on'] })
      const residual = record.number('residual_value')
      if (residual != null && endsOn && inWindow(endsOn, window)) obligations.push({ kind: 'residual', dueOn: endsOn, amount: residual, currency, estimate: false, fields: ['residual_value', 'ends_on'] })
    }
    const deadlines: DeadlineDraft[] = endsOn ? [{ key: 'end', title: `${title} löper ut`, dueOn: endsOn, priority: 'normal', fields: ['ends_on'] }] : []
    return {
      agreement: { kind: 'lease', title, counterparty, startsOn, endsOn, noticeMonths: null, renewalTerms: null, amount, currency, period: 'monthly', principal: null, interestRate: null, sources: {} },
      obligations,
      deadlines: futureOnly(deadlines, today),
      waitingOn: record.missing('monthly_fee', 'starts_on'),
    }
  },

  loan(record, window, today) {
    const counterparty = party(record, 'lender')
    const principal = record.number('principal')
    const currency = record.text('currency') ?? 'SEK'
    const rate = record.number('interest_rate')
    const startsOn = record.date('disbursed_on')
    const termMonths = record.number('term_months')
    const endsOn = record.date('maturity_on') ?? (startsOn && termMonths != null ? addMonths(startsOn, termMonths) : null)
    const freeMonths = record.number('amortisation_free_months') ?? 0
    const step = periodMonths(record.text('instalment_frequency'))
    const printedInstalment = record.number('instalment_amount')
    // A bullet loan (free months cover the whole term, nothing printed as an instalment) is repaid at maturity.
    const periodic = printedInstalment != null || (termMonths != null && freeMonths < termMonths)
    const instalments = periodic && termMonths != null ? Math.max(1, Math.round((termMonths - freeMonths) / step)) : null
    const instalment = printedInstalment ?? (principal != null && instalments ? roundOre(principal / instalments) : null)
    // Interest that compounds or falls due at maturity or conversion is never a monthly payment.
    const interestAccrues = interestAccruesUntilMaturity(record.text('interest_terms'))
    const title = `Lån ${record.text('loan_number') ?? counterparty.name ?? ''}`.trim()

    const obligations: ObligationDraft[] = []
    const firstAmortisation = startsOn && periodic && instalment != null ? addMonths(startsOn, freeMonths + step) : null
    if (startsOn && principal != null) {
      let remaining = principal
      for (let k = 1; k <= 600; k++) {
        const dueOn = addMonths(startsOn, k * step)
        if (dueOn > (endsOn && endsOn < window.to ? endsOn : window.to)) break
        if (rate != null && !interestAccrues && inWindow(dueOn, window)) {
          obligations.push({ kind: 'interest', dueOn, amount: roundOre((remaining * rate) / 100 * (step / 12)), currency, estimate: true, fields: ['principal', 'interest_rate', 'disbursed_on'] })
        }
        if (firstAmortisation && instalment != null && dueOn >= firstAmortisation) {
          if (inWindow(dueOn, window)) {
            obligations.push({ kind: 'amortisation', dueOn, amount: instalment, currency, estimate: printedInstalment == null, fields: printedInstalment == null ? ['principal', 'term_months', 'disbursed_on'] : ['instalment_amount', 'disbursed_on'] })
          }
          remaining = Math.max(0, roundOre(remaining - instalment))
        }
      }
      if (!periodic && endsOn && inWindow(endsOn, window)) {
        // What comes on top (compounded interest) is not printed, so the amount is the principal and never matched on its own.
        obligations.push({ kind: 'amortisation', dueOn: endsOn, amount: principal, currency, estimate: interestAccrues, fields: ['principal', 'maturity_on'] })
      }
    }
    const deadlines: DeadlineDraft[] = []
    if (endsOn) deadlines.push({ key: 'maturity', title: `${title} förfaller till slutbetalning`, dueOn: endsOn, priority: 'important', fields: ['maturity_on'] })
    if (firstAmortisation && freeMonths > 0 && (!endsOn || firstAmortisation < endsOn)) {
      deadlines.push({ key: 'amortisation_start', title: `Amorteringen på ${lower(title)} börjar`, dueOn: firstAmortisation, priority: 'normal', fields: ['disbursed_on', 'amortisation_free_months'] })
    }
    return {
      agreement: {
        kind: 'loan',
        title,
        counterparty,
        startsOn,
        endsOn,
        noticeMonths: null,
        renewalTerms: null,
        amount: periodic ? instalment : principal,
        currency,
        period: periodic ? periodForMonths(step) : 'one_time',
        principal,
        interestRate: rate,
        sources: {},
      },
      obligations,
      deadlines: futureOnly(deadlines, today),
      waitingOn: record.missing('principal', 'disbursed_on'),
    }
  },

  subscription(record, window, today) {
    const counterparty = party(record, 'provider')
    const amount = record.number('fee_amount')
    const currency = record.text('currency') ?? 'SEK'
    const period = periodFromEnum(record.text('fee_period')) ?? 'monthly'
    const startsOn = record.date('starts_on')
    const endsOn = record.date('ends_on')
    const autoRenewal = record.text('auto_renewal') === 'yes'
    const noticeMonths = monthsFromProse(record.text('notice_period'))
    const title = `Abonnemang ${record.text('service_description') ?? counterparty.name ?? ''}`.trim()

    const obligations: ObligationDraft[] = []
    if (amount != null) {
      const anchor = startsOn ?? today
      const fields = startsOn ? ['fee_amount', 'fee_period', 'starts_on'] : ['fee_amount', 'fee_period']
      const dates = period === 'one_time' ? (inWindow(anchor, window) ? [anchor] : []) : monthlySeries(anchor, PERIOD_MONTHS[period], { ...window, end: endsOn })
      for (const dueOn of dates) obligations.push({ kind: 'payment', dueOn, amount, currency, estimate: false, fields })
    }
    const deadlines: DeadlineDraft[] = []
    if (endsOn && noticeMonths != null) {
      deadlines.push({ key: 'notice', title: `Sista dag att säga upp ${lower(title)}`, dueOn: addMonths(endsOn, -noticeMonths), priority: 'important', fields: ['ends_on', 'notice_period'] })
    }
    if (endsOn) deadlines.push({ key: 'end', title: `Bindningstiden för ${lower(title)} går ut${autoRenewal ? ', förlängs annars automatiskt' : ''}`, dueOn: endsOn, priority: 'normal', fields: ['ends_on'] })
    return {
      agreement: { kind: 'subscription', title, counterparty, startsOn, endsOn, noticeMonths, renewalTerms: autoRenewal ? 'Förlängs automatiskt' : null, amount, currency, period, principal: null, interestRate: null, sources: {} },
      obligations,
      deadlines: futureOnly(deadlines, today),
      waitingOn: record.missing('fee_amount'),
    }
  },
}

function party(record: SettledRecord, prefix: string): AgreementDraft['counterparty'] {
  return { name: record.text(`${prefix}_name`), orgNumber: record.text(`${prefix}_org_number`) }
}

const inWindow = (iso: string, window: Window) => iso >= window.from && iso <= window.to

const futureOnly = (deadlines: DeadlineDraft[], today: string) => deadlines.filter((d) => d.dueOn >= today)

/** "Hyresavtal Vasagatan 12" reads "hyresavtalet Vasagatan 12" inside a sentence. */
function lower(title: string): string {
  const [head, ...rest] = title.split(' ')
  const definite: Record<string, string> = { Hyresavtal: 'hyresavtalet', Leasingavtal: 'leasingavtalet', Lån: 'lånet', Abonnemang: 'abonnemanget' }
  return [definite[head] ?? head.toLowerCase(), ...rest].join(' ')
}

/** Interest that is compounded, added to the loan, or paid at maturity or conversion, as the terms describe it. */
function interestAccruesUntilMaturity(terms: string | null): boolean {
  return terms != null && /compound|kapitalis|added to the (loan|principal)|läggs till (lånet|kapitalet)|vid förfall|(on|at|upon) (the )?maturity|upon conversion|vid konvertering/i.test(terms)
}

/** Months between instalments from prose such as "kvartalsvis" or "per år"; monthly when unsaid. */
function periodMonths(prose: string | null): number {
  if (!prose) return 1
  if (/kvartal|quarter/i.test(prose)) return 3
  if (/\b(år|year|annual)/i.test(prose)) return 12
  return 1
}

function periodForMonths(months: number): Period {
  return months === 12 ? 'yearly' : months === 3 ? 'quarterly' : 'monthly'
}

function periodFromEnum(value: string | null): Period | null {
  return value === 'monthly' || value === 'quarterly' || value === 'yearly' || value === 'one_time' ? value : null
}

/** "3 månader" or "90 dagar" as whole months; null when the prose says something else. */
function monthsFromProse(prose: string | null): number | null {
  if (!prose) return null
  const months = prose.match(/(\d+)\s*(mån|month)/i)
  if (months) return Number(months[1])
  const days = prose.match(/(\d+)\s*(dag|day)/i)
  if (days) return Math.round(Number(days[1]) / 30)
  return null
}
