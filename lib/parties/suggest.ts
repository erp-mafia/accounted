/**
 * Parties, phase 1c: the suggestion pipeline.
 *
 * Turns what the ledger already knows about a company into suggested parties
 * so a migrant's register is full on arrival. Inputs are the observed parties
 * (posted vouchers grouped by ledger key, get_observed_parties) and the hard
 * keys read from documents linked to those vouchers (get_ledger_key_evidence:
 * org number, VAT number, bankgiro, plusgiro, printed name). Output is a list
 * of items for apply_party_suggestions, which writes parties with status
 * 'suggested' and never merges on name: a key attaches to an existing party
 * only through its org number or because that exact key is already an alias.
 *
 * Keys that look alike (same core) are reported in the reason as
 * similar_to, so the queue can offer "same as X?" for a person to decide.
 * The model selection step is not wired here yet; it runs in shadow through
 * scripts/parties/eval-selection.ts until its decisions are labelled.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { coreKey, displayNameFromVoucherText } from './ledger-key'
import { extractNameCandidates, extractVatNumbers } from './name-extract'
import { getObservedParties, type ObservedParty } from './observed'

export interface IdentityEvidence {
  value: string
  n: number
  first_seen: string | null
  last_seen: string | null
}

export interface LedgerKeyEvidence {
  key: string
  docs: number
  self_docs: number
  orgs: Array<{ org: string; n: number }>
  vat_numbers: Array<{ vat: string; n: number }>
  names: Array<{ name: string; n: number }>
  bankgiro: IdentityEvidence[]
  plusgiro: IdentityEvidence[]
}

export interface ExistingParty {
  id: string
  display_name: string
  org_number: string | null
  alias_keys: string[]
  status: 'suggested' | 'confirmed'
}

export interface SuggestionFact {
  field: string
  value: unknown
  source: 'ledger' | 'document'
  reference?: Record<string, unknown>
}

export interface SuggestionIdentity {
  scheme: 'bankgiro' | 'plusgiro'
  value: string
  first_seen: string | null
  last_seen: string | null
  seen_count: number
}

export interface SuggestionReason {
  /** How the key attaches, or why it becomes a new party. */
  attach: 'party_id' | 'org_number' | 'alias_key' | 'new'
  occurrences: number
  expense_sek: number
  revenue_sek: number
  first_seen: string
  last_seen: string
  docs: number
  /** Documents whose supplier org number is the company's own: sales side. */
  self_docs: number
  org_number?: string
  /** More than one org number seen under the key: hard key withheld. */
  ambiguous_orgs?: string[]
  dominant_account?: string | null
  /** Live parties with the same core: a merge question, never a merge. */
  similar_to?: Array<{ party_id: string; display_name: string }>
}

export interface SuggestionItem {
  key: string
  display_name: string
  legal_name?: string
  kind: 'company'
  origin: 'ledger' | 'document'
  org_number?: string
  vat_number?: string
  party_id?: string
  alias_keys: string[]
  reason: SuggestionReason
  facts: SuggestionFact[]
  identities: SuggestionIdentity[]
}

export interface SuggestionSkip {
  key: string
  label: ObservedParty['label']
}

export interface BuildResult {
  items: SuggestionItem[]
  skipped: SuggestionSkip[]
}

interface PickedName {
  display: string
  legal?: string
  /** ISO 3166-1 alpha-2 read out of the voucher text, when it says. */
  country?: string
  /** The text points abroad: foreign legal form, country word or VAT prefix. */
  foreign?: boolean
}

/** The voucher texts under a key, most common first, at most three. */
function voucherTexts(observed: ObservedParty): string[] {
  const out: string[] = []
  for (const t of [observed.name, ...(observed.variants ?? [])]) {
    const v = (t ?? '').trim()
    if (v && !out.includes(v)) out.push(v)
    if (out.length === 3) break
  }
  return out
}

