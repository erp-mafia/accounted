/**
 * Counterpart resolver, the run: for one company, every distinct transaction
 * string without a live alias goes through the ladder and gets one.
 *
 *   pre-pass  ->  document  ->  directory  ->  legal name  ->  model  ->  verify  ->  alias row
 *
 * The model sees only what the earlier rungs left, each line with the
 * register parties that resemble it as candidates, so a reading lands on an
 * existing party when one exists. Readings the model was half sure of go
 * through the verify pass before they are stored. Link-band model readings
 * are offered to the shared directory, which takes them only when a second
 * company produced the same one.
 *
 * Everything written is a display-time overlay. Turning the resolver off
 * (COUNTERPARTY_RESOLVER_MODE=off) leaves the ledger and the transactions
 * exactly as they were.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { GENERIC_WORDS } from '@/lib/parties/classify'
import { preclean, type Precleaned } from './preclean'
import { lookupDirectory, promoteIfShared } from './directory'
import { readCounterparts, readerAvailable, verifyCounterparts, type ModelReading, type ReaderCandidate, type ReaderLine } from './model-reading'
import { planAlias, type AliasDecision, type DocumentHit, type IdentityHit, type RegisterMatch } from './plan'

const log = createLogger('parties.resolver')

export type ResolverMode = 'off' | 'act'

export function resolverMode(): ResolverMode {
  return (process.env.COUNTERPARTY_RESOLVER_MODE ?? 'act').toLowerCase() === 'off' ? 'off' : 'act'
}

export interface RunOptions {
  /** How far back to look for transactions. Default 400 days. */
  sinceDays?: number
  /** Cap on distinct strings sent to the model in one run. Default 400. */
  maxModelLines?: number
  /** Skip the model entirely (tests, cold deployments). */
  useModel?: boolean
  /** Plan and read, write nothing; the decisions come back on the summary. */
  dryRun?: boolean
}

export interface RunSummary {
  companyId: string
  strings: number
  alreadyResolved: number
  planned: number
  byBand: Record<'link' | 'tentative' | 'nil', number>
  bySource: Record<string, number>
  modelLines: number
  verified: number
  promoted: number
  written: number
  /** Only on a dry run. */
  decisions?: AliasDecision[]
}

interface TxRow {
  id: string
  original_description: string | null
  description: string | null
  amount: number | string
  currency: string | null
  merchant_name: string | null
}

interface Group {
  raw: string
  pre: Precleaned
  txIds: string[]
  count: number
  amountAbs: number
  /** Signed sum, so the group's direction is the majority direction. */
  amountNet: number
  currency: string
}

interface PartyRow {
  id: string
  display_name: string
  alias_keys: string[] | null
  status: string
}

const PAGE = 1000

async function loadTransactions(supabase: SupabaseClient, companyId: string, sinceDays: number): Promise<TxRow[]> {
  const since = new Date(Date.now() - sinceDays * 86400e3).toISOString().slice(0, 10)
  const rows: TxRow[] = []
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, original_description, description, amount, currency, merchant_name')
      .eq('company_id', companyId)
      .gte('date', since)
      .order('date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`transactions: ${error.message}`)
    rows.push(...((data ?? []) as TxRow[]))
    if (!data || data.length < PAGE) break
  }
  return rows
}

export function groupStrings(rows: TxRow[]): Map<string, Group> {
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const raw = (r.original_description?.trim() || r.description?.trim() || r.merchant_name?.trim() || '').slice(0, 500)
    if (raw.length < 2) continue
    const pre = preclean(raw)
    const key = pre.aliasKey
    const g = groups.get(key) ?? { raw, pre, txIds: [], count: 0, amountAbs: 0, amountNet: 0, currency: r.currency || 'SEK' }
    g.txIds.push(r.id)
    g.count += 1
    g.amountAbs += Math.abs(Number(r.amount) || 0)
    g.amountNet += Number(r.amount) || 0
    groups.set(key, g)
  }
  return groups
}

