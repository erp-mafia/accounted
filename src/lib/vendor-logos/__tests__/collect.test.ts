/**
 * The daily collect reads a year of suppliers, inbox documents and bank rows
 * across every company. It paged with OFFSET over the whole year, so every
 * page re-read every row before it, and each bank-text page pattern-matched
 * every transaction of the year: a page passed the 8 s statement timeout
 * (the 03 UTC run, 2026-11-21 and 22). Now each page starts after the last id
 * of the one before, and a bank read covers two weeks of rows, never the year.
 * These tests run the collect against rows that answer the chain's filters as
 * the database would, so paging that skips or repeats a row fails them.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { bankWindows, collectCandidateDomains, COLLECT_BANK_WINDOW_DAYS, COLLECT_PAGE, COLLECT_WINDOW_DAYS } from '../collect'

const NOW = new Date('2026-11-22T03:20:00Z')
const TODAY = todayIsoStockholm(NOW)
const SINCE = addDaysIso(TODAY, -COLLECT_WINDOW_DAYS)

type Row = Record<string, unknown>
type Call = { method: string; args: unknown[] }

const likeToRegExp = (pattern: string) =>
  new RegExp(`^${pattern.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

/** What a read of `rows` answers for the chain's filters, order, limit and range. */
function answer(rows: Row[], calls: Call[]): { data: Row[] } {
  let out = [...rows]
  for (const { method, args } of calls) {
    const [column, value, extra] = args as [string, unknown, unknown]
    if (method === 'gte') out = out.filter((r) => String(r[column]) >= String(value))
    if (method === 'lt') out = out.filter((r) => String(r[column]) < String(value))
    if (method === 'gt') out = out.filter((r) => String(r[column]) > String(value))
    if (method === 'not' && value === 'is' && extra === null) out = out.filter((r) => r[column] !== null && r[column] !== undefined)
    if (method === 'ilikeAnyOf') {
      const patterns = (value as string[]).map(likeToRegExp)
      out = out.filter((r) => typeof r[column] === 'string' && patterns.some((p) => p.test(r[column] as string)))
    }
  }
  const order = calls.find((c) => c.method === 'order')
  if (order) out.sort((a, b) => String(a[order.args[0] as string]).localeCompare(String(b[order.args[0] as string])))
  const range = calls.find((c) => c.method === 'range')
  if (range) out = out.slice(range.args[0] as number, (range.args[1] as number) + 1)
  const limit = calls.find((c) => c.method === 'limit')
  if (limit) out = out.slice(0, limit.args[0] as number)
  return { data: out.slice(0, 1000) }
}

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(6, '0')}`

function world(sizes: { suppliers?: number; documents?: number }) {
  const suppliers = Array.from({ length: sizes.suppliers ?? 0 }, (_, n) => ({
    id: id('s', n), name: `Leverantör ${n}`, email: `faktura@leverantor${n}.se`, updated_at: '2026-06-01T00:00:00Z',
  }))
  const documents = Array.from({ length: sizes.documents ?? 0 }, (_, n) => ({
    id: id('d', n), email_from: `noreply@vendor${n}.se`, supplier_name: `Vendor ${n}`, created_at: '2026-06-01T00:00:00Z',
  }))
  // One bank row a day for the year, a website in every third text, and a
  // merchant name with a website on every fifth; one row older than the
  // year and one dated after today.
  const transactions: Row[] = []
  for (let day = -COLLECT_WINDOW_DAYS - 1, n = 0; day <= 3; day++, n++) {
    transactions.push({
      id: id('t', n),
      date: addDaysIso(TODAY, day),
      description: n % 3 === 0 ? `KORTKÖP SHOP${n}.SE` : `KORTKÖP BUTIK ${n}`,
      merchant_name: n % 5 === 0 ? `merchant${n}.io` : null,
    })
  }
  const mock = createTableMockSupabase({
    suppliers: (calls) => answer(suppliers, calls),
    invoice_inbox_items: (calls) => answer(documents, calls),
    transactions: (calls) => answer(transactions, calls),
  })
  return { ...mock, service: mock.supabase as unknown as SupabaseClient, suppliers, documents, transactions }
}

/** The chains of every read of `table`, split at each from(). */
function reads(calls: { table: string; method: string; args: unknown[] }[], table: string): Call[][] {
  const out: Call[][] = []
  for (const call of calls) {
    if (call.table !== table) continue
    if (call.method === 'select') out.push([])
    out[out.length - 1]?.push({ method: call.method, args: call.args })
  }
  return out
}

describe('collectCandidateDomains', () => {
  it('reads every document of a large year once, each page after the last id of the one before', async () => {
    const c = world({ documents: 2 * COLLECT_PAGE + 345, suppliers: COLLECT_PAGE + 1 })

    const { counts, domains } = await collectCandidateDomains(c.service, NOW)

    expect(counts.documents).toBe(c.documents.length)
    expect(counts.suppliers).toBe(c.suppliers.length)
    expect(domains.has('vendor0.se')).toBe(true)
    expect(domains.has(`vendor${c.documents.length - 1}.se`)).toBe(true)
    const pages = reads(c.calls, 'invoice_inbox_items')
    expect(pages).toHaveLength(3)
    // Keyset, never OFFSET: the first page has no lower id, each next one starts after the last.
    expect(pages.flat().some((call) => call.method === 'range')).toBe(false)
    expect(pages.map((p) => p.find((call) => call.method === 'gt')?.args ?? null)).toEqual([
      null,
      ['id', id('d', COLLECT_PAGE - 1)],
      ['id', id('d', 2 * COLLECT_PAGE - 1)],
    ])
    expect(pages.every((p) => p.some((call) => call.method === 'limit' && call.args[0] === COLLECT_PAGE))).toBe(true)
  })

  it('reads the bank rows two weeks at a time over the year, each row in the year once', async () => {
    const c = world({})

    const { counts } = await collectCandidateDomains(c.service, NOW)

    const inYear = c.transactions.filter((t) => String(t.date) >= SINCE)
    const withWebsite = inYear.filter((t) => /\.SE$/.test(String(t.description)) || t.merchant_name !== null)
    expect(counts.transactions).toBe(withWebsite.length)

    const bankReads = reads(c.calls, 'transactions')
    expect(bankReads.flat().some((call) => call.method === 'range')).toBe(false)
    for (const read of bankReads) {
      const from = read.find((call) => call.method === 'gte')?.args
      const to = read.find((call) => call.method === 'lt')?.args
      expect(from?.[0]).toBe('date')
      // Bounded: two weeks at most, except the last window, open past today.
      if (to) {
        expect(to[0]).toBe('date')
        expect(to[1]).toBe(addDaysIso(String(from?.[1]), COLLECT_BANK_WINDOW_DAYS))
      } else {
        expect(String(from?.[1]) > addDaysIso(TODAY, -COLLECT_BANK_WINDOW_DAYS)).toBe(true)
      }
    }
    // The windows read are exactly bankWindows from the year's first day, each
    // read for the texts and for the merchant names.
    const readWindows = bankReads.map((read) => ({
      from: read.find((call) => call.method === 'gte')?.args[1],
      to: read.find((call) => call.method === 'lt')?.args[1] ?? null,
      column: read.find((call) => call.method === 'ilikeAnyOf')?.args[0],
    }))
    expect(readWindows).toEqual(
      bankWindows(SINCE, TODAY).flatMap((w) => [
        { ...w, column: 'description' },
        { ...w, column: 'merchant_name' },
      ]),
    )
    expect(readWindows[0]!.from).toBe(SINCE)
  })
})

describe('collectCandidateDomains on a failed read', () => {
  it('rejects with the database error instead of collecting part of the year', async () => {
    const c = world({ documents: 10 })
    c.setTable('invoice_inbox_items', { error: { message: 'canceling statement due to statement timeout', code: '57014' } })
    await expect(collectCandidateDomains(c.service, NOW)).rejects.toMatchObject({ message: 'canceling statement due to statement timeout', code: '57014' })
  })

  it('stops, rather than reading the same page for ever, when a full page carries no id', async () => {
    const c = world({})
    c.setTable('suppliers', { data: Array.from({ length: COLLECT_PAGE }, () => ({ name: 'x', email: 'a@b.se' })) })
    await expect(collectCandidateDomains(c.service, NOW)).rejects.toThrow('no id to continue after')
  })
})

describe('bankWindows', () => {
  it('covers the year from its first day in contiguous two-week windows, the last one open', () => {
    const windows = bankWindows(SINCE, TODAY)
    expect(windows[0]!.from).toBe(SINCE)
    for (let n = 1; n < windows.length; n++) expect(windows[n]!.from).toBe(windows[n - 1]!.to)
    expect(windows.slice(0, -1).every((w) => w.to === addDaysIso(w.from, COLLECT_BANK_WINDOW_DAYS))).toBe(true)
    const last = windows[windows.length - 1]!
    expect(last.to).toBeNull()
    expect(last.from <= TODAY).toBe(true)
    expect(windows).toHaveLength(Math.floor(COLLECT_WINDOW_DAYS / COLLECT_BANK_WINDOW_DAYS) + 1)
  })
})
