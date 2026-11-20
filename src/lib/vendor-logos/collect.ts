/**
 * The domains worth an icon: every vendor the curated lists know, and every
 * vendor a company's last year names by a website, by its supplier record
 * or by the documents it sent. Service role only (it reads across
 * companies); what leaves here is a set of brand domains, never a company,
 * a name or a row.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { DIRECTORY_SEED } from '@/lib/parties/resolver/directory-seed'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
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
  const sinceDate = addDaysIso(todayIsoStockholm(now), -COLLECT_WINDOW_DAYS)
  const domains = new Set<string>()
  const add = (d: string | null | undefined) => {
    if (d) domains.add(d)
  }

  const suppliers = await fetchAllRows<{ id: string; name: string | null; email: string | null }>(({ from, to }) =>
    service
      .from('suppliers')
      .select('id, name, email')
      .not('email', 'is', null)
      .gte('updated_at', sinceTs)
      .order('id', { ascending: true })
      .range(from, to),
  )
  for (const s of suppliers) add(resolveVendorDomain({ name: s.name, emails: [s.email] })?.domain)

  const documents = await fetchAllRows<{ id: string; email_from: string | null; supplier_name: string | null }>(({ from, to }) =>
    service
      .from('invoice_inbox_items')
      .select('id, email_from, supplier_name:extracted_data->supplier->>name')
      .gte('created_at', sinceTs)
      .order('id', { ascending: true })
      .range(from, to),
  )
  for (const d of documents) add(resolveVendorDomain({ name: d.supplier_name, emails: [d.email_from] })?.domain)

  type BankRow = { id: string; merchant_name: string | null; description: string | null }
  const byDescription = await fetchAllRows<BankRow>(({ from, to }) =>
    service
      .from('transactions')
      .select('id, merchant_name, description')
      .gte('date', sinceDate)
      .ilikeAnyOf('description', HOST_LIKE)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const byMerchant = await fetchAllRows<BankRow>(({ from, to }) =>
    service
      .from('transactions')
      .select('id, merchant_name, description')
      .gte('date', sinceDate)
      .ilikeAnyOf('merchant_name', HOST_LIKE)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const transactions = new Map([...byDescription, ...byMerchant].map((t) => [t.id, t]))
  for (const t of transactions.values()) add(resolveVendorDomain({ name: t.merchant_name, texts: [t.description] })?.domain)

  for (const d of staticDomains()) domains.add(d)
  return { domains, counts: { suppliers: suppliers.length, documents: documents.length, transactions: transactions.size } }
}
