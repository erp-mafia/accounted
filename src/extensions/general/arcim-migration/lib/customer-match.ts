/**
 * Which existing customer card a provider customer is, before the durable
 * migration worker lets the database create a new one (crm#1294).
 *
 * resolve_provider_migration_party adopts an existing customer on its org
 * number only. A hand-made privatperson card keeps its personnummer encrypted
 * in personal_number and has no org number, so it never matched: an
 * invoice-only migration into a company whose customers were entered by hand
 * created a second, nearly empty card for every one of them and pointed the
 * invoices at it. The card already said who the customer was: the
 * personnummer, and the provider's own customer number, typed into
 * customer_number.
 *
 * The match runs here, not in SQL, because the personnummer can only be read
 * with the application's key. A match is recorded as the source customer's
 * mapping (adopt_provider_migration_invoice_party), which the commit then
 * resolves like any earlier mapping. A source customer that already has a
 * mapping is never re-matched, so a re-run creates nothing new and moves
 * nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'
import type { CustomerDto, PartyDto, SalesInvoiceDto } from '@/lib/providers/dto'
import { partyOrgKey } from '@/lib/invariants/org-number'
import { normalizeVatNumber } from '@/lib/vat/vat-number'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'

const log = createLogger('extensions/arcim-migration/customer-match')

/** What the source says about one customer, each value already normalised. */
export interface PartyFacts {
  /** Org number or personnummer, see partyOrgKey. */
  identity?: string
  vat?: string
  /** The provider's own customer number (kundnummer), see sourceCustomerNumber. */
  number?: string
  /** See customerNameKey. */
  name?: string
}

/** An existing customer row, reduced to the keys a match compares. */
export interface CustomerCard {
  id: string
  /** Org number and personnummer keys the row holds (0 to 2). */
  identities: string[]
  vat?: string
  number?: string
  name?: string
}

/** A source customer seen in one batch, under the id the commit maps it by. */
export interface PartyCandidate {
  sourceId: string
  facts: PartyFacts
}

/** Case, surrounding and repeated whitespace and Unicode form do not tell two names apart. */
export function customerNameKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const key = raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
  return key || undefined
}

function vatKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  return normalizeVatNumber(raw) || undefined
}

function numberKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const key = String(raw).trim().toLowerCase()
  return key || undefined
}

function partyIdentity(party: PartyDto): string | undefined {
  return partyOrgKey(party.identifications?.find((i) => i.schemeId === 'SE:ORGNR')?.id || party.legalEntity?.companyId) ?? undefined
}

function partyVat(party: PartyDto): string | undefined {
  return vatKey(party.identifications?.find((i) => /(^|:)VAT$/i.test(i.schemeId ?? ''))?.id)
}

/**
 * The customer number the user sees in the source system, when the record
 * carries one. Only providers whose field is that number: Bokio, Björn Lundén
 * and WINT hand back an internal id, which no hand-typed card holds, and
 * which could only collide with one by accident.
 */
function sourceCustomerNumber(provider: string, raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined
  if (provider === 'fortnox' || provider === 'visma') return numberKey(raw['CustomerNumber'])
  if (provider === 'briox') return numberKey(raw['customernumber'] ?? raw['customer_number'])
  return undefined
}

/** Facts for the customer a sales invoice names. */
export function salesInvoicePartyFacts(provider: string, invoice: SalesInvoiceDto): PartyFacts {
  return {
    identity: partyIdentity(invoice.customer),
    vat: partyVat(invoice.customer),
    number: sourceCustomerNumber(provider, invoice._raw),
    name: customerNameKey(invoice.customer.name),
  }
}

/** Facts for a customer from the provider's customer register. */
export function customerRegisterFacts(provider: string, dto: CustomerDto): PartyFacts {
  return {
    identity: partyIdentity(dto.party),
    vat: vatKey(dto.vatNumber) ?? partyVat(dto.party),
    number: sourceCustomerNumber(provider, dto._raw)
      ?? (['fortnox', 'visma', 'briox'].includes(provider) ? numberKey(dto.customerNumber) : undefined),
    name: customerNameKey(dto.party.name),
  }
}

type Predicate = (card: CustomerCard, facts: PartyFacts) => boolean

const sameIdentity: Predicate = (card, facts) => !!facts.identity && card.identities.includes(facts.identity)
const sameVat: Predicate = (card, facts) => !!facts.vat && card.vat === facts.vat
const sameNumber: Predicate = (card, facts) => !!facts.number && card.number === facts.number
const sameName: Predicate = (card, facts) => !!facts.name && card.name === facts.name

