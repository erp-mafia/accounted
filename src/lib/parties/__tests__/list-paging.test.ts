import { describe, expect, it } from 'vitest'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { aliasKeyOf, getCounterpartList, type AliasRecord } from '../list'

/**
 * crm#2146: Motparter reads a company's bank rows and readings in pages of
 * 1,000. Postgres sorts each OFFSET page on its own, so rows that tie on
 * every ordered column can come back in another order on the next page: one
 * row is read twice and its neighbour never, and the bank figures per
 * counterpart come out wrong. Paging is exact only on a total order.
 */

/** The bank rows and readings paged and sorted like Postgres; every other read is empty. */
function supabaseWith(tables: { transactions: object[]; counterparty_aliases: object[] }) {
  return createPagedMockSupabase(tables, { sortLikePostgres: true }).supabase as never
}

const isoDay = (day: number) => new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)

const bankRow = (i: number, text: string, day: number) => ({
  id: `tx-${String(i).padStart(5, '0')}`,
  amount: -(i + 1),
  amount_sek: null,
  date: isoDay(day),
  original_description: text,
  description: null,
  merchant_name: null,
})

const reading = (name: string): AliasRecord => ({
  alias_key: aliasKeyOf({ original_description: name, description: null, merchant_name: null }),
  party_id: null,
  display_name: name,
  kind: 'merchant',
  rail: null,
  country: null,
  what: null,
  band: 'link',
  source: 'model',
})

/** A made-up counterpart name per number, each its own alias key: "Butik aaaa", "Butik baaa", ... */
const shopName = (i: number) =>
  `Butik ${Array.from({ length: 4 }, (_, k) => String.fromCharCode(97 + (Math.floor(i / 26 ** k) % 26))).join('')}`

describe('Motparter past one page of bank rows (crm#2146)', () => {
  it('counts every bank row once when rows that share a date straddle a page boundary', async () => {
    // 2,400 bank rows of 12 counterparts, 30 a day: rows 1,000 and 2,000 fall inside a day.
    const names = manyRows(12, shopName)
    const transactions = manyRows(2400, (i) => bankRow(i, names[i % names.length]!, Math.floor(i / 30)))
    const expected = Object.fromEntries(names.map((name) => [name, { count: 0, outSek: 0 }]))
    for (const t of transactions) {
      expected[t.original_description]!.count += 1
      expected[t.original_description]!.outSek += -t.amount
    }

    const list = await getCounterpartList(
      supabaseWith({ transactions, counterparty_aliases: names.map(reading) }),
      'company-1',
      { period: 'all' },
    )

    expect(Object.fromEntries(list.rows.map((r) => [r.name, { count: r.count, outSek: r.outSek }]))).toEqual(expected)
    expect(list.counts.unnamedTransactions).toBe(0)
  })

  it('reads every counterpart reading once past 1,000 of them', async () => {
    const names = manyRows(1500, shopName)
    // One bank row a day, so only the readings can tie.
    const transactions = names.map((name, i) => bankRow(i, name, i))

    const list = await getCounterpartList(
      supabaseWith({ transactions, counterparty_aliases: names.map(reading) }),
      'company-1',
      { period: 'all' },
    )

    expect(list.counts.read).toBe(1500)
    expect(list.rows.filter((r) => r.count !== 1)).toEqual([])
    expect(list.counts.unnamedTransactions).toBe(0)
  })
})
