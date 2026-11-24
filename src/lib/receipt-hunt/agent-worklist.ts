/**
 * Kvittojakten for a connected agent: what is missing an underlag, shaped so
 * an agent with its own mail connector can go and find it.
 *
 * The built-in hunt (hunt.ts) searches the mailbox Accounted is connected to.
 * This is the other engine for the same job: the user's own agent (Claude,
 * ChatGPT, Grok) searches through ITS mail connector, and this module only
 * tells it what to look for. Nothing here reads mail or writes anything.
 *
 * Two sources, one list:
 *  - posted verifikat without underlag (the verifikat_without_documents RPC,
 *    the same truth as the Att göra row), enriched with the supplier invoice
 *    or bank transaction behind the verifikat so there is a name to search on;
 *  - unbooked purchases without a receipt: every outflow the Underlag page
 *    lists (purchases-without-underlag.ts), whatever its amount or currency,
 *    so the agent and the page never disagree about what is missing. Not the
 *    built-in hunt's candidates: the hunt reads the same view behind a 100 kr
 *    floor, a cost bound on Accounted's own mail search and model call. An
 *    agent searches through its own connector, so the floor only hid work,
 *    and it compared kronor with a USD or EUR row's own amount, which dropped
 *    nearly every card row on a foreign-currency account (crm#1785).
 *
 * A supplier invoice without a document is not a third source: it surfaces as
 * its registration verifikat, which is where its underlag has to land.
 */
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { booksPurchase, movesOnlyBetweenOwnAccounts, type PlausibilityLine } from '@/lib/bookkeeping/voucher-plausibility'
import { resolveInboxAddress } from '@/lib/documents/inbox-address'
import { resolvePortal, type CompanyPortal } from './company-portals'
import { fetchPurchasesWithoutUnderlag } from './purchases-without-underlag'
import { readCompanyPortals } from './company-portals-read'
import { FETCH_DATE_WINDOW_DAYS, canHaveEmailReceipt } from './select'
import { resolveUnderlagElsewhere, type UnderlagElsewhere } from './underlag-elsewhere'

export type AgentWorklistKind = 'verifikat' | 'transaction'

export interface AgentWorklistItem {
  kind: AgentWorklistKind
  /** Set for kind 'verifikat': the target of gnubok_link_document_to_voucher. */
  journal_entry_id: string | null
  /** Set for kind 'transaction': the target of gnubok_attach_document_to_transaction. */
  transaction_id: string | null
  /** "A217" for a verifikat, null for an unbooked transaction. */
  voucher: string | null
  date: string
  /** Positive, in `currency`. */
  amount: number
  currency: string
  /** Best available name to search mail for; null when only `description` exists. */
  counterparty: string | null
  description: string | null
  /** Supplier's own invoice number when the verifikat registers a supplier invoice. */
  invoice_number: string | null
  /** Mail is worth searching from `search_from` to `search_to` (inclusive). */
  search_from: string
  search_to: string
  /**
   * False for rows that never have a mailed receipt (salary, tax, bank fees,
   * Stripe's rows), for verifikat that bought nothing (money in, a share
   * issue) and for verifikat imported from earlier books: the agent skips the
   * mail search and reports them as needing a human. A transfer between the
   * company's own accounts is not on the list at all: the bank statement is
   * its underlag.
   */
  mail_searchable: boolean
  /** Where the invoice lives when the vendor does not mail it. */
  portal: { vendor: string; url: string; note: string | null } | null
  /**
   * The card charge may exceed the receipt total: a restaurant bill is signed
   * for with a tip the printed kvitto never shows. An agent comparing amounts
   * strictly calls that a mismatch, which is what happened to the restaurant
   * rows in the first trial run.
   */
  tip_possible: boolean
  /**
   * One sentence in Swedish, naming one place and one action, for the human
   * who has to fetch this underlag themselves. Written for the person, not the
   * agent: the agent repeats it verbatim when it comes up empty, and the app
   * can render it on the Att göra row. It says where the receipt is, never
   * what was tried.
   */
  next_step: string
  /**
   * Set when the verifikat pays an invoice whose underlag is already on the
   * invoice's own verifikat: stage `document_id` on this one with copy: true
   * instead of searching mail. A mail search only finds the same invoice
   * again (crm#1584). Null otherwise, and always for a transaction.
   */
  underlag_on: UnderlagElsewhere | null
}

