import { partyOrgKey } from '@/lib/invariants/org-number'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget'
import type { CustomerDto, SupplierDto } from '@/lib/providers/dto'
import { fetchMigrationPage, hydrateCustomers, hydrateSuppliers } from '@/lib/providers/provider-data-fetcher'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeVatNumber } from '@/lib/vat/vat-number'
import { looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'
import {
  buildCustomerCards,
  customerNameKey,
  customerRegisterFacts,
  matchExistingCustomer,
  type CustomerCard,
  type PartyFacts,
} from './customer-match'
import {
  buildCustomerMetadataEnrichment,
  buildSupplierEnrichment,
  writeCustomerEnrichment,
  writeSupplierEnrichment,
  type CustomerMetadataEnrichment,
  type ExistingCustomerMetadata,
  type ExistingSupplierDetails,
  type SupplierEnrichment,
} from './customer-metadata'
import { customerIdentityColumns, mapCustomer, mapSupplier } from './entity-mapper'
import { consentUnusable, isMigrationResetSource, messageOf } from './repair-fortnox-supplier-numbers'

/**
 * crm#1436, one-off: brings the customer and supplier cards older imports
 * wrote up to what the import writes today. Driven by the register-repair
 * cron (runRegisterRepair).
 *
 * The onboarding import saved every Fortnox customer and supplier its
 * 90-second detail pass did not reach from Fortnox's short list, which has no
 * type, active flag, VAT number, country or terms; before 22 October it read
 * no detail at all. Visma and Bokio records were read under names those
 * providers do not use. So a privatperson became a company with its
 * personnummer in plain text as org number, inactive records came along, and
 * contact, address, VAT and bank fields stayed empty. The import is fixed;
 * this repairs what it already wrote.
 *
 * Every card is read again from its provider (Fortnox's detail form, one
 * request each) and gets what the import writes today, never over a value
 * someone set:
 *
 *   filled    an empty column the record has (the re-sync gap fill rules)
 *   private   a company the provider calls a private person, with no
 *             personal_number and no org number or a personnummer as one:
 *             typed individual, the personnummer encrypted into
 *             personal_number, org_number cleared
 *   foreign   a swedish_business with no country that the record makes an
 *             EU or non-EU business
 *   terms     the 30-day import default where the record states other terms
 *   currency  a supplier on SEK whose record bills in another currency
 *   archived  a card the import made from a record the provider marks
 *             inactive, with no invoices
 *
 * Only a company whose connection still answers can be read; a consent that
 * is gone leaves its cards as they are. A card is found through the import's
 * source map, else by identity the way the durable import matches (an
 * inactive record only through the source map). Every write is guarded on
 * the values it was decided on, so a card someone changed since the read is
 * left alone, and each changed card is kept in register_repair_progress with
 * what it held before.
 */

const log = createLogger('register-repair')

export type RepairProvider = 'fortnox' | 'visma' | 'bokio'
export const REPAIR_PROVIDERS: readonly RepairProvider[] = ['fortnox', 'visma', 'bokio']
type Resource = 'customers' | 'suppliers'
const RESOURCES: Resource[] = ['customers', 'suppliers']
export type RepairKind = 'filled' | 'private' | 'foreign' | 'terms' | 'currency' | 'archived'

const IMPORT_DEFAULT_TERMS = 30
const FOREIGN_TYPES = new Set(['eu_business', 'non_eu_business'])
/** What the import gives a supplier whose record names no currency: all the older import ever wrote. */
const IMPORT_DEFAULT_CURRENCY = mapSupplier({ id: '', supplierNumber: '', active: true, party: { name: '', identifications: [] } }, '', '')
  .default_currency
const MAX_PAGES = 1000
/** Detail reads per hydration call; a batch cut off by the deadline is read again by the next run. */
const BATCH_SIZE = 50

export interface CustomerRow extends ExistingCustomerMetadata {
  id: string
  name: string | null
  customer_number: string | null
  customer_type: string | null
  org_number: string | null
  personal_number: string | null
  vat_number: string | null
  default_payment_terms: number | null
}

export interface SupplierRow extends ExistingSupplierDetails {
  id: string
  name: string | null
  supplier_type: string | null
  org_number: string | null
  default_payment_terms: number | null
  default_currency: string | null
}


/** What one card gets. */
export interface CardRepair {
  resource: Resource
  id: string
  /** Empty columns to fill, written under the gap fill's own guards. */
  fill: CustomerMetadataEnrichment | SupplierEnrichment | null
  /** Columns that still hold the old import's value, and their new value. */
  correct: Record<string, unknown>
  /** The values `correct` is written only while they are still there. */
  guard: Record<string, unknown>
  /** What `correct` replaces, for the revert. A personnummer is never kept here. */
  was: Record<string, unknown>
  kinds: RepairKind[]
  /**
   * The key of the record the card was decided from (planRegisterRepair sets
   * it): where the next run starts when this one stops writing before it.
   */
  key?: string
}

function providerNumber(dto: CustomerDto): string | null {
  return dto.party.identifications?.find((i) => i.schemeId === 'SE:ORGNR')?.id || dto.party.legalEntity?.companyId || null
}

function repairOf(resource: Resource, id: string, fill: CardRepair['fill'], parts: Omit<CardRepair, 'resource' | 'id' | 'fill' | 'kinds'>,
  kinds: Set<RepairKind>): CardRepair | null {
  if (fill) kinds.add('filled')
  return kinds.size > 0 ? { resource, id, fill, ...parts, kinds: [...kinds] } : null
}

/** A customer card against the provider's record. `sourceMapped`: the import made the card from this record. */
export function customerRepair(row: CustomerRow, dto: CustomerDto, sourceMapped: boolean, now: string): CardRepair | null {
  // No provider, so no customer number: this repair fills none (crm#1744 left
  // the numbers of earlier imports to a decision of their own).
  const mapped = mapCustomer(dto, '', '')
  const fill = buildCustomerMetadataEnrichment(row, mapped)
  const correct: Record<string, unknown> = {}
  const guard: Record<string, unknown> = {}
  const was: Record<string, unknown> = {}
  const kinds = new Set<RepairKind>()

  if (dto.type === 'private' && row.customer_type !== 'individual' && !row.personal_number
    && (!row.org_number || looksLikeSwedishPersonalNumber(row.org_number))) {
    // A sole trader's org number is a personnummer too: the provider's own
    // type is what tells the two apart, never the number.
    const { personal_number } = customerIdentityColumns('individual', row.org_number ?? providerNumber(dto))
    Object.assign(correct, { customer_type: 'individual', org_number: null, personal_number })
    Object.assign(guard, { customer_type: row.customer_type, org_number: row.org_number, personal_number: null })
    // The org number is read back from personal_number on a revert.
    was.customer_type = row.customer_type
    if (fill) delete (fill as CustomerMetadataEnrichment).org_number
    kinds.add('private')
  } else if (row.customer_type === 'swedish_business' && FOREIGN_TYPES.has(String(mapped.customer_type)) && row.country === null) {
    Object.assign(correct, { customer_type: mapped.customer_type })
    Object.assign(guard, { customer_type: 'swedish_business' })
    was.customer_type = 'swedish_business'
    kinds.add('foreign')
  }
  if (row.default_payment_terms === IMPORT_DEFAULT_TERMS && mapped.default_payment_terms !== IMPORT_DEFAULT_TERMS) {
    correct.default_payment_terms = mapped.default_payment_terms
    guard.default_payment_terms = was.default_payment_terms = IMPORT_DEFAULT_TERMS
    kinds.add('terms')
  }
  if (!dto.active && sourceMapped) {
    correct.archived_at = now
    guard.archived_at = was.archived_at = null
    kinds.add('archived')
  }
  return repairOf('customers', row.id, fill, { correct, guard, was }, kinds)
}

/** The supplier twin of customerRepair. */
export function supplierRepair(row: SupplierRow, dto: SupplierDto, sourceMapped: boolean, now: string): CardRepair | null {
  // No chart read, so no default account: as customerRepair (crm#1744).
  const mapped = mapSupplier(dto, '', '')
  const fill = buildSupplierEnrichment(row, mapped)
  const correct: Record<string, unknown> = {}
  const guard: Record<string, unknown> = {}
  const was: Record<string, unknown> = {}
  const kinds = new Set<RepairKind>()

  if (row.supplier_type === 'swedish_business' && FOREIGN_TYPES.has(String(mapped.supplier_type)) && row.country === null) {
    correct.supplier_type = mapped.supplier_type
    guard.supplier_type = was.supplier_type = 'swedish_business'
    kinds.add('foreign')
  }
  if (row.default_currency === IMPORT_DEFAULT_CURRENCY && mapped.default_currency !== IMPORT_DEFAULT_CURRENCY) {
    correct.default_currency = mapped.default_currency
    guard.default_currency = was.default_currency = IMPORT_DEFAULT_CURRENCY
    kinds.add('currency')
  }
  if (row.default_payment_terms === IMPORT_DEFAULT_TERMS && mapped.default_payment_terms !== IMPORT_DEFAULT_TERMS) {
    correct.default_payment_terms = mapped.default_payment_terms
    guard.default_payment_terms = was.default_payment_terms = IMPORT_DEFAULT_TERMS
    kinds.add('terms')
  }
  if (!dto.active && sourceMapped) {
    correct.archived_at = now
    guard.archived_at = was.archived_at = null
    kinds.add('archived')
  }
  return repairOf('suppliers', row.id, fill, { correct, guard, was }, kinds)
}

// ── Finding the card behind each record ─────────────────────────────

export interface SourceRecord {
  resource: Resource
  sourceId: string
  active: boolean
  facts: PartyFacts
  dto: CustomerDto | SupplierDto
}

export interface RecordMatch {
  /** `<resource>:<source id>`; matches are read in this order. */
  key: string
  record: SourceRecord
  cardId: string
  sourceMapped: boolean
}

const recordKey = (resource: Resource, sourceId: string) => `${resource}:${sourceId}`
const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function supplierFacts(dto: SupplierDto): PartyFacts {
  return {
    identity: partyOrgKey(dto.party.identifications?.find((i) => i.schemeId === 'SE:ORGNR')?.id || dto.party.legalEntity?.companyId) ?? undefined,
    vat: dto.vatNumber ? normalizeVatNumber(dto.vatNumber) || undefined : undefined,
    name: customerNameKey(dto.party.name),
  }
}

export function sourceRecord(provider: RepairProvider, resource: Resource, dto: CustomerDto | SupplierDto): SourceRecord | null {
  if (!dto.id) return null
  const facts = resource === 'customers' ? customerRegisterFacts(provider, dto as CustomerDto) : supplierFacts(dto as SupplierDto)
  return { resource, sourceId: dto.id, active: dto.active, facts, dto }
}

/** The cards sharing a key with the facts, so a record is never compared with every card. */
function candidateIndex(cards: CustomerCard[]): (facts: PartyFacts) => CustomerCard[] {
  const index = new Map<string, CustomerCard[]>()
  const add = (key: string, card: CustomerCard) => index.set(key, [...(index.get(key) ?? []), card])
  for (const card of cards) {
    for (const identity of card.identities) add(`i:${identity}`, card)
    if (card.vat) add(`v:${card.vat}`, card)
    if (card.number) add(`n:${card.number}`, card)
    if (card.name) add(`m:${card.name}`, card)
  }
  return (facts) => {
    const found = new Set<CustomerCard>()
    for (const key of [facts.identity && `i:${facts.identity}`, facts.vat && `v:${facts.vat}`,
      facts.number && `n:${facts.number}`, facts.name && `m:${facts.name}`]) {
      if (key) for (const card of index.get(key) ?? []) found.add(card)
    }
    return [...found]
  }
}

/**
 * The card each record names, in key order, from `from` on. Every record is
 * matched, `from` or not, so a card claimed in an earlier run is claimed in
 * this one too. A name match never takes a card another record maps to, and
 * an inactive record the import never brought over is not looked for.
 */
export function matchRecords(
  records: SourceRecord[],
  cards: Record<Resource, CustomerCard[]>,
  sourceMap: Map<string, string[]>,
  from: string | null = null,
): RecordMatch[] {
  const matches: RecordMatch[] = []
  const ordered = records.map((record) => ({ key: recordKey(record.resource, record.sourceId), record }))
    .sort((a, b) => compareKeys(a.key, b.key))
  for (const resource of RESOURCES) {
    const known = new Set(cards[resource].map((card) => card.id))
    const index = candidateIndex(cards[resource])
    const claimed = new Set<string>()
    for (const [key, targets] of sourceMap) if (key.startsWith(`${resource}:`)) for (const t of targets) claimed.add(t)
    for (const { key, record } of ordered) {
      if (record.resource !== resource) continue
      const targets = sourceMap.get(key)
      let cardId: string | null
      if (targets) cardId = targets.length === 1 ? targets[0] : null
      else if (!record.active) continue
      else {
        cardId = matchExistingCustomer(record.facts, index(record.facts), claimed)
        if (cardId) claimed.add(cardId)
      }
      if (!cardId || !known.has(cardId)) continue
      if (from !== null && key < from) continue
      matches.push({ key, record, cardId, sourceMapped: !!targets })
    }
  }
  return matches.sort((a, b) => compareKeys(a.key, b.key))
}

// ── Reading and writing ─────────────────────────────────────────────

interface Connection {
  accessToken: string
  providerCompanyId?: string
}

export interface RegisterRepairDeps {
  resolveConsent?: typeof resolveConsent
  fetchMigrationPage?: typeof fetchMigrationPage
  hydrateCustomers?: typeof hydrateCustomers
  hydrateSuppliers?: typeof hydrateSuppliers
}

/** The provider refused the token partway through the detail reads; `cause` is its own error. */
class ConsentRefused extends Error {}

/** The run's deadline passed before any record's detail was read: while listing the registers, or right after. */
class OutOfTime extends Error {}

/**
 * A Fortnox 401: the token aged out or the grant is gone, and one refresh
 * tells which. Fortnox retires a token a moment before the expiry we stamp,
 * so a company read across the hour meets a 401 on a live connection (B11).
 */
function fortnoxTokenRefused(provider: RepairProvider, error: unknown): boolean {
  const cause = error instanceof ConsentRefused ? error.cause : error
  return provider === 'fortnox' && (cause as { statusCode?: unknown } | null)?.statusCode === 401
}

async function listRecords(provider: RepairProvider, connection: Connection, fetchPage: typeof fetchMigrationPage,
  deadline: number): Promise<SourceRecord[]> {
  const records: SourceRecord[] = []
  for (const resource of RESOURCES) {
    let pages = 0
    for (let page: number | null = 1; page !== null;) {
      // Checked before every page: a large register listed by a company that
      // started late in the run went on long past the cutoff, and the run was
      // ended at the platform's limit with every company's progress unsaved.
      if (Date.now() >= deadline) throw new OutOfTime()
      if (pages++ >= MAX_PAGES) throw new Error('PROVIDER_PAGE_LIMIT')
      // The page itself runs inside the deadline too, as the migration worker
      // reads it (fetchRegisterPage): the budget scope reaches the provider
      // client, its rate limiter and its retries, so a page in flight at the
      // deadline is aborted instead of running up to three 60 s attempts on.
      const current = page
      let result: Awaited<ReturnType<typeof fetchMigrationPage>>
      try {
        result = await withExecutionDeadline(deadline, 'register-repair-list',
          () => fetchPage(provider, connection.accessToken, connection.providerCompanyId, resource, current))
      } catch (error) {
        if (error instanceof ExecutionBudgetExceeded) throw new OutOfTime()
        throw error
      }
      for (const dto of result.items) {
        const record = sourceRecord(provider, resource, dto as CustomerDto | SupplierDto)
        if (record) records.push(record)
      }
      page = result.nextPage
    }
  }
  return records
}

interface Cards {
  rows: { customers: Map<string, CustomerRow>; suppliers: Map<string, SupplierRow> }
  cards: Record<Resource, CustomerCard[]>
}

async function loadCards(supabase: SupabaseClient, companyId: string): Promise<Cards> {
  const customers = await fetchAllRows<CustomerRow>(({ from, to }) => supabase.from('customers')
    .select('id, name, customer_number, customer_type, org_number, personal_number, vat_number, contact_person, invoice_email_cc_addresses, invoice_email_bcc_addresses, email, phone, address_line1, address_line2, postal_code, city, country, notes, default_payment_terms')
    .eq('company_id', companyId).is('archived_at', null).order('id').range(from, to))
  const suppliers = await fetchAllRows<SupplierRow>(({ from, to }) => supabase.from('suppliers')
    .select('id, name, supplier_type, org_number, vat_number, email, phone, address_line1, address_line2, postal_code, city, country, bankgiro, plusgiro, bank_account, clearing_number, account_number, iban, bic, notes, default_payment_terms, default_currency')
    .eq('company_id', companyId).is('archived_at', null).order('id').range(from, to))
  return {
    rows: { customers: new Map(customers.map((row) => [row.id, row])), suppliers: new Map(suppliers.map((row) => [row.id, row])) },
    cards: {
      customers: buildCustomerCards(customers),
      suppliers: suppliers.map((row) => {
        const identity = partyOrgKey(row.org_number)
        return {
          id: row.id,
          identities: identity ? [identity] : [],
          vat: row.vat_number ? normalizeVatNumber(row.vat_number) || undefined : undefined,
          name: customerNameKey(row.name),
        }
      }),
    },
  }
}

/** Card ids by record key. A derived invoice-party id has no provider record behind it. */
async function loadSourceMap(supabase: SupabaseClient, companyId: string, provider: RepairProvider): Promise<Map<string, string[]>> {
  const rows = await fetchAllRows<{ resource: Resource; source_id: string; target_id: string }>(({ from, to }) =>
    supabase.from('migration_source_records').select('resource, source_id, target_id')
      .eq('company_id', companyId).eq('provider', provider).in('resource', RESOURCES).order('id').range(from, to))
  const map = new Map<string, string[]>()
  for (const row of rows) {
    if (row.source_id.startsWith('invoice-party:')) continue
    const key = recordKey(row.resource, row.source_id)
    map.set(key, [...new Set([...(map.get(key) ?? []), row.target_id])])
  }
  return map
}

/**
 * Each match's record in the form today's import maps: Fortnox's detail form,
 * read in batches until the deadline; Visma and Bokio list the whole record.
 * `next` is the key of the first batch not read, or null when all were.
 */
async function readRecords(provider: RepairProvider, matches: RecordMatch[], connection: Connection, deadline: number,
  deps: Required<Pick<RegisterRepairDeps, 'hydrateCustomers' | 'hydrateSuppliers'>>,
): Promise<{ read: Map<string, CustomerDto | SupplierDto>; next: string | null }> {
  const read = new Map<string, CustomerDto | SupplierDto>()
  if (provider !== 'fortnox') {
    for (const match of matches) read.set(match.key, match.record.dto)
    return { read, next: null }
  }
  for (let i = 0; i < matches.length; i += BATCH_SIZE) {
    const batch = matches.slice(i, i + BATCH_SIZE)
    if (deadline - Date.now() <= 0) return { read, next: batch[0].key }
    for (const resource of RESOURCES) {
      const group = batch.filter((m) => m.record.resource === resource)
      if (group.length === 0) continue
      const dtos = [...new Map(group.map((m) => [m.record.sourceId, m.record.dto])).values()]
      const result = resource === 'customers'
        ? await deps.hydrateCustomers('fortnox', connection.accessToken, connection.providerCompanyId, dtos as CustomerDto[], deadline - Date.now())
        : await deps.hydrateSuppliers('fortnox', connection.accessToken, connection.providerCompanyId, dtos as SupplierDto[], deadline - Date.now())
      if (result.hydration.abortedBy === 'auth') throw new ConsentRefused(messageOf(result.authError), { cause: result.authError })
      if (result.hydration.abortedBy === 'budget') return { read, next: batch[0].key }
      const items = 'customers' in result ? result.customers : result.suppliers
      // A record whose detail could not be read is left out: its list form is what went wrong.
      for (const dto of items) if (!result.unhydratedIds.has(dto.id)) read.set(recordKey(resource, dto.id), dto)
    }
  }
  return { read, next: null }
}

/**
 * 'out_of_time': the deadline passed before any record's detail was read
 * (while listing, or right after it). Nothing was decided and the company
 * keeps its cursor.
 */
export type ProviderReadState = 'fetched' | 'no_consent' | 'consent_expired' | 'failed' | 'out_of_time'

export interface RegisterRepairPlan {
  state: ProviderReadState
  error?: string
  repairs: CardRepair[]
  next: string | null
}

const emptyPlan = (state: ProviderReadState, error?: string): RegisterRepairPlan =>
  ({ state, ...(error ? { error } : {}), repairs: [], next: null })

/** What one run would write for a company's cards from one provider, without writing it. */
export async function planRegisterRepair(
  supabase: SupabaseClient,
  companyId: string,
  provider: RepairProvider,
  options: { from: string | null; deadline: number; now?: string },
  deps: RegisterRepairDeps = {},
): Promise<RegisterRepairPlan> {
  const { data, error } = await supabase.from('provider_consents').select('id')
    .eq('company_id', companyId).eq('provider', provider).in('status', [0, 1]).order('updated_at', { ascending: false })
  if (error) throw new Error(`provider_consents: ${error.message}`)
  const consents = (data ?? []) as { id: string }[]
  if (consents.length === 0) return emptyPlan('no_consent')

  const plan = async (connection: Connection): Promise<RegisterRepairPlan> => {
    const records = await listRecords(provider, connection, deps.fetchMigrationPage ?? fetchMigrationPage, options.deadline)
    const { rows, cards } = await loadCards(supabase, companyId)
    const matches = matchRecords(records, cards, await loadSourceMap(supabase, companyId, provider), options.from)
    const { read, next } = await readRecords(provider, matches, connection, options.deadline, {
      hydrateCustomers: deps.hydrateCustomers ?? hydrateCustomers,
      hydrateSuppliers: deps.hydrateSuppliers ?? hydrateSuppliers,
    })
    if (read.size === 0 && next !== null && Date.now() >= options.deadline) throw new OutOfTime()
    const now = options.now ?? new Date().toISOString()
    const repairs: CardRepair[] = []
    // Two records naming one card: the first decides, as the import's own match does.
    const decided = new Set<string>()
    for (const match of matches) {
      const dto = read.get(match.key)
      const cardKey = recordKey(match.record.resource, match.cardId)
      if (!dto || decided.has(cardKey)) continue
      decided.add(cardKey)
      const repair = match.record.resource === 'customers'
        ? customerRepair(rows.customers.get(match.cardId)!, dto as CustomerDto, match.sourceMapped, now)
        : supplierRepair(rows.suppliers.get(match.cardId)!, dto as SupplierDto, match.sourceMapped, now)
      if (repair) repairs.push({ ...repair, key: match.key })
    }
    return { state: 'fetched', repairs, next }
  }

  const resolve = deps.resolveConsent ?? resolveConsent
  let lastError: string | undefined
  for (const consent of consents) {
    let connection: Connection | undefined
    try {
      // May refresh the access token and store the rotated pair, exactly as a sync does.
      connection = await resolve(companyId, consent.id)
      return await plan(connection)
    } catch (err) {
      let failure = err
      // A 401 a fresh token cannot outlive is a refused connection.
      if (connection && fortnoxTokenRefused(provider, err)) {
        try {
          return await plan(await resolve(companyId, consent.id, { rejectedAccessToken: connection.accessToken }))
        } catch (retryError) {
          failure = retryError
        }
      }
      if (failure instanceof OutOfTime) return { state: 'out_of_time', repairs: [], next: options.from }
      lastError = messageOf(failure)
      if (!(failure instanceof ConsentRefused) && !consentUnusable(failure)) return emptyPlan('failed', lastError)
    }
  }
  return emptyPlan('consent_expired', lastError)
}

export interface ChangedCard {
  resource: Resource
  id: string
  kinds: RepairKind[]
  filled?: string[]
  was?: Record<string, unknown>
}

/** The card ids among `ids` that have an invoice: those are never archived. */
async function withInvoices(supabase: SupabaseClient, companyId: string, resource: Resource, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200)
    const { data, error } = resource === 'customers'
      ? await supabase.from('invoices').select('party:customer_id').eq('company_id', companyId).in('customer_id', slice)
      : await supabase.from('supplier_invoices').select('party:supplier_id').eq('company_id', companyId).in('supplier_id', slice)
    if (error) throw new Error(`${resource} invoices: ${error.message}`)
    for (const row of (data ?? []) as { party: string }[]) found.add(row.party)
  }
  return found
}

