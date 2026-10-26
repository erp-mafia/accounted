import type { SupabaseClient } from '@supabase/supabase-js'
import type { CustomerDto, SupplierDto } from '@/lib/providers/dto'
import { fetchMigrationPage, hydrateCustomers, hydrateSuppliers } from '@/lib/providers/provider-data-fetcher'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeVatNumber } from '@/lib/vat/vat-number'
import {
  buildCustomerCards,
  customerNameKey,
  customerRegisterFacts,
  identityKey,
  matchExistingCustomer,
  type CustomerCard,
  type PartyFacts,
} from './customer-match'
import { consentUnusable, isMigrationResetSource, messageOf } from './repair-fortnox-supplier-numbers'

/**
 * crm#1245: gives customers and suppliers imported from Fortnox before !747
 * (customers) and !874 (suppliers) the payment terms Fortnox holds for them.
 * Both imports read Fortnox's short list form, which has no TermsOfPayment,
 * so every card got the 30-day default: in prod 12 of 7 334 job-path
 * customers were not on 30 before the fix, 243 of 368 after it. One-off,
 * driven by the fortnox-terms-backfill cron (runFortnoxTermsBackfill).
 *
 * The terms come from Fortnox itself, one detail read per card: the stored
 * import payloads hold the list form too, so they cannot say. Each record
 * finds its card through the import's source map, or, for the older import
 * path that wrote none, through the identity match the durable import uses
 * (customer-match). Only a card still on 30 is a candidate, and the write
 * repeats that condition, so a term a person set since wins.
 *
 * A company with tens of thousands of cards does not fit one run, so
 * candidates are read in key order and a run that reaches its deadline
 * stores `next`, the key the following run starts from, in
 * fortnox_terms_backfill_progress (migration 20261026230300).
 */

export type TermsResource = 'customers' | 'suppliers'
const RESOURCES: TermsResource[] = ['customers', 'suppliers']
const MAX_FORTNOX_PAGES = 1000

/** The default both importers wrote when the source named no terms. */
export const IMPORT_DEFAULT_TERMS = 30

/** Detail reads per hydration call; a batch cut off by the deadline is read again by the next run. */
const BATCH_SIZE = 50

/** One Fortnox customer or supplier in its list form, with the keys a match compares. */
export interface TermsSourceRecord {
  resource: TermsResource
  sourceId: string
  active: boolean
  facts: PartyFacts
  dto: CustomerDto | SupplierDto
}

/** An existing card: its terms and the keys a match compares. */
export interface TermsCard {
  terms: number | null
  card: CustomerCard
}

/** A card still on the import default and the record behind it. */
export interface TermsCandidate {
  /** `<resource>:<source id>`; candidates are read in this order. */
  key: string
  resource: TermsResource
  cardId: string
  record: TermsSourceRecord
}

/**
 * Match level: has_terms (the card is not on 30), no_card, inactive.
 * Read level: fill, same (Fortnox says 30 too), no_terms (Fortnox names none,
 * or a code that is not whole days 0-365), unread (the detail read failed),
 * conflict (two records name the card with different terms; left alone).
 */
export type TermsOutcome = 'fill' | 'same' | 'no_terms' | 'unread' | 'conflict' | 'has_terms' | 'no_card' | 'inactive'

export interface TermsFill {
  resource: TermsResource
  id: string
  terms: number
}

export type FortnoxFetchState = 'fetched' | 'no_consent' | 'consent_expired' | 'failed'

export interface TermsBackfillPlan {
  fortnox: FortnoxFetchState
  fortnoxError?: string
  listed: number
  /** Candidates from `from` on. */
  candidates: number
  counts: Record<TermsResource, Partial<Record<TermsOutcome, number>>>
  fills: TermsFill[]
  /** Where the next run starts, or null when every candidate was read. */
  next: string | null
}