async function loadLiveAliasKeys(supabase: SupabaseClient, companyId: string, keys: string[]): Promise<Set<string>> {
  const live = new Set<string>()
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200)
    const { data, error } = await supabase
      .from('counterparty_aliases')
      .select('alias_key')
      .eq('company_id', companyId)
      .is('superseded_at', null)
      .in('alias_key', slice)
    if (error) throw new Error(`counterparty_aliases: ${error.message}`)
    for (const r of (data ?? []) as Array<{ alias_key: string }>) live.add(r.alias_key)
  }
  return live
}

async function loadDocumentHits(supabase: SupabaseClient, companyId: string, txIds: string[]): Promise<Map<string, DocumentHit>> {
  const hits = new Map<string, DocumentHit>()
  for (let i = 0; i < txIds.length; i += 200) {
    const slice = txIds.slice(i, i + 200)
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('matched_transaction_id, extracted_data')
      .eq('company_id', companyId)
      .in('matched_transaction_id', slice)
    if (error) {
      // The inbox is an extension; a deployment without it has no table.
      log.info('invoice_inbox_items not readable, skipping document hits', { message: error.message })
      return hits
    }
    for (const r of (data ?? []) as Array<{ matched_transaction_id: string | null; extracted_data: { supplier?: { name?: string | null; country?: string | null } | null } | null }>) {
      const name = r.extracted_data?.supplier?.name?.trim()
      if (r.matched_transaction_id && name) hits.set(r.matched_transaction_id, { supplierName: name.slice(0, 200), country: r.extracted_data?.supplier?.country ?? null })
    }
  }
  return hits
}

async function loadParties(supabase: SupabaseClient, companyId: string): Promise<PartyRow[]> {
  const { data, error } = await supabase
    .from('parties')
    .select('id, display_name, alias_keys, status')
    .eq('company_id', companyId)
    .is('archived_at', null)
    .is('merged_into', null)
    .limit(5000)
  if (error) throw new Error(`parties: ${error.message}`)
  return (data ?? []) as PartyRow[]
}

// Words that name a kind of thing, not a company: a candidate offered on
// "hotel" or "utlägg" alone misled the model in the first dry run.
const STOP = new Set([
  ...GENERIC_WORDS,
  'sverige', 'sweden', 'stockholm', 'göteborg', 'malmö', 'group', 'holding', 'international', 'online', 'services', 'service', 'company',
  'hotel', 'hotell', 'restaurang', 'restaurant', 'cafe', 'café', 'bistro', 'krog', 'pizzeria', 'bageri', 'kiosk', 'butik', 'shop', 'store',
  'test', 'kund', 'pris', 'aktiebolag', 'limited', 'systems', 'software', 'solutions', 'consulting', 'media', 'design', 'digital', 'studio', 'partners',
])

function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9åäöé]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 4 && !STOP.has(t))
}

/** Register parties that share a token with the text, most overlap first, at most five. */
export function candidatesFor(text: string, parties: PartyRow[]): RegisterMatch[] {
  const t = new Set(nameTokens(text))
  if (!t.size) return []
  const scored: Array<{ p: PartyRow; score: number }> = []
  for (const p of parties) {
    const pt = nameTokens(p.display_name)
    let score = 0
    for (const x of pt) if (t.has(x)) score += 1
    if (score > 0) scored.push({ p, score })
  }
  scored.sort((a, b) => b.score - a.score || a.p.display_name.localeCompare(b.p.display_name, 'sv'))
  return scored.slice(0, 5).map(({ p }) => ({ partyId: p.id, name: p.display_name }))
}

interface IdentityRow {
  party_id: string
  scheme: string
  value: string
}