export interface AgentWorklist {
  items: AgentWorklistItem[]
  total_count: number
  /** The company's inbox address: mail forwarded here becomes an inbox document. Null when not provisioned. */
  inbox_address: string | null
  /** Pass as `offset` for the next page. Absent on the last page. */
  next_offset?: number
}

/** Verifikat already carrying a staged or settled link are not asked about twice. */
const CLAIMED_STATUSES = ['pending', 'committing', 'committed'] as const
const LINK_OPERATION_TYPES = [
  'link_document_to_voucher',
  'link_documents_to_vouchers',
  'attach_document_to_transaction',
] as const
const LOOKUP_CHUNK = 150
const MAX_ITEMS = 100
/** verifikat_without_documents returns at most this many rows per call. */
const VERIFIKAT_PAGE = 100
/**
 * How many verifikat (most recent first, the RPC's order) the list is ranked
 * over. Fixed, never derived from `offset`: a window that grew with the page
 * would re-rank, and page two would repeat or skip items of page one. It used
 * to be one RPC page, so a second round of the hunt could only re-request the
 * same top 100 (agent feedback seq 957595). Also the most verifikat the VAT
 * close check classifies (MissingUnderlagErrands.maxRows).
 */
export const VERIFIKAT_WINDOW = 500

/**
 * How far back an invoice settled by bankgiro, plusgiro or OCR is worth
 * searching for. The payment happens on the due date; the invoice that backs
 * it was mailed when it was issued, which is a month or more earlier, so the
 * symmetric ±10-day window around the payment misses it entirely. Three such
 * rows (a supplier invoice, a subscription and a legal fee) were reported as
 * "not in mail" in the first trial run while the invoices sat in the mailbox.
 */
const INVOICE_DAYS_BEFORE = 45

/** A payment that settles an invoice rather than buying something on the spot. */
const INVOICE_DESCRIPTOR = /bankgiro|plusgiro|\bbg\b|\bpg\b|\bocr\b|faktura|invoice/i

/** Places where the card charge is the bill plus a tip. */
const TIP_DESCRIPTOR =
  /restaurang|restaurant|\brest\b|bistro|brasserie|pizzeria|sushi|kebab|krog|\bbar\b|cafe|café|\bkafe\b|deli|matsal/i

/**
 * Chains that send their receipt to Kivra instead of mailing it. A mail search
 * for these is wasted: the receipt exists, just not in any inbox.
 */
const KIVRA_DESCRIPTOR =
  /\bica\b|\bcoop\b|apotek|\bjula\b|kjell|rusta|stadium|åhléns|ahlens|systembolaget|willys|hemköp|clas ohlson/i

/** Bought in person, so the receipt is usually paper or in the vendor's app. */
const IN_PERSON_DESCRIPTOR =
  /parkering|easypark|parkster|circle k|preem|okq8|\bshell\b|\bst1\b|\btaxi\b|uber|pressbyrån|7-eleven|zettle|izettle/i

/**
 * A payment provider's own rows on its statement, which bought nothing: Wise
 * books its charge for a card payment, transfer or conversion as a row of its
 * own ("FEE-CARD-... Wise Charges for: CARD-..."), and a move between the
 * company's currency balances as another ("BALANCE-... Converted 100.00 EUR
 * to 1,100.00 SEK"). The underlag is the provider's statement. Read on the
 * bank row's own description: a fee on a transfer carries the payee of the
 * transfer as its merchant name. With no amount floor these small rows reach
 * the worklist, and a mail search for them can only come back empty.
 */
