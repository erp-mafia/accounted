/**
 * Motparter, the list: one row per counterpart, whoever named it.
 *
 * A row is a party (confirmed or still a suggestion) or, until a party
 * exists, a name the resolver read out of the bank strings. Money comes
 * from the bank side when the counterpart has bank strings tied to it, and
 * from the ledger otherwise, so a company that arrived by SIE import still
 * sees its suppliers. Nothing here asks to be confirmed: a suggested party
 * is a row like any other, marked quietly, and unnamed spend stays off the
 * list (it belongs on the transactions, as cleansed text).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { stripTrailingWhenAndWho } from './ledger-key'
import { getRegister, type LedgerStats, type PartyRole, type RegisterPeriod, type RegisterRow } from './register'
import type { SuggestionReason } from './suggest'
import { matchSeedText } from './resolver/directory'
import { isScbConfigured } from './scb/config'

export type CounterpartStatus = 'confirmed' | 'suggested' | 'read' | 'tentative'

export interface CounterpartRow {
  /** The party id, or `alias:<key>` for a counterpart that is only a reading so far. */
  id: string
  partyId: string | null
  name: string
  what: string | null
  kind: string
  rail: string | null
  country: string | null
  logoDomain: string | null
  status: CounterpartStatus
  roles: PartyRole[]
  defaultRoles: PartyRole[]
  orgNumber: string | null
  account: string | null
  accountName: string | null
  count: number
  inSek: number
  outSek: number
  lastSeen: string | null
  aliasKeys: string[]
  statsSource: 'bank' | 'ledger' | 'none'
  /** Why a suggestion is here: the ledger's own reasons (org number in a document, vouchers, rhythm). */
  reason: SuggestionReason | null
  rhythm: LedgerStats['rhythm'] | null
  /** The rung that named a reading (document, directory, ledger, anchor, model), so the row can say so. */
  source: string | null
}

export interface CounterpartList {
  rows: CounterpartRow[]
  counts: { total: number; confirmed: number; suggested: number; read: number; tentative: number; unnamedTransactions: number }
  period: RegisterPeriod
  scbConfigured: boolean
}

export interface AliasRecord {
  alias_key: string
  party_id: string | null
  display_name: string | null
  kind: string
  rail: string | null
  country: string | null
  what: string | null
  band: 'link' | 'tentative' | 'nil'
  source: string
}

export interface BankStats {
  count: number
  inSek: number
  outSek: number
  lastSeen: string | null
}

interface TxRecord {
  amount: number | string
  amount_sek: number | string | null
  date: string
  original_description: string | null
  description: string | null
  merchant_name: string | null
}

const OFF_LIST_KINDS = new Set(['payroll', 'transfer', 'category', 'unsure'])

function roundOre(n: number): number {
  return Math.round(n * 100) / 100
}

export function aliasKeyOf(tx: Pick<TxRecord, 'original_description' | 'description' | 'merchant_name'>): string {
  const raw = tx.original_description?.trim() || tx.description?.trim() || tx.merchant_name?.trim() || ''
  return raw ? normalizeCounterpartyName(raw) || raw.toLowerCase() : ''
}

/** Bank-side money per alias key. */
export function bankStatsByKey(rows: TxRecord[]): Map<string, BankStats> {
  const out = new Map<string, BankStats>()
  for (const r of rows) {
    const key = aliasKeyOf(r)
    if (!key) continue
    const amount = Number(r.amount_sek ?? r.amount) || 0
    const s = out.get(key) ?? { count: 0, inSek: 0, outSek: 0, lastSeen: null }
    s.count += 1
    if (amount > 0) s.inSek += amount
    else s.outSek += Math.abs(amount)
    if (!s.lastSeen || r.date > s.lastSeen) s.lastSeen = r.date
    out.set(key, s)
  }
  for (const s of out.values()) {
    s.inSek = roundOre(s.inSek)
    s.outSek = roundOre(s.outSek)
  }
  return out
}

