import type { ParsedSIEFile } from './types'
import { formatCounterpartyName, normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'

/**
 * Aggregated, display-ready model for the import theater: the knowledge graph
 * that builds itself while an SIE import runs. Everything is derived from the
 * client-parsed file, capped hard so 2 000+ vouchers become a readable
 * constellation instead of a hairball.
 */
export interface TheaterModel {
  companyName: string
  /** Fiscal years present in the file, oldest first (tree rings). */
  years: { start: string; end: string }[]
  /** Class buckets that exist in the file, with total line weight. */
  buckets: { id: TheaterBucket; weight: number }[]
  /** Top accounts by posting count, heaviest first. */
  accounts: { number: string; name: string; bucket: TheaterBucket; weight: number }[]
  /** Top recognized counterparties from voucher texts, heaviest first. */
  counterparties: { name: string; account: string; weight: number }[]
  totalVouchers: number
  totalCounterparties: number
}

export type TheaterBucket = 'tillgangar' | 'skulder' | 'intakter' | 'kostnader'

const MAX_ACCOUNTS = 14
const MAX_COUNTERPARTIES = 12

/** Internal accounting voucher texts that are not counterparties. */
const SKIP_DESCRIPTIONS = [
  'lön',
  'löner',
  'moms',
  'momsredovisning',
  'avskrivning',
  'avskrivningar',
  'omföring',
  'bokslut',
  'årets resultat',
  'ingående balans',
  'utgående balans',
  'öresavrundning',
  'rättelse',
]

export function bucketOfAccount(accountNumber: string): TheaterBucket {
  switch (accountNumber.charAt(0)) {
    case '1':
      return 'tillgangar'
    case '2':
      return 'skulder'
    case '3':
      return 'intakter'
    default:
      return 'kostnader'
  }
}

function isSkippableDescription(description: string): boolean {
  const lower = description.toLowerCase()
  return SKIP_DESCRIPTIONS.some((skip) => lower.startsWith(skip))
}

export function buildTheaterModel(parsed: ParsedSIEFile): TheaterModel {
  // Account weights = transaction line counts; names from #KONTO.
  const accountNames = new Map(parsed.accounts.map((a) => [a.number, a.name]))
  const accountWeights = new Map<string, number>()
  for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) {
      accountWeights.set(line.account, (accountWeights.get(line.account) ?? 0) + 1)
    }
  }

  const accounts = [...accountWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ACCOUNTS)
    .map(([number, weight]) => ({
      number,
      name: accountNames.get(number) ?? '',
      bucket: bucketOfAccount(number),
      weight,
    }))

  const bucketWeights = new Map<TheaterBucket, number>()
  for (const [number, weight] of accountWeights) {
    const bucket = bucketOfAccount(number)
    bucketWeights.set(bucket, (bucketWeights.get(bucket) ?? 0) + weight)
  }

  // Counterparties: normalized voucher texts, internal accounting texts
  // skipped, grouped by normalized identity. The "dominant account" is the
  // most frequent non-1930/2440-style counter account seen with the name;
  // for display purposes the heaviest account of the voucher works well.
  const counterpartyWeights = new Map<string, { display: string; weight: number; accounts: Map<string, number> }>()
  for (const voucher of parsed.vouchers) {
    const description = voucher.description.trim()
    if (!description || isSkippableDescription(description)) continue
    const normalized = normalizeCounterpartyName(description)
    if (!normalized || normalized.length < 3) continue
    const entry = counterpartyWeights.get(normalized) ?? {
      display: formatCounterpartyName(normalized),
      weight: 0,
      accounts: new Map<string, number>(),
    }
    entry.weight += 1
    // Weight counter accounts by absolute amount so the counterparty attaches
    // to its P&L/balance account rather than the bank leg.
    let heaviest: { account: string; amount: number } | null = null
    for (const line of voucher.lines) {
      const isSettlement = line.account.startsWith('19') || line.account.startsWith('24')
      if (isSettlement) continue
      const amount = Math.abs(line.amount)
      if (!heaviest || amount > heaviest.amount) heaviest = { account: line.account, amount }
    }
    if (heaviest) {
      entry.accounts.set(heaviest.account, (entry.accounts.get(heaviest.account) ?? 0) + 1)
    }
    counterpartyWeights.set(normalized, entry)
  }

  const allCounterparties = [...counterpartyWeights.values()].filter((c) => c.weight >= 2)
  const counterparties = allCounterparties
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_COUNTERPARTIES)
    .map((c) => {
      const dominant = [...c.accounts.entries()].sort((a, b) => b[1] - a[1])[0]
      return { name: c.display, account: dominant?.[0] ?? '', weight: c.weight }
    })

  const years = [...parsed.header.fiscalYears]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((y) => ({ start: y.start, end: y.end }))

  return {
    companyName: parsed.header.companyName ?? '',
    years,
    buckets: (['tillgangar', 'skulder', 'intakter', 'kostnader'] as const)
      .filter((id) => (bucketWeights.get(id) ?? 0) > 0)
      .map((id) => ({ id, weight: bucketWeights.get(id) ?? 0 })),
    accounts,
    counterparties,
    totalVouchers: parsed.vouchers.length,
    totalCounterparties: allCounterparties.length,
  }
}