const PROVIDER_OWN_ROW = /^(?:FEE-(?:CARD|TRANSFER|BALANCE)-\d+|BALANCE-\d+\s+Converted\b)/i

/**
 * transactions.import_source of the Stripe feed, which brings the Stripe
 * balance in as a bank account (stripe/lib/transaction-sync.ts,
 * STRIPE_IMPORT_SOURCE; a test there keeps the two equal). Every outflow on
 * it is Stripe's own row: its fee on each payment ("Stripe-avgift
 * (Stripe-betalning <payer>)", the payer being the company's customer), its
 * usage fees, automatic tax, a refund to a buyer, a payout to the bank. No
 * mailbox holds a receipt for one: Stripe bills its fees on a monthly invoice,
 * and the rest is on its balance report. Read on the row's source, never its
 * words: a card purchase paid through Stripe at another merchant
 * ("STRIPE* ...") on the bank account has a receipt of its own.
 */
export const STRIPE_FEED_IMPORT_SOURCE = 'stripe'

/** As much of a posted verifikat's line as the classifier reads. */
export type BookedLine = Pick<PlausibilityLine, 'account_number' | 'debit_amount'>

interface VerifikatRow {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number
  entry_date: string
  description: string
  source_type: string
  gross_amount: number
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Which errand a missing underlag actually needs, from its descriptor and,
 * for a posted verifikat, the accounts it books on.
 *
 * Ordered by how a receipt reaches a Swedish company: a vendor that withholds
 * its invoice behind a login, a chain that sends to Kivra, a counter purchase
 * that only exists on paper, and otherwise the mailbox. Before all of them,
 * what has no receipt at all: salary and tax, and a verifikat that bought
 * nothing. Before those, what is not a receipt errand: a row of the Stripe
 * feed, or a verifikat booked from one, whose underlag is Stripe's invoice
 * or report (stripe), and a transfer between the company's own accounts,
 * whose underlag is the bank statement, so nothing is missing (own_transfer).
 * First of all, a verifikat imported from earlier books: its underlag is
 * where those books were kept (the previous system, the byrå or paper), so
 * the errand is to confirm that, not to search (crm#1582).
 *
 * Exported because this is derived, never stored: the app can classify the
 * rows it already has without an agent having run, and the agent's sentence
 * and the app's summary then say the same thing by construction.
 */
export type NextStepKind = 'imported' | 'not_mail' | 'no_purchase' | 'stripe' | 'own_transfer' | 'portal' | 'kivra' | 'paper' | 'mail'

/**
 * `companyPortals` are the company's own (public.company_portals); without
 * them only the portal directory says where an invoice waits behind a login.
 *
 * `lines` are a posted verifikat's; absent for an unbooked bank row, which has
 * only its words. They catch what no word does: a verifikat that bought
 * nothing (booksPurchase), such as a share issue or a sales
 * samlingsverifikat, and among those a transfer between the company's own
 * accounts (movesOnlyBetweenOwnAccounts), which needs nothing beyond the bank
 * statement. In a trial run (2026-10-28) those, sorted largest first, filled
 * the whole first page of a mail search. A transfer is read before the words,
 * whatever it is called; otherwise the words go first: a tax payment says so,
 * and the sentence for it names the skattekonto.
 *
 * `sourceType` is a posted verifikat's journal_entries.source_type: 'import'
 * (SIE) wins over every word, since even an imported salary verifikat has its
 * lönespecifikation in the earlier books, not in a mailbox.
 *
 * `importSource` is the feed of the bank row (transactions.import_source): an
 * unbooked row's own, or for a posted verifikat STRIPE_FEED_IMPORT_SOURCE
 * when a row of the Stripe feed is booked on it, so the day's sales
 * samlingsverifikat reads as Stripe's errand like its rows did.
 */
export function nextStepKind(
  descriptor: string | null,
  companyPortals: readonly CompanyPortal[] = [],
  lines?: readonly BookedLine[],
  sourceType?: string | null,
  importSource?: string | null,
): NextStepKind {
  if (sourceType === 'import') return 'imported'
  if (importSource === STRIPE_FEED_IMPORT_SOURCE) return 'stripe'
  if (lines && movesOnlyBetweenOwnAccounts(lines)) return 'own_transfer'
  if (!canHaveEmailReceipt(descriptor)) return 'not_mail'
  if (lines && !booksPurchase(lines)) return 'no_purchase'
  if (resolvePortal(companyPortals, descriptor)) return 'portal'
  if (KIVRA_DESCRIPTOR.test(descriptor ?? '')) return 'kivra'
  if (TIP_DESCRIPTOR.test(descriptor ?? '') || IN_PERSON_DESCRIPTOR.test(descriptor ?? '')) return 'paper'
  return 'mail'
}

/**
 * The "Inget underlag krävs" reason for an imported verifikat whose underlag
 * stays where the earlier books were kept. BFL 7 kap asks that the underlag is
 * kept, readable and producible for seven years, not that it moves into the
 * system the books moved to.
 */
export const UNDERLAG_ARCHIVED_ELSEWHERE_REASON = 'Underlag arkiverat utanför Accounted (tidigare system eller papper)'

/**
 * What to tell the person when the agent cannot fetch this one: one sentence,
 * one place, one action. Never mentions searching, agents or what failed. By
 * the time this is read, the reader only wants the errand.
 */
function nextStep(kind: NextStepKind, portal: AgentWorklistItem['portal']): string {
  switch (kind) {
    case 'imported':
      // The reason is the one the waiver dialogs suggest
      // (journal_list.no_doc_required_suggestion_archived_elsewhere).
      return `Importerat verifikat: underlaget finns där bokföringen fördes tidigare. Ligger det kvar där, markera det Inget underlag krävs med orsaken "${UNDERLAG_ARCHIVED_ELSEWHERE_REASON}".`
    case 'own_transfer':
      return 'Överföring mellan egna konton: kontoutdraget är underlaget, så det finns inget att hämta.'
    case 'not_mail':
      return 'Hämtas inte ur mejlen: underlaget är lönespecifikationen, skattekontot eller kontoutdraget.'
    case 'no_purchase':
      return 'Inget inköp, så inget kvitto: underlaget är kontoutdraget eller betalleverantörens rapport.'
    case 'stripe':
      return 'Logga in på Stripe och ladda ner underlaget: månadsfakturan för Stripes avgifter, saldorapporten för övriga rader.'
    case 'portal':
      return `Logga in på ${portal?.vendor ?? 'leverantören'} och ladda ner fakturan: ${portal?.url ?? ''}`.trim()
    case 'kivra':
      return 'Kvittot ligger troligen i Kivra: öppna det, tryck Dela och välj Accounted.'
    case 'paper':
      return 'Papperskvitto: fota det med mobilen och skicka det till kvittoadressen.'
    case 'mail':
      return 'Leta i mejlen och vidarebefordra kvittot till kvittoadressen.'
  }
}

function withSearchHints(
  base: Omit<
    AgentWorklistItem,
    'search_from' | 'search_to' | 'mail_searchable' | 'portal' | 'tip_possible' | 'next_step' | 'underlag_on'
  >,
  companyPortals: readonly CompanyPortal[],
  lines?: readonly BookedLine[],
  underlagOn: UnderlagElsewhere | null = null,
  sourceType?: string | null,
  importSource?: string | null,
): AgentWorklistItem {
  const descriptor = base.counterparty ?? base.description
  // A payment that settles an invoice opens the window earlier: the invoice was
  // mailed when it was issued, the payment happens on the due date. The window
  // never closes later, because a document dated well after the charge belongs
  // to the next period, not this purchase.
  const settlesInvoice = Boolean(base.invoice_number) || INVOICE_DESCRIPTOR.test(descriptor ?? '')
  const searchWindow = {
    search_from: shiftDate(base.date, -(settlesInvoice ? INVOICE_DAYS_BEFORE : FETCH_DATE_WINDOW_DAYS)),
    search_to: shiftDate(base.date, FETCH_DATE_WINDOW_DAYS),
  }
  // The invoice is already in the books: the errand is a copy, not a search.
  if (underlagOn) {
    return {
      ...base,
      ...searchWindow,
      mail_searchable: false,
      portal: null,
      tip_possible: false,
      next_step: `Fakturan finns redan på ${underlagOn.voucher} (${underlagOn.entry_date}): koppla en kopia av den till det här verifikatet.`,
      underlag_on: underlagOn,
    }
  }
  // An unbooked bank row has no lines to say it bought nothing, only its words
  // and the feed it came from (nextStepKind reads the Stripe feed first).
  const kind: NextStepKind =
    base.kind === 'transaction' && importSource !== STRIPE_FEED_IMPORT_SOURCE && PROVIDER_OWN_ROW.test(base.description ?? '')
      ? 'no_purchase'
      : nextStepKind(descriptor, companyPortals, lines, sourceType, importSource)
  const mailSearchable =
    kind !== 'imported' && kind !== 'not_mail' && kind !== 'no_purchase' && kind !== 'stripe' && kind !== 'own_transfer'
  // The company's own portal for the supplier first, then the directory's.
  const portal = mailSearchable ? resolvePortal(companyPortals, descriptor) : null
  const portalHint = portal ? { vendor: portal.vendor, url: portal.url, note: portal.note } : null
  return {
    ...base,
    ...searchWindow,
    mail_searchable: mailSearchable,
    portal: portalHint,
    tip_possible: TIP_DESCRIPTOR.test(descriptor ?? ''),
    next_step: nextStep(kind, portalHint),
    underlag_on: null,
  }
}

async function fetchClaimedTargets(supabase: SupabaseClient, companyId: string) {
  const rows = await fetchAllRows<{
    params: {
      journal_entry_id?: string
      transaction_id?: string
      /** link_documents_to_vouchers: N links staged as one operation. */
      links?: { journal_entry_id?: string }[]
    } | null
  }>((range) =>
    supabase
      .from('pending_operations')
      .select('params')
      .eq('company_id', companyId)
      .in('operation_type', [...LINK_OPERATION_TYPES])
      .in('status', [...CLAIMED_STATUSES])
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  const journalEntryIds = new Set<string>()
  const transactionIds = new Set<string>()
  for (const row of rows) {
    if (row.params?.journal_entry_id) journalEntryIds.add(row.params.journal_entry_id)
    if (row.params?.transaction_id) transactionIds.add(row.params.transaction_id)
    for (const link of row.params?.links ?? []) {
      if (link.journal_entry_id) journalEntryIds.add(link.journal_entry_id)
    }
  }
  return { journalEntryIds, transactionIds }
}

interface VerifikatContext {
  counterparty: string | null
  invoice_number: string | null
  amount: number | null
  currency: string | null
}

/** A voucher link (samlingsverifikat, split) with the feed of its bank row. */
type FeedLinkRow = { journal_entry_id: string; tx: { import_source: string | null } | null }

/**
 * Who the verifikat is about: the supplier invoice it registers, else the bank
 * row it books. Beside it, which verifikat have a row of the Stripe feed
 * booked on them: through the row's own pointer, or through a voucher link,
 * the only anchor of a samlingsverifikat's rows.
 */
async function fetchVerifikatContext(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
): Promise<{ context: Map<string, VerifikatContext>; stripeFed: Set<string> }> {
  const context = new Map<string, VerifikatContext>()
  const stripeFed = new Set<string>()
  for (let i = 0; i < journalEntryIds.length; i += LOOKUP_CHUNK) {
    const chunk = journalEntryIds.slice(i, i + LOOKUP_CHUNK)
    const [siRes, txRes, stripeLinks] = await Promise.all([
      supabase
        .from('supplier_invoices')
        .select('registration_journal_entry_id, supplier_invoice_number, total, currency, supplier:suppliers(name)')
        .eq('company_id', companyId)
        .in('registration_journal_entry_id', chunk),
      supabase
        .from('transactions')
        .select('journal_entry_id, merchant_name, amount, currency, import_source')
        .eq('company_id', companyId)
        .in('journal_entry_id', chunk),
      fetchAllRows<FeedLinkRow>((range) =>
        supabase
          .from('transaction_voucher_links')
          .select('journal_entry_id, tx:transactions!inner(import_source)')
          .eq('company_id', companyId)
          .eq('tx.import_source', STRIPE_FEED_IMPORT_SOURCE)
          .in('journal_entry_id', chunk)
          .order('id', { ascending: true })
          .range(range.from, range.to) as unknown as PromiseLike<{ data: FeedLinkRow[] | null; error: { message: string } | null }>,
      ),
    ])
    if (siRes.error) throw new Error(`supplier_invoices lookup failed: ${siRes.error.message}`)
    if (txRes.error) throw new Error(`transactions lookup failed: ${txRes.error.message}`)
    for (const link of stripeLinks) {
      if (link.tx?.import_source === STRIPE_FEED_IMPORT_SOURCE) stripeFed.add(link.journal_entry_id)
    }

    // Bank rows first so a supplier invoice, which names the supplier and the
    // invoice number, overwrites the thinner bank descriptor.
    for (const r of (txRes.data ?? []) as {
      journal_entry_id: string
      merchant_name: string | null
      amount: number
      currency: string | null
      import_source?: string | null
    }[]) {
      if (r.import_source === STRIPE_FEED_IMPORT_SOURCE) stripeFed.add(r.journal_entry_id)
      context.set(r.journal_entry_id, {
        counterparty: r.merchant_name,
        invoice_number: null,
        amount: Math.abs(r.amount),
        currency: r.currency,
      })
    }
    for (const r of (siRes.data ?? []) as unknown as {
      registration_journal_entry_id: string
      supplier_invoice_number: string | null
      total: number
      currency: string | null
      supplier: { name: string | null } | null
    }[]) {
      context.set(r.registration_journal_entry_id, {
        counterparty: r.supplier?.name ?? null,
        invoice_number: r.supplier_invoice_number,
        amount: r.total,
        currency: r.currency,
      })
    }
  }
  return { context, stripeFed }
}

/** Who each verifikat is about and what it booked: what its errand is read on. */
async function fetchVerifikatFacts(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
): Promise<{
  context: Map<string, VerifikatContext>
  linesByEntry: Map<string, PlausibilityLine[]>
  /** The feed (import_source) to read each verifikat's errand on: the Stripe feed's, or null. */
  feedOf: (journalEntryId: string) => string | null
}> {
  const [{ context, stripeFed }, lines] = await Promise.all([
    fetchVerifikatContext(supabase, companyId, journalEntryIds),
    // What each verifikat booked: whether it bought anything at all, and
    // whether it pays an invoice (the credit side of kundfordringar).
    fetchLinesByEntryIds<PlausibilityLine & { id: string; journal_entry_id: string }>(
      supabase,
      journalEntryIds,
      'account_number, debit_amount, credit_amount',
    ),
  ])
  const linesByEntry = new Map<string, PlausibilityLine[]>()
  for (const line of lines) {
    const entryLines = linesByEntry.get(line.journal_entry_id)
    if (entryLines) entryLines.push(line)
    else linesByEntry.set(line.journal_entry_id, [line])
  }
  const feedOf = (journalEntryId: string) => (stripeFed.has(journalEntryId) ? STRIPE_FEED_IMPORT_SOURCE : null)
  return { context, linesByEntry, feedOf }
}

/** As much of a verifikat_without_documents row as its errand is read on. */
export interface VerifikatErrandRow {
  journal_entry_id: string
  description: string | null
  source_type?: string | null
}

/**
 * The errand (nextStepKind) of each verifikat without underlag, read on what
 * the worklist reads a verifikat on: the name of the supplier invoice or bank
 * row behind it, the feed of that row, its lines, its source type and the
 * company's own portals.
 * For readers that hold the RPC's rows rather than the worklist (the
 * missing-underlag list, the VAT close check), so one verifikat reads as the
 * same errand everywhere. Throws on a failed read.
 */
export async function verifikatNextStepKinds(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly VerifikatErrandRow[],
): Promise<Map<string, NextStepKind>> {
  const kinds = new Map<string, NextStepKind>()
  if (rows.length === 0) return kinds
  const [{ context, linesByEntry, feedOf }, companyPortals] = await Promise.all([
    fetchVerifikatFacts(supabase, companyId, [...new Set(rows.map((r) => r.journal_entry_id))]),
    readCompanyPortals(supabase, companyId),
  ])
  for (const row of rows) {
    const id = row.journal_entry_id
    const descriptor = context.get(id)?.counterparty ?? row.description
    kinds.set(id, nextStepKind(descriptor, companyPortals, linesByEntry.get(id), row.source_type, feedOf(id)))
  }
  return kinds
}

/**
 * The agent's worklist: unbooked bank purchases first, then posted verifikat,
 * largest amount first within each. A receipt found before booking lets the
 * purchase be booked from it; a posted verifikat only gains a link. Within a
 * kind the biggest gaps in the räkenskapsinformation are worth a mail search
 * first, the order the built-in hunt drains its queue in.
 */
const kindRank = (kind: AgentWorklistKind) => (kind === 'transaction' ? 0 : 1)

/** The ranking window of verifikat without underlag, paged through the RPC's own cap. */
async function fetchVerifikatWindow(
  supabase: SupabaseClient,
  companyId: string,
  since: string | null,
  until: string | null,
): Promise<{ rows: VerifikatRow[]; total: number }> {
  const rows: VerifikatRow[] = []
  let total = 0
  for (let offset = 0; offset < VERIFIKAT_WINDOW; offset += VERIFIKAT_PAGE) {
    // p_until (inclusive) goes only with an until, as in
    // gnubok_list_verifikat_without_documents.
    const { data, error } = await supabase.rpc('verifikat_without_documents', {
      p_company_id: companyId,
      p_since: since,
      p_min_amount: 0,
      p_limit: VERIFIKAT_PAGE,
      p_offset: offset,
      ...(until ? { p_until: until } : {}),
    })
    if (error) throw new Error(`verifikat_without_documents failed: ${error.message}`)
    const result = data as {
      ok?: boolean
      code?: string
      total_count?: number
      verifikat?: VerifikatRow[]
    } | null
    if (!result?.ok) {
      throw new Error(`verifikat_without_documents failed: ${result?.code ?? 'unknown error'}`)
    }
    total = result.total_count ?? 0
    const page = result.verifikat ?? []
    rows.push(...page)
    if (page.length < VERIFIKAT_PAGE || rows.length >= total) break
  }
  return { rows, total }
}

export async function resolveAgentWorklist(
  supabase: SupabaseClient,
  companyId: string,
  /** `since` and `until` are ISO dates, both inclusive, applied to both sources. */
  opts: { limit?: number; offset?: number; since?: string | null; until?: string | null } = {},
): Promise<AgentWorklist> {
  const limit = Math.min(Math.max(1, opts.limit ?? 25), MAX_ITEMS)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const since = opts.since ?? null
  const until = opts.until ?? null

  const [verifikatWindow, transactions, claimed, inboxAddress, companyPortals] = await Promise.all([
    fetchVerifikatWindow(supabase, companyId, since, until),
    fetchPurchasesWithoutUnderlag(supabase, companyId),
    fetchClaimedTargets(supabase, companyId),
    resolveInboxAddress(supabase, companyId),
    readCompanyPortals(supabase, companyId),
  ])

  const unclaimed = verifikatWindow.rows.filter(
    (v) => !claimed.journalEntryIds.has(v.journal_entry_id),
  )
  const { context, linesByEntry, feedOf } = await fetchVerifikatFacts(
    supabase,
    companyId,
    unclaimed.map((v) => v.journal_entry_id),
  )
  // A transfer between the company's own accounts has the bank statement as
  // its underlag: nothing is missing and there is nothing to hunt for, so it
  // is left out like a claimed one.
  const verifikat = unclaimed.filter(
    (v) =>
      nextStepKind(
        context.get(v.journal_entry_id)?.counterparty ?? v.description,
        companyPortals,
        linesByEntry.get(v.journal_entry_id),
        v.source_type,
        feedOf(v.journal_entry_id),
      ) !== 'own_transfer',
  )
  const underlagElsewhere = await resolveUnderlagElsewhere(supabase, companyId, verifikat, linesByEntry)

  // Ranked on the SEK value: `amount` is in the row's own currency, and a
  // USD 90 subscription must not sort under a 100 kr parking receipt.
  const ranked: { item: AgentWorklistItem; sek: number }[] = []
  for (const v of verifikat) {
    const ctx = context.get(v.journal_entry_id)
    ranked.push({
      sek: v.gross_amount,
      item: withSearchHints({
        kind: 'verifikat',
        journal_entry_id: v.journal_entry_id,
        transaction_id: null,
        voucher: v.voucher_series ? formatVoucher(v) : String(v.voucher_number),
        date: v.entry_date,
        amount: ctx?.amount ?? v.gross_amount,
        currency: ctx?.currency ?? 'SEK',
        counterparty: ctx?.counterparty ?? null,
        description: v.description,
        invoice_number: ctx?.invoice_number ?? null,
      }, companyPortals, linesByEntry.get(v.journal_entry_id), underlagElsewhere.get(v.journal_entry_id) ?? null, v.source_type, feedOf(v.journal_entry_id)),
    })
  }
  for (const tx of transactions) {
    if (claimed.transactionIds.has(tx.id)) continue
    if (!tx.date || tx.amount == null) continue
    if (since && tx.date < since) continue
    if (until && tx.date > until) continue
    ranked.push({
      sek: Math.abs(tx.amount_sek ?? tx.amount),
      item: withSearchHints({
        kind: 'transaction',
        journal_entry_id: null,
        transaction_id: tx.id,
        voucher: null,
        date: tx.date,
        amount: Math.abs(tx.amount),
        currency: tx.currency ?? 'SEK',
        counterparty: tx.merchant_name ?? null,
        description: tx.description ?? null,
        invoice_number: null,
      }, companyPortals, undefined, null, null, tx.import_source),
    })
  }

  ranked.sort((a, b) => kindRank(a.item.kind) - kindRank(b.item.kind) || b.sek - a.sek)
  const end = offset + limit
  return {
    items: ranked.slice(offset, end).map((r) => r.item),
    // The verifikat total comes from the RPC (it may exceed the window
    // fetched here); claimed rows and transfers between own accounts inside
    // the window are subtracted so the number matches what the agent can
    // actually work on.
    total_count:
      verifikatWindow.total -
      (verifikatWindow.rows.length - verifikat.length) +
      ranked.filter((r) => r.item.kind === 'transaction').length,
    inbox_address: inboxAddress,
    ...(end < ranked.length ? { next_offset: end } : {}),
  }
}