function pickName(observed: ObservedParty, evidence: LedgerKeyEvidence | undefined): PickedName {
  // A printed supplier name from a document beats the voucher text, which is
  // upper-cased, truncated and prefixed by whatever the source system did.
  const printed = evidence?.names[0]?.name
  if (printed && printed.length >= 2) return { display: printed, legal: printed }
  // Assistant-written descriptions bury the company in a sentence; a legal
  // form or a country word in the text names it better than the head does.
  const candidates = voucherTexts(observed).flatMap(extractNameCandidates)
  const anchored =
    candidates.find((c) => c.source === 'legal_form' && !c.foreign) ??
    candidates.find((c) => c.source === 'legal_form') ??
    candidates.find((c) => c.source === 'country')
  if (anchored) return { display: anchored.name, ...(anchored.country ? { country: anchored.country } : {}), foreign: anchored.foreign }
  const head = candidates.find((c) => c.source === 'head')
  return {
    display: displayNameFromVoucherText(observed.name || observed.key),
    ...(head?.country ? { country: head.country } : {}),
    ...(head?.foreign ? { foreign: true } : {}),
  }
}

function identitiesFrom(evidence: LedgerKeyEvidence | undefined): SuggestionIdentity[] {
  if (!evidence) return []
  const out: SuggestionIdentity[] = []
  for (const scheme of ['bankgiro', 'plusgiro'] as const) {
    for (const e of evidence[scheme]) {
      out.push({ scheme, value: e.value, first_seen: e.first_seen, last_seen: e.last_seen, seen_count: e.n })
    }
  }
  return out
}

/**
 * Pure: decide what each observed party key becomes. Only keys the
 * pre-classifier calls 'party' continue; the rest are returned as skipped so
 * callers can show why "Inköp av varor" is not a supplier.
 */
export function buildSuggestions(input: {
  observed: ObservedParty[]
  evidence: LedgerKeyEvidence[]
  existing: ExistingParty[]
}): BuildResult {
  const evidenceByKey = new Map(input.evidence.map((e) => [e.key, e]))
  const byOrg = new Map<string, ExistingParty>()
  const byAlias = new Map<string, ExistingParty>()
  const byCore = new Map<string, ExistingParty[]>()
  for (const p of input.existing) {
    if (p.org_number && !byOrg.has(p.org_number)) byOrg.set(p.org_number, p)
    for (const a of p.alias_keys) if (!byAlias.has(a)) byAlias.set(a, p)
    const c = coreKey(p.display_name)
    if (c) byCore.set(c, [...(byCore.get(c) ?? []), p])
    for (const a of p.alias_keys) {
      const ac = coreKey(a)
      if (ac && ac !== c) byCore.set(ac, [...(byCore.get(ac) ?? []), p])
    }
  }

  const items: SuggestionItem[] = []
  const skipped: SuggestionSkip[] = []
  for (const o of input.observed) {
    if (o.label !== 'party') {
      skipped.push({ key: o.key, label: o.label })
      continue
    }
    const ev = evidenceByKey.get(o.key)
    const orgs = ev?.orgs ?? []
    const org = orgs.length === 1 ? orgs[0]!.org : undefined
    const existing = (org && byOrg.get(org)) || byAlias.get(o.key) || undefined
    const name = pickName(o, ev)
    const reason: SuggestionReason = {
      attach: existing ? (org && byOrg.get(org) === existing ? 'org_number' : 'alias_key') : 'new',
      occurrences: o.occurrences,
      expense_sek: o.expense_sek,
      revenue_sek: o.revenue_sek,
      first_seen: o.first_seen,
      last_seen: o.last_seen,
      docs: ev?.docs ?? 0,
      self_docs: ev?.self_docs ?? 0,
      dominant_account: o.dominant_account_number,
    }
    if (org) reason.org_number = org
    if (orgs.length > 1) reason.ambiguous_orgs = orgs.map((x) => x.org)
    if (!existing) {
      const similar = (byCore.get(coreKey(o.key)) ?? []).filter((p) => !org || p.org_number !== org)
      if (similar.length) reason.similar_to = similar.slice(0, 6).map((p) => ({ party_id: p.id, display_name: p.display_name }))
    }

    const facts: SuggestionFact[] = []
    if (o.dominant_account_number) {
      facts.push({
        field: 'dominant_account',
        value: { account: o.dominant_account_number, share: o.dominant_account_share, count: o.dominant_account_count },
        source: 'ledger',
        reference: { occurrences: o.occurrences, first_seen: o.first_seen, last_seen: o.last_seen },
      })
    }
    if (o.cadence_days != null) {
      facts.push({ field: 'cadence_days', value: o.cadence_days, source: 'ledger', reference: { occurrences: o.occurrences } })
    }
    if (org) {
      facts.push({ field: 'org_number', value: org, source: 'document', reference: { docs: orgs[0]!.n } })
    }
    if (name.legal) {
      facts.push({ field: 'legal_name', value: name.legal, source: 'document', reference: { docs: ev?.names[0]?.n ?? 0 } })
    }
    // The texts themselves, so the registry picker can read a name out of
    // them later without scanning the ledger again.
    const texts = voucherTexts(o)
    if (texts.length) {
      facts.push({ field: 'voucher_text', value: texts, source: 'ledger', reference: { occurrences: o.occurrences } })
    }
    if (name.country) {
      facts.push({ field: 'country', value: name.country, source: 'ledger', reference: { occurrences: o.occurrences } })
    }
    // A single foreign VAT number written in the text is the counterpart's
    // (the company's own SE number is what people note next to it).
    const textVats = [...new Set(texts.flatMap(extractVatNumbers).filter((v) => v.country !== 'SE').map((v) => v.vat))]
    const textVat = textVats.length === 1 ? textVats[0] : undefined
    if (textVat && !ev?.vat_numbers[0]?.vat) {
      facts.push({ field: 'vat_number', value: textVat, source: 'ledger', reference: { occurrences: o.occurrences } })
    }

    // Identities only when the hard key is unambiguous: a key that mixes two
    // org numbers would otherwise attach one supplier's bankgiro to another.
    const identities = orgs.length > 1 ? [] : identitiesFrom(ev)
    const vat = ev?.vat_numbers[0]?.vat ?? textVat

    items.push({
      key: o.key,
      display_name: name.display,
      ...(name.legal ? { legal_name: name.legal } : {}),
      kind: 'company',
      origin: org ? 'document' : 'ledger',
      ...(org ? { org_number: org } : {}),
      ...(vat && orgs.length <= 1 ? { vat_number: vat } : {}),
      ...(existing ? { party_id: existing.id } : {}),
      alias_keys: [o.key],
      reason,
      facts,
      identities,
    })
  }
  return { items, skipped }
}

