import type { SupabaseClient } from '@supabase/supabase-js'
import { allowlistReachesCompany, credentialActor } from '@/lib/auth/api-keys'
import { partnerClientNames, partnerSlugOf } from '@/lib/auth/oauth-partner-clients'
import { cashAccountBankName, cashAccountLogoUrl, type CashAccountWithBank } from '@/lib/cash-accounts/labels'
import { ibanLast4 } from '@/lib/cash-accounts/selection-refusal'
import { stockholmWallTimeToUtc, todayIsoStockholm } from '@/lib/dates/iso'
import { listConnections } from '@/lib/digital-mailboxes/connections'
import { resolveInboxAddress } from '@/lib/documents/inbox-address'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { inboxHref, isInkorgV2Enabled, LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { createLogger } from '@/lib/logger'
import { buildReportDataStatus } from '@/lib/reports/data-status'
import { connectionKind, type ConnectionKind } from '@/lib/settings/mcp-connections'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createServiceClient } from '@/lib/supabase/server'
import { chunk } from '@/lib/utils'
import { packFitsForm, type KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { catalogueKnowledge, chosenKnowledge, isActiveKnowledge } from '@/lib/agent-skills/knowledge-list'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { agentCards, tallyWork, type CardConnection, type StagerRef } from './agent-cards'

const log = createLogger('agent-picture')

/**
 * The picture of what a connected agent gets, as data: what is connected to
 * the company (the sources), the company itself (how much it holds, what it
 * remembers, what the agent knows, and whether the books agree with what
 * comes from outside) and the agents connected to it, one card per product,
 * with what they did today.
 *
 * Every part is best effort with a deadline of its own: a part that fails or
 * runs out of time comes back as unknown (null, or a source whose state is
 * `unknown`) and the rest still answers. A failed read never says "not
 * connected" or "nothing to look at".
 *
 * Nothing here judges the books. The checks are the unexplained queue
 * (lib/unexplained) and the report data status (lib/reports/data-status) as
 * they answer: this module only carries their results to a screen.
 *
 * Every read filters on the company. The exceptions are named where they
 * are made: the company's own row (by id), the signed-in person's WhatsApp
 * link and own connections (by user), the names of the people whose
 * connections the person may list (by their ids), the count of the
 * connections the person may not list (by the company's members), the
 * knowledge registry, which is the same for every company, and the items
 * the company's team installed (by the team the company's own row names).
 */

/** A source or connection as the picture draws it. */
export type PictureLinkState = 'connected' | 'needs_attention' | 'not_connected' | 'unknown'

export type PictureSourceKey =
  | 'bank'
  | 'skatteverket'
  | 'bolagsverket'
  | 'inbox'
  | 'whatsapp'
  | 'kivra'
  | 'billo'
  | 'gmail'
  | 'stripe'
  | 'pos'
  | 'shopify'
  | 'woocommerce'
  | 'zettle'

export type PictureSourceGroupId = 'bank' | 'authorities' | 'documents' | 'sales'

export interface PictureSource {
  /** Unique in the picture: the key, or the key and a record id. */
  id: string
  /** Which source it is: the screen names it and picks its mark from this. */
  key: PictureSourceKey
  /** A name the data carries (the bank, a venue); null when the screen names the source by its key. */
  name: string | null
  /** What the data says about it: an account's name, the inbox address, a masked phone number. */
  detail: string | null
  /** Bank accounts only: the last four characters of the account, never more. */
  tail: string | null
  /** The inbox only: documents received through the address this calendar year; null when not counted. */
  count: number | null
  state: PictureLinkState
  /** When it last delivered, when that is stored. */
  last_delivered_at: string | null
  /** A mark the data picks (a bank's logo under /logos/banks); null when the key decides. */
  logo: string | null
  /** Where a press leads: where the source is managed, or connected. */
  href: string
}

export interface PictureSourceGroup {
  id: PictureSourceGroupId
  items: PictureSource[]
}

export interface PictureCounts {
  /** Verifikat in the books: posted, and posted then reversed. */
  vouchers: number | null
  bank_rows: number | null
  documents: number | null
  customers: number | null
  suppliers: number | null
}

export type PictureCheckStatus = 'agrees' | 'attention' | 'unknown'

/** One result of one check, as the check answered it. */
export interface PictureCheckLine {
  id: string
  /** A check of the unexplained queue (lib/unexplained CHECK_IDS), or `bank_feed` for the report data status. */
  check_id: string
  /** The check's own name; null for `bank_feed`, which the screen names. */
  name_sv: string | null
  name_en: string | null
  /** What the result is about when the check has several: a bank account, a momsperiod. */
  subject: string | null
  /** A bank account's result only: the last four characters of the account, so two accounts with one name read apart. */
  subject_tail: string | null
  status: PictureCheckStatus
  /** attention only: the difference as the check gives it, in `unit`. */
  difference: number | null
  unit: 'SEK' | 'count' | null
  /** attention only: how many things there are to look at. */
  things: number | null
  /** The date the comparison holds at, or the instant the source was last read. */
  as_of: string | null
  /** attention only: the screen where it is handled. */
  href: string | null
  /** unknown only: the check's typed reason, when it gave one. */
  reason_code: string | null
}

export interface PictureChecks {
  read_at: string
  lines: PictureCheckLine[]
  counts: Record<PictureCheckStatus, number>
  /** Results the queue left out of its list (they are counted above). */
  truncated: number
  /** True when the unexplained queue could not be read: its checks are missing from `lines`. */
  queue_unavailable: boolean
}

export interface PictureKnowledge {
  /** How many knowledge items the company's agent gets today (lib/agent-skills/knowledge-list.ts); null when it could not be read. */
  items: number | null
  /** Those items, by id: the folders tell what the agent gets from what else exists with them. Null when it could not be read. */
  active: string[] | null
}

/** What waits on the company's people: questions to answer and proposals to approve, across every agent. */
export interface PictureWaiting {
  /** Open questions; 0 for a company without the question list. */
  questions: number
  /** Proposals that wait for approval. */
  proposals: number
}

export interface PictureCompany {
  name: string | null
  /** What waits on the company's people, as Hem and the menu count it; null when it was not counted. */
  waiting: PictureWaiting | null
  counts: PictureCounts
  /** Active remembered facts; null when the count could not be read. */
  memory_facts: number | null
  knowledge: PictureKnowledge
  /** null when no check could be read at all. */
  checks: PictureChecks | null
}

export interface PictureActorActivity {
  calls_today: number
  last_call_at: string | null
}

/** How many questions a stager asked and how many proposals it prepared. */
export interface PictureWorkCount {
  questions: number
  proposals: number
}

/**
 * What the company's connections did for it today, from the question list
 * and the staged operations: counts by who staged the row, never what a
 * question or a proposal says. A row that names a connection by id is
 * counted under that id; a row that carries a label and no id under the
 * label. Which card a count belongs to is worked out in agent-cards.ts.
 */
export interface PictureWork {
  by_connection: Record<string, PictureWorkCount>
  by_label: Record<string, PictureWorkCount>
}

/** What the agents did, from the tool call log: counts and times, never which records were read. */
export interface PictureActivity {
  /** The server's clock when the log was read. */
  now: string
  /** The Stockholm calendar day the counts cover. */
  day: string
  /** Per connection (api key id). A connection with no row here made no call the read reached. */
  actors: Record<string, PictureActorActivity>
  /** True when the day held more calls than were read: the counts are then lower bounds. */
  capped: boolean
  /** Active remembered facts right now, so a fact saved while the picture is open shows; null when the count could not be read. */
  memory_facts: number | null
  /** The questions asked and the proposals prepared that day, by stager; null when they could not be read. */
  work: PictureWork | null
}

/** One connection: an api key. */
export interface PictureAgent {
  /** The connection's id (the api key's). */
  id: string
  kind: ConnectionKind
  /** A hand-made key's own name or a partner's name; null when the screen names the client by its kind. */
  name: string | null
  /** The service account the connection belongs to, by its name; null for a person's connection. */
  service_account: string | null
  last_used_at: string | null
  calls_today: number
  last_call_at: string | null
  /** When the connection was made. */
  connected_at: string
  /** The signed-in person's own connection. */
  is_own: boolean
  /** Whose a colleague's connection is (full name, else e-mail); null for the person's own, for a service account's, and when the name could not be read. */
  owner_name: string | null
}

/**
 * One card of the agents column: a product (every connection the screen
 * names by the same kind), a connection with a name of its own, or a service
 * account (agent-cards.ts).
 */
export interface PictureAgentCard {
  /** Unique among the cards: the kind, `key:` and the connection's id, or `account:` and the service account's id. */
  id: string
  kind: ConnectionKind
  /** The name of a card that is one named connection; null when the screen names the card by its kind or by its account. */
  name: string | null
  /** The service account the card stands for, by its name; null otherwise. */
  service_account: string | null
  /** The connections behind the card, the one that worked last first. */
  connections: PictureAgent[]
  /** The labels only this card's connections write in the records: a row that carries such a label and no id belongs to the card. */
  labels: string[]
}

export interface PictureAgents {
  /** The cards, the ones that worked last first. */
  list: PictureAgentCard[]
  /** Cards past the listed ones. */
  more: number
  /**
   * Live connections that reach the company and that the person may not
   * list: other people's, and service accounts' the person cannot read. A
   * number and nothing else about them. null when they could not be counted.
   */
  others: number | null
  /** null when the tool call log could not be read: the counts above are then 0 and mean nothing. */
  activity: PictureActivity | null
}

export interface AgentPicture {
  generated_at: string
  sources: PictureSourceGroup[]
  company: PictureCompany
  /** null when the connections could not be read. */
  agents: PictureAgents | null
}

/**
 * What the door wires in. The loader lives in the agent module and reads
 * the ledger and the registers only through their own readers; the ones
 * below belong to other modules, so the route hands them over.
 */
export interface AgentPicturePorts {
  /** Runs a ledger read the way the door's other ledger reads run (behind the SIE import lease). */
  ledgerRead?: <T>(read: () => Promise<T>) => Promise<T>
  /** The company's Skatteverket connection and when the skattekonto saldo was last fetched. */
  skatteverket?: () => Promise<{ state: 'connected' | 'not_connected' | 'unknown'; last_sync_at: string | null }>
  /** What waits on the company's people, from the counters Hem and the menu read. */
  waiting?: () => Promise<PictureWaiting>
}

/** A part's deadline. The reads behind it keep running; their answer is just no longer waited for. */
const PART_DEADLINE_MS = 2500
/** The checks read the reports, so they get longer. */
const CHECKS_DEADLINE_MS = 6000
/** The count of the connections the person may not list: shorter than a part's, so a slow count never costs the listed connections. */
const OTHERS_DEADLINE_MS = 2000

/** Cards listed in the agents column; the rest are a number. */
const MAX_AGENTS = 6
/** Not connected sources offered beside the connected ones. */
const MAX_NOT_CONNECTED = 2
/** The sources that are offered when not connected, the first ones first. */
const OFFERED_WHEN_OFF: readonly PictureSourceKey[] = ['stripe', 'pos', 'whatsapp', 'shopify', 'woocommerce', 'zettle']

const HREF: Record<PictureSourceKey, string> = {
  bank: '/settings/banking',
  skatteverket: '/settings/skatteverket',
  bolagsverket: '/settings/company',
  // The workspace's address; loadSources puts the company's own inbox in its place.
  inbox: LEGACY_INBOX_HREF,
  whatsapp: '/settings/whatsapp',
  kivra: '/settings/connections',
  billo: '/settings/connections',
  gmail: '/settings/mail',
  stripe: '/import?mode=stripe',
  pos: '/settings/pos',
  shopify: '/import?mode=shopify',
  woocommerce: '/import?mode=woocommerce',
  zettle: '/import?mode=zettle',
}

/** Where a stopped or stale bank feed is handled. */
const BANK_FEED_HREF = '/settings/banking'

type QueryError = { message: string } | null

function source(key: PictureSourceKey, state: PictureLinkState, patch: Partial<PictureSource> = {}): PictureSource {
  return { id: key, key, name: null, detail: null, tail: null, count: null, state, last_delivered_at: null, logo: null, href: HREF[key], ...patch }
}

/** One part, inside its deadline: null when it fails or runs out of time. */
async function within<T>(part: string, companyId: string, ms: number, read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.warn('agent picture part timed out', { companyId, part, ms })
      resolve(null)
    }, ms)
  })
  const answer = (async (): Promise<T | null> => {
    try {
      return await read()
    } catch (err) {
      log.warn('agent picture part failed', { companyId, part, reason: err instanceof Error ? err.message : String(err) })
      return null
    }
  })()
  try {
    return await Promise.race([answer, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function failed(what: string, error: QueryError): never {
  throw new Error(`${what} read failed: ${error?.message ?? 'unknown'}`)
}

/** A head count: null when the read fails, never a made-up zero. */
async function headCount(query: PromiseLike<{ count: number | null; error: QueryError }>): Promise<number | null> {
  const { count, error } = await query
  return error ? null : (count ?? 0)
}

// ---------------------------------------------------------------- sources

type BankRow = CashAccountWithBank & { bank_connection: { bank_name: string | null; status?: string | null; last_synced_at?: string | null } | null }

/** The last four characters that name an account: its IBAN's, or a card's own. */
function accountTail(row: BankRow): string | null {
  if (row.kind === 'card') return row.card_last4?.[0]?.slice(-4) ?? null
  return ibanLast4(row.iban) ?? null
}

/**
 * The cash accounts a bank connection feeds. A connection that has stopped
 * (error, expired) still shows, as needing attention; one that was revoked
 * or never finished does not.
 */
async function bankSources(supabase: SupabaseClient, companyId: string): Promise<PictureSource[]> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*, bank_connection:bank_connections(bank_name, status, last_synced_at)')
    .eq('company_id', companyId)
    .eq('enabled', true)
    .not('bank_connection_id', 'is', null)
    .order('is_primary', { ascending: false })
    .order('ledger_account', { ascending: true })
  if (error) failed('cash accounts', error)

  const items: PictureSource[] = []
  for (const row of (data ?? []) as BankRow[]) {
    const status = row.bank_connection?.status
    const state: PictureLinkState | null =
      status === 'active' ? 'connected' : status === 'error' || status === 'expired' ? 'needs_attention' : null
    if (!state) continue
    const name = cashAccountBankName(row)
    const accountName = row.name?.trim() || null
    items.push(
      source('bank', state, {
        id: `bank:${row.id}`,
        name,
        detail: accountName && accountName !== name ? accountName : null,
        tail: accountTail(row),
        last_delivered_at: row.bank_connection?.last_synced_at ?? null,
        logo: cashAccountLogoUrl(row),
      }),
    )
  }
  if (items.length > 0) return items
  return ENABLED_EXTENSION_IDS.has('enable-banking') ? [source('bank', 'not_connected')] : []
}

async function skatteverketSource(ports: AgentPicturePorts): Promise<PictureSource> {
  if (!ports.skatteverket) return source('skatteverket', 'unknown')
  const answer = await ports.skatteverket()
  return source('skatteverket', answer.state, { last_delivered_at: answer.last_sync_at })
}

/**
 * The register data the company holds and when it was fetched. The company's
 * own row, so the filter is its id.
 */
async function bolagsverketSource(supabase: SupabaseClient, companyId: string): Promise<PictureSource | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('tic_snapshot_fetched_at')
    .eq('id', companyId)
    .not('tic_snapshot', 'is', null)
    .maybeSingle()
  if (error) failed('register data', error)
  const row = data as { tic_snapshot_fetched_at: string | null } | null
  if (row) return source('bolagsverket', 'connected', { last_delivered_at: row.tic_snapshot_fetched_at })
  return ENABLED_EXTENSION_IDS.has('tic') ? source('bolagsverket', 'not_connected') : null
}

/** The inbox address, how many documents came through it this calendar year and when the last one did. */
async function inboxSource(supabase: SupabaseClient, companyId: string, now: Date): Promise<PictureSource> {
  const address = await resolveInboxAddress(supabase, companyId)
  if (!address) return source('inbox', 'not_connected')
  const yearStart = stockholmWallTimeToUtc(`${todayIsoStockholm(now).slice(0, 4)}-01-01`, '00:00').toISOString()
  const [count, last] = await Promise.all([
    headCount(
      supabase
        .from('invoice_inbox_items')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('source', 'email')
        .gte('created_at', yearStart),
    ),
    supabase
      .from('invoice_inbox_items')
      .select('created_at')
      .eq('company_id', companyId)
      .eq('source', 'email')
      .order('created_at', { ascending: false })
      .limit(1),
  ])
  const newest = last.error ? null : ((last.data ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null
  return source('inbox', 'connected', { detail: address, count, last_delivered_at: newest })
}

/**
 * The signed-in person's phone link. A link belongs to a person, not to a
 * company, so the filter is the user.
 */
async function whatsappSource(supabase: SupabaseClient, userId: string): Promise<PictureSource> {
  const { data, error } = await supabase
    .from('whatsapp_phone_links')
    .select('phone_masked, last_message_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle()
  if (error) failed('whatsapp link', error)
  const row = data as { phone_masked: string; last_message_at: string | null } | null
  if (!row) return source('whatsapp', 'not_connected')
  return source('whatsapp', 'connected', { detail: row.phone_masked, last_delivered_at: row.last_message_at })
}

/** Kivra and Billo, where the company receives through them. */
async function mailboxSources(supabase: SupabaseClient, companyId: string): Promise<PictureSource[]> {
  const connections = await listConnections(supabase, companyId)
  return connections
    .filter((c) => c.receive_state === 'active' && (c.provider === 'kivra' || c.provider === 'billo'))
    .map((c) => source(c.provider as 'kivra' | 'billo', 'connected', { last_delivered_at: c.last_synced_at }))
}

async function gmailSource(supabase: SupabaseClient, companyId: string): Promise<PictureSource | null> {
  const { data, error } = await supabase.from('mail_connections').select('status').eq('company_id', companyId).in('status', ['active', 'needs_reconsent'])
  if (error) failed('mail connections', error)
  const rows = (data ?? []) as Array<{ status: string }>
  if (rows.length === 0) return null
  return source('gmail', rows.some((r) => r.status === 'active') ? 'connected' : 'needs_attention')
}

/** The connected cash register venues, labelled as the connections page labels them. */
async function posSource(supabase: SupabaseClient, companyId: string): Promise<PictureSource> {
  const { data, error } = await supabase
    .from('pos_connections')
    .select('venue_name, provider_name, health')
    .eq('company_id', companyId)
    .eq('status', 'active')
  if (error) failed('cash register connections', error)
  const venues = (data ?? []) as Array<{ venue_name: string; provider_name: string; health: string }>
  if (venues.length === 0) return source('pos', 'not_connected')
  return source('pos', venues.some((v) => v.health === 'action_required') ? 'needs_attention' : 'connected', {
    detail: venues.length === 1 ? `${venues[0].venue_name} (${venues[0].provider_name})` : venues.map((v) => v.venue_name).join(', '),
  })
}

function activeOrOff(key: PictureSourceKey, what: string, result: { data: unknown; error: QueryError }): PictureSource {
  if (result.error) failed(what, result.error)
  return source(key, ((result.data ?? []) as unknown[]).length > 0 ? 'connected' : 'not_connected')
}

async function stripeSource(supabase: SupabaseClient, companyId: string): Promise<PictureSource> {
  return activeOrOff('stripe', 'stripe connections', await supabase.from('stripe_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1))
}

async function shopifySource(supabase: SupabaseClient, companyId: string): Promise<PictureSource> {
  return activeOrOff('shopify', 'shopify connections', await supabase.from('shopify_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1))
}

async function woocommerceSource(supabase: SupabaseClient, companyId: string): Promise<PictureSource> {
  return activeOrOff('woocommerce', 'woocommerce connections', await supabase.from('woocommerce_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1))
}

async function zettleSource(supabase: SupabaseClient, companyId: string): Promise<PictureSource> {
  return activeOrOff('zettle', 'zettle connections', await supabase.from('zettle_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1))
}

/**
 * Every connected source stays; of the ones that are offered when not
 * connected, the first MAX_NOT_CONNECTED stay and the rest are left out.
 */
export function limitNotConnected(groups: PictureSourceGroup[]): PictureSourceGroup[] {
  const offered = groups
    .flatMap((g) => g.items)
    .filter((item) => item.state === 'not_connected' && OFFERED_WHEN_OFF.includes(item.key))
    .sort((a, b) => OFFERED_WHEN_OFF.indexOf(a.key) - OFFERED_WHEN_OFF.indexOf(b.key))
  const dropped = new Set(offered.slice(MAX_NOT_CONNECTED).map((item) => item.id))
  return groups
    .map((g) => ({ ...g, items: g.items.filter((item) => !dropped.has(item.id)) }))
    .filter((g) => g.items.length > 0)
}

async function loadSources(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  ports: AgentPicturePorts,
  now: Date,
): Promise<PictureSourceGroup[]> {
  const has = (id: string) => ENABLED_EXTENSION_IDS.has(id)
  const part = <T>(name: string, read: () => Promise<T>) => within(name, companyId, PART_DEADLINE_MS, read)
  const none = Promise.resolve(null)

  const [bank, skatteverket, bolagsverket, inbox, whatsapp, mailboxes, gmail, stripe, pos, shopify, woocommerce, zettle] = await Promise.all([
    part('bank', () => bankSources(supabase, companyId)),
    has('skatteverket') ? part('skatteverket', () => skatteverketSource(ports)) : none,
    part('bolagsverket', async () => ({ item: await bolagsverketSource(supabase, companyId) })),
    // The address exists only where the installation receives mail.
    has('invoice-inbox') && process.env.RESEND_INBOUND_DOMAIN ? part('inbox', () => inboxSource(supabase, companyId, now)) : none,
    has('whatsapp-inbox') ? part('whatsapp', () => whatsappSource(supabase, userId)) : none,
    part('mailboxes', () => mailboxSources(supabase, companyId)),
    has('mail') ? part('gmail', () => gmailSource(supabase, companyId)) : none,
    has('stripe') ? part('stripe', () => stripeSource(supabase, companyId)) : none,
    part('pos', () => posSource(supabase, companyId)),
    has('shopify') ? part('shopify', () => shopifySource(supabase, companyId)) : none,
    has('woocommerce') ? part('woocommerce', () => woocommerceSource(supabase, companyId)) : none,
    has('zettle') ? part('zettle', () => zettleSource(supabase, companyId)) : none,
  ])

  const present = (items: Array<PictureSource | null>): PictureSource[] => items.filter((item): item is PictureSource => item !== null)
  // The inbox card leads to the company's inbox: the new Inkorg page inside its rollout, the workspace outside it.
  const inboxLink = inboxHref(isInkorgV2Enabled(companyId))
  return limitNotConnected([
    // A failed read is unknown, never "not connected".
    { id: 'bank', items: bank ?? [source('bank', 'unknown')] },
    {
      id: 'authorities',
      items: present([
        has('skatteverket') ? (skatteverket ?? source('skatteverket', 'unknown')) : null,
        bolagsverket ? bolagsverket.item : source('bolagsverket', 'unknown'),
      ]),
    },
    {
      id: 'documents',
      items: present([
        has('invoice-inbox') && process.env.RESEND_INBOUND_DOMAIN ? { ...(inbox ?? source('inbox', 'unknown')), href: inboxLink } : null,
        whatsapp,
        ...(mailboxes ?? []),
        gmail,
      ]),
    },
    { id: 'sales', items: present([stripe, pos, shopify, woocommerce, zettle]) },
  ])
}

// ---------------------------------------------------------------- the company

async function loadCompanyName(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  // The company's own row: the filter is its id.
  const { data, error } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle()
  if (error) failed('company', error)
  return (data as { name: string | null } | null)?.name ?? null
}

const NO_COUNTS: PictureCounts = { vouchers: null, bank_rows: null, documents: null, customers: null, suppliers: null }

async function loadCounts(supabase: SupabaseClient, companyId: string): Promise<PictureCounts> {
  const head = { count: 'exact', head: true } as const
  const [vouchers, bankRows, documents, customers, suppliers] = await Promise.all([
    headCount(supabase.from('journal_entries').select('id', head).eq('company_id', companyId).in('status', ['posted', 'reversed'])),
    headCount(supabase.from('transactions').select('id', head).eq('company_id', companyId)),
    headCount(supabase.from('document_attachments').select('id', head).eq('company_id', companyId).eq('admission_state', 'admitted')),
    headCount(supabase.from('customers').select('id', head).eq('company_id', companyId)),
    headCount(supabase.from('suppliers').select('id', head).eq('company_id', companyId)),
  ])
  return { vouchers, bank_rows: bankRows, documents, customers, suppliers }
}

/** The facts the briefing sends: active, and not replaced by a later one. */
async function loadMemoryFacts(supabase: SupabaseClient, companyId: string): Promise<number | null> {
  return headCount(
    supabase.from('agent_memory').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true).is('superseded_by', null),
  )
}

/**
 * The items the company installed, its own rows and its team's: only which
 * item each row points at, which is all the count reads of them. The
 * company's rows are read by the company; the team's by the team its own row
 * names. Throws when a read fails.
 */
async function installedItems(supabase: SupabaseClient, companyId: string, teamId: string | null): Promise<Array<{ atom_id: string | null }>> {
  const [own, team] = await Promise.all([
    fetchAllRows<{ atom_id: string | null }>(({ from, to }) =>
      supabase.from('company_skills').select('atom_id').eq('company_id', companyId).not('atom_id', 'is', null).order('id').range(from, to),
    ),
    teamId
      ? fetchAllRows<{ atom_id: string | null }>(({ from, to }) =>
          supabase.from('company_skills').select('atom_id').eq('team_id', teamId).not('atom_id', 'is', null).order('id').range(from, to),
        )
      : Promise.resolve([]),
  ])
  return [...team, ...own]
}

/**
 * The knowledge items the company's agent gets today: the items of the
 * catalogue's knowledge list that are active for the company, by the
 * catalogue's own rule (lib/agent-skills/knowledge-list.ts: a general item
 * always, an industry or company-form item when the profile names it or the
 * company installed it).
 *
 * Read once, and only what the count needs: which items the registry holds
 * and of which kind (the catalogue's own list: live, exposed, top level and
 * written for the company's legal form, as loadKnowledgeOptions reads it),
 * which items the profile names, and which the company installed. No item's
 * text is read. The registry is the same for every company, so that read
 * has no company filter; the company's own row is read by its id.
 *
 * Throws when a read fails: which items are active is then not known, and
 * nothing is guessed.
 */
async function loadKnowledge(supabase: SupabaseClient, companyId: string): Promise<{ items: number; active: string[] }> {
  const [company, registry, profile] = await Promise.all([
    supabase.from('companies').select('entity_type, team_id').eq('id', companyId).maybeSingle(),
    supabase.from('agent_atom_registry').select('id, tier').eq('is_active', true).eq('mcp_exposed', true).is('parent_atom_id', null).order('tier').order('id'),
    supabase.from('agent_profiles').select('vertical_atoms, modifier_atoms').eq('company_id', companyId).maybeSingle(),
  ])
  if (company.error) failed('company', company.error)
  if (registry.error) failed('knowledge registry', registry.error)
  if (profile.error) failed('agent profile', profile.error)
  const own = company.data as { entity_type: string | null; team_id: string | null } | null
  const [entityType, installed] = await Promise.all([
    // The form the row carries, read by the form's own rule; it reads the row itself only when the row here names none.
    resolveCompanyEntityType(supabase, companyId, own?.entity_type),
    installedItems(supabase, companyId, own?.team_id ?? null),
  ])
  const list = ((registry.data ?? []) as Array<{ id: string; tier: KnowledgeOption['tier'] }>).filter((item) => packFitsForm(item.id, entityType))
  const chosen = chosenKnowledge(profile.data as { vertical_atoms: string[] | null; modifier_atoms: string[] | null } | null, installed)
  const active = catalogueKnowledge(list)
    .filter((item) => isActiveKnowledge(item.tier, item.id, chosen))
    .map((item) => item.id)
  return { items: active.length, active }
}

// ---------------------------------------------------------------- checks

/**
 * The bank feed as the report data status reads it, over the fiscal year
 * that holds today, up to today. Null when the company has no feed, or no
 * fiscal year covers today (the status has no range to read then).
 */
async function bankFeedLine(supabase: SupabaseClient, companyId: string, today: string, now: Date): Promise<PictureCheckLine | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', today)
    .gte('period_end', today)
    .order('period_start', { ascending: false })
    .limit(1)
  if (error) failed('fiscal period', error)
  const periodId = ((data ?? []) as Array<{ id: string }>)[0]?.id
  if (!periodId) return null

  const base: PictureCheckLine = {
    id: 'bank_feed',
    check_id: 'bank_feed',
    name_sv: null,
    name_en: null,
    subject: null,
    subject_tail: null,
    status: 'unknown',
    difference: null,
    unit: null,
    things: null,
    as_of: null,
    href: null,
    reason_code: null,
  }
  const status = await buildReportDataStatus(supabase, companyId, { periodId, toDate: today, now })
  if ('unavailable' in status) return base
  if (status.bank.feed_status === null) return null
  // The status's own two answers: the feed runs, and no row the range covers is missing.
  const current = status.bank.feed_status === 'active' && !status.bank.stale
  return {
    ...base,
    status: current ? 'agrees' : 'attention',
    things: current ? null : 1,
    as_of: status.bank.last_sync_at,
    href: current ? null : BANK_FEED_HREF,
  }
}

/** The last four characters of each of the company's cash accounts, by account id. Empty when they cannot be read: the name still stands. */
async function accountTails(supabase: SupabaseClient, companyId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('cash_accounts').select('id, iban, kind, card_last4').eq('company_id', companyId)
  const tails = new Map<string, string>()
  if (error) return tails
  for (const row of (data ?? []) as Array<{ id: string; iban: string | null; kind?: string | null; card_last4?: string[] | null }>) {
    const tail = row.kind === 'card' ? (row.card_last4?.[0]?.slice(-4) ?? null) : (ibanLast4(row.iban) ?? null)
    if (tail) tails.set(row.id, tail)
  }
  return tails
}

async function loadChecks(supabase: SupabaseClient, companyId: string, ports: AgentPicturePorts, now: Date): Promise<PictureChecks | null> {
  const today = todayIsoStockholm(now)
  const ledgerRead = ports.ledgerRead ?? (<T>(read: () => Promise<T>) => read())

  const [queue, bank] = await Promise.all([
    (async () => {
      try {
        // Loaded on first use: the checks pull in the report generators.
        const unexplained = await import('@/lib/unexplained')
        const list = await ledgerRead(() => unexplained.listUnexplained({ supabase, companyId }, { today }))
        return { list, nameEn: (id: Parameters<typeof unexplained.getCheckDefinition>[0]) => unexplained.getCheckDefinition(id).name_en }
      } catch (err) {
        log.warn('unexplained queue unavailable', { companyId, reason: err instanceof Error ? err.message : String(err) })
        return null
      }
    })(),
    (async (): Promise<{ line: PictureCheckLine | null } | null> => {
      try {
        return { line: await bankFeedLine(supabase, companyId, today, now) }
      } catch (err) {
        log.warn('bank data status unavailable', { companyId, reason: err instanceof Error ? err.message : String(err) })
        return null
      }
    })(),
  ])
  if (!queue && !bank) return null

  const lines: PictureCheckLine[] = []
  const counts: Record<PictureCheckStatus, number> = { agrees: 0, attention: 0, unknown: 0 }
  // Two bank accounts can share a name: each bank account's result also carries the account's last four characters.
  const tails = queue?.list.items.some((row) => row.subject.kind === 'bank_account') ? await accountTails(supabase, companyId) : new Map<string, string>()
  if (queue) {
    counts.agrees += queue.list.counts.ok
    counts.attention += queue.list.counts.unexplained
    counts.unknown += queue.list.counts.cannot_check
    for (const row of queue.list.items) {
      const subject = row.subject.kind === 'bank_account' ? row.subject.name : row.subject.kind === 'vat_period' ? row.subject.label : null
      const subjectKey =
        row.subject.kind === 'bank_account' ? row.subject.cash_account_id : row.subject.kind === 'vat_period' ? row.subject.label : 'company'
      const attention = row.status === 'unexplained'
      lines.push({
        id: `${row.check_id}:${subjectKey}`,
        check_id: row.check_id,
        name_sv: row.name_sv,
        name_en: queue.nameEn(row.check_id),
        subject,
        subject_tail: row.subject.kind === 'bank_account' ? (tails.get(row.subject.cash_account_id) ?? null) : null,
        status: row.status === 'ok' ? 'agrees' : attention ? 'attention' : 'unknown',
        difference: attention ? row.difference : null,
        unit: row.unit,
        // A count check says how many rows; a money difference is one thing to look at.
        things: attention ? (row.unit === 'count' ? Math.max(1, Math.round(row.difference ?? 1)) : 1) : null,
        as_of: row.as_of,
        href: attention ? (row.next?.screen ?? null) : null,
        reason_code: row.status === 'cannot_check' ? row.refusal_code : null,
      })
    }
  } else {
    counts.unknown += 1
  }
  if (bank?.line) {
    counts[bank.line.status] += 1
    // What needs a look first, like the queue's own order.
    if (bank.line.status === 'attention') lines.unshift(bank.line)
    else lines.push(bank.line)
  }
  return { read_at: now.toISOString(), lines, counts, truncated: queue?.list.truncated ?? 0, queue_unavailable: !queue }
}

// ---------------------------------------------------------------- agents

/** Rows read per page of the tool call log, newest first. */
const ACTIVITY_PAGE = 200
/** Pages read at most: past it the day's counts are lower bounds. */
const ACTIVITY_MAX_PAGES = 5

/**
 * What the company's connections did: per connection, how many tool calls it
 * made today (the Stockholm calendar day) and when the last one was. Read
 * from the newest rows of the tool call log backwards, a page at a time,
 * until a page reaches before today. The log holds the tool's name and who
 * called, never the arguments or what was read. The answer also carries the
 * questions asked and the proposals prepared today, by stager, and the
 * number of remembered facts right now, so the picture's memory follows a
 * fact saved while it is open.
 *
 * Throws when the log cannot be read.
 */
export async function loadAgentActivity(supabase: SupabaseClient, companyId: string, now: Date = new Date()): Promise<PictureActivity> {
  const [calls, memoryFacts, work] = await Promise.all([
    readToolCalls(supabase, companyId, now),
    loadMemoryFacts(supabase, companyId),
    workTodayOrUnknown(supabase, companyId, now),
  ])
  return { ...calls, memory_facts: memoryFacts, work }
}

/** The actor types a connection stages a proposal as (lib/auth/api-keys.ts credentialActor). */
export const CONNECTION_ACTOR_TYPES = ['api_key', 'mcp_oauth', 'service_account'] as const
/** Proposals read for one day at most: past it the day's counts are lower bounds. */
const WORK_MAX_ROWS = 5000

/**
 * The questions asked and the proposals prepared today (the Stockholm
 * calendar day), counted by who staged them. Only who staged each row is
 * read, never what it says. A question its asker took back and a proposal a
 * newer one replaced are left out: neither is something done for the
 * company. The questions are read only where the company has the question
 * list.
 *
 * Throws when a read fails.
 */
async function readWorkToday(supabase: SupabaseClient, companyId: string, now: Date): Promise<PictureWork> {
  const dayStart = stockholmWallTimeToUtc(todayIsoStockholm(now), '00:00').toISOString()
  const [questions, proposals] = await Promise.all([
    (async (): Promise<StagerRef[]> => {
      if (!isCompanyQuestionsEnabled(companyId)) return []
      const { data, error } = await supabase
        .from('company_questions')
        .select('actor_id, actor_label')
        .eq('company_id', companyId)
        .gte('created_at', dayStart)
        .or('close_reason.is.null,close_reason.neq.withdrawn')
      if (error) failed('questions asked today', error)
      return (data ?? []) as StagerRef[]
    })(),
    fetchAllRows<StagerRef>(
      ({ from, to }) =>
        supabase
          .from('pending_operations')
          .select('actor_id, actor_label')
          .eq('company_id', companyId)
          .in('actor_type', [...CONNECTION_ACTOR_TYPES])
          .gte('created_at', dayStart)
          .or('rejection_category.is.null,rejection_category.neq.superseded')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      { maxRows: WORK_MAX_ROWS },
    ),
  ])
  return tallyWork(questions, proposals)
}

/** The day's work, or null (with a log line) when it cannot be read: the calls are still answered. */
async function workTodayOrUnknown(supabase: SupabaseClient, companyId: string, now: Date): Promise<PictureWork | null> {
  try {
    return await readWorkToday(supabase, companyId, now)
  } catch (err) {
    log.warn('work of the day unavailable', { companyId, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** The tool call log's part of the activity. Throws when the log cannot be read. */
async function readToolCalls(supabase: SupabaseClient, companyId: string, now: Date): Promise<Omit<PictureActivity, 'memory_facts' | 'work'>> {
  const day = todayIsoStockholm(now)
  const dayStart = stockholmWallTimeToUtc(day, '00:00').getTime()
  // No prototype: the key is text read from the log, and a table without one
  // holds any text as an ordinary entry.
  const actors: Record<string, PictureActorActivity> = Object.create(null) as Record<string, PictureActorActivity>
  let capped = false

  for (let page = 0; page < ACTIVITY_MAX_PAGES; page += 1) {
    const from = page * ACTIVITY_PAGE
    const { data, error } = await supabase
      .from('event_log')
      .select('created_at, actor_id:data->>actorId')
      .eq('company_id', companyId)
      .eq('event_type', 'mcp.tool_called')
      .order('sequence', { ascending: false })
      .range(from, from + ACTIVITY_PAGE - 1)
    if (error) failed('tool call log', error)
    const rows = (data ?? []) as unknown as Array<{ created_at: string; actor_id: string | null }>

    let reachedBeforeToday = rows.length < ACTIVITY_PAGE
    for (const row of rows) {
      const today = Date.parse(row.created_at) >= dayStart
      if (!today) reachedBeforeToday = true
      if (!row.actor_id) continue
      const actor = (actors[row.actor_id] ??= { calls_today: 0, last_call_at: null })
      // Newest first: the first row seen for a connection is its last call.
      if (!actor.last_call_at) actor.last_call_at = row.created_at
      if (today) actor.calls_today += 1
    }
    if (reachedBeforeToday) break
    if (page === ACTIVITY_MAX_PAGES - 1) capped = true
  }
  return { now: now.toISOString(), day, actors, capped }
}

interface KeyRow {
  id: string
  name: string
  client: string | null
  last_used_at: string | null
  created_at: string
  user_id: string
  service_account_id: string | null
  company_id: string | null
}

/**
 * The connections the API settings page lists for the company and this
 * person: the live keys homed in the company (a member reads their own, an
 * admin every member's: the table's own policy), and the person's own keys
 * homed in another company that reach this one (no company list on the key,
 * or this company on it).
 */
async function loadConnectionKeys(supabase: SupabaseClient, companyId: string, userId: string): Promise<KeyRow[]> {
  const [homed, own] = await Promise.all([
    supabase
      .from('api_keys')
      .select('id, name, client, last_used_at, created_at, user_id, service_account_id, company_id')
      .eq('company_id', companyId)
      .is('revoked_at', null),
    // The person's own connections, wherever they were made: the filter is the user.
    supabase
      .from('api_keys')
      .select('id, name, client, last_used_at, created_at, user_id, service_account_id, company_id')
      .eq('user_id', userId)
      .is('revoked_at', null),
  ])
  if (homed.error) failed('connections', homed.error)
  const here = (homed.data ?? []) as KeyRow[]
  const listed = new Set(here.map((key) => key.id))
  const elsewhere = own.error
    ? []
    : ((own.data ?? []) as KeyRow[]).filter((key) => key.company_id !== companyId && !key.service_account_id && !listed.has(key.id))
  if (elsewhere.length === 0) return here

  // A key's company list is readable with the service role only. The read is
  // keyed by the person's own key ids; without it their reach is not known
  // and they are left out.
  const { data, error } = await createServiceClient()
    .from('api_key_companies')
    .select('api_key_id, company_id')
    .in('api_key_id', elsewhere.map((key) => key.id))
  if (error) {
    log.warn('connection company lists unavailable', { companyId, reason: error.message })
    return here
  }
  const lists = new Map<string, string[]>()
  for (const row of (data ?? []) as Array<{ api_key_id: string; company_id: string }>) {
    lists.set(row.api_key_id, [...(lists.get(row.api_key_id) ?? []), row.company_id])
  }
  return [...here, ...elsewhere.filter((key) => allowlistReachesCompany(lists.get(key.id), companyId))]
}

/** Ids per read of a list keyed by ids. */
const ID_CHUNK = 150

/**
 * How many live connections reach the company beyond the ones the person
 * may list (`listed`, by key id): other people's sign-ins and keys, and the
 * service-account keys the person cannot read. The answer is a number and
 * nothing else: no name, no owner, no key leaves this function.
 *
 * Read with the service role, since the person's own access shows only
 * their own connections, or for an owner or admin the ones homed in the
 * company. Each read is keyed by the company: its members, the live keys of
 * those members, its service accounts' live keys, and the company lists of
 * the members' keys. Only key ids are read.
 *
 * A person's key reaches the company when its user is a member of it and the
 * key's company list lets it in (lib/auth/api-keys.ts
 * allowlistReachesCompany, the rule the listed connections are read by). A
 * service account's key reaches its own company alone. Live is not revoked,
 * as for the listed connections.
 *
 * Throws when a read fails.
 */
async function countOtherConnections(companyId: string, listed: ReadonlySet<string>): Promise<number> {
  const service = createServiceClient()
  const [members, accountKeys] = await Promise.all([
    service.from('company_members').select('user_id').eq('company_id', companyId),
    service.from('api_keys').select('id').eq('company_id', companyId).not('service_account_id', 'is', null).is('revoked_at', null),
  ])
  if (members.error) failed('company members', members.error)
  if (accountKeys.error) failed('service account connections', accountKeys.error)
  const ofAccounts = ((accountKeys.data ?? []) as Array<{ id: string }>).filter((key) => !listed.has(key.id)).length
  const memberIds = [...new Set(((members.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id))]

  // The members' own keys, wherever they were made: the filter is the company's members.
  const candidates: string[] = []
  for (const ids of chunk(memberIds, ID_CHUNK)) {
    const rows = await fetchAllRows<{ id: string }>(({ from, to }) =>
      service.from('api_keys').select('id').in('user_id', ids).is('service_account_id', null).is('revoked_at', null).order('id', { ascending: true }).range(from, to),
    )
    for (const row of rows) if (!listed.has(row.id)) candidates.push(row.id)
  }
  if (candidates.length === 0) return ofAccounts

  const lists = new Map<string, string[]>()
  for (const ids of chunk(candidates, ID_CHUNK)) {
    const rows = await fetchAllRows<{ api_key_id: string; company_id: string }>(({ from, to }) =>
      service.from('api_key_companies').select('api_key_id, company_id').in('api_key_id', ids).order('api_key_id', { ascending: true }).order('company_id', { ascending: true }).range(from, to),
    )
    for (const row of rows) lists.set(row.api_key_id, [...(lists.get(row.api_key_id) ?? []), row.company_id])
  }
  return ofAccounts + candidates.filter((id) => allowlistReachesCompany(lists.get(id), companyId)).length
}


/**
 * The names of the company's service accounts that hold a listed key, read
 * with the service role as the API settings page reads them (every member
 * who sees the key sees whose it is). Empty when they cannot be read.
 */
async function serviceAccountNames(companyId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (ids.length === 0) return names
  const { data, error } = await createServiceClient().from('service_accounts').select('id, name').eq('company_id', companyId).in('id', ids)
  if (error) {
    log.warn('service account names unavailable', { companyId, reason: error.message })
    return names
  }
  for (const row of (data ?? []) as Array<{ id: string; name: string }>) names.set(row.id, row.name)
  return names
}

/**
 * The names of the other people whose connections are listed, by user id:
 * full name, else e-mail, as the API settings page says whose a colleague's
 * sign-in is. Read with the service role, keyed by the owners of keys the
 * person's own access already listed. Empty when they cannot be read.
 */
async function ownerNames(companyId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (userIds.length === 0) return names
  // People, not company rows: the filter is their ids.
  const { data, error } = await createServiceClient().from('profiles').select('id, full_name, email').in('id', userIds)
  if (error) {
    log.warn('connection owner names unavailable', { companyId, reason: error.message })
    return names
  }
  for (const row of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    const name = row.full_name?.trim() || row.email
    if (name) names.set(row.id, name)
  }
  return names
}

/** A connection as it is read: what the picture shows of it, and what puts it on a card. */
type ReadConnection = PictureAgent & CardConnection

/**
 * The company's connections as the person may list them (`keyRows`,
 * loadConnectionKeys), the ones that worked last first, each with the calls
 * `toolCalls` holds for it (the log is read beside the reads here). Throws
 * when the connections cannot be read.
 */
async function readConnections(
  companyId: string,
  userId: string,
  keyRows: Promise<KeyRow[]>,
  toolCalls: Promise<Omit<PictureActivity, 'memory_facts' | 'work'> | null>,
): Promise<ReadConnection[]> {
  const keys = await keyRows

  const partnerSlugs = keys.map((key) => partnerSlugOf(key.client)).filter((slug): slug is string => slug !== null)
  const accountIds = [...new Set(keys.map((key) => key.service_account_id).filter((id): id is string => id !== null))]
  const colleagueIds = [...new Set(keys.filter((key) => key.user_id !== userId && !key.service_account_id).map((key) => key.user_id))]
  const [partnerNames, accountNames, owners, activity] = await Promise.all([
    partnerSlugs.length > 0 ? partnerClientNames(createServiceClient(), partnerSlugs) : new Map<string, string>(),
    serviceAccountNames(companyId, accountIds),
    ownerNames(companyId, colleagueIds),
    toolCalls,
  ])

  const connections = keys.map((key): ReadConnection => {
    const partnerSlug = partnerSlugOf(key.client)
    const partnerName = partnerNames.get(partnerSlug ?? '') ?? null
    // Who a key is comes from its one definition (credentialActor): a key the sign-in minted is a client.
    const actor = credentialActor({
      apiKeyName: key.name,
      client: key.client,
      clientName: partnerName,
      serviceAccount: key.service_account_id ? { id: key.service_account_id, name: accountNames.get(key.service_account_id) ?? key.name } : null,
    })
    const kind = connectionKind({ source: actor.type === 'mcp_oauth' ? 'signin' : 'manual', client: key.client })
    // What the key's records call it. Not known for an account or a partner whose name could
    // not be read, nor for a client that registered itself (its name is read when it calls).
    const labelKnown = key.service_account_id
      ? accountNames.has(key.service_account_id)
      : partnerSlug
        ? partnerName !== null
        : !key.client?.startsWith('registered:')
    const seen = activity?.actors[key.id]
    return {
      id: key.id,
      kind,
      name: kind === 'key' ? key.name : kind === 'partner' ? partnerName : null,
      // Without the account's name the key's own stands in: the connection is still the account's.
      service_account: key.service_account_id ? (accountNames.get(key.service_account_id) ?? key.name) : null,
      service_account_id: key.service_account_id,
      label: labelKnown ? actor.label : null,
      last_used_at: key.last_used_at,
      calls_today: seen?.calls_today ?? 0,
      last_call_at: seen?.last_call_at ?? null,
      connected_at: key.created_at,
      is_own: key.user_id === userId,
      owner_name: key.user_id === userId || key.service_account_id ? null : (owners.get(key.user_id) ?? null),
    }
  })
  // The ones that worked last come first.
  const latest = (agent: PictureAgent) => Date.parse(agent.last_call_at ?? agent.last_used_at ?? '') || 0
  return connections.sort((a, b) => latest(b) - latest(a))
}

/** A connection as the picture hands it out: without what only put it on its card. */
function shownConnection({ service_account_id: _accountId, label: _label, ...connection }: ReadConnection): PictureAgent {
  return connection
}

/**
 * Every card of the company's connections as the person may list them: the
 * ones the picture lists and the ones past them. The tool call log is not
 * read, so a connection's calls are 0 here. Throws when the connections
 * cannot be read.
 */
export async function loadAgentCards(supabase: SupabaseClient, companyId: string, userId: string): Promise<PictureAgentCard[]> {
  const connections = await readConnections(companyId, userId, loadConnectionKeys(supabase, companyId, userId), Promise.resolve(null))
  return agentCards(connections).map((card): PictureAgentCard => ({ ...card, connections: card.connections.map(shownConnection) }))
}

/** The cards with their tool calls and the day's work; the picture adds the memory count it reads in its own part. */
type AgentsRead = Omit<PictureAgents, 'activity'> & { activity: Omit<PictureActivity, 'memory_facts'> | null }

async function loadAgents(supabase: SupabaseClient, companyId: string, userId: string, now: Date): Promise<AgentsRead> {
  const toolCalls = readToolCalls(supabase, companyId, now).catch((err: unknown) => {
    log.warn('tool call log unavailable', { companyId, reason: err instanceof Error ? err.message : String(err) })
    return null
  })
  // The connections the person may list, read once: the cards are made of them, and the count of the others leaves them out.
  const keys = loadConnectionKeys(supabase, companyId, userId)
  const [connections, calls, work, others] = await Promise.all([
    readConnections(companyId, userId, keys, toolCalls),
    toolCalls,
    workTodayOrUnknown(supabase, companyId, now),
    // Unknown (null) when it fails or runs out of time: the listed connections are still answered.
    within('other connections', companyId, OTHERS_DEADLINE_MS, async () => countOtherConnections(companyId, new Set((await keys).map((key) => key.id)))),
  ])
  // One card per product (agent-cards.ts), in the order of each card's newest connection.
  const cards = agentCards(connections).map((card): PictureAgentCard => ({ ...card, connections: card.connections.map(shownConnection) }))
  return { list: cards.slice(0, MAX_AGENTS), more: Math.max(0, cards.length - MAX_AGENTS), others, activity: calls && { ...calls, work } }
}

// ---------------------------------------------------------------- the picture

/**
 * The picture for one company and the signed-in person. Never throws: each
 * part that cannot be read is unknown in the answer.
 */
export async function loadAgentPicture(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  ports: AgentPicturePorts = {},
  now: Date = new Date(),
): Promise<AgentPicture> {
  const part = <T>(name: string, read: () => Promise<T>, ms = PART_DEADLINE_MS) => within(name, companyId, ms, read)

  const [sources, name, waiting, counts, memoryFacts, knowledge, checks, agents] = await Promise.all([
    loadSources(supabase, companyId, userId, ports, now),
    part('company', async () => ({ name: await loadCompanyName(supabase, companyId) })),
    // Not counted without the door's counters: nothing is said about what waits.
    part('waiting', async () => (ports.waiting ? await ports.waiting() : null)),
    part('counts', () => loadCounts(supabase, companyId)),
    part('memory', async () => ({ facts: await loadMemoryFacts(supabase, companyId) })),
    part('knowledge', () => loadKnowledge(supabase, companyId)),
    part('checks', async () => ({ checks: await loadChecks(supabase, companyId, ports, now) }), CHECKS_DEADLINE_MS),
    part('agents', () => loadAgents(supabase, companyId, userId, now)),
  ])

  return {
    generated_at: now.toISOString(),
    sources,
    company: {
      name: name?.name ?? null,
      waiting: waiting ?? null,
      counts: counts ?? NO_COUNTS,
      memory_facts: memoryFacts?.facts ?? null,
      knowledge: { items: knowledge?.items ?? null, active: knowledge?.active ?? null },
      checks: checks?.checks ?? null,
    },
    agents: agents && { ...agents, activity: agents.activity && { ...agents.activity, memory_facts: memoryFacts?.facts ?? null } },
  }
}