/** Both state an identity number and they differ: two legal persons. */
const identityConflict: Predicate = (card, facts) =>
  !!facts.identity && card.identities.length > 0 && !card.identities.includes(facts.identity)
const vatConflict: Predicate = (card, facts) => !!facts.vat && !!card.vat && card.vat !== facts.vat
const numberConflict: Predicate = (card, facts) => !!facts.number && !!card.number && card.number !== facts.number

const words = (name: string | undefined): Set<string> =>
  new Set((name ?? '').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3))

/**
 * A customer number is free text on the card. When the user numbered the
 * cards their own way, the same number on another customer would pass for a
 * match; a renamed customer ("Sam Nylander" and "Sam Daniel Nylander") still
 * shares a word with itself, two unrelated customers do not.
 */
const namesShareAWord: Predicate = (card, facts) => {
  if (!card.name || !facts.name) return true
  const theirs = words(card.name)
  for (const word of words(facts.name)) if (theirs.has(word)) return true
  return false
}

/**
 * An org number and the VAT number made from it name a legal person, not a
 * customer card: the departments of one public authority are separate
 * customers at the source under one org number (crm#1398). A card whose
 * customer number and name both differ from the source's is another of them,
 * even when it is the only card with that org number. Folding it in would
 * put two customers' invoices on one card, which a merge cannot undo; a card
 * too many can be merged later. The same name keeps the match (the user
 * numbered the cards their own way, crm#1294).
 */
const anotherCustomerOfTheSamePerson: Predicate = (card, facts) => numberConflict(card, facts) && !sameName(card, facts)

/**
 * Strongest key first. A tier answers only with cards that contradict none of
 * the facts a stronger key would have compared, so two customers who share a
 * name but not an org number, personnummer, VAT number or customer number
 * stay two customers.
 *
 * `shared`: whether the tier may answer with a card another source customer
 * already maps to. An identity, VAT or customer number on the card names one
 * legal person, so a second source record of that person (a customer entered
 * twice at the source) belongs on the same card. A name names no one: two
 * source customers that only share a name stay two customers.
 */
const TIERS: { matches: Predicate; admissible: Predicate; shared: boolean }[] = [
  { matches: sameIdentity, admissible: (c, f) => !anotherCustomerOfTheSamePerson(c, f), shared: true },
  {
    matches: sameVat,
    admissible: (c, f) => !identityConflict(c, f) && !anotherCustomerOfTheSamePerson(c, f),
    shared: true,
  },
  {
    matches: (c, f) => sameNumber(c, f) && namesShareAWord(c, f),
    admissible: (c, f) => !identityConflict(c, f) && !vatConflict(c, f),
    shared: true,
  },
  {
    matches: sameName,
    admissible: (c, f) => !identityConflict(c, f) && !vatConflict(c, f) && !numberConflict(c, f),
    shared: false,
  },
]
const NARROWERS: Predicate[] = [sameVat, sameNumber, sameName]

/**
 * The one existing card these facts identify, or null. Several cards on the
 * same key are told apart by the weaker keys; when they still cannot be, the
 * answer is null (a new card), never a guess and never a weaker tier.
 * `claimed` holds the cards another source customer already maps to.
 */
export function matchExistingCustomer(
  facts: PartyFacts,
  cards: CustomerCard[],
  claimed: ReadonlySet<string> = new Set(),
): string | null {
  for (let tier = 0; tier < TIERS.length; tier++) {
    const { matches, admissible, shared } = TIERS[tier]
    let found = cards.filter((card) =>
      (shared || !claimed.has(card.id)) && admissible(card, facts) && matches(card, facts))
    if (found.length === 0) continue
    for (const narrow of NARROWERS.slice(tier)) {
      if (found.length === 1) break
      const narrowed = found.filter((card) => narrow(card, facts))
      if (narrowed.length > 0) found = narrowed
    }
    return found.length === 1 ? found[0].id : null
  }
  return null
}

type CustomerRow = {
  id: string
  name: string | null
  org_number: string | null
  personal_number: string | null
  vat_number: string | null
  customer_number: string | null
}

/**
 * Cards from customer rows. A personnummer that cannot be decrypted (no key
 * configured, a damaged value) only drops that key: the card still matches
 * on everything else.
 */
