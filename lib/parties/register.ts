/**
 * Parties, phase 1: the read model behind the Kontakter register.
 *
 * One list, three tiers (plan section 03): confirmed parties carry roles and
 * money; suggested parties wait in the queue with a reason per row; observed
 * parties are computed from the ledger and never stored. Money, rhythm and
 * the dominant account for every tier come from get_observed_parties, joined
 * to a party through its alias keys, so a confirmed party the books know
 * shows the same numbers a migrant saw in the reveal.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { coreKey } from './ledger-key'
import { getObservedParties, type ObservedParty } from './observed'
import type { SuggestionReason } from './suggest'

export type RegisterView = 'all' | 'customers' | 'suppliers' | 'suggested' | 'observed'
export type RegisterPeriod = '12m' | 'all'

export interface PartyRoleLink {
  customerId: string | null
  supplierId: string | null
}

export interface LedgerStats {
  occurrences: number
  expenseSek: number
  revenueSek: number
  firstSeen: string | null
  lastSeen: string | null
  cadenceDays: number | null
  rhythm: ObservedParty['rhythm']
  dominantAccount: string | null
  dominantShare: number | null
  variants: string[]
}

export interface RegisterRow {
  id: string
  displayName: string
  orgNumber: string | null
  kind: string
  status: 'confirmed' | 'suggested'
  roles: PartyRoleLink
  stats: LedgerStats | null
  /** Sales invoices for a customer role; supplier invoices for a supplier role. */
  invoiceCount: number
  reason: SuggestionReason | null
  /** Live parties sharing this party's core name: a merge question, never a merge. */
  similar: Array<{ id: string; displayName: string }>
  createdAt: string
}

export interface ObservedRow {
  key: string
  name: string
  stats: LedgerStats
  label: ObservedParty['label']
}

export interface RegisterCounts {
  all: number
  customers: number
  suppliers: number
  suggested: number
  observed: number
}

export interface Register {
  counts: RegisterCounts
  rows: RegisterRow[]
  observed: ObservedRow[]
  /** Observed keys the pre-classifier calls a category: unattributed spend. */
  generic: { count: number; expenseSek: number; examples: string[] }
  period: RegisterPeriod
}

interface PartyRecord {
  id: string
  display_name: string
  org_number: string | null
  kind: string
  status: 'confirmed' | 'suggested'
  alias_keys: string[]
  suggested_reason: SuggestionReason | null
  created_at: string
  archived_at?: string | null
}

export function statsFrom(o: ObservedParty): LedgerStats {
  return {
    occurrences: o.occurrences,
    expenseSek: Number(o.expense_sek) || 0,
    revenueSek: Number(o.revenue_sek) || 0,
    firstSeen: o.first_seen ?? null,
    lastSeen: o.last_seen ?? null,
    cadenceDays: o.cadence_days,
    rhythm: o.rhythm,
    dominantAccount: o.dominant_account_number,
    dominantShare: o.dominant_account_share,
    variants: o.variants ?? [],
  }
}

/** Sum the observed keys a party owns into one stats block. */
export function mergeStats(parts: ObservedParty[]): LedgerStats | null {
  if (parts.length === 0) return null
  const sorted = [...parts].sort((a, b) => b.occurrences - a.occurrences)
  const lead = statsFrom(sorted[0]!)
  const out: LedgerStats = { ...lead, variants: [] }
  let first: string | null = null
  let last: string | null = null
  for (const p of sorted) {
    if (p !== sorted[0]) {
      out.occurrences += p.occurrences
      out.expenseSek += Number(p.expense_sek) || 0
      out.revenueSek += Number(p.revenue_sek) || 0
    }
    if (p.first_seen && (!first || p.first_seen < first)) first = p.first_seen
    if (p.last_seen && (!last || p.last_seen > last)) last = p.last_seen
    for (const v of p.variants ?? []) if (!out.variants.includes(v)) out.variants.push(v)
  }
  out.firstSeen = first
  out.lastSeen = last
  out.expenseSek = roundOre(out.expenseSek)
  out.revenueSek = roundOre(out.revenueSek)
  return out
}

