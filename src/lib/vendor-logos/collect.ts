/**
 * The domains worth an icon: every vendor the curated lists know, and every
 * vendor a company's last year names by a website, by its supplier record
 * or by the documents it sent. Service role only (it reads across
 * companies); what leaves here is a set of brand domains, never a company,
 * a name or a row.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DIRECTORY_SEED } from '@/lib/parties/resolver/directory-seed'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'
import { curatedDomains } from './aliases'
import { registrableDomain } from './domain'
import { isExcludedDomain } from './excluded'
import { resolveVendorDomain } from './resolve'

export const COLLECT_WINDOW_DAYS = 365

/**
 * The patterns a bank text must match to be read for a host at all: a dot
 * and a common TLD prefix. The database filters on them, so a year of
 * transactions arrives as the few rows that write a website, not as every
 * row. "%.co%" covers .com and .cloud, "%.de%" covers .dev.
 */
const HOST_LIKE = ['se', 'co', 'io', 'ai', 'app', 'net', 'nu', 'de', 'org', 'eu', 'no', 'dk', 'fi', 'uk', 'nl', 'me', 'tv', 'info', 'shop', 'store', 'tech', 'so', 'sh'].map(
  (tld) => `%.${tld}%`,
)

/** Rows per read of the collection. */
export const COLLECT_PAGE = 1000

/**
 * Days of bank rows per read. The bank-text filter is a pattern match on
 * every row the read covers, so a read covers a bounded slice of the year,
 * found by the date index, never the year: a read over the whole year scanned
 * every transaction of every company once per page, and a page passed the
 * 8 s statement timeout (the 03 UTC collect run, 2026-11-21 and 22). Two weeks
 * of bank rows, across every company, took 0.4 s (2026-11-22).
 */
export const COLLECT_BANK_WINDOW_DAYS = 14

/**
 * Every row of a read, COLLECT_PAGE at a time, each page starting after the
 * last id of the one before (keyset): a late page costs what the first does.
 * OFFSET paging re-read every earlier row on every page (the year of inbox
 * documents: 3.3 s for the 77th page of 78).
 */
async function readAfterId<T extends { id: string }>(
  page: (afterId: string | null) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  let afterId: string | null = null
  for (;;) {
    const { data, error } = await page(afterId)
    if (error) throw dbError(error, null)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < COLLECT_PAGE) return rows
    afterId = batch[batch.length - 1]!.id
  }
}

/**
 * The bank-row windows from `sinceDate`, COLLECT_BANK_WINDOW_DAYS each, as
 * [from, to) pairs; the last is open, so a row dated after today is read as
 * before.
 */
export function bankWindows(sinceDate: string, today: string): Array<{ from: string; to: string | null }> {
  const windows: Array<{ from: string; to: string | null }> = []
  let from = sinceDate
  for (;;) {
    const to = addDaysIso(from, COLLECT_BANK_WINDOW_DAYS)
    if (to > today) {
      windows.push({ from, to: null })
      return windows
    }
    windows.push({ from, to })
    from = to
  }
}

/** The curated domains and the directory seed's, minus the excluded ones. */
export function staticDomains(): string[] {
  const seed = DIRECTORY_SEED.map((e) => registrableDomain(e.logoDomain))
  return [...new Set([...curatedDomains(), ...seed].filter((d): d is string => !!d && !isExcludedDomain(d)))].sort()
}

export interface CollectCounts {
  suppliers: number
  documents: number
  transactions: number
}

/** Every domain the last year's vendors resolve to, with how many rows of each kind were read. */
export async function collectCandidateDomains(
  service: SupabaseClient,
  now: Date = new Date(),
): Promise<{ domains: Set<string>; counts: CollectCounts }> {
  const sinceTs = new Date(now.getTime() - COLLECT_WINDOW_DAYS * 86_400_000).toISOString()
  const today = todayIsoStockholm(now)
  const sinceDate = addDaysIso(today, -COLLECT_WINDOW_DAYS)
  const domains = new Set<string>()
  const add = (d: string | null | undefined) => {
    if (d) domains.add(d)
  }

  const suppliers = await readAfterId<{ id: string; name: string | null; email: string | null }>((afterId) => {
    let q = service.from('suppliers').select('id, name, email').not('email', 'is', null).gte('updated_at', sinceTs)
    if (afterId) q = q.gt('id', afterId)
    return q.order('id', { ascending: true }).limit(COLLECT_PAGE)
  })
  for (const s of suppliers) add(resolveVendorDomain({ name: s.name, emails: [s.email] })?.domain)

  const documents = await readAfterId<{ id: string; email_from: string | null; supplier_name: string | null }>((afterId) => {
    let q = service
      .from('invoice_inbox_items')
      .select('id, email_from, supplier_name:extracted_data->supplier->>name')
      .gte('created_at', sinceTs)
    if (afterId) q = q.gt('id', afterId)
    return q.order('id', { ascending: true }).limit(COLLECT_PAGE)
  })
  for (const d of documents) add(resolveVendorDomain({ name: d.supplier_name, emails: [d.email_from] })?.domain)

  type BankRow = { id: string; merchant_name: string | null; description: string | null }
  const transactions = new Map<string, BankRow>()
  for (const window of bankWindows(sinceDate, today)) {
    for (const column of ['description', 'merchant_name'] as const) {
      const rows = await readAfterId<BankRow>((afterId) => {
        let q = service.from('transactions').select('id, merchant_name, description').gte('date', window.from)
        if (window.to) q = q.lt('date', window.to)
        q = q.ilikeAnyOf(column, HOST_LIKE)
        if (afterId) q = q.gt('id', afterId)
        return q.order('id', { ascending: true }).limit(COLLECT_PAGE)
      })
      for (const t of rows) transactions.set(t.id, t)
    }
  }
  for (const t of transactions.values()) add(resolveVendorDomain({ name: t.merchant_name, texts: [t.description] })?.domain)

  for (const d of staticDomains()) domains.add(d)
  return { domains, counts: { suppliers: suppliers.length, documents: documents.length, transactions: transactions.size } }
}