export interface TermsBackfillDeps {
  resolveConsent?: typeof resolveConsent
  fetchMigrationPage?: typeof fetchMigrationPage
  hydrateCustomers?: typeof hydrateCustomers
  hydrateSuppliers?: typeof hydrateSuppliers
}

const recordKey = (resource: TermsResource, sourceId: string) => `${resource}:${sourceId}`
const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function supplierFacts(dto: SupplierDto): PartyFacts {
  return {
    identity: identityKey(
      dto.party.identifications?.find((i) => i.schemeId === 'SE:ORGNR')?.id || dto.party.legalEntity?.companyId,
    ),
    vat: dto.vatNumber ? normalizeVatNumber(dto.vatNumber) || undefined : undefined,
    name: customerNameKey(dto.party.name),
  }
}

/** A listed Fortnox customer or supplier as a source record, or null without a number. */
export function termsSourceRecord(resource: TermsResource, dto: CustomerDto | SupplierDto): TermsSourceRecord | null {
  if (!dto.id) return null
  const facts = resource === 'customers'
    ? customerRegisterFacts('fortnox', dto as CustomerDto)
    : supplierFacts(dto as SupplierDto)
  return { resource, sourceId: dto.id, active: dto.active, facts, dto }
}

/** Fortnox's terms as whole days 0-365, else null (the range both forms accept). */
export function statedTerms(days: number | undefined): number | null {
  return days !== undefined && Number.isInteger(days) && days >= 0 && days <= 365 ? days : null
}

/**
 * The cards sharing at least one key with the facts. matchExistingCustomer
 * only ever answers with a card that matches on a key, so it gives the same
 * answer on these as on every card, without comparing each record with each
 * card (44 000 customers in the largest company).
 */
function candidateIndex(cards: CustomerCard[]): (facts: PartyFacts) => CustomerCard[] {
  const index = new Map<string, CustomerCard[]>()
  const add = (key: string, card: CustomerCard) => {
    const list = index.get(key) ?? []
    list.push(card)
    index.set(key, list)
  }
  for (const card of cards) {
    for (const identity of card.identities) add(`i:${identity}`, card)
    if (card.vat) add(`v:${card.vat}`, card)
    if (card.number) add(`n:${card.number}`, card)
    if (card.name) add(`m:${card.name}`, card)
  }
  return (facts) => {
    const found = new Set<CustomerCard>()
    const keys = [facts.identity && `i:${facts.identity}`, facts.vat && `v:${facts.vat}`,
      facts.number && `n:${facts.number}`, facts.name && `m:${facts.name}`]
    for (const key of keys) if (key) for (const card of index.get(key) ?? []) found.add(card)
    return [...found]
  }
}

type Counts = TermsBackfillPlan['counts']

function counter(counts: Counts) {
  return (resource: TermsResource, outcome: TermsOutcome) => {
    counts[resource][outcome] = (counts[resource][outcome] ?? 0) + 1
  }
}

/** The cards still on 30 that a Fortnox record names, in key order, from `from` on. */
export function matchTermsCandidates(
  records: TermsSourceRecord[],
  cards: Record<TermsResource, TermsCard[]>,
  sourceMap: Map<string, string[]>,
  from: string | null = null,
): { candidates: TermsCandidate[]; counts: Counts } {
  const counts: Counts = { customers: {}, suppliers: {} }
  const count = counter(counts)
  const candidates: TermsCandidate[] = []
  // Every record is matched, `from` or not, so a card claimed in an earlier
  // run is claimed in this one too; only the candidates are cut at `from`.
  const ordered = records
    .map((record) => ({ key: recordKey(record.resource, record.sourceId), record }))
    .sort((a, b) => compareKeys(a.key, b.key))
  for (const resource of RESOURCES) {
    const byId = new Map(cards[resource].map((c) => [c.card.id, c]))
    const index = candidateIndex(cards[resource].map((c) => c.card))
    // A name match never takes a card another source record maps to.
    const claimed = new Set<string>()
    for (const [key, targets] of sourceMap) if (key.startsWith(`${resource}:`)) for (const t of targets) claimed.add(t)

    for (const { key, record } of ordered) {
      if (record.resource !== resource) continue
      const targets = sourceMap.get(key)
      let id: string | null
      if (targets) {
        id = targets.length === 1 ? targets[0] : null
      } else if (!record.active) {
        count(resource, 'inactive')
        continue
      } else {
        id = matchExistingCustomer(record.facts, index(record.facts), claimed)
        if (id) claimed.add(id)
      }
      const card = id ? byId.get(id) : undefined
      if (!card) { count(resource, 'no_card'); continue }
      if (card.terms !== IMPORT_DEFAULT_TERMS) { count(resource, 'has_terms'); continue }
      if (from !== null && key < from) continue
      candidates.push({ key, resource, cardId: card.card.id, record })
    }
  }
  candidates.sort((a, b) => compareKeys(a.key, b.key))
  return { candidates, counts }
}

