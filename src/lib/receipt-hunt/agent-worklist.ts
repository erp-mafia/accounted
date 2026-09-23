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
 *  - unbooked purchases without a receipt (the built-in hunt's own candidate
 *    predicate, so the two engines never disagree about what is missing).
 *
 * A supplier invoice without a document is not a third source: it surfaces as
 * its registration verifikat, which is where its underlag has to land.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchCandidateTransactions } from './hunt'
import { lookupPortal } from './portal-directory'
import { FETCH_DATE_WINDOW_DAYS, canHaveEmailReceipt } from './select'

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
   * False for rows that never have a mailed receipt (salary, tax, bank fees):
   * the agent skips the mail search and reports them as needing a human.
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
}

export interface AgentWorklist {
  items: AgentWorklistItem[]
  total_count: number
  /** The company's inbox address: mail forwarded here becomes an inbox document. Null when not provisioned. */
  inbox_address: string | null
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
 * Which errand a missing underlag actually needs, from its descriptor alone.
 *
 * Ordered by how a receipt reaches a Swedish company: a vendor that withholds
 * its invoice behind a login, a chain that sends to Kivra, a counter purchase
 * that only exists on paper, and otherwise the mailbox.
 *
 * Exported because this is derived, never stored: the app can classify the
 * rows it already has without an agent having run, and the agent's sentence
 * and the app's summary then say the same thing by construction.
 */
export type NextStepKind = 'not_mail' | 'portal' | 'kivra' | 'paper' | 'mail'

export function nextStepKind(descriptor: string | null): NextStepKind {
  if (!canHaveEmailReceipt(descriptor)) return 'not_mail'
  if (lookupPortal(descriptor)) return 'portal'
  if (KIVRA_DESCRIPTOR.test(descriptor ?? '')) return 'kivra'
  if (TIP_DESCRIPTOR.test(descriptor ?? '') || IN_PERSON_DESCRIPTOR.test(descriptor ?? '')) return 'paper'
  return 'mail'
}

/**
 * What to tell the person when the agent cannot fetch this one: one sentence,
 * one place, one action. Never mentions searching, agents or what failed. By
 * the time this is read, the reader only wants the errand.
 */
function nextStep(descriptor: string | null, portal: AgentWorklistItem['portal']): string {
  switch (nextStepKind(descriptor)) {
    case 'not_mail':
      return 'Hämtas inte ur mejlen: underlaget är lönespecifikationen, skattekontot eller kontoutdraget.'
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
    'search_from' | 'search_to' | 'mail_searchable' | 'portal' | 'tip_possible' | 'next_step'
  >,
): AgentWorklistItem {
  const descriptor = base.counterparty ?? base.description
  const portal = lookupPortal(descriptor)
  const mailSearchable = canHaveEmailReceipt(descriptor)
  // A payment that settles an invoice opens the window earlier: the invoice was
  // mailed when it was issued, the payment happens on the due date. The window
  // never closes later, because a document dated well after the charge belongs
  // to the next period, not this purchase.
  const settlesInvoice = Boolean(base.invoice_number) || INVOICE_DESCRIPTOR.test(descriptor ?? '')
  const portalHint = portal
    ? { vendor: portal.vendor, url: portal.url, note: portal.note ?? null }
    : null
  return {
    ...base,
    search_from: shiftDate(base.date, -(settlesInvoice ? INVOICE_DAYS_BEFORE : FETCH_DATE_WINDOW_DAYS)),
    search_to: shiftDate(base.date, FETCH_DATE_WINDOW_DAYS),
    mail_searchable: mailSearchable,
    portal: portalHint,
    tip_possible: TIP_DESCRIPTOR.test(descriptor ?? ''),
    next_step: nextStep(descriptor, portalHint),
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

async function fetchInboxAddress(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const domain = process.env.RESEND_INBOUND_DOMAIN
  if (!domain) return null
  const { data, error } = await supabase
    .from('company_inboxes')
    .select('local_part')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle()
  if (error || !data) return null
  return `${(data as { local_part: string }).local_part}@${domain}`
}

interface VerifikatContext {
  counterparty: string | null
  invoice_number: string | null
  amount: number | null
  currency: string | null
}

/** Who the verifikat is about: the supplier invoice it registers, else the bank row it books. */
async function fetchVerifikatContext(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
): Promise<Map<string, VerifikatContext>> {
  const context = new Map<string, VerifikatContext>()
  for (let i = 0; i < journalEntryIds.length; i += LOOKUP_CHUNK) {
    const chunk = journalEntryIds.slice(i, i + LOOKUP_CHUNK)
    const [siRes, txRes] = await Promise.all([
      supabase
        .from('supplier_invoices')
        .select('registration_journal_entry_id, supplier_invoice_number, total, currency, supplier:suppliers(name)')
        .eq('company_id', companyId)
        .in('registration_journal_entry_id', chunk),
      supabase
        .from('transactions')
        .select('journal_entry_id, merchant_name, amount, currency')
        .eq('company_id', companyId)
        .in('journal_entry_id', chunk),
    ])
    if (siRes.error) throw new Error(`supplier_invoices lookup failed: ${siRes.error.message}`)
    if (txRes.error) throw new Error(`transactions lookup failed: ${txRes.error.message}`)

    // Bank rows first so a supplier invoice, which names the supplier and the
    // invoice number, overwrites the thinner bank descriptor.
    for (const r of (txRes.data ?? []) as {
      journal_entry_id: string
      merchant_name: string | null
      amount: number
      currency: string | null
    }[]) {
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
  return context
}

/**
 * The agent's worklist, largest amount first: the biggest gaps in the
 * räkenskapsinformation are the ones worth a mail search first, and the
 * built-in hunt drains its queue in the same order.
 */
export async function resolveAgentWorklist(
  supabase: SupabaseClient,
  companyId: string,
  opts: { limit?: number; since?: string | null } = {},
): Promise<AgentWorklist> {
  const limit = Math.min(Math.max(1, opts.limit ?? 25), MAX_ITEMS)
  const since = opts.since ?? null

  const [verifikatRes, transactions, claimed, inboxAddress] = await Promise.all([
    supabase.rpc('verifikat_without_documents', {
      p_company_id: companyId,
      p_since: since,
      p_min_amount: 0,
      p_limit: MAX_ITEMS,
      p_offset: 0,
    }),
    fetchCandidateTransactions(supabase, companyId),
    fetchClaimedTargets(supabase, companyId),
    fetchInboxAddress(supabase, companyId),
  ])
  if (verifikatRes.error) throw new Error(`verifikat_without_documents failed: ${verifikatRes.error.message}`)
  const verifikatResult = verifikatRes.data as {
    ok?: boolean
    code?: string
    total_count?: number
    verifikat?: VerifikatRow[]
  } | null
  if (!verifikatResult?.ok) {
    throw new Error(`verifikat_without_documents failed: ${verifikatResult?.code ?? 'unknown error'}`)
  }

  const verifikat = (verifikatResult.verifikat ?? []).filter(
    (v) => !claimed.journalEntryIds.has(v.journal_entry_id),
  )
  const context = await fetchVerifikatContext(
    supabase,
    companyId,
    verifikat.map((v) => v.journal_entry_id),
  )

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
        voucher: v.voucher_series ? `${v.voucher_series}${v.voucher_number}` : String(v.voucher_number),
        date: v.entry_date,
        amount: ctx?.amount ?? v.gross_amount,
        currency: ctx?.currency ?? 'SEK',
        counterparty: ctx?.counterparty ?? null,
        description: v.description,
        invoice_number: ctx?.invoice_number ?? null,
      }),
    })
  }
  for (const tx of transactions) {
    if (claimed.transactionIds.has(tx.id)) continue
    if (!tx.date || tx.amount == null) continue
    if (since && tx.date < since) continue
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
      }),
    })
  }

  ranked.sort((a, b) => b.sek - a.sek)
  return {
    items: ranked.slice(0, limit).map((r) => r.item),
    // The verifikat total comes from the RPC (it may exceed the page fetched
    // here); claimed rows inside that page are subtracted so the number
    // matches what the agent can actually work on.
    total_count:
      (verifikatResult.total_count ?? 0) -
      ((verifikatResult.verifikat ?? []).length - verifikat.length) +
      ranked.filter((r) => r.item.kind === 'transaction').length,
    inbox_address: inboxAddress,
  }
}
