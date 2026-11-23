import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildLedgerContext, voucherSeriesInUse } from '../ledger-context'
import { profileFactsFrom, profileLine, readProfileFacts, type ProfileFacts } from '../profile-line'

/**
 * The sentence above the list of Bokföringsregler (lib/agent-context/profile-line.ts):
 * how the company books, from the values the bookkeeping profile shows.
 */

const rulesSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'rules' })
const rulesEn = createTranslator({ locale: 'en', messages: en, namespace: 'rules' })
const line = (facts: ProfileFacts) => ({
  sv: profileLine(facts, (key, values) => rulesSv(key as never, values as never), 'sv'),
  en: profileLine(facts, (key, values) => rulesEn(key as never, values as never), 'en'),
})

describe('the sentence, in both languages', () => {
  it('names the method, the VAT period and the series when the company has all three', () => {
    expect(line({ method: 'accrual', vatPeriod: 'yearly', series: ['A'] })).toEqual({
      sv: 'Företaget bokför med fakturametoden, redovisar moms årsvis och använder serie A.',
      en: 'The company books with the accrual method, reports VAT yearly and uses series A.',
    })
    expect(line({ method: 'cash', vatPeriod: 'quarterly', series: ['A', 'B', 'M'] })).toEqual({
      sv: 'Företaget bokför med kontantmetoden, redovisar moms kvartalsvis och använder serierna A, B och M.',
      en: 'The company books with the cash method, reports VAT quarterly and uses series A, B and M.',
    })
    expect(line({ method: 'accrual', vatPeriod: 'monthly', series: ['A', 'B'] })).toEqual({
      sv: 'Företaget bokför med fakturametoden, redovisar moms månadsvis och använder serierna A och B.',
      en: 'The company books with the accrual method, reports VAT monthly and uses series A and B.',
    })
  })

  it('leaves out the part the company has no value for', () => {
    expect(line({ method: 'accrual', vatPeriod: null, series: ['A'] })).toEqual({
      sv: 'Företaget bokför med fakturametoden och använder serie A.',
      en: 'The company books with the accrual method and uses series A.',
    })
    expect(line({ method: null, vatPeriod: 'yearly', series: ['A'] })).toEqual({
      sv: 'Företaget redovisar moms årsvis och använder serie A.',
      en: 'The company reports VAT yearly and uses series A.',
    })
    expect(line({ method: 'cash', vatPeriod: 'monthly', series: [] })).toEqual({
      sv: 'Företaget bokför med kontantmetoden och redovisar moms månadsvis.',
      en: 'The company books with the cash method and reports VAT monthly.',
    })
  })

  it('is one part when the company has only one', () => {
    expect(line({ method: 'accrual', vatPeriod: null, series: [] })).toEqual({
      sv: 'Företaget bokför med fakturametoden.',
      en: 'The company books with the accrual method.',
    })
    expect(line({ method: null, vatPeriod: 'quarterly', series: [] })).toEqual({
      sv: 'Företaget redovisar moms kvartalsvis.',
      en: 'The company reports VAT quarterly.',
    })
    expect(line({ method: null, vatPeriod: null, series: ['A', 'B', 'C'] })).toEqual({
      sv: 'Företaget använder serierna A, B och C.',
      en: 'The company uses series A, B and C.',
    })
  })

  it('is no sentence when the company has none of the three', () => {
    expect(line({ method: null, vatPeriod: null, series: [] })).toEqual({ sv: null, en: null })
  })

  it('has no dash of either length and ends with a full stop', () => {
    for (const facts of [
      { method: 'accrual', vatPeriod: 'yearly', series: ['A'] },
      { method: 'cash', vatPeriod: null, series: ['A', 'B'] },
    ] satisfies ProfileFacts[]) {
      for (const text of Object.values(line(facts))) {
        expect(text).not.toMatch(/[\u2013\u2014]/)
        expect(text).toMatch(/\.$/)
      }
    }
  })
})