function sum(keys: string[], stats: Map<string, BankStats>): BankStats {
  const s: BankStats = { count: 0, inSek: 0, outSek: 0, lastSeen: null }
  for (const k of keys) {
    const b = stats.get(k)
    if (!b) continue
    s.count += b.count
    s.inSek += b.inSek
    s.outSek += b.outSek
    if (b.lastSeen && (!s.lastSeen || b.lastSeen > s.lastSeen)) s.lastSeen = b.lastSeen
  }
  s.inSek = roundOre(s.inSek)
  s.outSek = roundOre(s.outSek)
  return s
}

function roleList(row: RegisterRow): PartyRole[] {
  const roles: PartyRole[] = []
  if (row.roles.supplierId) roles.push('supplier')
  if (row.roles.customerId) roles.push('customer')
  return roles
}

function matches(q: string, ...fields: Array<string | null | undefined>): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return fields.some((f) => f && f.toLowerCase().includes(needle))
}

/** Pure composition of the list from its three sources; the loaders sit below. */
export function composeCounterparts(input: {
  parties: RegisterRow[]
  aliases: AliasRecord[]
  bank: Map<string, BankStats>
  q?: string
}): Omit<CounterpartList, 'period' | 'scbConfigured'> {
  const q = (input.q ?? '').trim()
  const byParty = new Map<string, AliasRecord[]>()
  const unowned: AliasRecord[] = []
  for (const a of input.aliases) {
    if (a.party_id) {
      byParty.set(a.party_id, [...(byParty.get(a.party_id) ?? []), a])
    } else {
      unowned.push(a)
    }
  }

  const rows: CounterpartRow[] = []
  for (const p of input.parties) {
    const aliases = byParty.get(p.id) ?? []
    const keys = aliases.map((a) => a.alias_key)
    const bank = sum(keys, input.bank)
    const known = aliases.find((a) => a.what) ?? aliases[0]
    const seed = matchSeedText(p.displayName)
    const useBank = bank.count > 0
    const ledger = p.stats
    // A suggestion still carries the ledger's head-of-text name; when the
    // directory knows the brand behind it, the brand is the name. A confirmed
    // record keeps the name the person gave it.
    const seedName = p.status === 'suggested' && seed && seed.name.toLowerCase() !== p.displayName.toLowerCase() ? seed.name : null
    // A suggestion stored before the month and initial strip ("Resend Jul",
    // "Kontorsplatser j") shows its company name; the stored row is untouched.
    const shownName = seedName ?? (p.status === 'suggested' ? stripTrailingWhenAndWho(p.displayName) : p.displayName)
    rows.push({
      id: p.id,
      partyId: p.id,
      name: shownName,
      what: known?.what ?? seed?.what ?? null,
      kind: known?.kind ?? (p.kind === 'person' ? 'person' : 'merchant'),
      rail: known?.rail ?? null,
      country: p.country ?? known?.country ?? null,
      logoDomain: seed?.logoDomain ?? null,
      status: p.status,
      roles: roleList(p),
      defaultRoles: p.defaultRoles,
      orgNumber: p.orgNumber,
      account: ledger?.dominantAccount ?? null,
      accountName: ledger?.dominantAccountName ?? null,
      count: useBank ? bank.count : (ledger?.occurrences ?? 0),
      inSek: useBank ? bank.inSek : roundOre(ledger?.revenueSek ?? 0),
      outSek: useBank ? bank.outSek : roundOre(ledger?.expenseSek ?? 0),
      lastSeen: useBank ? bank.lastSeen : (ledger?.lastSeen ?? null),
      aliasKeys: keys,
      statsSource: useBank ? 'bank' : ledger ? 'ledger' : 'none',
      reason: p.status === 'suggested' ? p.reason : null,
      rhythm: ledger?.rhythm ?? null,
      source: known?.source ?? null,
    })
  }

  // Readings with no party yet, grouped by the name the resolver gave them.
  const byName = new Map<string, AliasRecord[]>()
  let unnamed = 0
  for (const a of unowned) {
    const nameable = a.band !== 'nil' && !!a.display_name && !OFF_LIST_KINDS.has(a.kind)
    if (!nameable) {
      unnamed += input.bank.get(a.alias_key)?.count ?? 0
      continue
    }
    const k = a.display_name!.trim().toLowerCase()
    byName.set(k, [...(byName.get(k) ?? []), a])
  }
  const partyNames = new Set(input.parties.map((p) => p.displayName.trim().toLowerCase()))
  for (const [nameKey, aliases] of byName) {
    if (partyNames.has(nameKey)) {
      // Same name as a party the resolver did not link: count it there.
      const party = rows.find((r) => r.partyId && r.name.trim().toLowerCase() === nameKey)
      if (party) {
        const extra = sum(aliases.map((a) => a.alias_key), input.bank)
        party.aliasKeys.push(...aliases.map((a) => a.alias_key))
        party.count += extra.count
        party.inSek = roundOre(party.inSek + extra.inSek)
        party.outSek = roundOre(party.outSek + extra.outSek)
        if (extra.lastSeen && (!party.lastSeen || extra.lastSeen > party.lastSeen)) party.lastSeen = extra.lastSeen
        if (party.statsSource === 'none' && extra.count) party.statsSource = 'bank'
        continue
      }
    }
    const keys = aliases.map((a) => a.alias_key)
    const bank = sum(keys, input.bank)
    const first = aliases[0]!
    const known = aliases.find((a) => a.what) ?? first
    rows.push({
      id: `alias:${first.alias_key}`,
      partyId: null,
      name: first.display_name!,
      what: known.what,
      kind: known.kind,
      rail: known.rail,
      country: known.country,
      logoDomain: matchSeedText(first.display_name!)?.logoDomain ?? null,
      status: aliases.some((a) => a.band === 'tentative') ? 'tentative' : 'read',
      roles: [],
      defaultRoles: bank.inSek > bank.outSek ? ['customer'] : ['supplier'],
      orgNumber: null,
      account: null,
      accountName: null,
      count: bank.count,
      inSek: bank.inSek,
      outSek: bank.outSek,
      lastSeen: bank.lastSeen,
      aliasKeys: keys,
      statsSource: bank.count ? 'bank' : 'none',
      reason: null,
      rhythm: null,
      source: known.source,
    })
  }

  // Bank strings nobody has read yet count as unnamed too.
  const seen = new Set(input.aliases.map((a) => a.alias_key))
  for (const [key, s] of input.bank) if (!seen.has(key)) unnamed += s.count

  const filtered = rows
    .filter((r) => matches(q, r.name, r.orgNumber, r.what))
    .sort((a, b) => b.inSek + b.outSek - (a.inSek + a.outSek) || a.name.localeCompare(b.name, 'sv'))

  return {
    rows: filtered,
    counts: {
      total: rows.length,
      confirmed: rows.filter((r) => r.status === 'confirmed').length,
      suggested: rows.filter((r) => r.status === 'suggested').length,
      read: rows.filter((r) => r.status === 'read').length,
      tentative: rows.filter((r) => r.status === 'tentative').length,
      unnamedTransactions: unnamed,
    },
  }
}