interface Connection {
  accessToken: string
  providerCompanyId?: string
}

class ConsentRefused extends Error {}

/**
 * Reads each candidate's detail form in batches until the deadline and
 * decides its fill. Returns the key of the first batch it did not finish,
 * or null when it read them all.
 */
export async function readCandidateTerms(
  candidates: TermsCandidate[],
  connection: Connection,
  deadline: number,
  counts: Counts,
  deps: Required<Pick<TermsBackfillDeps, 'hydrateCustomers' | 'hydrateSuppliers'>>,
): Promise<{ fills: TermsFill[]; next: string | null }> {
  const count = counter(counts)
  const proposed = new Map<string, TermsFill>()
  const conflicts = new Set<string>()
  let next: string | null = null

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const budgetMs = deadline - Date.now()
    if (budgetMs <= 0) { next = batch[0].key; break }
    // A batch is one resource at a time; candidates are sorted customers first.
    const byResource = new Map<TermsResource, TermsCandidate[]>()
    for (const c of batch) byResource.set(c.resource, [...(byResource.get(c.resource) ?? []), c])

    const read = new Map<string, CustomerDto | SupplierDto>()
    let cutOff = false
    for (const [resource, group] of byResource) {
      const dtos = [...new Map(group.map((c) => [c.record.sourceId, c.record.dto])).values()]
      const result = resource === 'customers'
        ? await deps.hydrateCustomers('fortnox', connection.accessToken, connection.providerCompanyId,
          dtos as CustomerDto[], deadline - Date.now())
        : await deps.hydrateSuppliers('fortnox', connection.accessToken, connection.providerCompanyId,
          dtos as SupplierDto[], deadline - Date.now())
      if (result.hydration.abortedBy === 'auth') throw new ConsentRefused(messageOf(result.authError))
      if (result.hydration.abortedBy === 'budget') { cutOff = true; break }
      const items = 'customers' in result ? result.customers : result.suppliers
      for (const dto of items) if (!result.unhydratedIds.has(dto.id)) read.set(recordKey(resource, dto.id), dto)
    }
    if (cutOff) { next = batch[0].key; break }

    for (const c of batch) {
      const dto = read.get(c.key)
      if (!dto) { count(c.resource, 'unread'); continue }
      const terms = statedTerms(dto.defaultPaymentTermsDays)
      if (terms === null) { count(c.resource, 'no_terms'); continue }
      if (terms === IMPORT_DEFAULT_TERMS) { count(c.resource, 'same'); continue }
      const cardKey = recordKey(c.resource, c.cardId)
      const earlier = proposed.get(cardKey)
      if (earlier && earlier.terms !== terms) conflicts.add(cardKey)
      else proposed.set(cardKey, { resource: c.resource, id: c.cardId, terms })
    }
  }

  const fills: TermsFill[] = []
  for (const [cardKey, fill] of proposed) {
    if (conflicts.has(cardKey)) { count(fill.resource, 'conflict'); continue }
    count(fill.resource, 'fill')
    fills.push(fill)
  }
  return { fills, next }
}