export interface ApplyRegisterRepairsOptions {
  concurrency?: number
  /** Epoch ms after which no further card is started; the ones in flight finish. */
  deadline?: number
  /**
   * Called with each changed card as soon as its writes are done, so the
   * caller can keep the revert trail card by card: a run ended after its
   * writes used to lose the whole list of what it had changed.
   */
  onChanged?: (card: ChangedCard) => Promise<void>
}

export interface AppliedRegisterRepairs {
  changed: ChangedCard[]
  /**
   * The key of the first card not written because the deadline passed, or
   * null when every card was. Cards are written in key order, so everything
   * before it is done and the next run starts there.
   */
  stoppedAt: string | null
}

/** Writes the repairs, each part only while the card still holds what it was decided on. */
export async function applyRegisterRepairs(
  supabase: SupabaseClient,
  companyId: string,
  repairs: CardRepair[],
  options: ApplyRegisterRepairsOptions = {},
): Promise<AppliedRegisterRepairs> {
  for (const resource of RESOURCES) {
    const archiving = repairs.filter((r) => r.resource === resource && r.kinds.includes('archived'))
    const invoiced = await withInvoices(supabase, companyId, resource, archiving.map((r) => r.id))
    for (const repair of archiving) {
      if (!invoiced.has(repair.id)) continue
      delete repair.correct.archived_at
      delete repair.guard.archived_at
      delete repair.was.archived_at
      repair.kinds = repair.kinds.filter((kind) => kind !== 'archived')
    }
  }

  const changed: ChangedCard[] = []
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < repairs.length) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) return
      const repair = repairs[next++]
      const entry: ChangedCard = { resource: repair.resource, id: repair.id, kinds: [] }
      try {
        if (repair.fill) {
          const written = repair.resource === 'customers'
            ? await writeCustomerEnrichment(supabase, companyId, repair.id, repair.fill as CustomerMetadataEnrichment)
            : await writeSupplierEnrichment(supabase, companyId, repair.id, repair.fill as SupplierEnrichment)
          if (written.error) throw new Error(`${repair.resource}: ${written.error.message}`)
          if (written.data) {
            entry.kinds.push('filled')
            entry.filled = Object.keys(repair.fill).filter((column) => (repair.fill as Record<string, unknown>)[column] !== undefined)
          }
        }
        if (Object.keys(repair.correct).length > 0) {
          let query = supabase.from(repair.resource).update(repair.correct).eq('id', repair.id).eq('company_id', companyId)
          for (const [column, value] of Object.entries(repair.guard)) query = value === null ? query.is(column, null) : query.eq(column, value)
          const { data, error } = await query.select('id')
          if (error) throw new Error(`${repair.resource}: ${error.message}`)
          if ((data ?? []).length > 0) {
            entry.kinds.push(...repair.kinds.filter((kind) => kind !== 'filled'))
            entry.was = repair.was
          }
        }
      } catch (writeError) {
        // The other writers take no new card, and finish the one in hand.
        failed = true
        throw writeError
      } finally {
        // A card whose fill landed before its correction failed is changed
        // too: it goes on the trail with what it got.
        if (entry.kinds.length > 0) {
          changed.push(entry)
          await options.onChanged?.(entry)
        }
      }
    }
  }
  // Settled, not raced: when one writer fails, the others still have a card
  // in hand. Rejecting at the first failure let their writes land, and be
  // handed to onChanged, after the caller had already closed the trail, so
  // those cards were changed with no record of what they held.
  const settled = await Promise.allSettled(Array.from({ length: options.concurrency ?? 10 }, worker))
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  // Every worker has returned, so every card before `next` is written.
  return { changed, stoppedAt: next < repairs.length ? repairs[next].key ?? null : null }
}