function periodStart(period: RegisterPeriod): string | null {
  if (period === 'all') return null
  const d = new Date()
  d.setMonth(d.getMonth() - 12)
  return d.toISOString().slice(0, 10)
}

export async function getCounterpartList(
  supabase: SupabaseClient,
  companyId: string,
  options: { q?: string; period?: RegisterPeriod } = {},
): Promise<CounterpartList> {
  const period = options.period ?? '12m'
  const since = periodStart(period)
  const [register, aliases, transactions] = await Promise.all([
    getRegister(supabase, companyId, { view: 'all', period }),
    fetchAllRows<AliasRecord>(({ from, to }) =>
      supabase
        .from('counterparty_aliases')
        .select('alias_key, party_id, display_name, kind, rail, country, what, band, source')
        .eq('company_id', companyId)
        .is('superseded_at', null)
        .range(from, to),
    ).catch(() => [] as AliasRecord[]),
    fetchAllRows<TxRecord>(({ from, to }) => {
      let query = supabase
        .from('transactions')
        .select('amount, amount_sek, date, original_description, description, merchant_name')
        .eq('company_id', companyId)
        .eq('is_ignored', false)
      if (since) query = query.gte('date', since)
      return query.order('date', { ascending: false }).range(from, to)
    }),
  ])
  const composed = composeCounterparts({ parties: register.rows, aliases, bank: bankStatsByKey(transactions), q: options.q })
  return { ...composed, period, scbConfigured: isScbConfigured() }
}