async function listFortnoxRecords(
  connection: Connection,
  fetchPage: typeof fetchMigrationPage,
): Promise<TermsSourceRecord[]> {
  const records: TermsSourceRecord[] = []
  for (const resource of RESOURCES) {
    let page: number | null = 1
    let pages = 0
    while (page !== null) {
      if (pages++ >= MAX_FORTNOX_PAGES) throw new Error('FORTNOX_PAGE_LIMIT')
      const result = await fetchPage('fortnox', connection.accessToken, connection.providerCompanyId, resource, page)
      for (const dto of result.items) {
        const record = termsSourceRecord(resource, dto as CustomerDto | SupplierDto)
        if (record) records.push(record)
      }
      page = result.nextPage
    }
  }
  return records
}

async function loadCards(supabase: SupabaseClient, companyId: string): Promise<Record<TermsResource, TermsCard[]>> {
  const customers = await fetchAllRows<{
    id: string; name: string | null; org_number: string | null; personal_number: string | null
    vat_number: string | null; customer_number: string | null; default_payment_terms: number | null
  }>(({ from, to }) => supabase.from('customers')
    .select('id, name, org_number, personal_number, vat_number, customer_number, default_payment_terms')
    .eq('company_id', companyId).is('archived_at', null).order('id').range(from, to))
  const suppliers = await fetchAllRows<{
    id: string; name: string | null; org_number: string | null; vat_number: string | null
    default_payment_terms: number | null
  }>(({ from, to }) => supabase.from('suppliers')
    .select('id, name, org_number, vat_number, default_payment_terms')
    .eq('company_id', companyId).is('archived_at', null).order('id').range(from, to))
  const customerCards = buildCustomerCards(customers)
  return {
    customers: customers.map((row, i) => ({ terms: row.default_payment_terms, card: customerCards[i] })),
    suppliers: suppliers.map((row) => {
      const identity = identityKey(row.org_number)
      return {
        terms: row.default_payment_terms,
        card: {
          id: row.id,
          identities: identity ? [identity] : [],
          vat: row.vat_number ? normalizeVatNumber(row.vat_number) || undefined : undefined,
          name: customerNameKey(row.name),
        },
      }
    }),
  }
}

/** Card ids by record key. A derived invoice-party id has no Fortnox record behind it. */
async function loadSourceMap(supabase: SupabaseClient, companyId: string): Promise<Map<string, string[]>> {
  const rows = await fetchAllRows<{ resource: TermsResource; source_id: string; target_id: string }>(({ from, to }) =>
    supabase.from('migration_source_records').select('resource, source_id, target_id')
      .eq('company_id', companyId).eq('provider', 'fortnox').in('resource', RESOURCES)
      .order('id').range(from, to))
  const map = new Map<string, string[]>()
  for (const row of rows) {
    if (row.source_id.startsWith('invoice-party:')) continue
    const key = recordKey(row.resource, row.source_id)
    const targets = map.get(key) ?? []
    if (!targets.includes(row.target_id)) targets.push(row.target_id)
    map.set(key, targets)
  }
  return map
}

const emptyPlan = (fortnox: FortnoxFetchState, fortnoxError?: string): TermsBackfillPlan => ({
  fortnox, ...(fortnoxError ? { fortnoxError } : {}), listed: 0, candidates: 0,
  counts: { customers: {}, suppliers: {} }, fills: [], next: null,
})