// ── The revert trail ────────────────────────────────────────────────

/** Changed cards per append. */
const TRAIL_FLUSH_CARDS = 25
/** Once cards keep coming, none waits longer than this for its append. */
const TRAIL_FLUSH_MS = 1_000

/**
 * The company's revert trail, appended as cards are changed
 * (append_register_repair_changed, 20261112192903). The trail used to be
 * written once, after the last card: a run the platform ended before that
 * (27 in 30 days, 2026-11) had changed cards and kept no record of what they
 * held before. One append per card would queue the company's ten card
 * writers on its progress row and rewrite the growing array each time, so
 * cards are appended in batches: at 25 cards, after a second, and when the
 * company's run ends (flush). A run that is ended loses the cards not yet
 * appended: under 25 still buffered, plus any batch whose append was in
 * flight or queued behind it (each card writer waits for the batch it handed
 * over, so at most one such batch per writer), plus the cards in
 * `unrecorded` below, which are written only at the end.
 *
 * Appends run one at a time. Cards an append did not take (the function is
 * not deployed yet, or the call failed) are kept in `unrecorded` for the
 * caller to write at the end of the company's run, as before.
 */
export function registerRepairTrail(supabase: SupabaseClient, companyId: string, provider: RepairProvider,
  now: () => number = Date.now) {
  let buffer: ChangedCard[] = []
  let lastFlush = now()
  let appends: Promise<void> = Promise.resolve()
  let installed = true
  const unrecorded: ChangedCard[] = []

  const append = async (cards: ChangedCard[]) => {
    if (installed) {
      try {
        const { error } = await supabase.rpc('append_register_repair_changed',
          { p_company_id: companyId, p_provider: provider, p_cards: cards })
        if (!error) return
        // Code deployed ahead of the migration: no function yet.
        if (error.code === 'PGRST202' || error.code === '42883') installed = false
        else log.warn('register repair trail entries kept for the end of the run', { companyId, provider, code: error.code, cards: cards.length })
      } catch (err) {
        log.warn('register repair trail entries kept for the end of the run', { companyId, provider, error: messageOf(err), cards: cards.length })
      }
    }
    unrecorded.push(...cards)
  }

  /** Append every buffered card; resolves once every append so far is done. */
  const flush = (): Promise<void> => {
    if (buffer.length > 0) {
      const cards = buffer
      buffer = []
      lastFlush = now()
      appends = appends.then(() => append(cards))
    }
    return appends
  }

  return {
    add: async (card: ChangedCard): Promise<void> => {
      buffer.push(card)
      if (buffer.length >= TRAIL_FLUSH_CARDS || now() - lastFlush >= TRAIL_FLUSH_MS) await flush()
    },
    flush,
    unrecorded,
  }
}

