import { describe, it, expect } from 'vitest'
import {
  applyVerifikatSearch,
  isBoundedVerifikatScope,
  readVerifikatQuerySearch,
  readVerifikatSearch,
  verifikatSearchJoins,
  verifikatSearchParams,
  verifikatSearchReadings,
} from '../verifikat-search'

const NOTHING = { voucher: null, account: null, amount: null, dates: null }

describe('readVerifikatSearch', () => {
  it('reads plain text as nothing but text', () => {
    expect(readVerifikatSearch('hyra kvartal 1')).toEqual(NOTHING)
    expect(readVerifikatSearch('konto 1630')).toEqual(NOTHING)
    expect(readVerifikatSearch('1630a')).toEqual(NOTHING)
  })

  it('reads a voucher label in the forms people type', () => {
    for (const needle of ['A71', 'a71', 'a 71', 'A-71', '  A71 ']) {
      expect(readVerifikatSearch(needle), needle).toEqual({ ...NOTHING, voucher: { series: 'A', number: 71 } })
    }
  })

  it('reads an amount in every form the box promises, to the öre', () => {
    expect(readVerifikatSearch('12 500').amount).toBe(12500)
    expect(readVerifikatSearch('12500').amount).toBe(12500)
    expect(readVerifikatSearch('12 500,50').amount).toBe(12500.5)
    expect(readVerifikatSearch('12500.5').amount).toBe(12500.5)
    expect(readVerifikatSearch('12 500 kr').amount).toBe(12500)
    // The non-breaking space sv-SE formatting writes between thousands.
    expect(readVerifikatSearch('12 500,00 kr').amount).toBe(12500)
  })

  it('searches a magnitude: the sign of a pasted amount is dropped', () => {
    expect(readVerifikatSearch('-12500').amount).toBe(12500)
  })

  it('does not read zero as an amount: every line has one side at zero', () => {
    for (const needle of ['0', '00', '0,00', '0 kr']) {
      expect(readVerifikatSearch(needle).amount, needle).toBeNull()
    }
  })

  it('does not read a number too long to be an amount', () => {
    expect(readVerifikatSearch('99999999999999999999999').amount).toBeNull()
  })

  it('reads four digits as an account number and as an amount', () => {
    expect(readVerifikatSearch('1930')).toEqual({ ...NOTHING, account: '1930', amount: 1930 })
    // Three or five digits are an amount only.
    expect(readVerifikatSearch('193')).toEqual({ ...NOTHING, amount: 193 })
    expect(readVerifikatSearch('19300')).toEqual({ ...NOTHING, amount: 19300 })
  })

  it('reads one day', () => {
    expect(readVerifikatSearch('2026-03-15')).toEqual({
      ...NOTHING,
      dates: { from: '2026-03-15', to: '2026-03-15' },
    })
  })

  it('reads a month as its first to its last day', () => {
    expect(readVerifikatSearch('2026-03').dates).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(readVerifikatSearch('2026-02').dates).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(readVerifikatSearch('2028-02').dates).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(readVerifikatSearch('2026-12').dates).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('does not read a day or a month that does not exist', () => {
    for (const needle of ['2026-02-31', '2026-13-01', '2026-13', '2026-00', '0202-03-15']) {
      expect(readVerifikatSearch(needle).dates, needle).toBeNull()
    }
  })

  it('does not read a bare year as a date: it is an account number and an amount', () => {
    expect(readVerifikatSearch('2026')).toEqual({ ...NOTHING, account: '2026', amount: 2026 })
  })

  it('does not read other date spellings, which are amounts or text', () => {
    expect(readVerifikatSearch('20260315')).toEqual({ ...NOTHING, amount: 20260315 })
    expect(readVerifikatSearch('15/3 2026')).toEqual(NOTHING)
    expect(readVerifikatSearch('2026-3-15')).toEqual(NOTHING)
  })
})

describe('isBoundedVerifikatScope', () => {
  it('is bounded by a fiscal period, and by nothing else', () => {
    expect(isBoundedVerifikatScope({ periodId: 'period-1' })).toBe(true)
    for (const periodId of [null, undefined, '']) {
      expect(isBoundedVerifikatScope({ periodId }), String(periodId)).toBe(false)
    }
  })
})

describe('readVerifikatQuerySearch', () => {
  const BOUNDED = { periodId: 'period-1' }
  const UNBOUNDED = { periodId: null }

  it('reads everything inside a fiscal period', () => {
    for (const needle of ['12 500 kr', '1930', 'A71', '2026-03-15', 'hyra mars']) {
      expect(readVerifikatQuerySearch(needle, BOUNDED), needle).toEqual(readVerifikatSearch(needle))
    }
  })

  it('reads no amount without one, and keeps every other reading', () => {
    expect(readVerifikatQuerySearch('12 500 kr', UNBOUNDED)).toEqual(NOTHING)
    expect(readVerifikatQuerySearch('10432', UNBOUNDED)).toEqual(NOTHING)
    // Four digits stay an account number, as they were before amounts were read.
    expect(readVerifikatQuerySearch('1930', UNBOUNDED)).toEqual({ ...NOTHING, account: '1930' })
    expect(readVerifikatQuerySearch('A71', UNBOUNDED)).toEqual({ ...NOTHING, voucher: { series: 'A', number: 71 } })
    expect(readVerifikatQuerySearch('2026-03', UNBOUNDED).dates).toEqual({ from: '2026-03-01', to: '2026-03-31' })
  })
})

describe('verifikatSearchJoins and applyVerifikatSearch', () => {
  /** A query builder that notes the filters put on it. */
  interface Recorder {
    eq(...args: unknown[]): Recorder
    ilike(...args: unknown[]): Recorder
    or(...args: unknown[]): Recorder
  }
  function recorder(): { query: Recorder; calls: unknown[][] } {
    const calls: unknown[][] = []
    const note = (method: string) => (...args: unknown[]): Recorder => {
      calls.push([method, ...args])
      return query
    }
    const query: Recorder = { eq: note('eq'), ilike: note('ilike'), or: note('or') }
    return { query, calls }
  }

  /** Every alias a filter names: as `<alias>.column`, `<alias>.not.is.null` or a referencedTable. */
  function aliasesFiltered(calls: unknown[][]): string[] {
    const named = new Set<string>()
    for (const [, first, second] of calls) {
      for (const alias of String(first).match(/[a-z]+_match(?=\.)/g) ?? []) named.add(alias)
      const table = (second as { referencedTable?: string } | undefined)?.referencedTable
      if (table) named.add(table)
    }
    return Array.from(named).sort()
  }

  it('joins the lines once per reading that looks at them', () => {
    expect(verifikatSearchJoins(readVerifikatSearch('hyra'))).toBe('')
    expect(verifikatSearchJoins(readVerifikatSearch('2026-03-15'))).toBe('')
    expect(verifikatSearchJoins(readVerifikatSearch('12 500'))).toBe(', amount_match:journal_entry_lines()')
    expect(verifikatSearchJoins(readVerifikatSearch('1930'))).toBe(
      ', account_match:journal_entry_lines(), amount_match:journal_entry_lines()',
    )
    expect(verifikatSearchJoins(readVerifikatQuerySearch('1930', { periodId: null }))).toBe(
      ', account_match:journal_entry_lines()',
    )
  })

  it('never filters on a join the select does not carry: PostgREST refuses such a request', () => {
    for (const scope of [{ periodId: 'period-1' }, { periodId: null }]) {
      for (const search of ['hyra', 'A71', '1930', '0000', '12 500 kr', '10432', '2026-03', '2026-03-15']) {
        const needle = readVerifikatQuerySearch(search, scope)
        const { query, calls } = recorder()
        applyVerifikatSearch(query, search, needle)
        const joined = [...(verifikatSearchJoins(needle).match(/[a-z]+_match(?=:)/g) ?? [])].sort()
        expect(aliasesFiltered(calls), `${search} ${String(scope.periodId)}`).toEqual(joined)
      }
    }
  })

  it('leaves a number typed without a fiscal period as the plain text search it was', () => {
    const { query, calls } = recorder()
    applyVerifikatSearch(query, '10432', readVerifikatQuerySearch('10432', { periodId: null }))
    expect(calls).toEqual([['ilike', 'description', '%10432%']])
  })

  it('reads a needle for list_verifikat_by_amount as it reads it for the direct query', () => {
    for (const scope of [{ periodId: 'period-1' }, { periodId: null }]) {
      for (const search of ['hyra', 'A71', '1930', '0000', '12 500 kr', '10432', '2026-03', '2026-03-15']) {
        const needle = readVerifikatQuerySearch(search, scope)
        const { query, calls } = recorder()
        applyVerifikatSearch(query, search, needle)
        const filters = calls.map((c) => String(c[1])).join(' ')
        const direct = [
          'text',
          ...(filters.includes('voucher_series.eq.') ? ['voucher'] : []),
          ...(filters.includes('account_match.not.is.null') ? ['account'] : []),
          ...(filters.includes('amount_match.not.is.null') ? ['amount'] : []),
          ...(filters.includes('entry_date.') ? ['date'] : []),
        ]
        const p = verifikatSearchParams(search, needle)
        const rpc = [
          ...(p.p_search_pattern ? ['text'] : []),
          ...(p.p_search_voucher_series ? ['voucher'] : []),
          ...(p.p_search_account ? ['account'] : []),
          ...(p.p_search_amount !== null ? ['amount'] : []),
          ...(p.p_search_date_from ? ['date'] : []),
        ]
        const label = `${search} ${String(scope.periodId)}`
        expect(rpc, label).toEqual(direct)
        expect(verifikatSearchReadings(needle), label).toEqual(direct)
      }
    }
  })
})

describe('verifikatSearchParams', () => {
  const NO_SEARCH = {
    p_search_pattern: null,
    p_search_voucher_series: null,
    p_search_voucher_number: null,
    p_search_account: null,
    p_search_amount: null,
    p_search_date_from: null,
    p_search_date_to: null,
  }

  it('passes every reading of the needle as its own parameter', () => {
    expect(verifikatSearchParams('A71', readVerifikatQuerySearch('A71', { periodId: null }))).toEqual({
      ...NO_SEARCH,
      p_search_pattern: '%A71%',
      p_search_voucher_series: 'A',
      p_search_voucher_number: 71,
    })
    expect(verifikatSearchParams('1930', readVerifikatQuerySearch('1930', { periodId: 'period-1' }))).toEqual({
      ...NO_SEARCH,
      p_search_pattern: '%1930%',
      p_search_account: '1930',
      p_search_amount: 1930,
    })
    expect(verifikatSearchParams('2026-03', readVerifikatQuerySearch('2026-03', { periodId: null }))).toEqual({
      ...NO_SEARCH,
      p_search_pattern: '%2026-03%',
      p_search_date_from: '2026-03-01',
      p_search_date_to: '2026-03-31',
    })
  })

  it('escapes LIKE wildcards typed, and reads * as % the way PostgREST does for the direct query', () => {
    const search = 'a*b 50%_x'
    expect(verifikatSearchParams(search, readVerifikatQuerySearch(search, { periodId: null })).p_search_pattern).toBe(
      '%a%b 50\\%\\_x%',
    )
  })

  it('is all NULL without a search', () => {
    expect(verifikatSearchParams(null, null)).toEqual(NO_SEARCH)
  })
})
