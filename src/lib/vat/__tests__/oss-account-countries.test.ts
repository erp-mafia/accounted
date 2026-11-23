/**
 * The rules behind "which EU country is this OSS account for", shared by the
 * dashboard route, the v1 operation and the MCP tool:
 * lib/vat/oss-account-countries.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import {
  ossAccountCountriesTitle,
  setOssAccountCountries,
  type OssAccountCountryInput,
} from '../oss-account-countries'

const log = createLogger('test')
const ctxFor = (supabase: unknown) => ({ supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log })

/** Every call that would change a row. */
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const writes = (calls: { table: string; method: string; args: unknown[] }[]) => calls.filter((c) => WRITE_METHODS.has(c.method))

const CHART = [
  { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', default_vat_treatment: 'oss', oss_country: null, oss_vat_rate: null },
  { account_number: '3150', account_name: 'Försäljning OSS Frankrike 20 %', default_vat_treatment: 'oss', oss_country: 'FR', oss_vat_rate: 20 },
  { account_number: '2671', account_name: 'Utgående moms OSS Tyskland', default_vat_treatment: null, oss_country: null, oss_vat_rate: null },
  { account_number: '3001', account_name: 'Försäljning varor 25 %', default_vat_treatment: 'standard_25', oss_country: null, oss_vat_rate: null },
  { account_number: '2650', account_name: 'Redovisningskonto för moms', default_vat_treatment: null, oss_country: null, oss_vat_rate: null },
]
const chartOf = (...numbers: string[]) => CHART.filter((row) => numbers.includes(row.account_number))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('setOssAccountCountries', () => {
  it('sets the country and rate on a sales account and the country on a VAT account, and leaves what already stands', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: chartOf('3149', '3150', '2671') })
    enqueue({ data: null })
    enqueue({ data: null })

    const outcome = await setOssAccountCountries(ctxFor(supabase), [
      { account_number: '3149', country: 'DE', vat_rate: 19 },
      { account_number: '3150', country: 'FR', vat_rate: 20 },
      { account_number: '2671', country: 'DE' },
    ])

    expect(outcome).toEqual({
      ok: true,
      data: {
        accounts: [
          { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', kind: 'sales', oss_country: 'DE', oss_vat_rate: 19 },
          { account_number: '3150', account_name: 'Försäljning OSS Frankrike 20 %', kind: 'sales', oss_country: 'FR', oss_vat_rate: 20 },
          { account_number: '2671', account_name: 'Utgående moms OSS Tyskland', kind: 'vat', oss_country: 'DE', oss_vat_rate: null },
        ],
        updated: 2,
        unchanged: 1,
      },
    })
    expect(writes(calls).map((call) => call.args[0])).toEqual([
      { oss_country: 'DE', oss_vat_rate: 19 },
      { oss_country: 'DE', oss_vat_rate: null },
    ])
    // Every read and write stays inside the company.
    const companyFilters = calls.filter((call) => call.method === 'eq' && call.args[0] === 'company_id')
    expect(companyFilters).toHaveLength(3)
    expect(companyFilters.every((call) => call.args[1] === 'company-1')).toBe(true)
  })

  it('takes EU on a VAT account shared by every country, and clears an account with null', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: chartOf('2671', '3150') })
    enqueue({ data: null })
    enqueue({ data: null })

    const outcome = await setOssAccountCountries(ctxFor(supabase), [
      { account_number: '2671', country: 'EU' },
      { account_number: '3150', country: null, vat_rate: 20 },
    ])

    expect(outcome).toMatchObject({ ok: true, data: { updated: 2, unchanged: 0 } })
    expect(writes(calls).map((call) => call.args[0])).toEqual([
      { oss_country: 'EU', oss_vat_rate: null },
      { oss_country: null, oss_vat_rate: null },
    ])
  })

  it('stores and answers the rate with the two decimals the column keeps', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: chartOf('3149') })
    enqueue({ data: null })

    const outcome = await setOssAccountCountries(ctxFor(supabase), [
      { account_number: '3149', country: 'DE', vat_rate: 19.000000001 },
    ])

    expect(outcome).toMatchObject({ ok: true, data: { accounts: [{ oss_country: 'DE', oss_vat_rate: 19 }], updated: 1 } })
    expect(writes(calls).map((call) => call.args[0])).toEqual([{ oss_country: 'DE', oss_vat_rate: 19 }])
  })

  it('a dry run answers what would change and writes nothing', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: chartOf('3149', '3150') })

    const outcome = await setOssAccountCountries(
      ctxFor(supabase),
      [
        { account_number: '3149', country: 'DE', vat_rate: 19 },
        { account_number: '3150', country: 'FR', vat_rate: 20 },
      ],
      { dryRun: true },
    )

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        changes: [
          {
            account_number: '3149',
            account_name: 'Försäljning OSS Tyskland 19 %',
            kind: 'sales',
            current: { oss_country: null, oss_vat_rate: null },
            next: { oss_country: 'DE', oss_vat_rate: 19 },
          },
        ],
        unchanged: 1,
      },
    })
    expect(writes(calls)).toEqual([])
  })

  it('refuses the whole call, before any write, for one account that cannot take what it is given', async () => {
    const refused: Array<[string, OssAccountCountryInput, string]> = [
      ['an account that is no OSS account', { account_number: '3001', country: 'DE', vat_rate: 19 }, 'momskod OSS'],
      ['the momsredovisning account', { account_number: '2650', country: 'DE' }, '26xx utom 2650'],
      ['Sweden', { account_number: '3149', country: 'SE', vat_rate: 25 }, 'inte ett annat EU-land'],
      ['a country outside the EU', { account_number: '3149', country: 'NO', vat_rate: 25 }, 'inte ett annat EU-land'],
      ['EU on a sales account', { account_number: '3149', country: 'EU', vat_rate: 19 }, 'inte ett annat EU-land'],
      ['a sales account without a rate', { account_number: '3149', country: 'DE' }, 'momssats i procent'],
      ['a rate finer than two decimals', { account_number: '3149', country: 'DE', vat_rate: 19.123 }, 'momssats i procent'],
      ['a rate on a VAT account', { account_number: '2671', country: 'DE', vat_rate: 19 }, 'anger bara land'],
    ]
    for (const [what, item, sv] of refused) {
      const { supabase, enqueue, calls } = createQueuedMockSupabase()
      enqueue({ data: chartOf('3149', item.account_number) })
      // Beside an account that is fine, unless the refused one is that account.
      const items = item.account_number === '3149' ? [item] : [{ account_number: '3149', country: 'DE', vat_rate: 19 }, item]
      const outcome = await setOssAccountCountries(ctxFor(supabase), items)
      expect(outcome, what).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { account_number: item.account_number } })
      expect((outcome as { messageSv?: string }).messageSv, what).toContain(sv)
      expect((outcome as { messageEn?: string }).messageEn, what).toBeTruthy()
      expect(writes(calls), what).toEqual([])
    }
  })

  it('answers ACCOUNT_NOT_FOUND for a number outside the chart, and refuses a number listed twice', async () => {
    const missing = createQueuedMockSupabase()
    missing.enqueue({ data: chartOf('3149') })
    expect(
      await setOssAccountCountries(ctxFor(missing.supabase), [
        { account_number: '3149', country: 'DE', vat_rate: 19 },
        { account_number: '3999', country: 'FR', vat_rate: 20 },
      ]),
    ).toEqual({ ok: false, code: 'ACCOUNT_NOT_FOUND', details: { account_number: '3999', account_numbers: ['3999'] } })
    expect(writes(missing.calls)).toEqual([])

    const twice = createQueuedMockSupabase()
    const outcome = await setOssAccountCountries(ctxFor(twice.supabase), [
      { account_number: '3149', country: 'DE', vat_rate: 19 },
      { account_number: '3149', country: 'FR', vat_rate: 20 },
    ])
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { account_number: '3149' } })
    expect(twice.calls).toEqual([])
  })
})

describe('ossAccountCountriesTitle', () => {
  it('names the accounts, and counts the ones past the first eight', () => {
    expect(ossAccountCountriesTitle(['3149', '2671'])).toBe('OSS-land på konton: 3149, 2671')
    const eleven = Array.from({ length: 11 }, (_, i) => String(3140 + i))
    expect(ossAccountCountriesTitle(eleven)).toBe('OSS-land på konton: 3140, 3141, 3142, 3143, 3144, 3145, 3146, 3147 och 3 till')
  })
})