/** What one run for a company would write, without writing it. */
export async function planFortnoxTermsBackfill(
  supabase: SupabaseClient,
  companyId: string,
  options: { from: string | null; deadline: number },
  deps: TermsBackfillDeps = {},
): Promise<TermsBackfillPlan> {
  const { data, error } = await supabase.from('provider_consents').select('id')
    .eq('company_id', companyId).eq('provider', 'fortnox').in('status', [0, 1])
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`provider_consents: ${error.message}`)
  const consents = (data ?? []) as { id: string }[]
  if (consents.length === 0) return emptyPlan('no_consent')

  let lastError: string | undefined
  for (const consent of consents) {
    try {
      // May refresh the access token and store the rotated pair, exactly as a sync does.
      const connection = await (deps.resolveConsent ?? resolveConsent)(companyId, consent.id)
      const records = await listFortnoxRecords(connection, deps.fetchMigrationPage ?? fetchMigrationPage)
      const [cards, sourceMap] = [await loadCards(supabase, companyId), await loadSourceMap(supabase, companyId)]
      const { candidates, counts } = matchTermsCandidates(records, cards, sourceMap, options.from)
      const { fills, next } = await readCandidateTerms(candidates, connection, options.deadline, counts, {
        hydrateCustomers: deps.hydrateCustomers ?? hydrateCustomers,
        hydrateSuppliers: deps.hydrateSuppliers ?? hydrateSuppliers,
      })
      return { fortnox: 'fetched', listed: records.length, candidates: candidates.length, counts, fills, next }
    } catch (err) {
      lastError = messageOf(err)
      if (!(err instanceof ConsentRefused) && !consentUnusable(err)) return emptyPlan('failed', lastError)
    }
  }
  return emptyPlan('consent_expired', lastError)
}

export interface TermsFillResult {
  /** Cards that got their terms. */
  filled: number
  /** Cards whose terms someone changed, or that went away, since the read: left alone. */
  changed: number
  /** The cards that got their terms, for the log: each was on 30 before. */
  filledIds: string[]
}

/** Writes the fills, each only while the card is still on 30. */
export async function applyTermsFills(
  supabase: SupabaseClient,
  companyId: string,
  fills: TermsFill[],
  options: { concurrency?: number } = {},
): Promise<TermsFillResult> {
  let next = 0
  let changed = 0
  const filledIds: string[] = []
  // One failed write stops the other workers too.
  let failed = false
  const worker = async () => {
    while (!failed && next < fills.length) {
      const fill = fills[next++]
      const { data, error } = await supabase.from(fill.resource).update({ default_payment_terms: fill.terms })
        .eq('id', fill.id).eq('company_id', companyId).eq('default_payment_terms', IMPORT_DEFAULT_TERMS).select('id')
      if (error) {
        failed = true
        throw new Error(`${fill.resource}: ${error.message}`)
      }
      if ((data ?? []).length > 0) filledIds.push(fill.id)
      else changed++
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 10 }, worker))
  return { filled: filledIds.length, changed, filledIds }
}

/** A company's row in fortnox_terms_backfill_progress. */
export interface TermsBackfillProgress {
  company_id: string
  next_key: string | null
  outcome: string | null
  attempts: number
  filled_customer_ids: string[]
  filled_supplier_ids: string[]
}

/** Runs in a row that fail, or read nothing new, before a company is given up on. */
const MAX_ATTEMPTS = 3
/** Companies read side by side; Fortnox limits each connection on its own. */
const PARALLEL_COMPANIES = 4
/** A company is not started with less time than this left in the run. */
const MIN_COMPANY_MS = 30_000

export interface TermsBackfillRunSummary {
  /** Companies with a live Fortnox connection and no outcome yet, before this run. */
  pending: number
  /** Companies this run worked on. */
  worked: number
  /** Of those, the ones that reached an outcome. */
  finished: number
  /** Cards that got their terms in this run. */
  filled: number
}

/**
 * One cron run: works through the companies with a live Fortnox connection
 * that have no outcome yet, most recently used connection first, each from
 * its stored cursor, until the deadline. Idempotent: a card is written only
 * while it is still on 30, so a run cut short repeats nothing harmful.
 */