/**
 * Same-core parties among the live rows. Read-time, never stored: the
 * selection eval measured 9% false merges on shared trade names, so this
 * only ever asks.
 */
export function similarAmong(parties: Array<{ id: string; display_name: string; alias_keys: string[] }>): Map<string, Array<{ id: string; displayName: string }>> {
  const byCore = new Map<string, Array<{ id: string; displayName: string }>>()
  const coresOf = new Map<string, Set<string>>()
  for (const p of parties) {
    const cores = new Set<string>()
    const c = coreKey(p.display_name)
    if (c) cores.add(c)
    for (const a of p.alias_keys) {
      const ac = coreKey(a)
      if (ac) cores.add(ac)
    }
    coresOf.set(p.id, cores)
    for (const core of cores) byCore.set(core, [...(byCore.get(core) ?? []), { id: p.id, displayName: p.display_name }])
  }
  // Cores that extend another core by whole words share its first word:
  // "fortnox finans" reaches "fortnox" and the other way round.
  const byFirstWord = new Map<string, string[]>()
  for (const core of byCore.keys()) {
    const first = core.split(' ')[0]!
    byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), core])
  }
  const extendsCore = (a: string, b: string) => a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ')
  const out = new Map<string, Array<{ id: string; displayName: string }>>()
  for (const p of parties) {
    const seen = new Set<string>([p.id])
    const similar: Array<{ id: string; displayName: string }> = []
    for (const core of coresOf.get(p.id) ?? []) {
      for (const candidate of byFirstWord.get(core.split(' ')[0]!) ?? []) {
        if (!extendsCore(core, candidate)) continue
        for (const other of byCore.get(candidate) ?? []) {
          if (seen.has(other.id)) continue
          seen.add(other.id)
          similar.push(other)
        }
      }
    }
    out.set(p.id, similar)
  }
  return out
}