// ── The cron run ────────────────────────────────────────────────────

/** A company and provider's row in register_repair_progress, without the changed cards it keeps. */
export interface RegisterRepairProgress {
  company_id: string
  provider: RepairProvider
  next_key: string | null
  outcome: string | null
  attempts: number
  counts: Partial<Record<RepairKind, number>>
}

/** Runs in a row that fail, or read nothing new, before a company is given up on. */
const MAX_ATTEMPTS = 3
/** Companies read side by side; each provider limits each connection on its own. */
const PARALLEL_COMPANIES = 4
/** A company is not started with less time than this left in the run: listing a large Fortnox register takes most of a minute. */
const MIN_COMPANY_MS = 60_000
/**
 * Cards decided just before the deadline are still written: the writes get
 * this long after it, and stop where they are when it is over. The route's
 * 150 s cutoff plus this leaves 90 s of its 300 for the writes in flight and
 * each company's progress row.
 */
const WRITE_GRACE_MS = 60_000

export interface RegisterRepairRunSummary {
  /** Company and provider pairs with a live connection and no outcome yet, before this run. */
  pending: number
  worked: number
  finished: number
  /** Cards this run changed. */
  changed: number
  /** Companies whose run ended in an error that is not on their progress row (it could not be written). */
  errors: number
}

