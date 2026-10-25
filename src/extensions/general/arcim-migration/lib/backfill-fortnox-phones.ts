import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupplierDto } from '@/lib/providers/dto'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { fetchMigrationPage } from '@/lib/providers/provider-data-fetcher'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { classifyProviderError } from '@/lib/providers/with-provider-call'
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

/**
 * crm#1436: fills in the phone number of customers and suppliers imported from
 * Fortnox before the mapper read the list form's `Phone` (it read only the
 * single record's `Phone1`). One-off, driven by fortnox-phone-backfill-routes.
 *
 * The numbers come from two places; Fortnox today wins over a stored record:
 *   1. the background import's stored payloads (migration_job_chunks), each
 *      sealed with its raw Fortnox fields. Needs no Fortnox call.
 *   2. Fortnox itself, through the company's connection. The older import
 *      path stored nothing, so this is the only source for its companies.
 *
 * Each record finds its card through the import's source map; a record the
 * map does not know (the older path wrote none) through the identity match
 * the durable import uses (customer-match). Only a card whose phone is NULL
 * is filled: an empty string is a number the user cleared.
 */

export type PhoneResource = 'customers' | 'suppliers'
const RESOURCES: PhoneResource[] = ['customers', 'suppliers']
const MAX_FORTNOX_PAGES = 1000

/** One Fortnox customer or supplier, reduced to what the backfill compares. */
export interface PhoneSourceRecord {
  resource: PhoneResource
  sourceId: string
  active: boolean
  phone: string | null
  facts: PartyFacts
}

/** An existing card: its phone and the keys a match compares. */
export interface PhoneCard {
  phone: string | null
  card: CustomerCard
}

/**
 * Record level: has_phone (the card already has one, or an empty string),
 * no_phone (Fortnox has none), no_card, inactive. Card level: fill, conflict
 * (two records name the card with different numbers; left alone).
 */
export type PhoneOutcome = 'fill' | 'has_phone' | 'no_phone' | 'no_card' | 'inactive' | 'conflict'

export interface PhoneFill {
  resource: PhoneResource
  id: string
  phone: string
}

export type FortnoxFetchState = 'skipped' | 'fetched' | 'no_consent' | 'consent_expired' | 'failed'

export interface PhoneBackfillPlan {
  stored: number
  fetched: number
  unreadable: number
  fortnox: FortnoxFetchState
  fortnoxError?: string
  counts: Record<PhoneResource, Partial<Record<PhoneOutcome, number>>>
  fills: PhoneFill[]
}

export interface PhoneBackfillDeps {
  openPayload?: <T>(payload: string) => T
  resolveConsent?: typeof resolveConsent
  fetchMigrationPage?: typeof fetchMigrationPage
}

const recordKey = (resource: PhoneResource, sourceId: string) => `${resource}:${sourceId}`

function supplierFacts(dto: SupplierDto): PartyFacts {
  return {
    identity: identityKey(
      dto.party.identifications?.find((i) => i.schemeId === 'SE:ORGNR')?.id || dto.party.legalEntity?.companyId,
    ),
    vat: dto.vatNumber ? normalizeVatNumber(dto.vatNumber) || undefined : undefined,
    name: customerNameKey(dto.party.name),
  }
}

/**
 * The record behind raw Fortnox fields, mapped with today's mapper: a stored
 * payload carries the DTO of its import day, whose phone is missing.
 */
export function phoneSourceRecord(resource: PhoneResource, raw: Record<string, unknown>): PhoneSourceRecord | null {
  if (resource === 'customers') {
    const dto = mapFortnoxToCustomer(raw)
    if (!dto.id) return null
    return {
      resource, sourceId: dto.id, active: dto.active,
      phone: dto.party.contact?.telephone ?? null, facts: customerRegisterFacts('fortnox', dto),
    }
  }
  const dto = mapFortnoxToSupplier(raw)
  if (!dto.id) return null
  return {
    resource, sourceId: dto.id, active: dto.active,
    phone: dto.party.contact?.telephone ?? null, facts: supplierFacts(dto),
  }
}