function periodStart(period: RegisterPeriod, now = new Date()): string | null {
  if (period === 'all') return null
  const d = new Date(now)
  d.setUTCFullYear(d.getUTCFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

function normalizeQuery(q: string | undefined): string {
  return (q ?? '').trim().toLowerCase()
}

function matches(q: string, ...fields: Array<string | null | undefined>): boolean {
  if (!q) return true
  const digits = q.replace(/[^0-9]/g, '')
  return fields.some((f) => {
    if (!f) return false
    const s = f.toLowerCase()
    if (s.includes(q)) return true
    return digits.length >= 4 && s.replace(/[^0-9]/g, '').includes(digits)
  })
}

/**
 * Load the register for one company. Reads only; the pipeline that fills the
 * suggested tier is suggestPartiesForCompany.
 */
export async function getRegister(
  supabase: SupabaseClient,
  companyId: string,
  options: { view?: RegisterView; q?: string; period?: RegisterPeriod } = {},
): Promise<Register> {
  const period = options.period ?? '12m'
  const q = normalizeQuery(options.q)

  const [parties, customers, suppliers, observed, customerCounts, supplierCounts] = await Promise.all([
    // Archived (dismissed) parties stay out of the list but keep their keys
    // claimed, so a dismissed suggestion does not resurface as observed.
    fetchAllRows<PartyRecord>(({ from, to }) =>
      supabase
        .from('parties')
        .select('id, display_name, org_number, kind, status, alias_keys, suggested_reason, created_at, archived_at')
        .eq('company_id', companyId)
        .is('merged_into', null)
        .order('display_name', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{ id: string; party_id: string | null }>(({ from, to }) =>
      supabase.from('customers').select('id, party_id').eq('company_id', companyId).not('party_id', 'is', null).range(from, to),
    ),
    fetchAllRows<{ id: string; party_id: string | null }>(({ from, to }) =>
      supabase.from('suppliers').select('id, party_id').eq('company_id', companyId).not('party_id', 'is', null).range(from, to),
    ),
    getObservedParties(supabase, companyId, { fromDate: periodStart(period), limit: 5000 }),
    fetchAllRows<{ customer_id: string }>(({ from, to }) =>
      supabase.from('invoices').select('customer_id').eq('company_id', companyId).not('customer_id', 'is', null).range(from, to),
    ),
    fetchAllRows<{ supplier_id: string }>(({ from, to }) =>
      supabase.from('supplier_invoices').select('supplier_id').eq('company_id', companyId).not('supplier_id', 'is', null).range(from, to),
    ),
  ])

  const customerByParty = new Map<string, string>()
  for (const c of customers) if (c.party_id && !customerByParty.has(c.party_id)) customerByParty.set(c.party_id, c.id)
  const supplierByParty = new Map<string, string>()
  for (const s of suppliers) if (s.party_id && !supplierByParty.has(s.party_id)) supplierByParty.set(s.party_id, s.id)
  const invoicesByCustomer = new Map<string, number>()
  for (const r of customerCounts) invoicesByCustomer.set(r.customer_id, (invoicesByCustomer.get(r.customer_id) ?? 0) + 1)
  const invoicesBySupplier = new Map<string, number>()
  for (const r of supplierCounts) invoicesBySupplier.set(r.supplier_id, (invoicesBySupplier.get(r.supplier_id) ?? 0) + 1)

  const observedByKey = new Map(observed.map((o) => [o.key, o]))
  const claimedKeys = new Set<string>()
  const similarById = similarAmong(parties.filter((p) => !p.archived_at))
  const rows: RegisterRow[] = []
  for (const p of parties) {
    const parts: ObservedParty[] = []
    for (const k of p.alias_keys) {
      const o = observedByKey.get(k)
      if (o) {
        parts.push(o)
        claimedKeys.add(k)
      }
    }
    if (p.archived_at) continue
    const customerId = customerByParty.get(p.id) ?? null
    const supplierId = supplierByParty.get(p.id) ?? null
    rows.push({
      id: p.id,
      displayName: p.display_name,
      orgNumber: p.org_number,
      kind: p.kind,
      status: p.status,
      roles: { customerId, supplierId },
      stats: mergeStats(parts),
      invoiceCount: (customerId ? (invoicesByCustomer.get(customerId) ?? 0) : 0) + (supplierId ? (invoicesBySupplier.get(supplierId) ?? 0) : 0),
      reason: p.status === 'suggested' ? p.suggested_reason : null,
      similar: similarById.get(p.id) ?? [],
      createdAt: p.created_at,
    })
  }

  const observedRows: ObservedRow[] = []
  const generic = { count: 0, expenseSek: 0, examples: [] as string[] }
  for (const o of observed) {
    if (claimedKeys.has(o.key)) continue
    if (o.label === 'party' || o.label === 'unsure') {
      observedRows.push({ key: o.key, name: o.name || o.key, stats: statsFrom(o), label: o.label })
    } else if (o.label === 'category') {
      generic.count += 1
      generic.expenseSek += Number(o.expense_sek) || 0
      if (generic.examples.length < 3) generic.examples.push(o.name || o.key)
    }
  }
  generic.expenseSek = roundOre(generic.expenseSek)

  const confirmed = rows.filter((r) => r.status === 'confirmed')
  const counts: RegisterCounts = {
    all: confirmed.length,
    customers: confirmed.filter((r) => r.roles.customerId).length,
    suppliers: confirmed.filter((r) => r.roles.supplierId).length,
    suggested: rows.filter((r) => r.status === 'suggested').length,
    observed: observedRows.length,
  }

  const view = options.view ?? 'all'
  const byMoney = (a: RegisterRow, b: RegisterRow) =>
    (b.stats?.expenseSek ?? 0) + (b.stats?.revenueSek ?? 0) - ((a.stats?.expenseSek ?? 0) + (a.stats?.revenueSek ?? 0)) ||
    a.displayName.localeCompare(b.displayName, 'sv')
  let selected: RegisterRow[]
  switch (view) {
    case 'customers':
      selected = confirmed.filter((r) => r.roles.customerId)
      break
    case 'suppliers':
      selected = confirmed.filter((r) => r.roles.supplierId)
      break
    case 'suggested':
      selected = rows.filter((r) => r.status === 'suggested')
      break
    case 'observed':
      selected = []
      break
    default:
      selected = confirmed
  }
  selected = selected.filter((r) => matches(q, r.displayName, r.orgNumber)).sort(byMoney)
  const observedSelected =
    view === 'observed'
      ? observedRows
          .filter((r) => matches(q, r.name, r.key))
          .sort((a, b) => b.stats.expenseSek + b.stats.revenueSek - (a.stats.expenseSek + a.stats.revenueSek))
      : []

  return { counts, rows: selected, observed: observedSelected, generic, period }
}

// ── Dossier ─────────────────────────────────────────────────────────────────

export interface PartyFact {
  id: string
  field: string
  value: unknown
  rank: string
  source: string
  reference: Record<string, unknown> | null
  fetchedAt: string | null
  recordedAt: string
}

export interface PartyIdentity {
  id: string
  scheme: string
  value: string
  status: 'known' | 'unverified'
  source: string
  firstSeen: string | null
  lastSeen: string | null
  seenCount: number
}

export interface PartyDecision {
  id: string
  kind: string
  note: string | null
  createdAt: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export interface PartyVoucher {
  id: string
  entryDate: string
  description: string
  voucher: string
  amount: number
}

export interface Dossier {
  party: RegisterRow & { aliasKeys: string[]; legalName: string | null; vatNumber: string | null }
  facts: PartyFact[]
  identities: PartyIdentity[]
  decisions: PartyDecision[]
  vouchers: PartyVoucher[]
  similar: Array<{ id: string; displayName: string; orgNumber: string | null; status: string }>
}

/**
 * The dossier for one party. A dismissed (archived) party is hidden here as
 * it is in the register; a merged party resolves to its survivor, so a
 * stale link lands on the right dossier instead of a dead one.
 */
export async function getDossier(supabase: SupabaseClient, companyId: string, partyId: string, hops = 0): Promise<Dossier | null> {
  const { data: party, error } = await supabase
    .from('parties')
    .select('id, display_name, legal_name, org_number, vat_number, kind, status, alias_keys, suggested_reason, created_at, merged_into, archived_at')
    .eq('company_id', companyId)
    .eq('id', partyId)
    .maybeSingle()
  if (error) throw new Error(`parties lookup failed: ${error.message}`)
  if (!party) return null
  const p = party as PartyRecord & { legal_name: string | null; vat_number: string | null; merged_into: string | null }
  if (p.merged_into) {
    if (hops >= 16) return null
    const { data: survivor, error: chainError } = await supabase.rpc('canonical_party_id', { p_party_id: p.id })
    if (chainError) throw new Error(`canonical_party_id failed: ${chainError.message}`)
    if (!survivor || survivor === p.id) return null
    return getDossier(supabase, companyId, survivor as string, hops + 1)
  }
  if (p.archived_at) return null

  const [facts, identities, decisions, customer, supplier, observed] = await Promise.all([
    supabase
      .from('party_facts')
      .select('id, field, value, rank, source, reference, fetched_at, recorded_at')
      .eq('company_id', companyId)
      .eq('party_id', partyId)
      .is('superseded_at', null)
      .order('recorded_at', { ascending: false }),
    supabase
      .from('party_identities')
      .select('id, scheme, value, status, source, first_seen, last_seen, seen_count')
      .eq('company_id', companyId)
      .eq('party_id', partyId)
      .order('seen_count', { ascending: false }),
    supabase
      .from('party_decisions')
      .select('id, kind, note, created_at, before, after')
      .eq('company_id', companyId)
      .eq('party_id', partyId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('customers').select('id').eq('company_id', companyId).eq('party_id', partyId).limit(1).maybeSingle(),
    supabase.from('suppliers').select('id').eq('company_id', companyId).eq('party_id', partyId).limit(1).maybeSingle(),
    getObservedParties(supabase, companyId, { limit: 5000 }),
  ])
  for (const r of [facts, identities, decisions]) if (r.error) throw new Error(`dossier read failed: ${r.error.message}`)

  const parts = observed.filter((o) => p.alias_keys.includes(o.key))
  const stats = mergeStats(parts)

  // Recent vouchers: the observed variants are the raw descriptions.
  let vouchers: PartyVoucher[] = []
  if (stats && stats.variants.length > 0) {
    const { data } = await supabase
      .from('journal_entries')
      .select('id, entry_date, description, voucher_series, voucher_number, journal_entry_lines(debit_amount, account_number)')
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .in('description', stats.variants.slice(0, 200))
      .order('entry_date', { ascending: false })
      .limit(12)
    vouchers = ((data ?? []) as Array<{
      id: string
      entry_date: string
      description: string
      voucher_series: string | null
      voucher_number: number | null
      journal_entry_lines: Array<{ debit_amount: number | null; account_number: string }> | null
    }>).map((e) => ({
      id: e.id,
      entryDate: e.entry_date,
      description: e.description,
      voucher: e.voucher_series && e.voucher_number != null ? `${e.voucher_series}-${e.voucher_number}` : '',
      amount: roundOre(
        (e.journal_entry_lines ?? [])
          .filter((l) => /^[3-8][0-9]{3}$/.test(l.account_number))
          .reduce((s, l) => s + (Number(l.debit_amount) || 0), 0),
      ),
    }))
  }

  const reason = p.status === 'suggested' ? p.suggested_reason : null
  const live = await fetchAllRows<{ id: string; display_name: string; org_number: string | null; status: string; alias_keys: string[] }>(({ from, to }) =>
    supabase
      .from('parties')
      .select('id, display_name, org_number, status, alias_keys')
      .eq('company_id', companyId)
      .is('merged_into', null)
      .is('archived_at', null)
      .range(from, to),
  )
  const liveById = new Map(live.map((l) => [l.id, l]))
  const similarIds = new Set<string>((similarAmong(live).get(p.id) ?? []).map((s) => s.id))
  for (const s of reason?.similar_to ?? []) if (liveById.has(s.party_id) && s.party_id !== p.id) similarIds.add(s.party_id)
  const similar: Dossier['similar'] = [...similarIds].map((id) => {
    const l = liveById.get(id)!
    return { id: l.id, displayName: l.display_name, orgNumber: l.org_number, status: l.status }
  })

  return {
    party: {
      id: p.id,
      displayName: p.display_name,
      legalName: p.legal_name,
      vatNumber: p.vat_number,
      orgNumber: p.org_number,
      kind: p.kind,
      status: p.status,
      aliasKeys: p.alias_keys,
      roles: { customerId: (customer.data as { id: string } | null)?.id ?? null, supplierId: (supplier.data as { id: string } | null)?.id ?? null },
      stats,
      invoiceCount: 0,
      reason,
      similar: similar.map((s) => ({ id: s.id, displayName: s.displayName })),
      createdAt: p.created_at,
    },
    facts: ((facts.data ?? []) as Array<Record<string, unknown>>).map((f) => ({
      id: f.id as string,
      field: f.field as string,
      value: f.value,
      rank: f.rank as string,
      source: f.source as string,
      reference: (f.reference as Record<string, unknown> | null) ?? null,
      fetchedAt: (f.fetched_at as string | null) ?? null,
      recordedAt: f.recorded_at as string,
    })),
    identities: ((identities.data ?? []) as Array<Record<string, unknown>>).map((i) => ({
      id: i.id as string,
      scheme: i.scheme as string,
      value: i.value as string,
      status: i.status as 'known' | 'unverified',
      source: i.source as string,
      firstSeen: (i.first_seen as string | null) ?? null,
      lastSeen: (i.last_seen as string | null) ?? null,
      seenCount: Number(i.seen_count) || 0,
    })),
    decisions: ((decisions.data ?? []) as Array<Record<string, unknown>>).map((d) => ({
      id: d.id as string,
      kind: d.kind as string,
      note: (d.note as string | null) ?? null,
      createdAt: d.created_at as string,
      before: (d.before as Record<string, unknown> | null) ?? null,
      after: (d.after as Record<string, unknown> | null) ?? null,
    })),
    vouchers,
    similar,
  }
}
