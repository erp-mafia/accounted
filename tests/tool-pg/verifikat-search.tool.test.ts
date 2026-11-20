/**
 * The verifikat list's search over a real PostgREST.
 *
 * A needle that is an account number, an amount or a bokföringsdatum becomes
 * filtered joins on the lines and arms of an `or` (applyVerifikatSearch,
 * lib/bookkeeping/verifikat-search.ts). All of that is PostgREST's grammar:
 * an embed under an alias with no columns, a logical filter on that embed,
 * `<alias>.not.is.null` and `and(...)` inside `or`. The route's own tests run
 * against a mocked client, which accepts any string. Here the reading, the
 * joins and the filters the route applies (readVerifikatQuerySearch,
 * verifikatSearchJoins, applyVerifikatSearch) run against stored verifikat
 * and must find exactly the ones the needle names, with a count that agrees:
 * inside a fiscal period, where an amount is read, and over every year,
 * where it is not.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyVerifikatSearch,
  readVerifikatQuerySearch,
  verifikatSearchJoins,
} from '@/lib/bookkeeping/verifikat-search'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { createToolPgClient } from './client'

interface FoundRow {
  voucher_series: string
  voucher_number: number
  lines: unknown[]
}

describe('the verifikat search over a real PostgREST', () => {
  const supabase = createToolPgClient()
  let companyId: string
  let fiscalPeriodId: string

  beforeAll(async () => {
    const seed = await seedCompany()
    companyId = seed.companyId
    fiscalPeriodId = seed.fiscalPeriodId
    const entry = { userId: seed.userId, companyId, fiscalPeriodId }

    // A1: one amount on both of its lines.
    await insertPostedJournalEntry({
      ...entry, voucherNumber: 1, entryDate: '2026-03-15', description: 'Hyra mars',
      lines: [
        { accountNumber: '5010', debitAmount: 12500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 12500 },
      ],
    })
    // A2: amounts with öre, the total on its one debit line.
    await insertPostedJournalEntry({
      ...entry, voucherNumber: 2, entryDate: '2026-03-20', description: 'Kundfaktura',
      lines: [
        { accountNumber: '1510', debitAmount: 12500.5, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 10000.4 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 2500.1 },
      ],
    })
    // A3: several lines on both sides, so its omslutning (39 426) is on none.
    await insertPostedJournalEntry({
      ...entry, voucherNumber: 3, entryDate: '2026-04-02', description: 'Lön april',
      lines: [
        { accountNumber: '7010', debitAmount: 30000, creditAmount: 0 },
        { accountNumber: '7510', debitAmount: 9426, creditAmount: 0 },
        { accountNumber: '2710', debitAmount: 0, creditAmount: 9000 },
        { accountNumber: '2731', debitAmount: 0, creditAmount: 9426 },
        { accountNumber: '2890', debitAmount: 0, creditAmount: 21000 },
      ],
    })
    // A4: mentions 12500 in its text, books another amount.
    await insertPostedJournalEntry({
      ...entry, voucherNumber: 4, entryDate: '2026-04-10', description: 'Rättning av 12500 till kund',
      lines: [
        { accountNumber: '2440', debitAmount: 800, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 800 },
      ],
    })
    // B1: the amount 1 930 kr, with no line on account 1930.
    await insertPostedJournalEntry({
      ...entry, voucherSeries: 'B', voucherNumber: 1, entryDate: '2026-04-15', description: 'Kontorsmaterial',
      lines: [
        { accountNumber: '6110', debitAmount: 1930, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1930 },
      ],
    })

    // Another company with the same verifikat as A1: never found.
    const other = await seedCompany()
    await insertPostedJournalEntry({
      userId: other.userId, companyId: other.companyId, fiscalPeriodId: other.fiscalPeriodId,
      voucherNumber: 1, entryDate: '2026-03-15', description: 'Hyra mars',
      lines: [
        { accountNumber: '5010', debitAmount: 12500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 12500 },
      ],
    })
  }, 30_000)

  /**
   * The list's direct query for one search, as the route builds it: inside
   * the fiscal period or, with `allYears`, over every year of the company,
   * where the route reads no amount (readVerifikatQuerySearch).
   */
  const find = async (
    search: string,
    { page = { from: 0, to: 49 }, allYears = false }: { page?: { from: number; to: number }; allYears?: boolean } = {},
  ) => {
    const needle = readVerifikatQuerySearch(search, { periodId: allYears ? null : fiscalPeriodId })
    const ofCompany = supabase
      .from('journal_entries')
      .select(`*, lines:journal_entry_lines(*)${verifikatSearchJoins(needle)}`, { count: 'exact' })
      .eq('company_id', companyId)
    const query = (allYears ? ofCompany : ofCompany.eq('fiscal_period_id', fiscalPeriodId))
      .order('voucher_series', { ascending: true })
      .order('voucher_number', { ascending: true })
      .range(page.from, page.to)
    const { data, error, count } = await applyVerifikatSearch(query, search, needle)
    expect(error, search).toBeNull()
    const rows = (data ?? []) as unknown as FoundRow[]
    return {
      found: rows.map((row) => `${row.voucher_series}${row.voucher_number}`),
      count,
      lineCounts: rows.map((row) => row.lines.length),
    }
  }

  it('finds a verifikat by the amount of a line, in the forms the box reads', async () => {
    expect((await find('12 500')).found).toEqual(['A1'])
    expect((await find('12 500 kr')).found).toEqual(['A1'])
    expect((await find('12 500,50')).found).toEqual(['A2'])
    expect((await find('12500.5')).found).toEqual(['A2'])
    // A credit line counts as much as a debit line.
    expect((await find('2500,10')).found).toEqual(['A2'])
    expect((await find('21000')).found).toEqual(['A3'])
  })

  it('keeps the text match next to the amount, so the result only grows', async () => {
    const { found, count } = await find('12500')
    expect(found).toEqual(['A1', 'A4'])
    expect(count).toBe(2)
  })

  it('still answers every line of a verifikat it found through one line', async () => {
    const { found, lineCounts } = await find('9000')
    expect(found).toEqual(['A3'])
    expect(lineCounts).toEqual([5])
  })

  it('matches lines, not the omslutning of a verifikat with several lines on both sides', async () => {
    expect((await find('39426')).found).toEqual([])
  })

  it('reads four digits as an account number and as an amount, and both apply', async () => {
    const { found, count } = await find('1930')
    // A1 and A4 have a line on account 1930; B1 has lines of 1 930 kr.
    expect(found).toEqual(['A1', 'A4', 'B1'])
    expect(count).toBe(3)
  })

  it('finds the verifikat of one bokföringsdatum, and of a month', async () => {
    expect((await find('2026-03-15')).found).toEqual(['A1'])
    expect((await find('2026-03')).found).toEqual(['A1', 'A2'])
    expect((await find('2026-04')).found).toEqual(['A3', 'A4', 'B1'])
    expect((await find('2026-05')).found).toEqual([])
  })

  it('finds a verifikat by its label and by its text, as before', async () => {
    expect((await find('A3')).found).toEqual(['A3'])
    expect((await find('b 1')).found).toEqual(['B1'])
    expect((await find('hyra')).found).toEqual(['A1'])
  })

  it('counts the whole widened set while it pages it', async () => {
    const { found, count } = await find('2026-04', { page: { from: 1, to: 1 } })
    expect(found).toEqual(['A4'])
    expect(count).toBe(3)
  })

  it('reads no amount when no fiscal period bounds the search, and finds what the search found before', async () => {
    // The text only: A4 mentions 12500. The lines of 12 500 on A1 are not looked at.
    expect((await find('12500', { allYears: true })).found).toEqual(['A4'])
    expect((await find('12 500 kr', { allYears: true })).found).toEqual([])
    // Four digits stay the account search: A1 and A4 have a line on 1930, B1 only the amount.
    const { found, count } = await find('1930', { allYears: true })
    expect(found).toEqual(['A1', 'A4'])
    expect(count).toBe(2)
    // A date is a column of the verifikat and is read either way.
    expect((await find('2026-03-15', { allYears: true })).found).toEqual(['A1'])
  })
})