export interface SuggestSummary {
  observed: number
  suggested: number
  skipped: number
  created: number
  attached: number
  identities: number
  facts: number
}

/**
 * Run the pipeline for one company and persist the result. Safe to re-run:
 * apply_party_suggestions is idempotent.
 */
export async function suggestPartiesForCompany(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  options: { fromDate?: string | null; limit?: number; chunkSize?: number } = {},
): Promise<SuggestSummary> {
  const observed = await getObservedParties(supabase, companyId, {
    fromDate: options.fromDate ?? null,
    limit: options.limit ?? 5000,
  })
  const { data: evidenceData, error: evidenceError } = await supabase.rpc('get_ledger_key_evidence', {
    p_company_id: companyId,
  })
  if (evidenceError) throw new Error(`get_ledger_key_evidence failed: ${evidenceError.message}`)
  const evidence = (Array.isArray(evidenceData) ? evidenceData : []) as LedgerKeyEvidence[]

  const existing = await fetchAllRows<ExistingParty>(({ from, to }) =>
    supabase
      .from('parties')
      .select('id, display_name, org_number, alias_keys, status')
      .eq('company_id', companyId)
      .is('merged_into', null)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .range(from, to),
  )

  const { items, skipped } = buildSuggestions({ observed, evidence, existing })
  const summary: SuggestSummary = {
    observed: observed.length,
    suggested: items.length,
    skipped: skipped.length,
    created: 0,
    attached: 0,
    identities: 0,
    facts: 0,
  }
  const chunk = Math.max(1, options.chunkSize ?? 200)
  for (let i = 0; i < items.length; i += chunk) {
    const { data, error } = await supabase.rpc('apply_party_suggestions', {
      p_company_id: companyId,
      p_user_id: userId,
      p_items: items.slice(i, i + chunk),
    })
    if (error) throw new Error(`apply_party_suggestions failed: ${error.message}`)
    const r = (data ?? {}) as Partial<Record<'created' | 'attached' | 'identities' | 'facts', number>>
    summary.created += r.created ?? 0
    summary.attached += r.attached ?? 0
    summary.identities += r.identities ?? 0
    summary.facts += r.facts ?? 0
  }
  return summary
}