export async function runFortnoxTermsBackfill(
  supabase: SupabaseClient,
  deadline: number,
  deps: TermsBackfillDeps = {},
): Promise<TermsBackfillRunSummary> {
  const consents = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
    supabase.from('provider_consents').select('company_id').eq('provider', 'fortnox').in('status', [0, 1])
      .order('updated_at', { ascending: false }).order('company_id').range(from, to))
  const progress = await fetchAllRows<TermsBackfillProgress>(({ from, to }) =>
    supabase.from('fortnox_terms_backfill_progress')
      .select('company_id, next_key, outcome, attempts, filled_customer_ids, filled_supplier_ids')
      .order('company_id').range(from, to))
  const rows = new Map(progress.map((row) => [row.company_id, row]))
  const queue = [...new Set(consents.map((c) => c.company_id))].filter((id) => !rows.get(id)?.outcome)
  const summary: TermsBackfillRunSummary = { pending: queue.length, worked: 0, finished: 0, filled: 0 }

  let next = 0
  const worker = async () => {
    while (next < queue.length && deadline - Date.now() >= MIN_COMPANY_MS) {
      const companyId = queue[next++]
      summary.worked++
      const row = await backfillCompany(supabase, companyId, rows.get(companyId), deadline, deps)
      summary.filled += row.filled
      if (row.outcome) summary.finished++
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_COMPANIES }, worker))
  return summary
}

async function backfillCompany(
  supabase: SupabaseClient,
  companyId: string,
  previous: TermsBackfillProgress | undefined,
  deadline: number,
  deps: TermsBackfillDeps,
): Promise<{ outcome: string | null; filled: number }> {
  const row: TermsBackfillProgress = previous ?? {
    company_id: companyId, next_key: null, outcome: null, attempts: 0, filled_customer_ids: [], filled_supplier_ids: [],
  }
  let lastError: string | null = null
  let filled = 0
  try {
    const { data: company, error } = await supabase.from('companies').select('archived_at')
      .eq('id', companyId).maybeSingle()
    if (error) throw new Error(`companies: ${error.message}`)
    if (!company || (company as { archived_at: string | null }).archived_at !== null) {
      row.outcome = 'archived'
    } else if (await isMigrationResetSource(supabase, companyId)) {
      // Its cards are immutable (block_migration_reset_source_mutation).
      row.outcome = 'migration_reset'
    } else {
      const plan = await planFortnoxTermsBackfill(supabase, companyId, { from: row.next_key, deadline }, deps)
      const written = await applyTermsFills(supabase, companyId, plan.fills)
      const ids = new Set(written.filledIds)
      for (const fill of plan.fills) {
        if (!ids.has(fill.id)) continue
        if (fill.resource === 'customers') row.filled_customer_ids = [...row.filled_customer_ids, fill.id]
        else row.filled_supplier_ids = [...row.filled_supplier_ids, fill.id]
      }
      filled = written.filled
      if (plan.fortnox === 'no_consent' || plan.fortnox === 'consent_expired') {
        row.outcome = plan.fortnox
      } else if (plan.fortnox === 'failed') {
        lastError = plan.fortnoxError ?? null
        row.attempts++
        if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'failed'
      } else if (plan.next === null) {
        row.outcome = 'done'
      } else if (plan.next === row.next_key) {
        // The run read nothing past where it started: count it as a miss.
        row.attempts++
        if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'stuck'
      } else {
        row.next_key = plan.next
        row.attempts = 0
      }
      lastError = lastError ?? plan.fortnoxError ?? null
    }
  } catch (err) {
    lastError = messageOf(err)
    row.attempts++
    if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'failed'
  }
  const { error } = await supabase.from('fortnox_terms_backfill_progress').upsert({
    company_id: row.company_id,
    next_key: row.next_key,
    outcome: row.outcome,
    attempts: row.attempts,
    filled_customer_ids: row.filled_customer_ids,
    filled_supplier_ids: row.filled_supplier_ids,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id' })
  if (error) throw new Error(`fortnox_terms_backfill_progress: ${error.message}`)
  return { outcome: row.outcome, filled }
}