/**
 * One cron run: works through every company and provider with a live
 * connection and no outcome yet, most recently used connection first, each
 * from its stored cursor, until the deadline. Idempotent: every write is
 * guarded, so a run cut short repeats nothing harmful.
 *
 * `deadline` ends the reading (listing and detail reads); card writes stop
 * WRITE_GRACE_MS after it, and each company then saves its cursor at the
 * first card it did not write. One company's error never ends the run for
 * the others.
 */
export async function runRegisterRepair(
  supabase: SupabaseClient,
  deadline: number,
  deps: RegisterRepairDeps = {},
): Promise<RegisterRepairRunSummary> {
  const consents = await fetchAllRows<{ company_id: string; provider: RepairProvider }>(({ from, to }) =>
    supabase.from('provider_consents').select('company_id, provider').in('provider', [...REPAIR_PROVIDERS]).in('status', [0, 1])
      .order('updated_at', { ascending: false }).order('company_id').range(from, to))
  const progress = await fetchAllRows<RegisterRepairProgress>(({ from, to }) =>
    supabase.from('register_repair_progress').select('company_id, provider, next_key, outcome, attempts, counts')
      .order('company_id').order('provider').range(from, to))
  const rows = new Map(progress.map((row) => [`${row.company_id}:${row.provider}`, row]))
  const queue = [...new Map(consents.map((c) => [`${c.company_id}:${c.provider}`, c])).values()]
    .filter((c) => !rows.get(`${c.company_id}:${c.provider}`)?.outcome)
  const summary: RegisterRepairRunSummary = { pending: queue.length, worked: 0, finished: 0, changed: 0, errors: 0 }

  let next = 0
  const worker = async () => {
    while (next < queue.length && deadline - Date.now() >= MIN_COMPANY_MS) {
      // The first companies get the whole run; the others start whenever one
      // before them finishes, with whatever time is left.
      const hadWholeRun = next < PARALLEL_COMPANIES
      const { company_id: companyId, provider } = queue[next++]
      summary.worked++
      try {
        const result = await repairCompany(supabase, companyId, provider, rows.get(`${companyId}:${provider}`), deadline,
          hadWholeRun, deps)
        summary.changed += result.changed
        if (result.outcome) summary.finished++
      } catch (err) {
        // The company's progress row could not be written. One company's
        // write error used to reject the whole run (HTTP 500 on 22 runs in 30
        // days, 2026-11) and drop the progress of the three worked beside it.
        // Its card writes are guarded, so the next run repeats nothing.
        summary.errors++
        log.error('register repair could not save a company\'s progress', err as Error, { companyId, provider })
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_COMPANIES }, worker))
  return summary
}