describe('the facts behind the sentence', () => {
  it('reads the method, the period and the series as the profile shows them', () => {
    expect(profileFactsFrom({ accounting_method: 'accrual', moms_period: 'yearly', vat_registered: true }, [{ voucher_series: 'B' }, { voucher_series: 'A' }, { voucher_series: 'A' }])).toEqual({
      method: 'accrual',
      vatPeriod: 'yearly',
      series: ['A', 'B'],
    })
  })

  it('has no VAT period for a company that is not registered for VAT', () => {
    expect(profileFactsFrom({ accounting_method: 'cash', moms_period: 'quarterly', vat_registered: false }, []).vatPeriod).toBeNull()
    expect(profileFactsFrom({ accounting_method: 'cash', moms_period: 'quarterly' }, []).vatPeriod).toBeNull()
  })

  it('has no value for what is missing or is not one of the known values', () => {
    expect(profileFactsFrom(null, null)).toEqual({ method: null, vatPeriod: null, series: [] })
    expect(profileFactsFrom(undefined, undefined)).toEqual({ method: null, vatPeriod: null, series: [] })
    expect(profileFactsFrom({ accounting_method: 'other', moms_period: 'weekly', vat_registered: true }, [{ voucher_series: null }, { voucher_series: '' }])).toEqual({
      method: null,
      vatPeriod: null,
      series: [],
    })
    expect(profileFactsFrom({ accounting_method: null, moms_period: null, vat_registered: true }, [])).toEqual({ method: null, vatPeriod: null, series: [] })
  })

  it('lists the series by the rule the bookkeeping profile uses', () => {
    const rows = [{ voucher_series: 'M' }, { voucher_series: 'A' }, { voucher_series: 'B' }, { voucher_series: 'A' }]
    expect(profileFactsFrom({}, rows).series).toEqual(voucherSeriesInUse(rows))
    expect(voucherSeriesInUse(rows)).toEqual(['A', 'B', 'M'])
    expect(voucherSeriesInUse(null)).toEqual([])
  })
})

describe('reading the facts for a company', () => {
  it('reads company_settings and voucher_sequences for the company', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, moms_period: 'quarterly', accounting_method: 'cash' } })
    enqueue({ data: [{ voucher_series: 'A' }, { voucher_series: 'B' }] })
    expect(await readProfileFacts(supabase as never, 'company-1')).toEqual({ method: 'cash', vatPeriod: 'quarterly', series: ['A', 'B'] })
    // Each read names the company itself, with or without row level security.
    expect(findCall('company_settings', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('voucher_sequences', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('says less, and nothing untrue, when a read fails', async () => {
    const settingsFailed = createQueuedMockSupabase()
    settingsFailed.enqueue({ data: null, error: { message: 'boom' } })
    settingsFailed.enqueue({ data: [{ voucher_series: 'A' }] })
    expect(await readProfileFacts(settingsFailed.supabase as never, 'company-1')).toEqual({ method: null, vatPeriod: null, series: ['A'] })

    const sequencesFailed = createQueuedMockSupabase()
    sequencesFailed.enqueue({ data: { vat_registered: true, moms_period: 'yearly', accounting_method: 'accrual' } })
    sequencesFailed.enqueue({ data: null, error: { message: 'boom' } })
    expect(await readProfileFacts(sequencesFailed.supabase as never, 'company-1')).toEqual({ method: 'accrual', vatPeriod: 'yearly', series: [] })
  })

  it('agrees with the bookkeeping profile on the same rows', async () => {
    const settings = { vat_registered: true, moms_period: 'monthly', accounting_method: 'accrual', pays_salaries: false }
    const sequences = [{ voucher_series: 'B' }, { voucher_series: 'A' }]
    // buildLedgerContext's seven reads, in its order (ledger-context.ts).
    const profile = createQueuedMockSupabase()
    profile.enqueue({ data: { account_usage: [], counterparty_patterns: [], supplier_patterns: [], vat_treatments_used: [], median_booking_lag_days: null } })
    profile.enqueue({ data: settings })
    profile.enqueue({ data: [] })
    profile.enqueue({ data: [] })
    profile.enqueue({ data: null, count: 0 })
    profile.enqueue({ data: sequences })
    profile.enqueue({ data: null, count: 0 })
    const context = await buildLedgerContext(profile.supabase as never, 'company-1', new Date('2026-06-01T12:00:00Z'))

    const facts = profileFactsFrom(settings, sequences)
    expect(facts.method).toBe(context.conventions.accounting_method)
    expect(facts.vatPeriod).toBe(context.vat_profile.moms_period)
    expect(facts.series).toEqual(context.conventions.voucher_series_in_use)
  })
})