/** Giro numbers the register already knows, by digits only. */
async function loadPartyGiros(supabase: SupabaseClient, companyId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { data, error } = await supabase
    .from('party_identities')
    .select('party_id, scheme, value')
    .eq('company_id', companyId)
    .in('scheme', ['bankgiro', 'plusgiro'])
    .limit(5000)
  if (error) {
    log.info('party_identities not readable, skipping giro anchors', { message: error.message })
    return out
  }
  for (const r of (data ?? []) as IdentityRow[]) {
    const digits = r.value.replace(/\D/g, '').replace(/^0+/, '')
    if (digits) out.set(`${r.scheme === 'plusgiro' ? 'pg' : 'bg'}:${digits}`, r.party_id)
  }
  return out
}

function partyByName(parties: PartyRow[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const p of parties) {
    const k = p.display_name.trim().toLowerCase()
    if (!m.has(k) || p.status === 'confirmed') m.set(k, p.id)
  }
  return m
}

export async function resolveCompanyCounterparts(supabase: SupabaseClient, companyId: string, options: RunOptions = {}): Promise<RunSummary> {
  const sinceDays = options.sinceDays ?? 400
  const maxModelLines = options.maxModelLines ?? 400
  const useModel = options.useModel ?? true
  const dryRun = options.dryRun ?? false
  const summary: RunSummary = {
    companyId,
    strings: 0,
    alreadyResolved: 0,
    planned: 0,
    byBand: { link: 0, tentative: 0, nil: 0 },
    bySource: {},
    modelLines: 0,
    verified: 0,
    promoted: 0,
    written: 0,
  }

  const rows = await loadTransactions(supabase, companyId, sinceDays)
  const groups = groupStrings(rows)
  summary.strings = groups.size
  if (!groups.size) return summary

  const live = dryRun ? new Set<string>() : await loadLiveAliasKeys(supabase, companyId, [...groups.keys()])
  const pending = [...groups.values()].filter((g) => !live.has(g.pre.aliasKey))
  summary.alreadyResolved = groups.size - pending.length
  if (!pending.length) return summary

  const [docHits, parties, giros] = await Promise.all([
    loadDocumentHits(supabase, companyId, pending.flatMap((g) => g.txIds)),
    loadParties(supabase, companyId),
    loadPartyGiros(supabase, companyId),
  ])
  const byName = partyByName(parties)
  const nameById = new Map(parties.map((p) => [p.id, p.display_name]))

  // Rungs one to four, per string.
  const firstPass = new Map<string, { group: Group; decision: AliasDecision; candidates: RegisterMatch[] }>()
  const forModel: Array<{ group: Group; line: ReaderLine; candidatesById: Map<string, RegisterMatch> }> = []
  let i = 0
  for (const group of pending) {
    const doc = group.txIds.map((id) => docHits.get(id)).find((d): d is DocumentHit => !!d) ?? null
    if (doc) doc.partyId = byName.get(doc.supplierName.toLowerCase()) ?? null
    const directory = await lookupDirectory(supabase, group.pre)
    const dirHit = directory ? { ...directory, partyId: byName.get(directory.name.toLowerCase()) ?? null, viaGiro: /^(bg|pg):/.test(directory.key) } : null
    let identity: IdentityHit | null = null
    if (group.pre.giro) {
      const partyId = giros.get(`${group.pre.giro.scheme}:${group.pre.giro.value.replace(/\D/g, '').replace(/^0+/, '')}`)
      const name = partyId ? nameById.get(partyId) : undefined
      if (partyId && name) identity = { partyId, name }
    }
    const decision = planAlias({ pre: group.pre, identity, document: doc, directory: dirHit })
    const candidates = candidatesFor(group.pre.text, parties)
    firstPass.set(group.pre.aliasKey, { group, decision, candidates })
    const needsModel = decision.band === 'nil' && decision.source === 'anchor' && (group.pre.label === 'party' || group.pre.label === 'unsure' || group.pre.label === 'authority' || group.pre.label === 'bank' || group.pre.label === 'intermediary')
    if (needsModel && useModel && forModel.length < maxModelLines) {
      i += 1
      const candidatesById = new Map(candidates.map((c, k) => [`p${k + 1}`, c]))
      const readerCandidates: ReaderCandidate[] = [...candidatesById.entries()].map(([id, c]) => ({ id, name: c.name }))
      forModel.push({
        group,
        candidatesById,
        line: {
          i,
          text: group.pre.text,
          amount: group.count ? group.amountAbs / group.count : 0,
          currency: group.currency,
          seenCount: group.count,
          companyCount: 1,
          rail: group.pre.rail,
          direction: group.amountNet > 0 ? 'in' : 'out',
          candidates: readerCandidates,
        },
      })
    }
  }

  // Rung five and six: the model, then the verify pass on the medium band.
  const readings = new Map<number, ModelReading>()
  const verdicts = new Map<number, 'yes' | 'no' | 'unsure'>()
  if (forModel.length && readerAvailable()) {
    summary.modelLines = forModel.length
    const got = await readCounterparts(forModel.map((f) => f.line))
    for (const [k, v] of got) readings.set(k, v)
    const toVerify = forModel
      .map((f) => ({ f, r: readings.get(f.line.i) }))
      .filter(({ f, r }) => r && planAlias({ pre: f.group.pre, model: r, candidatesById: f.candidatesById }).needsVerify)
      .map(({ f, r }) => ({ i: f.line.i, text: f.line.text, proposed: r!.pick ? f.candidatesById.get(r!.pick)!.name : r!.counterpart! }))
    if (toVerify.length) {
      const v = await verifyCounterparts(toVerify)
      for (const [k, val] of v) verdicts.set(k, val)
      summary.verified = v.size
    }
  }

  const decisions: AliasDecision[] = []
  for (const { group, decision } of firstPass.values()) {
    const m = forModel.find((f) => f.group === group)
    if (!m) {
      decisions.push(decision)
      continue
    }
    const reading = readings.get(m.line.i) ?? null
    const final = planAlias({ pre: group.pre, model: reading, candidatesById: m.candidatesById, verify: verdicts.get(m.line.i) ?? null })
    if (final.partyId === null && final.displayName) final.partyId = byName.get(final.displayName.toLowerCase()) ?? null
    decisions.push(final)
  }

  summary.planned = decisions.length
  for (const d of decisions) {
    summary.byBand[d.band] += 1
    summary.bySource[d.source] = (summary.bySource[d.source] ?? 0) + 1
  }

  if (dryRun) {
    summary.decisions = decisions
    return summary
  }

  // Store, then offer link-band model readings to the shared directory.
  for (let k = 0; k < decisions.length; k += 200) {
    const slice = decisions.slice(k, k + 200)
    const { error } = await supabase.from('counterparty_aliases').insert(
      slice.map((d) => ({
        company_id: companyId,
        alias_key: d.aliasKey,
        sample_text: d.sampleText,
        party_id: d.partyId,
        display_name: d.displayName,
        kind: d.kind,
        rail: d.rail,
        country: d.country,
        what: d.what,
        source: d.source,
        confidence: d.confidence,
        band: d.band,
        model: d.model,
        verified: d.verified,
      })),
    )
    if (error) {
      log.warn('alias insert failed', { companyId, message: error.message, rows: slice.length })
      continue
    }
    summary.written += slice.length
  }

  for (const d of decisions) {
    if (d.source !== 'model' || d.band !== 'link' || !d.displayName) continue
    const ok = await promoteIfShared(supabase, { aliasKey: d.aliasKey, displayName: d.displayName, kind: d.kind, rail: d.rail, country: d.country, what: d.what })
    if (ok) summary.promoted += 1
  }

  log.info('counterparts resolved', { ...summary, bySource: JSON.stringify(summary.bySource) })
  return summary
}