function consentUnusable(error: unknown): boolean {
  if (error && typeof error === 'object' && !(error instanceof Error) && 'status' in error) {
    return [401, 403, 404].includes(Number((error as { status: unknown }).status))
  }
  const code = classifyProviderError(error)
  return code === 'PROVIDER_AUTH_EXPIRED' || code === 'PROVIDER_LICENSE_MISSING'
    || code === 'PROVIDER_RESOURCE_FORBIDDEN' || code === 'PROVIDER_API_MODULE_INACTIVE'
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

/** Stored records, oldest import first so the newest one of a source id wins. */
async function storedRecords(
  supabase: SupabaseClient,
  companyId: string,
  open: <T>(payload: string) => T,
): Promise<{ records: PhoneSourceRecord[]; unreadable: number }> {
  const { data: jobs, error } = await supabase
    .from('migration_jobs').select('id').eq('company_id', companyId).eq('provider', 'fortnox')
  if (error) throw new Error(`migration_jobs: ${error.message}`)
  const jobIds = ((jobs ?? []) as { id: string }[]).map((j) => j.id)
  if (jobIds.length === 0) return { records: [], unreadable: 0 }
  const chunks = await fetchAllRows<{ resource: PhoneResource; payload: string }>(({ from, to }) =>
    supabase.from('migration_job_chunks').select('resource, payload')
      .eq('company_id', companyId).in('resource', RESOURCES).in('job_id', jobIds)
      .order('created_at').order('id').range(from, to))
  const records: PhoneSourceRecord[] = []
  let unreadable = 0
  for (const chunk of chunks) {
    let dto: { _raw?: Record<string, unknown>; migrationError?: string }
    try {
      dto = open<{ _raw?: Record<string, unknown>; migrationError?: string }>(chunk.payload)
    } catch {
      unreadable++
      continue
    }
    if (dto.migrationError) continue
    const record = dto._raw ? phoneSourceRecord(chunk.resource, dto._raw) : null
    if (record) records.push(record)
    else unreadable++
  }
  return { records, unreadable }
}

async function fortnoxRecords(
  supabase: SupabaseClient,
  companyId: string,
  deps: Required<Pick<PhoneBackfillDeps, 'resolveConsent' | 'fetchMigrationPage'>>,
): Promise<{ state: FortnoxFetchState; records: PhoneSourceRecord[]; error?: string }> {
  const { data, error } = await supabase.from('provider_consents').select('id')
    .eq('company_id', companyId).eq('provider', 'fortnox').in('status', [0, 1])
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`provider_consents: ${error.message}`)
  const consents = (data ?? []) as { id: string }[]
  if (consents.length === 0) return { state: 'no_consent', records: [] }
  let lastError: string | undefined
  for (const consent of consents) {
    try {
      // May refresh the access token and store the rotated pair, exactly as
      // a sync does.
      const connection = await deps.resolveConsent(companyId, consent.id)
      const records: PhoneSourceRecord[] = []
      for (const resource of RESOURCES) {
        let page: number | null = 1
        let pages = 0
        while (page !== null) {
          if (pages++ >= MAX_FORTNOX_PAGES) throw new Error('FORTNOX_PAGE_LIMIT')
          const result = await deps.fetchMigrationPage('fortnox', connection.accessToken,
            connection.providerCompanyId, resource, page)
          for (const dto of result.items) {
            const record = dto._raw ? phoneSourceRecord(resource, dto._raw) : null
            if (record) records.push(record)
          }
          page = result.nextPage
        }
      }
      return { state: 'fetched', records }
    } catch (err) {
      lastError = messageOf(err)
      if (!consentUnusable(err)) return { state: 'failed', records: [], error: lastError }
    }
  }
  return { state: 'consent_expired', records: [], error: lastError }
}