async function repairCompany(
  supabase: SupabaseClient,
  companyId: string,
  provider: RepairProvider,
  previous: RegisterRepairProgress | undefined,
  deadline: number,
  hadWholeRun: boolean,
  deps: RegisterRepairDeps,
): Promise<{ outcome: string | null; changed: number }> {
  const row: RegisterRepairProgress = previous ?? {
    company_id: companyId, provider, next_key: null, outcome: null, attempts: 0, counts: {},
  }
  let lastError: string | null = null
  let changedNow = 0
  // Each changed card goes onto the revert trail as it is written, in small
  // batches (registerRepairTrail).
  const trail = registerRepairTrail(supabase, companyId, provider)
  const record = async (card: ChangedCard) => {
    changedNow++
    for (const kind of card.kinds) row.counts[kind] = (row.counts[kind] ?? 0) + 1
    await trail.add(card)
  }
  try {
    const { data: company, error } = await supabase.from('companies').select('archived_at').eq('id', companyId).maybeSingle()
    if (error) throw new Error(`companies: ${error.message}`)
    if (!company || (company as { archived_at: string | null }).archived_at !== null) {
      row.outcome = 'archived'
    } else if (await isMigrationResetSource(supabase, companyId)) {
      // Its cards are immutable (block_migration_reset_source_mutation).
      row.outcome = 'migration_reset'
    } else {
      const plan = await planRegisterRepair(supabase, companyId, provider, { from: row.next_key, deadline }, deps)
      const applied = await applyRegisterRepairs(supabase, companyId, plan.repairs,
        { deadline: deadline + WRITE_GRACE_MS, onChanged: record })
      // Where the next run starts: the first card left unwritten, else the first record left unread.
      const next = applied.stoppedAt ?? plan.next
      if (plan.state === 'no_consent' || plan.state === 'consent_expired') {
        row.outcome = plan.state
      } else if (plan.state === 'failed') {
        row.attempts++
        if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'failed'
      } else if (plan.state === 'out_of_time') {
        // A company that started late keeps its cursor and its attempts: the
        // time ran out on the run, not on it. One that had the whole run and
        // still could not list its registers is counted, or it would be
        // started first, and cut off, on every run.
        if (hadWholeRun) {
          row.attempts++
          if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'stuck'
        }
      } else if (next === null) {
        row.outcome = 'done'
      } else if (next === row.next_key) {
        // The run read nothing past where it started: count it as a miss.
        row.attempts++
        if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'stuck'
      } else {
        row.next_key = next
        row.attempts = 0
      }
      lastError = plan.error ?? null
    }
  } catch (err) {
    lastError = messageOf(err)
    row.attempts++
    if (row.attempts >= MAX_ATTEMPTS) row.outcome = 'failed'
  }
  // The cards still buffered, also after a write that failed part-way:
  // applyRegisterRepairs settles every writer before it answers, so every
  // card it changed has been handed over by now.
  await trail.flush()
  const unrecorded = trail.unrecorded
  const { error } = await supabase.from('register_repair_progress').upsert({
    company_id: companyId,
    provider,
    next_key: row.next_key,
    outcome: row.outcome,
    attempts: row.attempts,
    counts: row.counts,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,provider' })
  if (error) throw new Error(`register_repair_progress: ${error.message}`)
  if (row.outcome === 'failed' || row.outcome === 'stuck') {
    // Given up on for good: its cards stay as the old import wrote them.
    // Once, here: the pair has an outcome now and is never queued again.
    log.error('register repair gave up on a company', undefined,
      { companyId, provider, outcome: row.outcome, attempts: row.attempts, nextKey: row.next_key, lastError })
  }
  // Only the cards the append RPC did not take. The trail is read only to
  // append to it: every run would otherwise carry every company's whole
  // revert list.
  if (unrecorded.length > 0) {
    const { data, error: readError } = await supabase.from('register_repair_progress').select('changed')
      .eq('company_id', companyId).eq('provider', provider).maybeSingle()
    if (readError) throw new Error(`register_repair_progress: ${readError.message}`)
    const changed = [...(((data as { changed?: ChangedCard[] } | null)?.changed) ?? []), ...unrecorded]
    const { error: appendError } = await supabase.from('register_repair_progress').update({ changed })
      .eq('company_id', companyId).eq('provider', provider)
    if (appendError) throw new Error(`register_repair_progress: ${appendError.message}`)
  }
  return { outcome: row.outcome, changed: changedNow }
}