export function buildCustomerCards(rows: CustomerRow[]): CustomerCard[] {
  let unreadable = 0
  const cards = rows.map((row) => {
    const identities = new Set<string>()
    const org = partyOrgKey(row.org_number)
    if (org) identities.add(org)
    if (row.personal_number) {
      try {
        const personal = partyOrgKey(revealStoredCustomerPersonalNumber(row.personal_number))
        if (personal) identities.add(personal)
      } catch {
        unreadable++
      }
    }
    return {
      id: row.id,
      identities: [...identities],
      vat: vatKey(row.vat_number),
      number: numberKey(row.customer_number),
      name: customerNameKey(row.name),
    }
  })
  // Counted, never the value: the log must not carry a personnummer.
  if (unreadable > 0) log.warn('customer personal numbers left out of matching: not decryptable', { count: unreadable })
  return cards
}

/** Ids the worker derives from an org number or an invoice, not from a source customer. */
const isDerivedSourceId = (sourceId: string): boolean => sourceId.startsWith('invoice-party:')

/**
 * Map each unmapped source customer in `parties` onto the existing card it
 * matches, before the batch is committed. Returns how many were mapped.
 *
 * Only cards the company had before the job started are candidates: the job's
 * own new cards are resolved by their source ids, and folding one source
 * customer into a card the job created for another (two departments under
 * one org number) is the merge resolve_provider_migration_party refuses.
 * Archived cards are left out: archiving is the user retiring the card. A
 * name match never takes a card another source customer of the same
 * connection already maps to (see TIERS); a derived id (one per org number or
 * per invoice, no source customer behind it) may.
 */
export async function adoptExistingCustomers(
  supabase: SupabaseClient,
  job: ProviderMigrationJob,
  parties: PartyCandidate[],
  within: <T>(promise: PromiseLike<T>) => Promise<T>,
): Promise<number> {
  // Without the job's start there is no telling the company's own cards from
  // the job's: leave every party to the commit, as before.
  if (!job.created_at) return 0
  const pending = new Map<string, PartyFacts>()
  for (const { sourceId, facts } of parties) if (sourceId && !pending.has(sourceId)) pending.set(sourceId, facts)
  if (pending.size === 0) return 0

  const { data: mapped, error: mappedError } = await within(supabase.from('migration_source_records')
    .select('source_id')
    .eq('company_id', job.company_id).eq('provider', job.provider).eq('account_key', job.account_key)
    .eq('resource', 'customers').in('source_id', [...pending.keys()]))
  if (mappedError) throw new Error(mappedError.message)
  for (const row of (mapped ?? []) as { source_id: string }[]) pending.delete(row.source_id)
  if (pending.size === 0) return 0

  // A company that had no customers before the job (the usual first
  // migration) answers here, without the source map read below.
  const rows = await within(fetchAllRows<CustomerRow>(({ from, to }) => supabase.from('customers')
    .select('id, name, org_number, personal_number, vat_number, customer_number')
    .eq('company_id', job.company_id).is('archived_at', null).lt('created_at', job.created_at)
    .order('id', { ascending: true }).range(from, to)))
  if (rows.length === 0) return 0
  const claims = await within(fetchAllRows<{ source_id: string; target_id: string }>(({ from, to }) => supabase
    .from('migration_source_records').select('source_id, target_id')
    .eq('company_id', job.company_id).eq('provider', job.provider).eq('account_key', job.account_key)
    .eq('resource', 'customers').order('id', { ascending: true }).range(from, to)))
  const cards = buildCustomerCards(rows)
  const claimed = new Set(claims.filter((c) => !isDerivedSourceId(c.source_id)).map((c) => c.target_id))

  const unclaimed: ReadonlySet<string> = new Set()
  let adopted = 0
  for (const [sourceId, facts] of pending) {
    const customerId = matchExistingCustomer(facts, cards, isDerivedSourceId(sourceId) ? unclaimed : claimed)
    if (!customerId) continue
    const { error } = await within(supabase.rpc('adopt_provider_migration_invoice_party', {
      p_job_id: job.id, p_source_id: sourceId, p_customer: customerId,
    }))
    if (error) throw new Error(error.message)
    if (!isDerivedSourceId(sourceId)) claimed.add(customerId)
    adopted++
  }
  log.info('existing customers matched before commit', { jobId: job.id, unmapped: pending.size, adopted })
  return adopted
}