async function loadCards(supabase: SupabaseClient, companyId: string): Promise<Record<PhoneResource, PhoneCard[]>> {
  const customers = await fetchAllRows<{
    id: string; name: string | null; org_number: string | null; personal_number: string | null
    vat_number: string | null; customer_number: string | null; phone: string | null
  }>(({ from, to }) => supabase.from('customers')
    .select('id, name, org_number, personal_number, vat_number, customer_number, phone')
    .eq('company_id', companyId).is('archived_at', null).order('id').range(from, to))
  const suppliers = await fetchAllRows<{
    id: string; name: string | null; org_number: string | null; vat_number: string | null; phone: string | null
  }>(({ from, to }) => supabase.from('suppliers')
    .select('id, name, org_number, vat_number, phone')
    .eq('company_id', companyId).is('archived_at', null).order('id').range(from, to))
  const customerCards = buildCustomerCards(customers)
  return {
    customers: customers.map((row, i) => ({ phone: row.phone, card: customerCards[i] })),
    suppliers: suppliers.map((row) => {
      const identity = identityKey(row.org_number)
      return {
        phone: row.phone,
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
  const rows = await fetchAllRows<{ resource: PhoneResource; source_id: string; target_id: string }>(({ from, to }) =>
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

/** Which card each record fills, decided on the whole set. */
export function planPhoneFills(
  records: PhoneSourceRecord[],
  cards: Record<PhoneResource, PhoneCard[]>,
  sourceMap: Map<string, string[]>,
): Pick<PhoneBackfillPlan, 'counts' | 'fills'> {
  const counts: PhoneBackfillPlan['counts'] = { customers: {}, suppliers: {} }
  const fills: PhoneFill[] = []
  for (const resource of RESOURCES) {
    const tally = counts[resource]
    const count = (outcome: PhoneOutcome) => { tally[outcome] = (tally[outcome] ?? 0) + 1 }
    const byId = new Map(cards[resource].map((c) => [c.card.id, c]))
    const candidates = candidateIndex(cards[resource].map((c) => c.card))
    // A name match never takes a card another source record maps to.
    const claimed = new Set<string>()
    for (const [key, targets] of sourceMap) if (key.startsWith(`${resource}:`)) for (const t of targets) claimed.add(t)
    const proposed = new Map<string, string>()
    const conflicts = new Set<string>()

    for (const record of records) {
      if (record.resource !== resource) continue
      if (!record.phone) { count('no_phone'); continue }
      const targets = sourceMap.get(recordKey(resource, record.sourceId))
      let id: string | null
      if (targets) {
        id = targets.length === 1 ? targets[0] : null
      } else if (!record.active) {
        count('inactive')
        continue
      } else {
        id = matchExistingCustomer(record.facts, candidates(record.facts), claimed)
        if (id) claimed.add(id)
      }
      const card = id ? byId.get(id) : undefined
      if (!card) { count('no_card'); continue }
      if (card.phone !== null) { count('has_phone'); continue }
      const earlier = proposed.get(card.card.id)
      if (earlier !== undefined && earlier !== record.phone) conflicts.add(card.card.id)
      else proposed.set(card.card.id, record.phone)
    }

    for (const [id, phone] of proposed) {
      if (conflicts.has(id)) { count('conflict'); continue }
      count('fill')
      fills.push({ resource, id, phone })
    }
  }
  return { counts, fills }
}

/** Everything a company's backfill would write, without writing it. */
export async function planFortnoxPhoneBackfill(
  supabase: SupabaseClient,
  companyId: string,
  options: { fetchFromFortnox: boolean },
  deps: PhoneBackfillDeps = {},
): Promise<PhoneBackfillPlan> {
  const stored = await storedRecords(supabase, companyId, deps.openPayload ?? openMigrationPayload)
  const byKey = new Map<string, PhoneSourceRecord>()
  for (const record of stored.records) byKey.set(recordKey(record.resource, record.sourceId), record)

  let fortnox: FortnoxFetchState = 'skipped'
  let fortnoxError: string | undefined
  let fetched = 0
  if (options.fetchFromFortnox) {
    const result = await fortnoxRecords(supabase, companyId, {
      resolveConsent: deps.resolveConsent ?? resolveConsent,
      fetchMigrationPage: deps.fetchMigrationPage ?? fetchMigrationPage,
    })
    fortnox = result.state
    fortnoxError = result.error
    fetched = result.records.length
    for (const record of result.records) byKey.set(recordKey(record.resource, record.sourceId), record)
  }

  const [cards, sourceMap] = [await loadCards(supabase, companyId), await loadSourceMap(supabase, companyId)]
  return {
    stored: stored.records.length,
    fetched,
    unreadable: stored.unreadable,
    fortnox,
    ...(fortnoxError ? { fortnoxError } : {}),
    ...planPhoneFills([...byKey.values()], cards, sourceMap),
  }
}

export interface PhoneFillResult {
  /** Cards that got their phone. */
  filled: number
  /** Cards that got a phone, or went away, since the plan: left alone. */
  changed: number
  /** Fills not reached before the deadline; a fresh run picks them up. */
  remaining: number
}

/** Writes the fills, each only while the card's phone is still NULL. */
export async function applyPhoneFills(
  supabase: SupabaseClient,
  companyId: string,
  fills: PhoneFill[],
  options: { deadline: number; concurrency?: number },
): Promise<PhoneFillResult> {
  let next = 0
  let filled = 0
  let changed = 0
  // One failed write stops the other workers too.
  let failed = false
  const worker = async () => {
    while (!failed && next < fills.length && Date.now() < options.deadline) {
      const fill = fills[next++]
      const { data, error } = await supabase.from(fill.resource).update({ phone: fill.phone })
        .eq('id', fill.id).eq('company_id', companyId).is('phone', null).select('id')
      if (error) {
        failed = true
        throw new Error(`${fill.resource}: ${error.message}`)
      }
      if ((data ?? []).length > 0) filled++
      else changed++
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 10 }, worker))
  return { filled, changed, remaining: fills.length - filled - changed }
}
